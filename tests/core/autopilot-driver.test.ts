import { describe, expect, test } from 'bun:test';
import {
  allNodesTerminal,
  buildContinuationSignal,
  mutationGate,
  nextReadyNodeId,
  rollbackOnRejection,
} from '~/core/autopilot-driver';
import { buildInitialNodes } from '~/core/autopilot-graph';
import type { Autopilot } from '~/schemas/autopilot';

function graph(overrides: Partial<Autopilot> = {}): Autopilot {
  return {
    schema_version: '0.1.0',
    autopilot_id: 'orch_driver01',
    work_item_id: 'wi_driver001',
    mode: 'autopilot',
    root_goal: 'g',
    completion_boundary: 'entire_work_item',
    approval_gate: {
      status: 'not_required',
      source: 'small_reversible_policy',
      approved_at: null,
      approved_by: null,
      evidence_refs: [],
    },
    nodes: buildInitialNodes(['ac-1']),
    caps: { fix_per_node: 2, switch_per_node: 1 },
    continue_policy: {
      continue_after_approval: true,
      continue_after_checkpoint: true,
      continue_after_fixable_failure: true,
      ask_user_only_for_user_owned_decisions: true,
    },
    stop_conditions: [],
    user_interrupt_policy: 'ask_only_for_user_owned_decisions',
    ...overrides,
  };
}

describe('mutationGate (M2.3 consumes approval status)', () => {
  test('approved / not_required => proceed', () => {
    expect(
      mutationGate(
        graph({
          approval_gate: {
            status: 'approved',
            source: 'user',
            approved_at: null,
            approved_by: null,
            evidence_refs: [],
          },
        }),
      ).allowed,
    ).toBe(true);
    expect(mutationGate(graph()).allowed).toBe(true);
  });
  test('pending => present_plan, not allowed', () => {
    const g = graph({
      approval_gate: {
        status: 'pending',
        source: null,
        approved_at: null,
        approved_by: null,
        evidence_refs: [],
      },
    });
    const result = mutationGate(g);
    expect(result.allowed).toBe(false);
    expect(result.action).toBe('present_plan');
  });
  test('rejected => blocked', () => {
    const g = graph({
      approval_gate: {
        status: 'rejected',
        source: null,
        approved_at: null,
        approved_by: null,
        evidence_refs: [],
      },
    });
    expect(mutationGate(g).action).toBe('blocked');
  });
});

describe('automatic continuation (M2.5)', () => {
  test('plan→implement→verify chains without intervention, then terminates', () => {
    let g = graph();
    expect(nextReadyNodeId(g)).toBe('N1');
    g = { ...g, nodes: g.nodes.map((n) => (n.id === 'N1' ? { ...n, status: 'passed' } : n)) };
    expect(nextReadyNodeId(g)).toBe('N2');
    g = { ...g, nodes: g.nodes.map((n) => (n.id === 'N2' ? { ...n, status: 'passed' } : n)) };
    expect(nextReadyNodeId(g)).toBe('N3');
    g = { ...g, nodes: g.nodes.map((n) => (n.id === 'N3' ? { ...n, status: 'passed' } : n)) };
    expect(nextReadyNodeId(g)).toBeNull();
    expect(allNodesTerminal(g)).toBe(true);
  });
});

describe('continuation signal (M2.5 — signal only, no artifact)', () => {
  test('carries handoff/re-entry flags and resume target with same autopilot_id', () => {
    const sig = buildContinuationSignal(graph(), 'context pressure');
    expect(sig.handoff_required).toBe(true);
    expect(sig.re_entry_required).toBe(true);
    expect(sig.resume.autopilot_id).toBe('orch_driver01');
    expect(sig.resume.work_item_id).toBe('wi_driver001');
    expect(sig.reason).toBe('context pressure');
  });
});

describe('rollbackOnRejection (G3: denied plan → rollback in-flight nodes)', () => {
  const rejected = {
    status: 'rejected' as const,
    source: null,
    approved_at: null,
    approved_by: null,
    evidence_refs: [],
  };

  test('rejected approval rolls running nodes back to pending and stops', () => {
    const nodes = buildInitialNodes(['ac-1']).map((n, i) =>
      i === 1 ? { ...n, status: 'running' as const } : n,
    );
    const result = rollbackOnRejection(graph({ approval_gate: rejected, nodes }));
    expect(result.stopped).toBe(true);
    expect(result.nodes.some((n) => n.status === 'running')).toBe(false);
    expect(result.nodes[1]?.status).toBe('pending');
  });

  test('passed nodes are left intact (only in-flight work rolls back)', () => {
    const nodes = buildInitialNodes(['ac-1']).map((n, i) =>
      i === 0 ? { ...n, status: 'passed' as const } : n,
    );
    const result = rollbackOnRejection(graph({ approval_gate: rejected, nodes }));
    expect(result.nodes[0]?.status).toBe('passed');
  });

  test('throws when called and approval is not rejected (guard the precondition)', () => {
    expect(() => rollbackOnRejection(graph())).toThrow();
  });
});
