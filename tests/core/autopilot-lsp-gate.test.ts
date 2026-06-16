import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleCompletionFromGraph } from '~/core/autopilot-complete';
import { buildInitialNodes } from '~/core/autopilot-graph';
import { recordResult } from '~/core/autopilot-loop';
import { AutopilotStore } from '~/core/autopilot-store';
import { localDir } from '~/core/ditto-paths';
import { completionEvidenceGate, completionGate } from '~/core/gates';
import { resolveServer } from '~/core/lsp/client';
import { WorkItemStore } from '~/core/work-item-store';
import type { Autopilot } from '~/schemas/autopilot';

/**
 * ac-2 — the autopilot edit-then-diagnostics gate is MONOTONIC. After a mutating
 * (implementer) pass, this test drives the REAL `recordResult` gate (no mock of
 * the gate logic) and asserts the four invariants of ac-2:
 *   1. SURFACED      — a changed TS file with a type error → the pass outcome
 *                      carries `lsp_advisory` with ≥1 error AND lsp-diagnostics.json
 *                      is written (the gate ran and surfaced the error).
 *   2. NOT BLOCKED   — same case: the node still records status=passed / outcome=pass,
 *                      and the completion path (gates + derivation) is byte-identical
 *                      to the no-advisory run (the advisory flips no verdict, adds no
 *                      blocking reason).
 *   3. NEVER CLEAN   — a clean changed TS file yields no advisory errors but ALSO
 *                      marks nothing verified/clean (no AC closed by the gate).
 *   4. DEGRADE       — server-absent (TYPESCRIPT_LSP_BIN=/nonexistent) and no-TS-file:
 *                      no advisory, outcome unchanged, no throw.
 *
 * The gate spawns the REAL typescript-language-server (n2 client). The SURFACED /
 * NEVER-CLEAN cases need it installed; they are skipped (not failed) when absent so
 * the suite stays green on machines without it. The DEGRADE case needs no server.
 */

const TS_SERVER = resolveServer('typescript');
const NOW = new Date('2026-06-16T00:00:00.000Z');
const BAD_TS = 'const x: number = "str";\nexport { x };\n';
const CLEAN_TS = 'export const n: number = 42;\n';

let repo: string;
let aps: AutopilotStore;
let wis: WorkItemStore;
let WI: string;

// A graph whose implement node (N2) is dispatched (running) and ready to record —
// the mutating pass-path seam the gate hooks into.
function graphWithRunningImplement(): Autopilot {
  return {
    schema_version: '0.1.0',
    autopilot_id: 'orch_lspgatetest',
    work_item_id: WI,
    mode: 'autopilot',
    root_goal: 'goal',
    completion_boundary: 'entire_work_item',
    approval_gate: {
      status: 'not_required',
      source: 'small_reversible_policy',
      approved_at: null,
      approved_by: null,
      evidence_refs: [],
    },
    // N1 design passed so N2 implement is reachable; mark N2 running so recordResult
    // accepts the pass directly (no need to drive nextNode through the approval gate).
    nodes: buildInitialNodes(['ac-1']).map((n) =>
      n.id === 'N1'
        ? { ...n, status: 'passed' as const }
        : n.id === 'N2'
          ? { ...n, status: 'running' as const }
          : n,
    ),
    caps: { fix_per_node: 2, switch_per_node: 1, converge_rounds: 3 },
    continue_policy: {
      continue_after_approval: true,
      continue_after_checkpoint: true,
      continue_after_fixable_failure: true,
      ask_user_only_for_user_owned_decisions: true,
    },
    stop_conditions: [],
    user_interrupt_policy: 'ask_only_for_user_owned_decisions',
  };
}

