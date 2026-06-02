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
  switch (graph.approval_gate.status) {
    case 'approved':
    case 'not_required':
      return { allowed: true, action: 'proceed', reason: `approval=${graph.approval_gate.status}` };
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
