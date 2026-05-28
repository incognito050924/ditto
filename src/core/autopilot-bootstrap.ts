import type { Autopilot } from '~/schemas/autopilot';
import type { IntentContract } from '~/schemas/intent';
import type { WorkItem } from '~/schemas/work-item';
import { buildInitialNodes } from './autopilot-graph';
import { AutopilotStore } from './autopilot-store';
import { type RiskAxes, acceptanceTestable, highRiskAssumption } from './gates';
import { generateId } from './id';

/**
 * Bootstrap the autopilot graph from a ready intent (M2.1b). This is the
 * *producer* of the initial graph and the approval status; the M2.2 driver only
 * consumes the graph it produces. Empty/ambiguous intent → no graph (route back
 * to interview, §6.3).
 */
export interface BootstrapInput {
  workItem: WorkItem;
  intent: IntentContract;
  /** Risk axes of the planned mutation; drives the approval decision. */
  risk: RiskAxes;
  /** Pre-approved input source (approved_spec/issue/prd/user), if any. */
  approvedSource?: 'approved_spec' | 'issue' | 'prd' | 'user';
  now?: Date;
}

export type BootstrapResult =
  | { status: 'created'; graph: Autopilot }
  | { status: 'intent_not_ready'; reasons: string[] }
  | { status: 'work_item_mismatch'; reasons: string[] };

function approvalGate(input: BootstrapInput): Autopilot['approval_gate'] {
  const base = { approved_at: null, approved_by: null, evidence_refs: [] as never[] };
  if (input.approvedSource) {
    return {
      ...base,
      status: 'approved',
      source: input.approvedSource,
      approved_at: input.approvedSource === 'user' ? (input.now ?? new Date()).toISOString() : null,
    };
  }
  // safeDefaultable(x) = ¬highRiskAssumption(x): high-risk needs approval, else not.
  if (highRiskAssumption(input.risk)) {
    return { ...base, status: 'pending', source: null };
  }
  return { ...base, status: 'not_required', source: 'small_reversible_policy' };
}

export async function bootstrapAutopilot(
  repoRoot: string,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  // Intent must belong to the same work item — otherwise the gate (intent AC
  // testability) and the score (graph nodes carrying those AC) would split
  // across two work items. Block before any state is written.
  if (input.intent.work_item_id !== input.workItem.id) {
    return {
      status: 'work_item_mismatch',
      reasons: [
        `intent.work_item_id=${input.intent.work_item_id} does not match workItem.id=${input.workItem.id}`,
      ],
    };
  }

  // Intent must be ready: at least one criterion, and none vague (§6.3 gate).
  const reasons: string[] = [];
  if (input.intent.acceptance_criteria.length === 0) {
    reasons.push('intent has no acceptance criteria');
  }
  for (const ac of input.intent.acceptance_criteria) {
    const t = acceptanceTestable({ statement: ac.statement });
    if (!t.pass) reasons.push(`criterion ${ac.id} not testable: ${t.reasons.join('; ')}`);
  }
  if (reasons.length > 0) return { status: 'intent_not_ready', reasons };

  const store = new AutopilotStore(repoRoot);
  const autopilotId = await generateId('orch', async () => false, {
    ...(input.now ? { now: input.now } : {}),
  });
  // Build nodes from the *intent* AC (the readied set the gate validated), not
  // the work item AC (which may still hold draft placeholders from earlier
  // UserPromptSubmit). plan §4 M2.1b — gate ↔ score consistency.
  const acceptanceIds = input.intent.acceptance_criteria.map((c) => c.id);

  const graph: Autopilot = {
    schema_version: '0.1.0',
    autopilot_id: autopilotId,
    work_item_id: input.workItem.id,
    mode: 'autopilot',
    root_goal: input.intent.goal,
    completion_boundary: 'entire_work_item',
    approval_gate: approvalGate(input),
    nodes: buildInitialNodes(acceptanceIds),
    caps: { fix_per_node: 2, switch_per_node: 1 },
    continue_policy: {
      continue_after_approval: true,
      continue_after_checkpoint: true,
      continue_after_fixable_failure: true,
      ask_user_only_for_user_owned_decisions: true,
    },
    stop_conditions: [
      'all_acceptance_criteria_passed_or_explicitly_closed',
      'blocked_by_user_owned_decision',
      'blocked_by_external_system',
      'safety_boundary_hit',
    ],
    user_interrupt_policy: 'ask_only_for_user_owned_decisions',
  };

  const written = await store.write(input.workItem.id, graph);
  return { status: 'created', graph: written };
}
