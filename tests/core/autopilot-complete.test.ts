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

  test('an AC passed without evidence keeps final_verdict off pass (evidence-gated)', () => {
    const graph = graphWith([
      node({ id: 'N3', acceptance_refs: ['ac-1'], status: 'passed', evidence_refs: [ev('t')] }),
      node({ id: 'N4', acceptance_refs: ['ac-2'], status: 'passed', evidence_refs: [] }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1', 'ac-2']), { now: NOW });
    expect(c.final_verdict).not.toBe('pass'); // ac-2 unverified
  });

  test('a default summary is derived when none is supplied', () => {
    const graph = graphWith([
      node({ id: 'N3', acceptance_refs: ['ac-1'], evidence_refs: [ev('t')] }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), { now: NOW });
    expect(c.summary.length).toBeGreaterThan(0);
  });
});