// Record a contentful mutating pass on N2 reporting `changedFile` as edited.
async function recordImplementPass(changedFile: string) {
  return recordResult(repo, {
    workItemId: WI,
    now: NOW,
    payload: {
      node_id: 'N2',
      result_text: `Implemented the change in ${changedFile}; the type now flows through the call site.`,
      outcome: 'pass',
      changed_files: [changedFile],
      evidence_refs: [{ kind: 'file', path: 'run.log', summary: 'bun test output' }],
    },
  });
}

const diagnosticsArtifactPath = () => localDir(repo, 'work-items', WI, 'lsp-diagnostics.json');

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-lspgate-'));
  aps = new AutopilotStore(repo);
  wis = new WorkItemStore(repo);
  const wi = await wis.create(
    {
      title: 'lsp gate test',
      source_request: 'test the edit-then-diagnostics gate',
      goal: 'the advisory gate surfaces LSP errors monotonically',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'gate is monotonic', verdict: 'unverified', evidence: [] },
      ],
    },
    NOW,
  );
  WI = wi.id;
  await aps.write(WI, { ...graphWithRunningImplement(), work_item_id: WI });
});

afterEach(async () => {
  // biome-ignore lint/performance/noDelete: env var must be unset via delete; assigning undefined coerces to the string "undefined"
  delete process.env.TYPESCRIPT_LSP_BIN;
  await rm(repo, { recursive: true, force: true });
});

