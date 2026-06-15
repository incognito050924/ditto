import { describe, expect, test } from 'bun:test';
import { applyApproval, applyRejection } from '~/core/autopilot-approval';
import type { Autopilot } from '~/schemas/autopilot';

type Gate = Autopilot['approval_gate'];

function pendingGate(): Gate {
  return {
    status: 'pending',
    source: null,
    approved_at: null,
    approved_by: null,
    evidence_refs: [],
  };
}

describe('applyApproval', () => {
  test('pending → approved with source/approved_at/approved_by', () => {
    const now = new Date('2026-06-16T00:00:00.000Z');
    const next = applyApproval(pendingGate(), { by: 'hskim', now });
    expect(next.status).toBe('approved');
    expect(next.source).toBe('user');
    expect(next.approved_at).toBe('2026-06-16T00:00:00.000Z');
    expect(next.approved_by).toBe('hskim');
  });

  test('honors an explicit source', () => {
    const next = applyApproval(pendingGate(), {
      source: 'approved_spec',
      now: new Date('2026-06-16T00:00:00.000Z'),
    });
    expect(next.source).toBe('approved_spec');
  });

  test('throws when the gate is not pending', () => {
    const gate = { ...pendingGate(), status: 'approved' as const };
    expect(() => applyApproval(gate, {})).toThrow(/not pending/);
  });
});

describe('applyRejection', () => {
  test('pending → rejected', () => {
    const next = applyRejection(pendingGate());
    expect(next.status).toBe('rejected');
  });

  test('records a reason as a note evidence_ref', () => {
    const next = applyRejection(pendingGate(), 'plan_brief is too vague');
    expect(next.status).toBe('rejected');
    expect(next.evidence_refs).toEqual([{ kind: 'note', summary: 'plan_brief is too vague' }]);
  });

  test('throws when the gate is not pending', () => {
    const gate = { ...pendingGate(), status: 'not_required' as const };
    expect(() => applyRejection(gate)).toThrow(/not pending/);
  });
});
