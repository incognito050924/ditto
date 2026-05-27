import type { Autopilot, AutopilotNode } from '~/schemas/autopilot';
import type { WorkItem } from '~/schemas/work-item';

/**
 * Node dispatch + failure classification (M2.4). The 6-section delegation packet
 * is what the orchestrator sends to an owner subagent. Context Isolation: the
 * packet carries the task and scope, never the driver's hypotheses or other
 * nodes' internal state.
 */
export interface DelegationPacket {
  task: string;
  expected_outcome: string;
  required_tools: string[];
  must_do: string[];
  must_not_do: string[];
  context: {
    work_item_id: string;
    file_scope: string[];
    done_when: string;
    acceptance_refs: string[];
  };
}

const OWNER_TOOLS: Record<AutopilotNode['owner'], string[]> = {
  researcher: ['Read', 'Grep', 'Glob', 'Bash', 'WebSearch', 'WebFetch'],
  planner: ['Read', 'Grep', 'Glob'],
  implementer: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
  reviewer: ['Read', 'Grep', 'Glob', 'Bash'],
  verifier: ['Read', 'Grep', 'Glob', 'Bash'],
  architect: ['Read', 'Grep', 'Glob'],
  'playwright-e2e': ['Read', 'Grep', 'Glob', 'Bash'],
  'knowledge-curator': ['Read', 'Grep', 'Glob', 'Write'],
};

export function buildDelegationPacket(node: AutopilotNode, workItem: WorkItem): DelegationPacket {
  const doneWhen =
    node.acceptance_refs.length > 0
      ? `acceptance criteria satisfied with evidence: ${node.acceptance_refs.join(', ')}`
      : node.purpose;
  return {
    task: node.purpose,
    expected_outcome: doneWhen,
    required_tools: OWNER_TOOLS[node.owner],
    must_do: [
      'Work only from this packet.',
      'Return a single result with evidence (command + exit code, file:line).',
      `Stop when done_when is met: ${doneWhen}.`,
    ],
    must_not_do: [
      "Do not assume the orchestrator's hypotheses or other nodes' internal state (Context Isolation).",
      'Do not grow or shrink the goal scope; no unrequested refactors or extra features.',
      ...(node.owner === 'implementer' ? [] : ['Do not mutate files (read-only role).']),
    ],
    context: {
      work_item_id: workItem.id,
      file_scope: workItem.changed_files,
      done_when: doneWhen,
      acceptance_refs: node.acceptance_refs,
    },
  };
}

export type FailureClass =
  | 'fixable'
  | 'wrong_approach'
  | 'blocked_external'
  | 'user_decision_needed';

export type FailureDecision = 'retry' | 'switch_approach' | 'escalate' | 'continue';

/**
 * Deterministic failure-decision policy (the *classification* is a judgment made
 * upstream; this maps a class + attempts + caps to an action). retry/switch are
 * automatic within caps; escalate/user-decision go to the user. Hitting a cap is
 * non-pass (≠ converged), surfaced via `cap_exceeded`.
 */
export function decideOnFailure(
  failureClass: FailureClass,
  attempts: AutopilotNode['attempts'],
  caps: Autopilot['caps'],
): { decision: FailureDecision; cap_exceeded: boolean } {
  switch (failureClass) {
    case 'fixable':
      return attempts.fix < caps.fix_per_node
        ? { decision: 'retry', cap_exceeded: false }
        : { decision: 'escalate', cap_exceeded: true };
    case 'wrong_approach':
      return attempts.switch < caps.switch_per_node
        ? { decision: 'switch_approach', cap_exceeded: false }
        : { decision: 'escalate', cap_exceeded: true };
    case 'blocked_external':
    case 'user_decision_needed':
      return { decision: 'escalate', cap_exceeded: false };
  }
}