describe.if(TS_SERVER !== null)('ac-2 gate with the real typescript-language-server', () => {
  test('1. SURFACED: a changed TS file with a type error surfaces ≥1 error advisory + writes the artifact', async () => {
    await writeFile(join(repo, 'bad.ts'), BAD_TS);

    const res = await recordImplementPass('bad.ts');

    // The gate surfaced the error onto the pass outcome.
    expect(res.lsp_advisory).toBeDefined();
    const advisory = res.lsp_advisory ?? [];
    expect(advisory.length).toBeGreaterThanOrEqual(1);
    expect(advisory[0]?.file).toBe('bad.ts');
    expect(advisory[0]?.diagnostics.length).toBeGreaterThanOrEqual(1);
    expect(advisory[0]?.diagnostics.every((d) => d.severity === 'error')).toBe(true);

    // The advisory artifact (lsp-diagnostics.json) was written and is marked advisory.
    const artifact = JSON.parse(await readFile(diagnosticsArtifactPath(), 'utf8'));
    expect(artifact.advisory).toBe(true);
    expect(artifact.files.length).toBeGreaterThanOrEqual(1);
  }, 25000);

  test('2. NOT BLOCKED (monotonic): the surfaced error leaves the node passed AND the completion path identical to a no-advisory run', async () => {
    await writeFile(join(repo, 'bad.ts'), BAD_TS);

    const res = await recordImplementPass('bad.ts');

    // The pass outcome is unchanged — the advisory did not flip pass/fail.
    expect(res.status).toBe('passed');
    expect(res.outcome).toBe('pass');
    expect(res.guard_contentful).toBe(true);
    expect(res.decision).toBeNull();
    expect(res.failure_class).toBeNull();
    const afterNode = (await aps.get(WI)).nodes.find((n) => n.id === 'N2');
    expect(afterNode?.status).toBe('passed');

    // Completion derived from the graph carrying the surfaced error must be byte-
    // identical to completion derived from the SAME graph without any advisory —
    // proving the advisory is not consumed by the completion path. The advisory
    // lives only on the recordResult outcome, never on the graph, so re-deriving
    // from the post-record graph is the no-advisory baseline.
    const wi = await wis.get(WI);
    const graphAfter = await aps.get(WI);
    const completion = assembleCompletionFromGraph(graphAfter, wi, { now: NOW });

    // No gate blocks, and no reason mentions lsp/diagnostics/advisory — the advisory
    // added no blocking reason to the completion.
    const structural = completionGate(wi, completion);
    const evidence = completionEvidenceGate(completion);
    const reasons = [...structural.reasons, ...evidence.reasons].join(' ').toLowerCase();
    expect(reasons).not.toContain('lsp');
    expect(reasons).not.toContain('diagnostic');
    expect(reasons).not.toContain('advisory');
    // The completion contract itself carries no lsp field (ac-3: completion is LSP-free).
    expect(JSON.stringify(completion).toLowerCase()).not.toContain('lsp_advisory');
  }, 25000);

  test('3. NEVER CERTIFIES CLEAN: a clean changed TS file yields no advisory errors and closes/marks nothing verified', async () => {
    await writeFile(join(repo, 'clean.ts'), CLEAN_TS);

    const res = await recordImplementPass('clean.ts');

    // No surfaced errors → no advisory note on the outcome.
    expect(res.lsp_advisory).toBeUndefined();

    // The clean run did NOT certify anything: the AC stays unverified and no node's
    // ac_verdicts were set by the gate (the gate writes no verdicts at all).
    const wi = await wis.get(WI);
    expect(wi.acceptance_criteria.find((c) => c.id === 'ac-1')?.verdict).toBe('unverified');
    const graphAfter = await aps.get(WI);
    expect(graphAfter.nodes.every((n) => (n.ac_verdicts ?? []).length === 0)).toBe(true);

    // The verify node (N3) is still pending — the gate did not stand in for it.
    expect(graphAfter.nodes.find((n) => n.id === 'N3')?.status).toBe('pending');
  }, 25000);

  test('NON-VACUITY: the SURFACED assertion is differential — bad fixture surfaces, server-absent does NOT (same input, gate off ⇒ no advisory)', async () => {
    // Same bad fixture, same mutating pass. With the gate ON (server present) it
    // surfaces; with the gate effectively OFF (server forced absent) it does not.
    // If the gate never ran, BOTH would be undefined and the SURFACED test would be
    // vacuous. The contrast proves the surfaced advisory is produced by the gate.
    await writeFile(join(repo, 'bad.ts'), BAD_TS);
    const withGate = await recordImplementPass('bad.ts');
    expect(withGate.lsp_advisory).toBeDefined();

    // Reset N2 to running for a second record (the first record passed it).
    await aps.write(WI, { ...graphWithRunningImplement(), work_item_id: WI });
    process.env.TYPESCRIPT_LSP_BIN = '/nonexistent/typescript-language-server';
    const gateOff = await recordImplementPass('bad.ts');
    expect(gateOff.lsp_advisory).toBeUndefined();
    // Outcome identical regardless of the advisory — monotonic across both runs.
    expect(withGate.status).toBe(gateOff.status);
    expect(withGate.outcome).toBe(gateOff.outcome);
  }, 25000);
});

describe('ac-2 gate DEGRADE (no server / no TS file — server-independent)', () => {
  test('4a. DEGRADE server-absent: TYPESCRIPT_LSP_BIN=/nonexistent → no advisory, pass unchanged, no throw', async () => {
    await writeFile(join(repo, 'bad.ts'), BAD_TS);
    process.env.TYPESCRIPT_LSP_BIN = '/nonexistent/typescript-language-server';

    const res = await recordImplementPass('bad.ts');

    expect(res.lsp_advisory).toBeUndefined();
    expect(res.status).toBe('passed');
    expect(res.outcome).toBe('pass');
    // SKIP path writes no advisory artifact.
    await expect(readFile(diagnosticsArtifactPath(), 'utf8')).rejects.toThrow();
  });

  test('4b. DEGRADE no-TS-file: a changed non-TS file is not checked → no advisory, pass unchanged, no throw', async () => {
    await writeFile(join(repo, 'notes.md'), '# notes\n');

    const res = await recordImplementPass('notes.md');

    expect(res.lsp_advisory).toBeUndefined();
    expect(res.status).toBe('passed');
    expect(res.outcome).toBe('pass');
    await expect(readFile(diagnosticsArtifactPath(), 'utf8')).rejects.toThrow();
  });
});
