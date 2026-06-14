import type { Autopilot, AutopilotNode } from '~/schemas/autopilot';
import { nodeTransition } from './autopilot-graph';

/**
 * Driver-support glue for the autopilot loop: approval-gate consumption (M2.3),
 * in-flight rollback on rejection (M2.3b), and terminal-state detection for the
 * continuation loop (M2.5).
 */

// ── M2.3: consume an already-set approval status (does not compute risk) ────

export interface MutationGate {
  allowed: boolean;
  action: 'proceed' | 'present_plan' | 'blocked';
  reason: string;
}

export function mutationGate(graph: Autopilot): MutationGate {
  const gate = graph.approval_gate;
  // Brief hard-gate (pre-mortem coverage engine §7.2). The brief regime is active
  // when `change_surface` is set (a non-light plan whose mutation must be gated on
  // an approved brief). When active, a user-approved gate (`approved`) additionally
  // requires the brief itself to be present — an absent brief under `approved` is a
  // false-green (the plan was approved but no brief was produced), so we return
  // pending to block, not proceed. `not_required` is the §8.2 light small-reversible
  // auto-waiver: it proceeds without requiring brief approval. A legacy graph (no
  // change_surface) skips this entirely and keeps status-only behavior, preserving
  // backward compatibility.
  const briefRegimeActive = gate.change_surface !== undefined;
  // ac-6 (wi_260614z7r) + LOW2 (wi_2606144ta) — close the change_surface escape-hatch,
  // narrowed to an UN-authorized approval. A passed design node with an absent
  // change_surface means producePlanGate did not run on it (coverage-manager §7.2
  // ALWAYS sets change_surface on a brief-producing design pass). Whether that is a
  // bypass depends on the authorizer: an explicit human/spec source took
  // responsibility for mutating without a brief (manual/small-graph approval) →
  // proceed; an approval with NO recorded source is the suspicious case → block.
  // The brief flow never sets `source` (autopilot-loop only copies status/
  // change_surface/plan_brief), so an explicit `source` can only come from a real
  // approval path. A PENDING design node (brief stage not yet run) stays the legacy
  // status-only path, so legacy graphs and pre-brief seeds do not regress.
  const designPassed = (graph.nodes ?? []).some(
    (n) => n.kind === 'design' && n.status === 'passed',
  );
  if (designPassed && !briefRegimeActive && gate.status === 'approved' && gate.source === null) {
    return {
      allowed: false,
      action: 'present_plan',
      reason:
        'design passed, change_surface absent, and approval has no authorizer (source=null): produce the brief before mutating',
    };
  }
  if (briefRegimeActive && gate.status === 'approved' && gate.plan_brief === undefined) {
    return {
      allowed: false,
      action: 'present_plan',
      reason: 'plan approved but plan_brief is absent: produce the brief before mutating',
    };
  }
  switch (gate.status) {
    case 'approved':
    case 'not_required':
      return { allowed: true, action: 'proceed', reason: `approval=${gate.status}` };
    case 'pending':
      return {
        allowed: false,
        action: 'present_plan',
        reason: 'approval pending: present the plan and stop before mutating',
      };
    case 'rejected':
      return { allowed: false, action: 'blocked', reason: 'plan was rejected' };
  }
}

// ── M2.3b: denied plan → rollback in-flight nodes (G3) ──────────────────────

export interface RollbackResult {
  nodes: AutopilotNode[];
  stopped: true;
  reason: string;
}

/**
 * When a plan is rejected, undo speculative progress: roll every in-flight
 * (`running`) node back to `pending` via the explicit transition table, leaving
 * terminal (`passed`) work intact, and stop. Re-planning then starts from a
 * clean graph rather than on top of half-run, now-invalid nodes. Precondition:
 * `approval_gate.status === 'rejected'` — calling it otherwise is a bug, so it
 * throws rather than silently no-op.
 */
export function rollbackOnRejection(graph: Autopilot): RollbackResult {
  if (graph.approval_gate.status !== 'rejected') {
    throw new Error(
      `rollbackOnRejection requires approval_gate.status='rejected', got '${graph.approval_gate.status}'`,
    );
  }
  const nodes = graph.nodes.map((n) =>
    n.status === 'running' ? { ...n, status: nodeTransition('running', 'rollback') } : n,
  );
  return { nodes, stopped: true, reason: 'plan rejected: rolled back in-flight nodes' };
}

// ── M2.5: automatic continuation between nodes ──────────────────────────────

/** All nodes are terminal (passed/failed) — nothing left to run. */
export function allNodesTerminal(graph: Autopilot): boolean {
  return graph.nodes.every((n) => n.status === 'passed' || n.status === 'failed');
}
