import type { Autopilot } from '~/schemas/autopilot';

/**
 * Pure approval-gate transitions for the `ditto autopilot approve/reject` CLI
 * (wi_260615xby A). These only WRITE the gate fields the schema already defines;
 * the autopilot loop core is untouched. The CLI persists the result through
 * `AutopilotStore.updateApprovalGate` so the mutation stays schema-validated and
 * atomic (§6.5). approve/reject are valid only from `pending` — a gate that is
 * already approved/rejected/not_required has nothing to act on, so the caller
 * gets a clear error instead of a silent no-op.
 */
export type ApprovalGate = Autopilot['approval_gate'];
export type ApprovalSourceValue = NonNullable<ApprovalGate['source']>;

export interface ApproveInput {
  /** Recorded as approved_by; defaults to 'user' for a manual CLI approval. */
  by?: string;
  /** Where the approval comes from; defaults to 'user' (a human ran the CLI). */
  source?: ApprovalSourceValue;
  now?: Date;
}

function requirePending(gate: ApprovalGate, action: string): void {
  if (gate.status !== 'pending') {
    throw new Error(`approval gate is not pending (current: ${gate.status}); nothing to ${action}`);
  }
}

export function applyApproval(gate: ApprovalGate, input: ApproveInput = {}): ApprovalGate {
  requirePending(gate, 'approve');
  return {
    ...gate,
    status: 'approved',
    source: input.source ?? 'user',
    approved_at: (input.now ?? new Date()).toISOString(),
    approved_by: input.by ?? 'user',
  };
}

export function applyRejection(gate: ApprovalGate, reason?: string): ApprovalGate {
  requirePending(gate, 'reject');
  const evidence_refs = reason
    ? [...gate.evidence_refs, { kind: 'note' as const, summary: reason }]
    : gate.evidence_refs;
  return { ...gate, status: 'rejected', evidence_refs };
}
