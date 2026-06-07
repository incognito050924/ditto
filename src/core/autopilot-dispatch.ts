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
  // Variant routing: deterministically filtered specialized-subagent candidates
  // (role + file_scope match). The driver picks a `subagent_type` from these
  // instead of the fixed owner; [] means no variant catalog applied.
  variant_candidates: { name: string; description: string }[];
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
  // [VERIFY] lifecycle owners (§2.2). security-reviewer/retrospective are read-only
  // analysis (run checks, no mutation); refactorer mutates code (Tidy First) so it
  // carries Edit/Write — which is also what marks it approval-gated (isMutatingOwner).
  'security-reviewer': ['Read', 'Grep', 'Glob', 'Bash'],
  refactorer: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
  retrospective: ['Read', 'Grep', 'Glob', 'Bash'],
  // The driver pseudo-owner is never spawned (nextNode intercepts it), so it has
  // no LLM toolset. Its irreversible git work is gated by a dedicated explicit
  // approval gate in autopilot-cleanup, not the Edit-derived mutation gate.
  driver: [],
};

/**
 * An owner mutates the workspace iff its toolset grants Edit. Deriving the
 * mutating signal from the one toolset table keeps the approval gate and the
 * packet's tools from ever drifting apart (gate ↔ tools consistency): adding a
 * mutating owner is a single edit here, not two lists to keep in sync.
 */
export function isMutatingOwner(owner: AutopilotNode['owner']): boolean {
  return OWNER_TOOLS[owner].includes('Edit');
}

// Planner-intelligence contract (계약 우선 · §2.4): a planner node is the graph
// generator, so its packet *requests* a `generated_nodes` lifecycle subgraph.
// DITTO supplies the deterministic request + the validation floor (addNodes /
// validateNodeAddition on splice); the LLM planner supplies which §2.2 stages the
// task needs. The acceptance side is already wired (A-3 recordResult promotion).
const PLANNER_GENERATE_DIRECTIVE =
  'Emit a `generated_nodes` subgraph: pick the §2.2 lifecycle stages this task ' +
  'actually needs (research·design·implement·review·verify·…), each node ' +
  '{id, kind, purpose, depends_on, acceptance_refs} mapped to its acceptance ' +
  'criteria; scale to task size (small tasks stay minimal — do not force a stage).';

export function buildDelegationPacket(
  node: AutopilotNode,
  workItem: WorkItem,
  variantCandidates: { name: string; description: string }[] = [],
  // The actual dispatch scope for this node (V2). Defaults to the shared
  // work-item changed_files so existing callers are unchanged, but the
  // orchestrator passes `scopeOf(node)` (node.file_scope ?? changed_files) so the
  // packet the subagent receives matches the active-node lease PreToolUse
  // enforces — otherwise a node that declares its own file_scope gets a packet
  // scoped to a different (often empty) file set.
  fileScope: string[] = workItem.changed_files,
): DelegationPacket {
  const isPlanner = node.owner === 'planner';
  const doneWhen =
    node.acceptance_refs.length > 0
      ? `acceptance criteria satisfied with evidence: ${node.acceptance_refs.join(', ')}`
      : node.purpose;
  // A planner closes on a generated subgraph, not just prose; surface it in the
  // expected outcome so done_when reflects the graph-generation responsibility.
  const expectedOutcome = isPlanner
    ? `${doneWhen} (return the plan as a generated_nodes subgraph)`
    : doneWhen;
  return {
    task: node.purpose,
    expected_outcome: expectedOutcome,
    required_tools: OWNER_TOOLS[node.owner],
    must_do: [
      'Work only from this packet.',
      'Return a single result with evidence (command + exit code, file:line).',
      ...(isPlanner ? [PLANNER_GENERATE_DIRECTIVE] : []),
      `Stop when done_when is met: ${doneWhen}.`,
    ],
    must_not_do: [
      "Do not assume the orchestrator's hypotheses or other nodes' internal state (Context Isolation).",
      'Do not grow or shrink the goal scope; no unrequested refactors or extra features.',
      ...(isMutatingOwner(node.owner) ? [] : ['Do not mutate files (read-only role).']),
    ],
    context: {
      work_item_id: workItem.id,
      file_scope: fileScope,
      done_when: doneWhen,
      acceptance_refs: node.acceptance_refs,
    },
    variant_candidates: variantCandidates,
  };
}

export type FailureClass =
  | 'fixable'
  | 'wrong_approach'
  | 'blocked_external'
  | 'user_decision_needed';

/**
 * Guard a child subagent's returned result before it can be counted as PASS
 * (G7: a completion *signal* is not completion *proof*). A native Task returns
 * the subagent's final text synchronously, but that text can be empty or a bare
 * acknowledgement ("done") carrying no evidence of the work. Such a result is
 * non-contentful and must be treated as inconclusive — routed back through the
 * failure pipeline as `fixable` (respawn, typically smaller), never as PASS.
 *
 * This is a deterministic floor on the orchestrator's collect step; it does not
 * judge evidence *depth* (that is the verifier's job) — only that there is
 * something to judge at all.
 */
export type ChildResultGuard =
  | { contentful: true }
  | { contentful: false; failure_class: 'fixable'; reason: string };

// The whole trimmed message is one short acknowledgement token — a claim of
// completion with no accompanying work or evidence.
const ACK_ONLY =
  /^(done|ok|okay|complete|completed|finished|fixed|pass|passed|success|succeeded|yes|ack|acknowledged|✓|✅|👍)[\s.!]*$/i;

export function guardChildResult(text: string): ChildResultGuard {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { contentful: false, failure_class: 'fixable', reason: 'empty child result' };
  }
  if (ACK_ONLY.test(trimmed)) {
    return {
      contentful: false,
      failure_class: 'fixable',
      reason: `ack-only child result ("${trimmed}") — acknowledgement is not evidence`,
    };
  }
  return { contentful: true };
}

/**
 * G7 floor 확장 (wi_260606h9q): a mutating node (implementer/refactorer) that
 * claims `pass` must carry actual change evidence — at least one `changed_files`
 * entry. A mutation that touched zero files is a completion *claim* with no
 * *proof* (prime directive), which is exactly the shape a spawn-skipping or
 * fabricated result takes. Force it back through the failure pipeline as fixable.
 *
 * This does NOT verify that a Task subagent actually ran (that is a main-agent
 * behaviour the harness owns and code cannot observe) — it only refuses to let a
 * mutating node close as pass with no file-change evidence at all.
 */
export function guardMutatingEvidence(
  owner: AutopilotNode['owner'],
  outcome: 'pass' | 'fail',
  changedFiles: string[],
): ChildResultGuard {
  if (outcome === 'pass' && isMutatingOwner(owner) && changedFiles.length === 0) {
    return {
      contentful: false,
      failure_class: 'fixable',
      reason: `mutating node (${owner}) claimed pass with no changed_files — a mutation with zero file changes is not evidence of work (claim ≠ proof)`,
    };
  }
  return { contentful: true };
}

export type FailureDecision = 'retry' | 'switch_approach' | 'escalate';

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
