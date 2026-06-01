import type { Autopilot, AutopilotNode } from '~/schemas/autopilot';
import { nodeTransition, selectReadyNode } from './autopilot-graph';

/**
 * Driver-support glue for the autopilot loop: approval-gate consumption (M2.3),
 * automatic continuation between nodes (M2.5), and the handoff/re-entry signal
 * raised on context pressure or cap (M2.5 — signal only; artifact creation is M4).
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

/**
 * After a node passes, the next ready node (deps satisfied) is selected without
 * user intervention. Returns null when none is runnable (done, blocked, or
 * waiting). An internal checkpoint passing is never a final answer.
 */
export function nextReadyNodeId(graph: Autopilot): string | null {
  return selectReadyNode(graph.nodes)?.id ?? null;
}

// ── M2.5: handoff / re-entry signal (no artifact yet; that is M4) ───────────

export interface ContinuationSignal {
  handoff_required: boolean;
  re_entry_required: boolean;
  /** Resume target keeps the SAME autopilot_id; scope is never narrowed. */
  resume: { autopilot_id: string; work_item_id: string };
  reason: string;
}

export function buildContinuationSignal(graph: Autopilot, reason: string): ContinuationSignal {
  return {
    handoff_required: true,
    re_entry_required: true,
    resume: { autopilot_id: graph.autopilot_id, work_item_id: graph.work_item_id },
    reason,
  };
}
