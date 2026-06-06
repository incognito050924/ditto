import { describe, expect, test } from 'bun:test';
import { assembleCompletionFromGraph, deriveAcVerdicts } from '~/core/autopilot-complete';
import { type Autopilot, type AutopilotNode, autopilot } from '~/schemas/autopilot';
import type { WorkItem } from '~/schemas/work-item';

const NOW = new Date('2026-06-02T00:00:00.000Z');

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
    autopilot_id: 'orch_completetest',
    work_item_id: 'wi_completetest',
    root_goal: 'goal',
    approval_gate: { status: 'not_required', source: 'small_reversible_policy' },
    nodes,
    caps: { fix_per_node: 2, switch_per_node: 1, converge_rounds: 3 },
    continue_policy: {},
    stop_conditions: [],
  });

const workItemWith = (acIds: string[]): WorkItem =>
  ({
    id: 'wi_completetest',
    changed_files: ['src/x.ts'],
    goal: 'the goal',
    acceptance_criteria: acIds.map((id) => ({
      id,
      statement: `${id} is met`,
      verdict: 'unverified',
      evidence: [],
    })),
  }) as unknown as WorkItem;

const ev = (path: string) => ({ kind: 'file' as const, path, summary: `evidence ${path}` });

describe('deriveAcVerdicts (evidence-gated: pass only with evidence; never auto-pass a claim)', () => {
  test('a passed addressing node WITH evidence → pass, carrying that evidence', () => {
    const graph = graphWith([
      node({ id: 'N3', acceptance_refs: ['ac-1'], status: 'passed', evidence_refs: [ev('t.log')] }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('pass');
    expect(v?.evidence).toEqual([ev('t.log')]);
  });

  test('a passed addressing node WITHOUT evidence → unverified (claim ≠ proof, not pass)', () => {
    const graph = graphWith([
      node({ id: 'N3', acceptance_refs: ['ac-1'], status: 'passed', evidence_refs: [] }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('unverified');
  });

  test('a failed addressing node → fail', () => {
    const graph = graphWith([
      node({ id: 'N3', acceptance_refs: ['ac-1'], status: 'failed', evidence_refs: [ev('t.log')] }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('fail');
  });

  test('no node addresses the criterion → unverified', () => {
    const graph = graphWith([
      node({ id: 'N3', acceptance_refs: ['ac-2'], evidence_refs: [ev('t')] }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('unverified');
  });

  test('evidence is the union across all addressing nodes', () => {
    const graph = graphWith([
      node({ id: 'N2', acceptance_refs: ['ac-1'], status: 'passed', evidence_refs: [ev('a')] }),
      node({ id: 'N3', acceptance_refs: ['ac-1'], status: 'passed', evidence_refs: [ev('b')] }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('pass');
    expect(v?.evidence).toEqual([ev('a'), ev('b')]);
  });

  // False-green repro (wi_260606e43 N3): the verifier judged ac-3 PARTIAL, but the
  // node passed *as a node* (its verification ran, evidence present) addressing all
  // three ACs. The node-level pass must NOT absorb the per-AC partial.
  test('a per-AC partial verdict overrides a node-level pass (no false-green; claim ≠ proof)', () => {
    const graph = graphWith([
      node({
        id: 'N3',
        acceptance_refs: ['ac-1', 'ac-2', 'ac-3'],
        status: 'passed',
        evidence_refs: [ev('verify.log')],
        ac_verdicts: [{ criterion_id: 'ac-3', verdict: 'partial' }],
      }),
    ]);
    const [a1, a2, a3] = deriveAcVerdicts(graph, ['ac-1', 'ac-2', 'ac-3']);
    expect(a1?.verdict).toBe('pass');
    expect(a2?.verdict).toBe('pass');
    expect(a3?.verdict).toBe('partial'); // not pass — the verifier judged it partial
  });

  test('a per-AC fail verdict overrides a node-level pass', () => {
    const graph = graphWith([
      node({
        id: 'N3',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        evidence_refs: [ev('verify.log')],
        ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'fail' }],
      }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('fail');
  });

  // The fold only ever LOWERS: an explicit pass cannot upgrade an evidence-less
  // structural unverified (the evidence gate still holds; claim ≠ proof).
  test('an explicit pass cannot raise a verdict above the evidence-gated structural floor', () => {
    const graph = graphWith([
      node({
        id: 'N3',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        evidence_refs: [],
        ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'pass' }],
      }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('unverified');
  });

  // A per-AC verdict for an AC the node does not address is ignored (it is not an
  // addressing node for that criterion).
  test('a per-AC verdict on a non-addressed criterion is ignored', () => {
    const graph = graphWith([
      node({
        id: 'N3',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        evidence_refs: [ev('t.log')],
        ac_verdicts: [{ criterion_id: 'ac-2', verdict: 'fail' }],
      }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('pass'); // ac-2's fail does not touch ac-1
  });
});

describe('assembleCompletionFromGraph (deterministic completion from the graph; final_verdict derived)', () => {
  test('all ACs covered by passed nodes with evidence → final_verdict=pass', () => {
    const graph = graphWith([
      node({
        id: 'N3',
        acceptance_refs: ['ac-1', 'ac-2'],
        status: 'passed',
        evidence_refs: [ev('t.log')],
      }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1', 'ac-2']), { now: NOW });
    expect(c.final_verdict).toBe('pass');
    expect(c.declared_by).toBe('verifier');
    expect(c.acceptance.map((a) => a.verdict)).toEqual(['pass', 'pass']);
    expect(c.changed_files).toEqual(['src/x.ts']); // from the work item
  });

  test('a per-AC partial keeps final_verdict off pass even when the node passed with evidence (false-green fix)', () => {
    const graph = graphWith([
      node({
        id: 'N3',
        acceptance_refs: ['ac-1', 'ac-2', 'ac-3'],
        status: 'passed',
        evidence_refs: [ev('t.log')],
        ac_verdicts: [{ criterion_id: 'ac-3', verdict: 'partial' }],
      }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1', 'ac-2', 'ac-3']), {
      now: NOW,
    });
    expect(c.final_verdict).toBe('partial');
    expect(c.acceptance.find((a) => a.criterion_id === 'ac-3')?.verdict).toBe('partial');
  });

  test('an AC passed without evidence keeps final_verdict off pass (evidence-gated)', () => {
    const graph = graphWith([
      node({ id: 'N3', acceptance_refs: ['ac-1'], status: 'passed', evidence_refs: [ev('t')] }),
      node({ id: 'N4', acceptance_refs: ['ac-2'], status: 'passed', evidence_refs: [] }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1', 'ac-2']), { now: NOW });
    expect(c.final_verdict).not.toBe('pass'); // ac-2 unverified
  });

  test('a non-terminal node is surfaced as a remaining risk naming the node ids', () => {
    const graph = graphWith([
      node({ id: 'N3', acceptance_refs: ['ac-1'], status: 'passed', evidence_refs: [ev('t')] }),
      node({ id: 'N4', acceptance_refs: ['ac-1'], status: 'blocked', evidence_refs: [] }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), { now: NOW });
    const risk = c.remaining_risks.find((r) => r.includes('non-terminal graph nodes'));
    expect(risk).toBeDefined();
    expect(risk).toContain('N4');
    expect(risk).not.toContain('N3'); // terminal nodes are not listed
  });

  test('caller-supplied remaining risks are preserved alongside the non-terminal entry', () => {
    const graph = graphWith([node({ id: 'N4', status: 'pending', evidence_refs: [] })]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), {
      now: NOW,
      remainingRisks: ['caller risk'],
    });
    expect(c.remaining_risks).toContain('caller risk');
    expect(c.remaining_risks.some((r) => r.includes('non-terminal graph nodes'))).toBe(true);
  });

  test('a graph where every node is terminal has no non-terminal-node entry', () => {
    const graph = graphWith([
      node({ id: 'N3', acceptance_refs: ['ac-1'], status: 'passed', evidence_refs: [ev('t')] }),
      node({ id: 'N4', acceptance_refs: ['ac-1'], status: 'failed', evidence_refs: [ev('f')] }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), { now: NOW });
    expect(c.remaining_risks.some((r) => r.includes('non-terminal graph nodes'))).toBe(false);
  });

  test('a default summary is derived when none is supplied', () => {
    const graph = graphWith([
      node({ id: 'N3', acceptance_refs: ['ac-1'], evidence_refs: [ev('t')] }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), { now: NOW });
    expect(c.summary.length).toBeGreaterThan(0);
  });
});
