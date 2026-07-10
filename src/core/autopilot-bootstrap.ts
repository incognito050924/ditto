import type { Autopilot, AutopilotNode } from '~/schemas/autopilot';
import type { IntentContract } from '~/schemas/intent';
import type { WorkItem } from '~/schemas/work-item';
import { type NodeGenerator, defaultNodeGenerator, kindToOwner } from './autopilot-graph';
import { AutopilotStore } from './autopilot-store';
import { type RiskAxes, acceptanceTestable, highRiskAssumption } from './gates';
import { generateId } from './id';
import { WorkItemStore } from './work-item-store';

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
  /** Node generation seam (A-1); defaults to the 3-node seed when omitted. */
  generateNodes?: NodeGenerator;
  /**
   * E2E entry-phase opt-in (wi_260707loq ac-6). When true, seed a `main-session`
   * e2e-author node BETWEEN design and implement, so the single user dialogue that
   * authors the e2e journey runs at ENTRY — before the autonomous implement→verify
   * run, which then carries no main-session node and never yields `main_session`
   * mid-run. Omitted/false ⇒ no e2e-author node ⇒ the loop never yields main_session
   * ⇒ e2e is skipped (ac-6 skip clause).
   */
  e2eOptIn?: boolean;
}

/**
 * Splice a `main-session` e2e-author node BETWEEN the design node and everything
 * that followed it (wi_260707loq ac-6): design → e2e-author → (implement → …). The
 * e2e-author node depends on the design node, and every node that depended DIRECTLY
 * on design is re-pointed onto the e2e-author node instead — so the single entry
 * dialogue gates the autonomous run. Carries no acceptance_refs (it authors the
 * journey, it judges no criterion — the retro-node convention), keeping it out of
 * the completion per-AC scoring. Idempotent, and a no-op when the generator produced
 * no design anchor (a non-standard chain is left untouched).
 */
function seedE2eAuthorNode(nodes: AutopilotNode[]): AutopilotNode[] {
  const design = nodes.find((n) => n.kind === 'design');
  if (!design) return nodes;
  const e2eAuthorId = `${design.id}-e2e-author`;
  if (nodes.some((n) => n.id === e2eAuthorId)) return nodes;
  const e2eAuthor: AutopilotNode = {
    id: e2eAuthorId,
    kind: 'e2e-author',
    owner: kindToOwner('e2e-author'),
    purpose: 'Author the e2e journey with the user before implementation (entry-phase dialogue)',
    status: 'pending',
    depends_on: [design.id],
    acceptance_refs: [],
    evidence_refs: [],
    attempts: { fix: 0, switch: 0 },
  };
  const rewired = nodes.map((n) =>
    n.id !== design.id && n.depends_on.includes(design.id)
      ? { ...n, depends_on: n.depends_on.map((d) => (d === design.id ? e2eAuthorId : d)) }
      : n,
  );
  // Insert the e2e-author node right after the design node (positional clarity).
  return rewired.flatMap((n) => (n.id === design.id ? [n, e2eAuthor] : [n]));
}

/**
 * Splice a `test-author` node into the pre-approval slot BETWEEN the design→e2e-author
 * anchor and the implement it gates (wi_2607105qy N2). Ordering:
 * design → [e2e-author] → test-author → implement → verify. The authoring node depends
 * on whatever currently precedes implement (the e2e-author if `seedE2eAuthorNode` ran,
 * else design), and every node that depended DIRECTLY on that predecessor (the implement)
 * is re-pointed onto the authoring node — so authoring gates implement. Modeled on
 * `seedE2eAuthorNode`: carries acceptance_refs:[] (it authors, it judges no criterion),
 * idempotent, and a no-op when there is no design anchor.
 *
 * GATED on `hasDynamicTestOracle` (ac-5 degrade precondition): only a work item with ≥1
 * `dynamic_test`-oracle AC gets an authoring node — with no dynamic_test AC there is no
 * red test to author, so no node is seeded (design→implement chain unchanged).
 */
export function seedTestAuthorNode(
  nodes: AutopilotNode[],
  hasDynamicTestOracle: boolean,
): AutopilotNode[] {
  if (!hasDynamicTestOracle) return nodes;
  const design = nodes.find((n) => n.kind === 'design');
  if (!design) return nodes;
  const authorId = `${design.id}-test-author`;
  if (nodes.some((n) => n.id === authorId)) return nodes;
  // Slot AFTER the e2e-author if it was seeded (so order stays
  // design → e2e-author → test-author), else directly after design.
  const e2eAuthor = nodes.find((n) => n.kind === 'e2e-author');
  const predecessorId = e2eAuthor ? e2eAuthor.id : design.id;
  const author: AutopilotNode = {
    id: authorId,
    kind: 'test-author',
    owner: kindToOwner('test-author'),
    purpose:
      'Author the failing (red) unit/mock test for each dynamic_test AC before the approval gate opens',
    status: 'pending',
    depends_on: [predecessorId],
    acceptance_refs: [],
    evidence_refs: [],
    attempts: { fix: 0, switch: 0 },
  };
  const rewired = nodes.map((n) =>
    n.id !== predecessorId && n.id !== authorId && n.depends_on.includes(predecessorId)
      ? { ...n, depends_on: n.depends_on.map((d) => (d === predecessorId ? authorId : d)) }
      : n,
  );
  // Insert the authoring node right after its predecessor (positional clarity).
  return rewired.flatMap((n) => (n.id === predecessorId ? [n, author] : [n]));
}

