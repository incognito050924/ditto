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
  // only when `change_surface` is set (a non-light plan whose mutation must be
  // gated on an approved brief). When active, a user-approved gate (`approved`)
  // additionally requires the brief itself to be present — an absent brief under
  // `approved` is a false-green (the plan was approved but no brief was produced),
  // so we return pending to block, not proceed. `not_required` is the §8.2 light
  // small-reversible auto-waiver: it proceeds without requiring brief approval.
  // A legacy graph (no change_surface) skips this entirely and keeps status-only
  // behavior, preserving backward compatibility.
  const briefRegimeActive = gate.change_surface !== undefined;
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
