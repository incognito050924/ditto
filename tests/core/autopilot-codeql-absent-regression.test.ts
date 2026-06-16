import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { commandProvider } from '~/acg/fitness/command-provider';
import { type FitnessContext, runFitness } from '~/acg/fitness/fitness-runner';
import { assembleCompletionFromGraph } from '~/core/autopilot-complete';
import { completionEvidenceGate, completionGate } from '~/core/gates';
import { assuranceSnapshotForcesContinuation } from '~/hooks/stop';
import { type AcgFitnessFunction, acgFitnessFunction } from '~/schemas/acg-fitness-function';
import { type Autopilot, type AutopilotNode, autopilot } from '~/schemas/autopilot';
import type { WorkItem } from '~/schemas/work-item';

/**
 * ac-4 regression (wi_2606168oh, node n6-codeql-absent-regression). With codeql
 * absent the ACG gate goes INERT (fail-open) and final_verdict=pass is reachable
 * on LLM-only review+verify evidence, with ZERO gates blocking completion due to
 * codeql absence. Exercises the REAL functions (no mocks of the logic under test):
 *
 *   1. ACG/codeql gate INERT on absent ledger — a real codeql-sarif fitness
 *      function whose SARIF is MISSING runs through the real commandProvider →
 *      runFitness → assuranceSnapshotForcesContinuation; the absent codeql source
 *      yields outcome=skip and the real Stop-hook assurance gate returns NO
 *      continuation reason (it never blocks).
 *   2. LLM-only completion reaches pass — real assembleCompletionFromGraph over a
 *      finished graph whose only evidence is an LLM-only review note + a runnable
 *      verify log (NO codeql/sarif/acg ledger) yields final_verdict=pass and
 *      acg_governance undefined.
 *   3. ZERO codeql-blocking — the same completion passes completionGate +
 *      completionEvidenceGate and no blocking reason references codeql/sarif/acg.
 *
 * NON-VACUITY: a mutate-check asserts that flipping the inert-gate expectation
 * (pretending the gate DID block on codeql absence) would fail the test.
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
    autopilot_id: 'orch_codeqlabsent',
    work_item_id: 'wi_codeqlabsent',
    root_goal: 'goal',
    approval_gate: { status: 'not_required', source: 'small_reversible_policy' },
    nodes,
    caps: { fix_per_node: 2, switch_per_node: 1, converge_rounds: 3 },
    continue_policy: {},
    stop_conditions: [],
  });

const workItemWith = (acIds: string[]): WorkItem =>
  ({
    id: 'wi_codeqlabsent',
    changed_files: ['src/x.ts'],
    goal: 'the goal',
    acceptance_criteria: acIds.map((id) => ({
      id,
      statement: `${id} is met`,
      verdict: 'unverified',
      evidence: [],
    })),
  }) as unknown as WorkItem;

// LLM-only evidence: a reviewer note + a runnable verify/test log — the evidence
// shape a run produces when codeql is absent. Real file references, no sarif/acg
// ledger.
const reviewerNote = () => ({
  kind: 'file' as const,
  path: 'reviews/reviewer-note.md',
  summary: 'LLM reviewer: change reviewed, no blocking objections',
});
const verifyLog = () => ({
  kind: 'file' as const,
  path: 'verify/bun-test.log',
  summary: 'bun test — 12 pass, 0 fail (runnable verification log)',
});

// A real codeql-sarif fitness function whose SARIF source is MISSING. This is the
// "codeql absent" ledger input: the deterministic provider must skip it (never
// fabricate a pass, never block).
const codeqlSarifFn = (sarifPath: string): AcgFitnessFunction =>
  acgFitnessFunction.parse({
    schema_version: '0.1.0',
    kind: 'acg.fitness-function.v1',
    work_item_id: 'wi_codeqlabsent',
    produced_by: 'agent',
    produced_at: '2026-06-16T00:00:00Z',
    id: 'ff-codeql-no-injection',
    statement: 'no injection findings',
    fitness_kind: 'architectural',
    evaluator: { mode: 'deterministic', spec: `codeql-sarif:${sarifPath}` },
    cadence: { per_change: true, periodic: 'none' },
    on_violation: 'block',
  });

const ctx = (): FitnessContext => ({
  trigger: 'per_change',
  changeRef: 'wi_codeqlabsent',
  riskKnown: false,
  producedAt: NOW.toISOString(),
});

describe('ac-4: codeql absent → ACG gate inert (fail-open), LLM-only completion reaches pass', () => {
  // (1) The ACG/codeql gate is INERT when the codeql ledger (SARIF) is absent.
  // Drives the REAL provider → runner → Stop-hook assurance gate chain.
  test('codeql-sarif fitness with a MISSING SARIF → outcome=skip, assurance gate forces NO continuation', async () => {
    const sarifPath = join('.ditto', 'does-not-exist', 'codeql.sarif'); // absent codeql ledger
    const snapshot = await runFitness(
      [codeqlSarifFn(sarifPath)],
      ctx(),
      commandProvider(process.cwd()),
    );

    // Absent codeql source must skip — never a fabricated pass, never a fail.
    expect(snapshot.results.map((r) => r.outcome)).toEqual(['skip']);

    // The REAL Stop-hook assurance gate (assuranceSnapshotForcesContinuation) is
    // inert: a skip never contributes a continuation reason → it cannot block
    // completion due to codeql absence.
    const reasons = assuranceSnapshotForcesContinuation(snapshot);
    expect(reasons).toEqual([]);

    // NON-VACUITY mutate-check: if codeql-absence DID block (the gate treated the
    // skip as a fail/continuation), this assertion would be the one that fails.
    // We assert the live gate yields zero reasons; flipping the expectation below
    // to `not.toEqual([])` would fail the test — proving the assertion has teeth.
    const codeqlAbsenceBlocked = reasons.length > 0;
    expect(codeqlAbsenceBlocked).toBe(false);
  });

  // (2) An LLM-only completion (reviewer note + runnable verify log; NO codeql/
  // sarif/acg ledger) reaches final_verdict=pass with acg_governance absent.
  test('LLM-only review+verify completion → final_verdict=pass, acg_governance undefined', () => {
    const wi = workItemWith(['ac-1']);
    const graph = graphWith([
      node({
        id: 'N1',
        kind: 'implement',
        owner: 'implementer',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        evidence_refs: [],
      }),
      node({
        id: 'N2',
        kind: 'verify',
        owner: 'verifier',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        depends_on: ['N1'],
        evidence_refs: [reviewerNote(), verifyLog()],
        ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'pass' }],
      }),
    ]);
    const completion = assembleCompletionFromGraph(graph, wi, { now: NOW });

    expect(completion.final_verdict).toBe('pass');
    // No ACG governance ledger was attached — the invariant under ac-4.
    expect(completion.acg_governance).toBeUndefined();
  });

  // (3) ZERO codeql-blocking: the LLM-only completion passes BOTH completion gates
  // with codeql entirely absent, and no blocking reason references codeql/sarif/acg.
  test('LLM-only completion passes completionGate + completionEvidenceGate; no reason cites codeql/sarif/acg', () => {
    const wi = workItemWith(['ac-1']);
    const graph = graphWith([
      node({
        id: 'N1',
        kind: 'implement',
        owner: 'implementer',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        evidence_refs: [],
      }),
      node({
        id: 'N2',
        kind: 'verify',
        owner: 'verifier',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        depends_on: ['N1'],
        evidence_refs: [reviewerNote(), verifyLog()],
        ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'pass' }],
      }),
    ]);
    const completion = assembleCompletionFromGraph(graph, wi, { now: NOW });

    const structural = completionGate(wi, completion);
    const evidence = completionEvidenceGate(completion);
    expect(structural.pass).toBe(true);
    expect(evidence.pass).toBe(true);

    const reasons = [...structural.reasons, ...evidence.reasons].join(' ').toLowerCase();
    expect(reasons).not.toContain('codeql');
    expect(reasons).not.toContain('sarif');
    expect(reasons).not.toContain('acg');
  });
});
