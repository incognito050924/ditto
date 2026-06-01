import { z } from 'zod';
import type { AutopilotNode } from '~/schemas/autopilot';
import { evidenceRef } from '~/schemas/common';
import {
  type DelegationPacket,
  type FailureClass,
  type FailureDecision,
  buildDelegationPacket,
  decideOnFailure,
  guardChildResult,
} from './autopilot-dispatch';
import { allNodesTerminal, mutationGate, rollbackOnRejection } from './autopilot-driver';
import { fileOverlapGate, nodeTransition, selectReadyNodes } from './autopilot-graph';
import { AutopilotStore } from './autopilot-store';
import { WorkItemStore } from './work-item-store';

/**
 * Autopilot loop step glue (G9) — surfaces the deterministic per-round steps of
 * the orchestrator loop so the `autopilot` skill calls them through the CLI
 * instead of re-describing the logic in prose. `nextNode` = loop steps 1–5
 * (re-read → approval → select → dispatch → packet); `recordResult` = step 6
 * (collect → G7 guard → classify → decide → persist). The *judgment* (pass/fail,
 * fixable vs wrong_approach, when to escalate) stays with the caller and arrives
 * as the `recordResult` payload; this module only enforces the deterministic
 * floor (charter §3.1: judgment in the agent, state in the schema).
 *
 * A node mutates files only when its owner is the implementer; every other owner
 * is read-only, so the approval gate blocks only a mutating node (contract §5.3 —
 * design/research may run before approval). A rejected plan invalidates the whole
 * graph and rolls back in-flight work regardless of which node is next.
 */
function isMutatingNode(node: AutopilotNode): boolean {
  return node.owner === 'implementer';
}

export type NextNodeResult =
  | { action: 'spawn'; node_id: string; owner: AutopilotNode['owner']; packet: DelegationPacket }
  | { action: 'present_plan'; reason: string }
  | { action: 'rollback'; reason: string; rolled_back_node_ids: string[] }
  | { action: 'waiting'; reason: string }
  | { action: 'done'; reason: string };

export async function nextNode(repoRoot: string, workItemId: string): Promise<NextNodeResult> {
  const aps = new AutopilotStore(repoRoot);
  const graph = await aps.get(workItemId);

  // A rejected plan invalidates everything: undo speculative (running) work and
  // stop. Idempotent — a second call finds no running nodes and rolls back none.
  if (graph.approval_gate.status === 'rejected') {
    const rb = rollbackOnRejection(graph);
    const rolledBack = graph.nodes.filter((n) => n.status === 'running').map((n) => n.id);
    await aps.write(workItemId, { ...graph, nodes: rb.nodes });
    return { action: 'rollback', reason: rb.reason, rolled_back_node_ids: rolledBack };
  }

  // Select the next dispatchable node (first ready, after the file-overlap gate
  // serializes any same-scope wave). v0 runs one owner at a time.
  const ready = selectReadyNodes(graph.nodes);
  if (ready.length === 0) {
    return allNodesTerminal(graph)
      ? { action: 'done', reason: 'all nodes terminal (passed/failed)' }
      : {
          action: 'waiting',
          reason: 'no ready node: dependencies unmet or a node is still running',
        };
  }
  const workItem = await new WorkItemStore(repoRoot).get(workItemId);
  const { dispatch } = fileOverlapGate(
    ready.map((n) => ({ id: n.id, file_scope: workItem.changed_files })),
  );
  const chosen = ready.find((n) => n.id === dispatch[0]?.id);
  if (!chosen) {
    return { action: 'waiting', reason: 'all ready nodes deferred by the file-overlap gate' };
  }

  // Approval gate applies only before a mutating node (contract §5.3).
  if (isMutatingNode(chosen)) {
    const gate = mutationGate(graph);
    if (!gate.allowed) return { action: 'present_plan', reason: gate.reason };
  }

  // Dispatch: pending → running through the explicit transition table, persisted.
  await aps.updateNode(workItemId, chosen.id, (n) => ({
    ...n,
    status: nodeTransition(n.status, 'dispatch'),
  }));
  return {
    action: 'spawn',
    node_id: chosen.id,
    owner: chosen.owner,
    packet: buildDelegationPacket(chosen, workItem),
  };
}