/**
 * Seed the settled-tree TEST BARRIER (wi_260708ds9 ac-1) — the analogue of
 * `seedE2eAuthorNode`, applied UNCONDITIONALLY so every new graph gets a barrier
 * (its ABSENCE, not its presence, is the pre-barrier legacy grandfather signal the
 * completion seam reads). Mirrors the seed convention:
 *  - `acceptance_refs:[]` keeps it OUT of the per-AC deriveAcVerdicts fold (it judges
 *    no single criterion — it is a whole-suite barrier), like the retro/e2e-author node;
 *  - it depends on the IMPLEMENT FRONTIER (the implement nodes no other implement node
 *    depends on — the last implements), so isNodeReady tracks a real node, while the
 *    `selectReadyNodes` settled-tree HOLD does the actual "wait for every implement"
 *    gating. On planner expansion the seed implement is superseded, so recordResult
 *    RE-ATTACHES this barrier onto the promoted implement frontier (the retro analogue).
 * No-op when the generator produced no implement node (nothing to gate) or a barrier
 * already exists (idempotent).
 */
function seedTestBarrier(nodes: AutopilotNode[]): AutopilotNode[] {
  if (nodes.some((n) => n.kind === 'test')) return nodes;
  const implementIds = nodes.filter((n) => n.kind === 'implement').map((n) => n.id);
  if (implementIds.length === 0) return nodes;
  const frontier = implementIds.filter(
    (id) => !nodes.some((m) => m.kind === 'implement' && m.depends_on.includes(id)),
  );
  const barrier: AutopilotNode = {
    id: 'test-barrier',
    kind: 'test',
    owner: kindToOwner('test'),
    purpose:
      'Run the scope-local unit/mock test subset as a settled-tree barrier after the implement wave settles',
    status: 'pending',
    depends_on: frontier,
    acceptance_refs: [],
    evidence_refs: [],
    attempts: { fix: 0, switch: 0 },
  };
  return [...nodes, barrier];
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
    const t = acceptanceTestable({
      statement: ac.statement,
      evidence_required: ac.evidence_required ?? [],
    });
    if (!t.pass) reasons.push(`criterion ${ac.id} not testable: ${t.reasons.join('; ')}`);
  }
  if (reasons.length > 0) return { status: 'intent_not_ready', reasons };

  // Mirror the readied intent AC into the work item (false-green seam,
  // wi_260624xb8). Bootstrap is the chokepoint every entry path funnels through;
  // a draft work item may still hold placeholder AC from UserPromptSubmit while
  // intent.json carries the readied set. Without this sync, completion (which
  // reads AC from work-item.acceptance_criteria) silently evaluates fewer
  // criteria than intent declares and can emit a false `pass`. Same shape as the
  // canonical deep-interview finalize mirror (interview-driver.ts:432).
  await new WorkItemStore(repoRoot).update(input.workItem.id, (current) => ({
    ...current,
    // wi_2606287v9 (#5) ac-2 / n8-review F1: the in_progress transition is the
    // START of the heavy path. Promote a non-terminal, not-already-in_progress WI
    // to in_progress HERE — the chokepoint every entry path funnels through (CLI
    // `ditto autopilot bootstrap` AND the canonical `ditto deep-interview finalize`
    // → finalizeInterview). Promoting in core makes both entry points symmetric.
    // gh-free: the claim/gh reflection on this edge belongs to the CLI wrapper
    // (autopilot.ts / deep-interview.ts finalizeCmd), which fires the n6 claim edge
    // helper once it sees this promotion + a github_issue link.
    ...(current.status !== 'in_progress' &&
    current.status !== 'done' &&
    current.status !== 'abandoned'
      ? { status: 'in_progress' as const }
      : {}),
    acceptance_criteria: input.intent.acceptance_criteria.map((ac) => ({
      id: ac.id,
      statement: ac.statement,
      verdict: ac.verdict,
      evidence: ac.evidence,
    })),
  }));

  const store = new AutopilotStore(repoRoot);
  const autopilotId = await generateId('orch', async () => false, {
    ...(input.now ? { now: input.now } : {}),
  });
  // Build nodes from the *intent* AC (the readied set the gate validated), not
  // the work item AC (which may still hold draft placeholders from earlier
  // UserPromptSubmit). plan §4 M2.1b — gate ↔ score consistency.
  const acceptanceIds = input.intent.acceptance_criteria.map((c) => c.id);

  const seededNodes = (input.generateNodes ?? defaultNodeGenerator)(acceptanceIds);
  const withE2e = input.e2eOptIn ? seedE2eAuthorNode(seededNodes) : seededNodes;
  // Pre-approval red-test authoring stage (wi_2607105qy N2): seeded BETWEEN the
  // design/e2e-author anchor and implement, but ONLY when ≥1 in-play AC carries a
  // `dynamic_test` oracle (ac-5 degrade precondition — nothing to author otherwise).
  // Applied AFTER e2e-author so the order is design → e2e-author → test-author →
  // implement, and BEFORE the barrier so the barrier still anchors on the implement node.
  const hasDynamicTestOracle = input.intent.acceptance_criteria.some(
    (ac) => ac.oracle?.verification_method === 'dynamic_test',
  );
  const withAuthor = seedTestAuthorNode(withE2e, hasDynamicTestOracle);
  // Settled-tree test barrier (ac-1 part b): seeded unconditionally on the implement
  // frontier. Applied AFTER e2e-author (which sits between design and implement) so
  // the two seams never conflict — the barrier only anchors on implement nodes.
  const nodes = seedTestBarrier(withAuthor);

  const graph: Autopilot = {
    schema_version: '0.1.0',
    autopilot_id: autopilotId,
    work_item_id: input.workItem.id,
    mode: 'autopilot',
    root_goal: input.intent.goal,
    completion_boundary: 'entire_work_item',
    approval_gate: approvalGate(input),
    nodes,
    caps: { fix_per_node: 2, switch_per_node: 1, converge_rounds: 3 },
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
