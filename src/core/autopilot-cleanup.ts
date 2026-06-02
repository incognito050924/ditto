import type { AutopilotNode } from '~/schemas/autopilot';
import { nodeTransition } from './autopilot-graph';
import { AutopilotStore } from './autopilot-store';
import { listRunWorktrees, removeRunWorktree } from './worktree';

type EvidenceRef = AutopilotNode['evidence_refs'][number];

/**
 * `cleanup` is the last [VERIFY] lifecycle stage (contract §2.2), wired to the
 * `driver` pseudo-owner: it is deterministic git/worktree teardown, so the engine
 * runs it in-process instead of spawning an LLM owner. The one thing DITTO itself
 * creates and never reclaims is the per-run git worktree (`createWorktreeForRun`),
 * so v0 cleanup tears those down. Worktree removal is irreversible git work, so it
 * is gated by an EXPLICIT approval — the small-reversible auto-waiver
 * (`approval_gate.status === 'not_required'`) is deliberately NOT sufficient.
 */
export interface CleanupPlan {
  /** Repo-relative paths of the per-run worktrees a run would tear down. */
  worktrees: string[];
}

export function planCleanup(repoRoot: string): CleanupPlan {
  return { worktrees: listRunWorktrees(repoRoot) };
}

/**
 * Irreversible git work needs explicit authorization. Only an operator-supplied
 * approval (`--approve`) or an explicitly `approved` plan gate clears it; a
 * `not_required` waiver (small reversible policy) does NOT — worktree teardown is
 * not the kind of small reversible change that policy covers.
 */
export function cleanupApprovalGate(
  approvalStatus: string,
  explicitApprove: boolean,
): { allowed: boolean; reason: string } {
  if (explicitApprove) return { allowed: true, reason: 'operator --approve' };
  if (approvalStatus === 'approved') return { allowed: true, reason: 'approval_gate=approved' };
  return {
    allowed: false,
    reason: `irreversible git (worktree removal) needs explicit approval; approval_gate=${approvalStatus} (the small-reversible waiver does not cover it)`,
  };
}

export interface RunCleanupInput {
  workItemId: string;
  nodeId: string;
  /** Operator authorization for the irreversible git step (the explicit gate). */
  approve?: boolean;
  now?: Date;
}

export type CleanupOutcome =
  | {
      status: 'passed';
      node_id: string;
      plan: string[];
      removed: string[];
      skipped: { path: string; reason: string }[];
    }
  | { status: 'blocked'; node_id: string; plan: string[]; reason: string };

/**
 * Run the deterministic cleanup step for one `cleanup` node: plan the teardown,
 * clear the explicit irreversible-git gate, then remove each run worktree (never
 * forced — git refuses dirty worktrees, which are surfaced as skipped rather than
 * destroyed). Passes the node with the teardown as evidence, or blocks it (logging
 * a user-owned decision) when the gate is not cleared and there is work to do.
 */
export async function runCleanup(
  repoRoot: string,
  input: RunCleanupInput,
): Promise<CleanupOutcome> {
  const aps = new AutopilotStore(repoRoot);
  const graph = await aps.get(input.workItemId);
  const node = graph.nodes.find((n) => n.id === input.nodeId);
  if (!node) {
    throw new Error(`node ${input.nodeId} not found in autopilot graph for ${input.workItemId}`);
  }
  if (node.kind !== 'cleanup') {
    throw new Error(`node ${node.id} is kind=${node.kind}, not cleanup`);
  }
  if (node.status === 'passed') {
    throw new Error(`cleanup node ${node.id} already passed`);
  }

  const plan = planCleanup(repoRoot);
  const gate = cleanupApprovalGate(graph.approval_gate.status, input.approve ?? false);

  // Move to running once (pending/blocked/failed → running); a node already
  // running stays put. This mirrors the dispatch the spawn path does for owners.
  if (node.status !== 'running') {
    await aps.updateNode(input.workItemId, node.id, (n) => ({
      ...n,
      status: nodeTransition(n.status, 'dispatch'),
    }));
  }

  // Gate only bites when there is irreversible work to do — an empty plan is a
  // no-op that closes cleanly regardless of approval (nothing to authorize).
  if (plan.worktrees.length > 0 && !gate.allowed) {
    await aps.updateNode(input.workItemId, node.id, (n) => ({
      ...n,
      status: nodeTransition('running', 'block'),
    }));
    await aps.appendDecision(input.workItemId, {
      ts: (input.now ?? new Date()).toISOString(),
      node_id: node.id,
      failure_class: 'user_decision_needed',
      decision: 'escalate',
      reason: gate.reason,
      attempts: node.attempts,
    });
    return { status: 'blocked', node_id: node.id, plan: plan.worktrees, reason: gate.reason };
  }

  const removed: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const wt of plan.worktrees) {
    try {
      removeRunWorktree(repoRoot, wt);
      removed.push(wt);
    } catch (err) {
      skipped.push({ path: wt, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const evidence: EvidenceRef[] = removed.map((wt) => ({
    kind: 'command' as const,
    command: `git worktree remove ${wt}`,
    summary: 'run worktree torn down',
  }));
  const skippedNote = skipped.length > 0 ? `; ${skipped.length} skipped (dirty/locked)` : '';
  const note =
    plan.worktrees.length === 0
      ? 'no run worktrees to clean'
      : `removed ${removed.length}/${plan.worktrees.length} run worktree(s)${skippedNote}`;
  evidence.push({ kind: 'note' as const, summary: note });

  await aps.updateNode(input.workItemId, node.id, (n) => ({
    ...n,
    status: nodeTransition('running', 'pass'),
    evidence_refs: evidence,
  }));
  return { status: 'passed', node_id: node.id, plan: plan.worktrees, removed, skipped };
}