export const recordResultPayload = z
  .object({
    node_id: z.string().min(1),
    result_text: z.string().describe("The owner subagent's full final text (fed to the G7 guard)"),
    outcome: z
      .enum(['pass', 'fail'])
      .describe('Caller judgment; pass is overridden if non-contentful'),
    failure_class: z
      .enum(['fixable', 'wrong_approach', 'blocked_external', 'user_decision_needed'])
      .optional()
      .describe('Required when outcome=fail; the caller-supplied classification'),
    evidence_refs: z.array(evidenceRef).optional().describe('Evidence pointers gathered on pass'),
    reason: z.string().optional().describe('2–3 line rationale recorded in the decision log'),
  })
  .superRefine((value, ctx) => {
    if (value.outcome === 'fail' && value.failure_class === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failure_class'],
        message: 'failure_class is required when outcome=fail',
      });
    }
  })
  .describe('One node result — caller judgment that the deterministic floor then enforces');

export type RecordResultPayload = z.infer<typeof recordResultPayload>;

export interface RecordResultInput {
  workItemId: string;
  payload: RecordResultPayload;
  now?: Date;
}

export interface RecordResultOutcome {
  node_id: string;
  status: AutopilotNode['status'];
  outcome: 'pass' | 'fail';
  /** false when the G7 guard overrode a claimed pass (empty/ack-only result). */
  guard_contentful: boolean;
  decision: FailureDecision | null;
  failure_class: FailureClass | null;
  cap_exceeded: boolean;
  reason: string;
}

export async function recordResult(
  repoRoot: string,
  input: RecordResultInput,
): Promise<RecordResultOutcome> {
  const aps = new AutopilotStore(repoRoot);
  const graph = await aps.get(input.workItemId);
  const node = graph.nodes.find((n) => n.id === input.payload.node_id);
  if (!node) {
    throw new Error(
      `node ${input.payload.node_id} not found in autopilot graph for ${input.workItemId}`,
    );
  }
  if (node.status !== 'running') {
    throw new Error(
      `node ${node.id} is not running (status=${node.status}); call next-node first to dispatch it`,
    );
  }

  // G7 floor: a completion *signal* is not completion *proof*. An empty or
  // ack-only result is non-contentful and is forced to a fixable failure even if
  // the caller claimed pass — acknowledgement is not evidence.
  const guard = guardChildResult(input.payload.result_text);
  const contentful = guard.contentful;

  // Effective outcome/class after the guard override.
  let outcome: 'pass' | 'fail' = input.payload.outcome;
  let failureClass: FailureClass | undefined = input.payload.failure_class;
  let guardReason = input.payload.reason ?? '';
  if (!guard.contentful) {
    outcome = 'fail';
    failureClass = 'fixable';
    guardReason = guard.reason;
  }

  if (outcome === 'pass') {
    await aps.updateNode(input.workItemId, node.id, (n) => ({
      ...n,
      status: nodeTransition(n.status, 'pass'),
      evidence_refs: input.payload.evidence_refs ?? n.evidence_refs,
    }));
    return {
      node_id: node.id,
      status: 'passed',
      outcome: 'pass',
      guard_contentful: true,
      decision: null,
      failure_class: null,
      cap_exceeded: false,
      reason: guardReason,
    };
  }

  // outcome === 'fail': map the (caller-supplied or guard-forced) class through
  // the deterministic decision policy.
  const klass = failureClass as FailureClass;
  // attempts are incremented for the consumed retry/switch before evaluating the
  // cap so the log reflects the attempt just spent.
  const { decision, cap_exceeded } = decideOnFailure(klass, node.attempts, graph.caps);

  let event: 'retry' | 'block' | 'fail';
  let attempts = node.attempts;
  switch (decision) {
    case 'retry':
      event = 'retry';
      attempts = { ...node.attempts, fix: node.attempts.fix + 1 };
      break;
    case 'switch_approach':
      event = 'retry';
      attempts = { ...node.attempts, switch: node.attempts.switch + 1 };
      break;
    default: // escalate (and the unreachable 'continue')
      event = cap_exceeded ? 'fail' : 'block';
      break;
  }

  const nextStatus = nodeTransition(node.status, event);
  await aps.updateNode(input.workItemId, node.id, (n) => ({
    ...n,
    status: nodeTransition(n.status, event),
    attempts,
  }));
  await aps.appendDecision(input.workItemId, {
    ts: (input.now ?? new Date()).toISOString(),
    node_id: node.id,
    failure_class: klass,
    decision,
    reason: guardReason || `${klass} → ${decision}`,
    attempts,
  });

  return {
    node_id: node.id,
    status: nextStatus,
    outcome: 'fail',
    guard_contentful: contentful,
    decision,
    failure_class: klass,
    cap_exceeded,
    reason: guardReason,
  };
}
