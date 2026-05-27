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

/** A node is runnable/ready when it is pending and every dependency has passed. */
export function isNodeReady(node: AutopilotNode, byId: Map<string, AutopilotNode>): boolean {
  if (node.status !== 'pending') return false;
  return node.depends_on.every((dep) => byId.get(dep)?.status === 'passed');
}

/**
 * Select the next ready node to run (autopilot loop step 2). Returns the first
 * ready node in graph order, or null when none is runnable right now.
 */
export function selectReadyNode(nodes: AutopilotNode[]): AutopilotNode | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return nodes.find((n) => isNodeReady(n, byId)) ?? null;
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
