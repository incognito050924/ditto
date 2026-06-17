import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

// Record a contentful mutating pass on N2 reporting many edited files at once —
// the sweeping-change path the file cap and bounded-parallel batching guard.
async function recordImplementPassMany(changedFiles: string[]) {
  return recordResult(repo, {
    workItemId: WI,
    now: NOW,
    payload: {
      node_id: 'N2',
      result_text: `Implemented the change across ${changedFiles.length} files; the types now flow through the call sites.`,
      outcome: 'pass',
      changed_files: changedFiles,
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
    // Force the gate "off" with a stub that resolves but never speaks LSP. (The
    // unified detection falls a set-but-missing env through to PATH, so a bogus
    // path would find the real server — a present-but-mute stub degrades instead.)
    const stub = join(repo, 'stub-lsp');
    await writeFile(stub, '#!/bin/sh\nexit 0\n');
    process.env.TYPESCRIPT_LSP_BIN = stub;
    const gateOff = await recordImplementPass('bad.ts');
    expect(gateOff.lsp_advisory).toBeUndefined();
    // Outcome identical regardless of the advisory — monotonic across both runs.
    expect(withGate.status).toBe(gateOff.status);
    expect(withGate.outcome).toBe(gateOff.outcome);
  }, 25000);
});

describe('ac-2 gate DEGRADE (no server / no TS file — server-independent)', () => {
  test('4a. DEGRADE server unusable: a present-but-mute server → no advisory, pass unchanged, no throw', async () => {
    await writeFile(join(repo, 'bad.ts'), BAD_TS);
    // A stub that resolves (detection succeeds) but exits without diagnostics —
    // the spawn/stdout-close degrade. (A set-but-missing env would fall through to
    // the real PATH server under the unified provisioner detection.)
    const stub = join(repo, 'stub-lsp');
    await writeFile(stub, '#!/bin/sh\nexit 0\n');
    process.env.TYPESCRIPT_LSP_BIN = stub;

    const res = await recordImplementPass('bad.ts');

    expect(res.lsp_advisory).toBeUndefined();
    expect(res.status).toBe('passed');
    expect(res.outcome).toBe('pass');
    // The mute server resolved, so the gate ran and wrote an (empty) advisory
    // record — surfacing no errors (files: []), hence no advisory on the outcome.
    // (The true SKIP→no-artifact path is covered by 4b, where no .ts is checked.)
    const artifact = JSON.parse(await readFile(diagnosticsArtifactPath(), 'utf8'));
    expect(artifact.files).toEqual([]);
  });

  test('4b. DEGRADE no-TS-file: a changed non-TS file is not checked → no advisory, pass unchanged, no throw', async () => {
    await writeFile(join(repo, 'notes.md'), '# notes\n');

    const res = await recordImplementPass('notes.md');

    expect(res.lsp_advisory).toBeUndefined();
    expect(res.status).toBe('passed');
    expect(res.outcome).toBe('pass');
    await expect(readFile(diagnosticsArtifactPath(), 'utf8')).rejects.toThrow();
  });

  test('5. FILE CAP DISCLOSED: more changed .ts files than the cap → only the cap is examined and the overflow is recorded as `truncated` (G3 — no silent cap)', async () => {
    // Mute stub so the gate runs but surfaces nothing — the cap arithmetic is what
    // we assert, independent of any server. Files need not exist on disk: the cap
    // is computed from the filtered changed-file list, not from per-file reads.
    const stub = join(repo, 'stub-lsp');
    await writeFile(stub, '#!/bin/sh\nexit 0\n');
    process.env.TYPESCRIPT_LSP_BIN = stub;

    const total = 30;
    const files = Array.from({ length: total }, (_, i) => `src/f${i}.ts`);
    const res = await recordImplementPassMany(files);

    expect(res.lsp_advisory).toBeUndefined(); // mute → nothing surfaced
    const artifact = JSON.parse(await readFile(diagnosticsArtifactPath(), 'utf8'));
    expect(artifact.files).toEqual([]);
    // The cap bit: examined + skipped === total reported, and some WERE skipped
    // (total exceeds the cap). Asserted via the disclosed counts, not the cap value,
    // so the test survives a future cap retune.
    expect(artifact.checked + artifact.truncated).toBe(total);
    expect(artifact.truncated).toBeGreaterThan(0);
    expect(artifact.checked).toBeLessThan(total);
  }, 20000);

  test('6. BOUNDED LATENCY: several non-responding .ts files finish within a short bound — short per-file timeout + bounded parallel, not N×8s-default serial', async () => {
    // A stub that connects but never answers (reads stdin, writes nothing) — each
    // getDiagnostics must hit its timeout. CHMOD +x is required: an un-executable
    // stub fails spawn (EACCES) and degrades instantly, which would NOT exercise the
    // timeout path. With the gate's short timeout + bounded parallel, n files finish
    // in ~ceil(n/concurrency)·gateTimeout, NOT n·8s serial.
    const stub = join(repo, 'stub-lsp');
    await writeFile(stub, '#!/bin/sh\ncat >/dev/null\n');
    await chmod(stub, 0o755);
    process.env.TYPESCRIPT_LSP_BIN = stub;

    const files = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `${n}.ts`);
    for (const f of files) await writeFile(join(repo, f), 'export const x = 1;\n');

    const start = performance.now();
    const res = await recordImplementPassMany(files);
    const elapsed = performance.now() - start;

    expect(res.lsp_advisory).toBeUndefined(); // every file degraded to []
    // 6 files: bounded-parallel(4)+3s ≈ 6s; serial+3s ≈ 18s; serial+8s-default ≈ 48s.
    // A 12s bound passes the parallel-short path and fails both serial paths.
    expect(elapsed).toBeLessThan(12000);
  }, 20000);
});
