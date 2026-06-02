import type { AutopilotNode } from '~/schemas/autopilot';

/**
 * kind → owner mapping (autopilot §2.2). The node kind names the activity; the
 * owner names the subagent role that runs it. Kept as a total map so an unknown
 * kind fails loudly rather than silently picking a default.
 */
const KIND_TO_OWNER: Record<AutopilotNode['kind'], AutopilotNode['owner']> = {
  research: 'researcher',
  design: 'planner',
  implement: 'implementer',
  review: 'reviewer',
  verify: 'verifier',
  fix: 'implementer',
  e2e: 'playwright-e2e',
  docs: 'implementer',
  knowledge: 'knowledge-curator',
};

export function kindToOwner(kind: AutopilotNode['kind']): AutopilotNode['owner'] {
  return KIND_TO_OWNER[kind];
}

/**
 * Explicit node transition table (W4-1 / G3). The node lifecycle is no longer an
 * implicit set of rules scattered across the driver: every legal status change
 * is an (status × event) → status entry here, and an event with no entry for the
 * current status is an illegal transition that fails loudly. `rollback` undoes a
 * speculative dispatch (running/failed → pending) — used when a plan is rejected.
 */
export type NodeEvent = 'dispatch' | 'pass' | 'fail' | 'block' | 'rollback' | 'retry';

const NODE_TRANSITIONS: Record<
  AutopilotNode['status'],
  Partial<Record<NodeEvent, AutopilotNode['status']>>
> = {
  // `retry` re-arms a running node to pending so the pending-only selector
  // (`selectReadyNodes`) re-picks it next round — a retryable/switch failure is
  // not terminal. Terminal failure (cap exceeded) uses `fail` → failed.
  pending: { dispatch: 'running', block: 'blocked' },
  running: {
    pass: 'passed',
    fail: 'failed',
    block: 'blocked',
    rollback: 'pending',
    retry: 'pending',
  },
  failed: { dispatch: 'running', rollback: 'pending' }, // retry re-dispatches
  blocked: { dispatch: 'running' }, // unblocked → re-dispatch
  passed: {}, // terminal within a run
};

export function nodeTransition(
  from: AutopilotNode['status'],
  event: NodeEvent,
): AutopilotNode['status'] {
  const to = NODE_TRANSITIONS[from][event];
  if (!to) throw new Error(`illegal node transition: ${from} --${event}-->`);
  return to;
}

/** A node is runnable/ready when it is pending and every dependency has passed. */
export function isNodeReady(node: AutopilotNode, byId: Map<string, AutopilotNode>): boolean {
  if (node.status !== 'pending') return false;
  return node.depends_on.every((dep) => byId.get(dep)?.status === 'passed');
}

/**
 * All ready nodes (the candidate concurrent wave), not just the first. The
 * orchestrator runs one owner at a time in v0, but a wave of independent ready
 * nodes must still pass the file-overlap gate before any are dispatched together.
 */
export function selectReadyNodes(nodes: AutopilotNode[]): AutopilotNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return nodes.filter((n) => isNodeReady(n, byId));
}

/**
 * file-overlap serialization gate (W4-1). Two owners that write the same file
 * must not run concurrently or they clobber each other. Greedily admit nodes
 * whose `file_scope` is disjoint from every already-admitted node's scope;
 * defer (serialize) the rest to a later wave. Deterministic in input order.
 * A node with an empty scope (read-only) claims nothing and is never deferred.
 */
export interface ScopedNode {
  id: string;
  file_scope: string[];
}

export function fileOverlapGate<T extends ScopedNode>(
  wave: T[],
): {
  dispatch: T[];
  serialized: T[];
} {
  const claimed = new Set<string>();
  const dispatch: T[] = [];
  const serialized: T[] = [];
  for (const node of wave) {
    const overlaps = node.file_scope.some((f) => claimed.has(f));
    if (overlaps) {
      serialized.push(node);
    } else {
      dispatch.push(node);
      for (const f of node.file_scope) claimed.add(f);
    }
  }
  return { dispatch, serialized };
}

/**
 * Minimal initial node chain for a ready intent: design (plan) → implement →
 * verify. The verify node carries every acceptance criterion as its refs so the
 * graph terminates only when all criteria are addressed.
 */
export function buildInitialNodes(acceptanceIds: string[]): AutopilotNode[] {
  const mk = (
    id: string,
    kind: AutopilotNode['kind'],
    purpose: string,
    depends_on: string[],
    acceptance_refs: string[],
  ): AutopilotNode => ({
    id,
    kind,
    owner: kindToOwner(kind),
    purpose,
    status: 'pending',
    depends_on,
    acceptance_refs,
    evidence_refs: [],
    attempts: { fix: 0, switch: 0 },
  });

  return [
    mk('N1', 'design', 'Plan the change against the acceptance criteria', [], acceptanceIds),
    mk('N2', 'implement', 'Implement the planned change', ['N1'], acceptanceIds),
    mk('N3', 'verify', 'Verify every acceptance criterion with evidence', ['N2'], acceptanceIds),
  ];
}

/**
 * Node generation seam (A-1). The bootstrap no longer hardcodes a node literal;
 * it calls a `NodeGenerator`. The default keeps the current 3-node seed so the
 * observable autopilot behavior is unchanged — the seam only removes the
 * structural ceiling (no way to grow the graph), not the default shape.
 */
export type NodeGenerator = (acceptanceIds: string[]) => AutopilotNode[];
export const defaultNodeGenerator: NodeGenerator = buildInitialNodes;

/**
 * Integrity gate for a node-add (A-1). Pure, no I/O — `addNodes` calls this
 * before any write. Throws on a duplicate id (against the existing graph or
 * within the batch), a dangling `depends_on` reference, or a `depends_on` edge
 * that introduces a cycle. Error messages carry stable markers so callers/tests
 * can assert on them: `duplicate node id` / `dangling depends_on` / `cycle`.
 */
export function validateNodeAddition(existing: AutopilotNode[], newNodes: AutopilotNode[]): void {
  const seen = new Set<string>();
  for (const node of existing) seen.add(node.id);
  for (const node of newNodes) {
    if (seen.has(node.id)) throw new Error(`duplicate node id: ${node.id}`);
    seen.add(node.id);
  }

  const merged = [...existing, ...newNodes];
  const byId = new Map(merged.map((n) => [n.id, n]));
  for (const node of newNodes) {
    for (const dep of node.depends_on) {
      if (!byId.has(dep)) {
        throw new Error(`dangling depends_on: node ${node.id} references unknown ${dep}`);
      }
    }
  }

  // Cycle detection over the merged depends_on edges (DFS with a recursion
  // stack). The pre-existing graph is acyclic by construction, but a new edge
  // can close a loop, so we check the whole merged graph.
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): void => {
    const status = state.get(id);
    if (status === 'done') return;
    if (status === 'visiting') throw new Error(`cycle introduced over depends_on at node ${id}`);
    state.set(id, 'visiting');
    for (const dep of byId.get(id)?.depends_on ?? []) visit(dep);
    state.set(id, 'done');
  };
  for (const node of merged) visit(node.id);
}
