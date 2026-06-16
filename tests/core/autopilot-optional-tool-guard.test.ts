import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleCompletionFromGraph } from '~/core/autopilot-complete';
import { defaultDoctorDeps } from '~/core/codeql/doctor';
import { probePlaywright } from '~/core/e2e/browser';
import { completionEvidenceGate, completionGate } from '~/core/gates';
import { type Autopilot, type AutopilotNode, autopilot } from '~/schemas/autopilot';
import type { WorkItem } from '~/schemas/work-item';

/**
 * AC-2 invariant guard (wi_2606168oh, node n2-guard-impl). On the autopilot path
 * the graceful behavior already exists at runtime; this guard makes it an
 * ENFORCED INVARIANT. It is a TEST, not new runtime control-flow: it adds NO code
 * path that can block autopilot completion (the whole point), it only FAILS if the
 * invariant is violated. Two halves:
 *   (a) probe-or-degrade — optional-tool (codeql / playwright) presence resolves
 *       via a NON-throwing probe; absence yields a degrade value, never a raw
 *       spawn throw on a missing binary.
 *   (b) completion never requires an optional ledger — the completion gates +
 *       completion derivation accept an LLM-only completion (no codeql/sarif/acg
 *       ledger, no e2e journey); optional-ledger absence is never a blocking reason.
 *
 * n4 adds the full AC-2 regression test exercising this on the autopilot path; this
 * node ships the guard mechanism + a smoke assertion that it works.
 */

const NOW = new Date('2026-06-16T00:00:00.000Z');

const node = (over: Partial<AutopilotNode> & Pick<AutopilotNode, 'id'>): AutopilotNode => ({
  kind: 'verify',
  owner: 'verifier',
  purpose: 'verify',
  status: 'passed',
  depends_on: [],
  acceptance_refs: [],
  evidence_refs: [],
  ac_verdicts: [],
  attempts: { fix: 0, switch: 0 },
  ...over,
});

const graphWith = (nodes: AutopilotNode[]): Autopilot =>
  autopilot.parse({
    schema_version: '0.1.0',
    autopilot_id: 'orch_optoolguard',
    work_item_id: 'wi_optoolguard',
    root_goal: 'goal',
    approval_gate: { status: 'not_required', source: 'small_reversible_policy' },
    nodes,
    caps: { fix_per_node: 2, switch_per_node: 1, converge_rounds: 3 },
    continue_policy: {},
    stop_conditions: [],
  });

const workItemWith = (acIds: string[]): WorkItem =>
  ({
    id: 'wi_optoolguard',
    changed_files: ['src/x.ts'],
    goal: 'the goal',
    acceptance_criteria: acIds.map((id) => ({
      id,
      statement: `${id} is met`,
      verdict: 'unverified',
      evidence: [],
    })),
  }) as unknown as WorkItem;

// LLM-only evidence: a runnable-command log (e.g. `bun test` output), NOT a codeql
// sarif, acg review-graph ledger, or e2e journey artifact. This is the evidence
// shape an autopilot run produces when the optional tools are absent — it still
// carries a real runnable verification (so it is not an ack), it just isn't an
// optional-tool ledger.
const llmEvidence = (path: string) => ({
  kind: 'file' as const,
  path,
  summary: `llm-only test log ${path}`,
});

describe('AC-2 guard (a): optional-tool presence is probe-or-degrade (no throw on absent binary)', () => {
  test('codeql detection uses non-throwing Bun.which — degrades to false, never throws', async () => {
    // defaultDoctorDeps.cliAvailable wraps Bun.which('codeql'); Bun.which returns
    // null (→ falsy) when the binary is absent. It must RESOLVE to a boolean, never
    // reject, regardless of whether codeql is installed in this environment.
    const available = await defaultDoctorDeps.cliAvailable();
    expect(typeof available).toBe('boolean');
  });

  test('Bun.which returns null for an absent binary (the degrade primitive), does not throw', () => {
    // The primitive the codeql path relies on: probe a name that cannot exist.
    expect(() => Bun.which('codeql-binary-that-cannot-exist-xyz')).not.toThrow();
    expect(Bun.which('codeql-binary-that-cannot-exist-xyz')).toBeNull();
  });

  test('playwright presence resolves via probePlaywright to a degrade value, never throws', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'optoolguard-'));
    // In a no-browser session this resolves { available: false, reason } — a
    // degrade VALUE. It must always resolve (never reject) and carry a boolean
    // `available`, so absence is a degrade, not a thrown missing-binary error.
    const probe = await probePlaywright(repoRoot);
    expect(typeof probe.available).toBe('boolean');
    if (!probe.available) expect(typeof probe.reason).toBe('string');
  });
});

describe('AC-2 guard (b): completion never requires an optional ledger (LLM-only contract passes)', () => {
  test('an LLM-only completion (no codeql/sarif/acg ledger, no e2e journey) passes both completion gates', () => {
    // Build a completion straight from a finished autopilot graph whose only
    // evidence is an LLM-only note — exactly what a run produces when the optional
    // tools are absent. No acg_governance ledger is attached.
    const wi = workItemWith(['ac-1']);
    const graph = graphWith([
      node({
        id: 'N1',
        kind: 'implement',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        evidence_refs: [llmEvidence('run.log')],
      }),
    ]);
    const completion = assembleCompletionFromGraph(graph, wi, { now: NOW });

    // The optional ledger field is absent — the invariant under test.
    expect(completion.acg_governance).toBeUndefined();
    expect(completion.final_verdict).toBe('pass');

    // Neither gate may block on the missing optional ledger.
    const structural = completionGate(wi, completion);
    const evidence = completionEvidenceGate(completion);
    expect(structural.pass).toBe(true);
    expect(evidence.pass).toBe(true);
    // Defense in depth: no blocking reason mentions an optional tool/ledger.
    const reasons = [...structural.reasons, ...evidence.reasons].join(' ').toLowerCase();
    expect(reasons).not.toContain('codeql');
    expect(reasons).not.toContain('sarif');
    expect(reasons).not.toContain('ledger');
    expect(reasons).not.toContain('journey');
  });
});
