import type { Autopilot } from '~/schemas/autopilot';
import type { CompletionContract } from '~/schemas/completion-contract';
import type { Convergence } from '~/schemas/convergence';
import type { ClosureMode } from '~/schemas/convergence';
import type { IntentContract } from '~/schemas/intent';
import type { InterviewState } from '~/schemas/interview-state';
import type { WorkItem } from '~/schemas/work-item';
import { COVERAGE_AXIS_MECHANISMS } from './coverage-manager';

/**
 * Deterministic gates (M0.4). Pure functions, no LLM calls (D5: 결정론 1차).
 * Each gate takes already-recorded fields and returns PASS/FAIL with reasons.
 * Admissibility/testability *judgement* lives in the LLM layer (M3); these
 * gates only read what was written (plan §2 M0.4).
 */
export interface GateResult {
  pass: boolean;
  reasons: string[];
}

function gate(reasons: string[]): GateResult {
  return { pass: reasons.length === 0, reasons };
}

// ── deterministic ambiguity floor (ouroboros deterministic_floor) ───────────

export interface AmbiguitySnapshot {
  /** Open required (critical) dimensions still unresolved. */
  open_required_sections: number;
  /** Conflicting / contradictory signals in the ledger. */
  conflicting: number;
  /** Share of answers that are assumptions rather than user answers (0..1). */
  assumption_ratio: number;
}

export function deterministicFloor(s: AmbiguitySnapshot): number {
  const raw = 0.05 * s.open_required_sections + 0.1 * s.conflicting + 0.05 * s.assumption_ratio;
  return Math.min(1, Math.max(0, raw));
}

function ambiguityFromInterview(state: InterviewState): AmbiguitySnapshot {
  const open = state.dimensions.filter((d) => d.critical && d.state !== 'resolved').length;
  const asked = state.questions.length;
  const assumption_ratio =
    asked === 0 ? (state.assumptions.length > 0 ? 1 : 0) : state.assumptions.length / asked;
  return {
    open_required_sections: open,
    conflicting: 0,
    assumption_ratio: Math.min(1, assumption_ratio),
  };
}

// ── interview readiness gate (deep-interview §4.2: score ∧ critical-resolved) ─

export function interviewReadinessGate(state: InterviewState): GateResult {
  const reasons: string[] = [];
  const unresolved = state.dimensions
    .filter((d) => d.critical && d.state !== 'resolved')
    .map((d) => d.id);
  if (unresolved.length > 0) {
    reasons.push(`critical dimensions unresolved: ${unresolved.join(', ')}`);
  }
  // LLM self-reported readiness cannot escape the deterministic floor on ambiguity.
  const floor = deterministicFloor(ambiguityFromInterview(state));
  const capped = Math.min(state.readiness.score, 1 - floor);
  if (capped < state.readiness.threshold) {
    reasons.push(
      `readiness ${capped.toFixed(2)} (floor-capped) below threshold ${state.readiness.threshold}`,
    );
  }
  return gate(reasons);
}

// ── closure mode (ledger-primary §W1-2: HOW closure was reached) ────────────

/**
 * Classify HOW a closure was reached (distinct from exit.reason, which says
 * *why*). Depends on both the reason and whether the gate genuinely passed:
 * a cap/diminishing closure with the gate still blocked is `ledger_only` (the
 * deterministic floor/cap forced it), but the same reason with a passing gate
 * is `mutual_agreement` (the cap merely coincided with genuine readiness).
 */
export function deriveClosureMode(
  reason: InterviewState['exit']['reason'] | Convergence['exit']['reason'],
  gatePassed: boolean,
): ClosureMode {
  switch (reason) {
    case 'readiness_met':
    case 'converged':
      return 'mutual_agreement';
    case 'cap_reached':
    case 'diminishing_returns':
      return gatePassed ? 'mutual_agreement' : 'ledger_only';
    case 'user_deferred':
    case 'user_owned_decision':
    case 'blocked':
      return 'safe_default';
  }
}

// ── acceptance criterion testability (VAGUE_TERMS + observable predicate) ────

const VAGUE_TERMS = [
  'robust',
  'fast',
  'faster',
  'secure',
  'user-friendly',
  'user friendly',
  'better',
  'improve',
  'improved',
  'properly',
  'correctly',
  'efficient',
  'efficiently',
  'intuitive',
  'seamless',
  'optimal',
  'scalable',
  'flexible',
  'nice',
];

// English predicates are word-bounded (\b); the \d digit branch is the
// language-neutral measurable signal. The Korean alternation matches verb stems
// (no \b — Korean is not an ASCII \w sequence) so conjugations (한다/된다/하면 …) hit.
const OBSERVABLE =
  /\b(returns?|rejects?|responds?|displays?|shows?|exits?|equals?|matches?|contains?|within|less than|greater than|at most|at least|status|code)\b|\d|반환|거부|응답|표시|노출|종료|같음|일치|포함|통과|실패|생성|갱신|호출/i;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function acceptanceTestable(ac: { statement: string }): GateResult {
  const reasons: string[] = [];
  const lower = ac.statement.toLowerCase();
  // Word-boundary match: 'breakfast' must not hit 'fast', 'improvement' must not
  // hit 'improve'. Multi-word phrases ('user friendly') keep \b around the whole.
  const vague = VAGUE_TERMS.filter((t) => new RegExp(`\\b${escapeRegex(t)}\\b`).test(lower));
  if (vague.length > 0) reasons.push(`vague term(s): ${[...new Set(vague)].join(', ')}`);
  if (!OBSERVABLE.test(ac.statement)) reasons.push('no observable/measurable predicate found');
  return gate(reasons);
}

// ── resolvability classifier (default-DENY over declared unverified labels) ──

/** One unverified entry as declared in the completion contract (resolvability/grounding are optional, additive). */
export type UnverifiedItem = CompletionContract['unverified'][number];

/** Class of a blocking unverified item, used by the Stop hook to render the reason. */
export type ResolvabilityKind = 'agent_resolvable' | 'blocked_external' | 'user_decision';

export interface ResolvabilityBlocker {
  /** The declared `item` text (what was not verified). */
  item: string;
  /** Why this item blocks a pass-close. */
  reason: string;
  /** Which class blocks; `user_decision` is a surface to defer, not a defect. */
  kind: ResolvabilityKind;
  /** True only for the user-decision surface (caller labels it deferred_needs_user_ok). */
  userDecision: boolean;
}

/** A grounding ref is satisfied only by a present, non-empty string. */
function isGrounded(u: UnverifiedItem): boolean {
  return typeof u.grounding === 'string' && u.grounding.trim().length > 0;
}

/** Whole-token AC-id reference in the item/reason text (structural, not free-text verb mining). */
function referencesAcceptanceId(u: UnverifiedItem, acceptanceIds: readonly string[]): boolean {
  const haystack = `${u.item} ${u.reason}`;
  return acceptanceIds.some((id) =>
    new RegExp(`(?<![\\w-])${escapeRegex(id)}(?![\\w-])`).test(haystack),
  );
}

/**
 * Pure classifier (deterministic-floor): given the ALREADY-DECLARED `unverified`
 * list and the work item's acceptance criterion ids, return the items that must
 * BLOCK a pass-close and why. It reads ONLY the passed-in list — no filesystem,
 * no code scanning (it classifies declared labels + structural signals; it does
 * not judge prose quality). Default-DENY: a labeled / AC-referencing item blocks
 * unless it is a grounded genuine residual. Rules:
 *  - `agent_resolvable` → ALWAYS blocks (the agent declared it resolvable; parking
 *    it is the anti-pattern). grounding does NOT excuse it.
 *  - `blocked_external` | `accepted_tradeoff` → block UNLESS `grounding` present
 *    (default-deny on ungrounded residual claims).
 *  - `user_decision` → blocks UNLESS `grounding` present (a recorded decision
 *    pointer = the decision was made); when it blocks it is flagged a USER-DECISION
 *    surface (`userDecision: true`) so the caller can label it deferred_needs_user_ok.
 *  - AC-referencing item (item/reason names one of `acceptanceIds`, whole-token) →
 *    treated as `agent_resolvable` (blocks) unless grounded, because it blocks a
 *    criterion the work owns. Structural id match, not keyword mining.
 *  - resolvability ABSENT and no AC reference (legacy/unlabeled) → does NOT block;
 *    such items stay governed by the existing out_of_scope rule (additive, no
 *    double-messaging the in-scope-unverified gate).
 */
export function resolvabilityBlockers(
  unverified: readonly UnverifiedItem[],
  acceptanceIds: readonly string[],
): ResolvabilityBlocker[] {
  const blockers: ResolvabilityBlocker[] = [];
  for (const u of unverified) {
    const grounded = isGrounded(u);
    // Structural AC-blocking signal: an unlabeled (or any) item naming an owned
    // criterion is treated as agent_resolvable — it blocks a criterion the work owns.
    const acRef = referencesAcceptanceId(u, acceptanceIds);

    if (u.resolvability === 'agent_resolvable' || (acRef && u.resolvability === undefined)) {
      if (grounded && u.resolvability !== 'agent_resolvable') continue; // AC-ref residual may be grounded
      blockers.push({
        item: u.item,
        reason:
          u.resolvability === 'agent_resolvable'
            ? 'declared agent_resolvable but parked (resolve it, do not park)'
            : 'references an owned acceptance criterion but is unverified',
        kind: 'agent_resolvable',
        userDecision: false,
      });
      continue;
    }

    if (u.resolvability === 'blocked_external' || u.resolvability === 'accepted_tradeoff') {
      if (grounded) continue;
      blockers.push({
        item: u.item,
        reason: `declared ${u.resolvability} without grounding (ungrounded residual claim)`,
        kind: 'blocked_external',
        userDecision: false,
      });
      continue;
    }

    if (u.resolvability === 'user_decision') {
      if (grounded) continue;
      blockers.push({
        item: u.item,
        reason: 'declared user_decision without a recorded decision pointer (surface for user ok)',
        kind: 'user_decision',
        userDecision: true,
      });
    }
    // resolvability absent and no AC reference → legacy/unlabeled; not blocked here.
  }
  return blockers;
}

// ── completion gate (cross-checks completion against the work item) ─────────

export function completionGate(item: WorkItem, completion: CompletionContract): GateResult {
  const reasons: string[] = [];
  // The AC-set cross-check (duplicate/missing/extra) applies to EVERY completion,
  // not just pass ones (V5). The charter requires each AC to carry a per-AC
  // verdict regardless of the overall verdict; a non-pass completion that simply
  // omits criteria would otherwise slip through here (Stop then sees a present
  // completion and stops treating it as a no-verification-path). The pass-only
  // `notPass` check below stays gated on pass — a non-pass completion is *expected*
  // to carry not-pass criteria.
  const expected = item.acceptance_criteria.map((c) => c.id);
  const expectedSet = new Set(expected);
  const reported = completion.acceptance.map((a) => a.criterion_id);
  const reportedSet = new Set(reported);

  // duplicate (count-based, not Set-based — Set comparison hides duplicates)
  if (reported.length !== reportedSet.size) {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const id of reported) {
      if (seen.has(id)) dupes.add(id);
      seen.add(id);
    }
    reasons.push(`duplicate criterion_id(s): ${[...dupes].join(', ')}`);
  }
  const missing = expected.filter((id) => !reportedSet.has(id));
  if (missing.length > 0) reasons.push(`missing criteria: ${missing.join(', ')}`);
  const extra = [...reportedSet].filter((id) => !expectedSet.has(id));
  if (extra.length > 0) reasons.push(`extra criteria not in work item: ${extra.join(', ')}`);

  if (completion.final_verdict === 'pass') {
    const notPass = completion.acceptance
      .filter((a) => a.verdict !== 'pass')
      .map((a) => a.criterion_id);
    if (notPass.length > 0) {
      reasons.push(`final_verdict=pass but not-pass criteria: ${[...new Set(notPass)].join(', ')}`);
    }
  }
  return gate(reasons);
}

// ── completion evidence gate (G8: ack/approval ≠ verification) ──────────────

/**
 * A `final_verdict=pass` must be backed by *some* runnable verification, not a
 * light acknowledgement ("approved", "ok", "looks good"). The schema accepts a
 * pass whose only per-criterion evidence is a `note` and whose `verifications`
 * are empty — that is the ack≠verification failure mode. This gate rejects it:
 * a passing completion needs at least one executed command (`verifications`) or
 * at least one non-`note` evidence / evidence_record on some criterion. It does
 * not judge per-criterion evidence *depth* (the verifier's job) — only that the
 * pass is not resting on an ack alone.
 */
export function completionEvidenceGate(completion: CompletionContract): GateResult {
  if (completion.final_verdict !== 'pass') return gate([]);
  const ranCommand = completion.verifications.length > 0;
  const hasRealCriterionEvidence = completion.acceptance.some(
    (a) => a.evidence.some((e) => e.kind !== 'note') || a.evidence_records.length > 0,
  );
  if (!ranCommand && !hasRealCriterionEvidence) {
    return gate([
      'final_verdict=pass with no runnable verification evidence (ack/approval is not verification)',
    ]);
  }
  return gate([]);
}

// ── convergence gate (reads recorded fields only; no admissibility inference) ─

export function convergenceGate(c: Convergence): GateResult {
  const reasons: string[] = [];

  const maxScore = Math.max(...c.versions.map((v) => v.score));
  const selected = c.versions.find((v) => v.version === c.selected_version);
  if (!selected) {
    reasons.push(`selected_version ${c.selected_version} not present in versions`);
  } else if (selected.score !== maxScore) {
    reasons.push(`selected_version is not argmax (selected ${selected.score} < max ${maxScore})`);
  }

  const openComputed = c.decision_ledger.filter(
    (e) => e.admissible && e.status === 'deferred',
  ).length;
  if (c.open_admissible_count !== openComputed) {
    reasons.push(
      `open_admissible_count recorded ${c.open_admissible_count} != computed ${openComputed}`,
    );
  }

  const expectedConverged = c.gate.completion_gate === 'pass' && openComputed === 0;
  if (c.gate.converged !== expectedConverged) {
    reasons.push(
      `gate.converged recorded ${c.gate.converged} != expected ${expectedConverged} (completion ∧ no-open-admissible)`,
    );
  }
  if (!expectedConverged) {
    reasons.push('not converged: completion_gate != pass or open admissible objections remain');
  }
  return gate(reasons);
}

// ── high-risk assumption / safe-default (§8-4: two sides of one predicate) ──

/**
 * Input-only risk judgment consumed by `highRiskAssumption` / `safeDefaultable`
 * and, at the producing boundary, by `finalizePayload.risk` in interview-driver
 * to drive the approval gate in bootstrapAutopilot. These axes are NOT persisted
 * to any artifact (intent.json / work-item.json / autopilot.json carry no such
 * field), so there is no persisted schema to validate. Verifiability of these
 * booleans is therefore enforced at the producing boundary (the finalize payload
 * and planner), not by a stored schema's superRefine.
 */
export interface RiskAxes {
  non_local: boolean;
  irreversible: boolean;
  unaudited: boolean;
}

export function highRiskAssumption(a: RiskAxes): boolean {
  return a.non_local || a.irreversible || a.unaudited;
}

export function safeDefaultable(a: RiskAxes): boolean {
  return !highRiskAssumption(a);
}

// ── knowledge-update trigger gate (durable-change recording: under ∧ over) ───

/**
 * The three triggers that make a change worth durable knowledge (axis-4). A
 * curator declares which fired this work item; the gate then checks the produced
 * record matches. This turns "valuable durable change" from pure curator
 * heuristic into an explicit, checkable surface.
 */
export interface KnowledgeTriggers {
  /** A durable decision worth an ADR (carries rationale + change condition). */
  adr_worthy_decision: boolean;
  /** A new ubiquitous-language term agreed with the user this work item. */
  new_agreed_term: boolean;
  /** A reusable pattern or a repeated learning seen again. */
  repeated_pattern: boolean;
}

/** Counts the curator declares it recorded this update (per-update delta). */
export interface KnowledgeRecordDelta {
  decisions: number;
  glossary_terms: number;
  patterns: number;
  learnings: number;
}

export function knowledgeTriggerFired(t: KnowledgeTriggers): boolean {
  return t.adr_worthy_decision || t.new_agreed_term || t.repeated_pattern;
}

/**
 * Gate the durable-knowledge recording against the three triggers, cutting BOTH
 * failure modes the axis-4 gap names:
 *  - under-recording (놓침): a declared trigger with no matching record content;
 *  - over-recording (노이즈): record content with no trigger declared.
 * A no-trigger work item that records nothing is the valid, EXPLICIT skip — the
 * gate passes (recording nothing is correct), it just must be a real no-trigger,
 * not silent omission while a trigger fired. The per-trigger→content mapping:
 * decision→decisions, term→glossary_terms, pattern→patterns∪learnings.
 */
export function knowledgeUpdateGate(t: KnowledgeTriggers, d: KnowledgeRecordDelta): GateResult {
  const reasons: string[] = [];
  const recorded = d.decisions + d.glossary_terms + d.patterns + d.learnings;
  if (!knowledgeTriggerFired(t) && recorded > 0) {
    reasons.push('durable content recorded but no trigger declared (over-recording: noise)');
  }
  if (t.adr_worthy_decision && d.decisions === 0) {
    reasons.push(
      'adr_worthy_decision trigger fired but no decision/ADR recorded (under-recording)',
    );
  }
  if (t.new_agreed_term && d.glossary_terms === 0) {
    reasons.push('new_agreed_term trigger fired but no glossary term added (under-recording)');
  }
  if (t.repeated_pattern && d.patterns + d.learnings === 0) {
    reasons.push(
      'repeated_pattern trigger fired but no pattern/learning recorded (under-recording)',
    );
  }
  return gate(reasons);
}

// ── decision-conflict routing gate (ADR-contradiction guardrail) ─────────────

/**
 * A single detected conflict between the work in flight and a recorded decision
 * (an ADR). WHETHER a conflict exists and its `(kind, level)` is the LLM layer's
 * judgement (host-delegated, ADR-0001) over the retrieved ADR gist; this gate is
 * the pure routing + transparency policy over already-classified conflicts.
 */
export interface DecisionConflict {
  /** The decision in conflict, e.g. `ADR-0006`. */
  adr_id: string;
  /** Constraint kind: a hard prohibition/requirement vs a soft preference. */
  kind: 'forbid' | 'require' | 'prefer';
  /**
   * Whether the conflict touches the work item's INTENT (its goal/AC — only the
   * user can resolve, since the request itself wants what the ADR forbids) or just
   * a candidate METHOD (an implementation path the agent can re-route by following
   * the ADR autonomously).
   */
  level: 'intent' | 'method';
  /**
   * The evidence for the conflict: what the ADR says and how the current work
   * touches it. Carried through to the disposition so the disclosure OUTPUT can
   * show WHY a decision was made — the transparency invariant requires the basis of
   * any ADR-considering autonomous judgement to appear in the user-facing output,
   * not just a log.
   */
  basis: string;
}

/** How a single conflict is handled. Every conflict is disclosed regardless of route. */
export type ConflictRoute =
  | 'align' // method conflict: follow the ADR autonomously, proceed
  | 'justify' // prefer conflict: record a justification, proceed
  | 'ask_user' // intent conflict, user present: confirm before mutating
  | 'block'; // intent conflict, autopilot: fail-closed, report at the Stop boundary

export interface ConflictDisposition {
  conflict: DecisionConflict;
  route: ConflictRoute;
}

export interface DecisionConflictResult {
  dispositions: ConflictDisposition[];
  /** A conflict that fails the run closed (an intent conflict under autopilot). */
  blocked: boolean;
  /** A conflict that needs user confirmation before mutating (intent, interactive). */
  needsApproval: boolean;
  /**
   * Transparency invariant: every detected conflict must be surfaced to the user in
   * the OUTPUT, even an auto-aligned method conflict the agent resolved without
   * asking. True whenever at least one conflict was detected — silent autonomous
   * compliance is a violation; the disclosure CONTENT is `dispositions` (each
   * carrying its `basis`).
   */
  disclose: boolean;
}

/**
 * Route each detected ADR conflict by `(kind, level, mode)` and decide whether the
 * run is blocked or needs approval. Pure and deterministic (D5: 결정론 1차) — it does
 * not judge whether a conflict exists, only what to do once one is classified.
 *
 * Routing:
 *  - prefer (any level)      → justify   (soft: record a reason, never blocks)
 *  - forbid/require · method → align     (follow the ADR autonomously)
 *  - forbid/require · intent → ask_user  (interactive) | block (autopilot, fail-closed)
 *
 * Transparency: `disclose` is true whenever any conflict was detected — the user is
 * always told, even for auto-aligned method conflicts (no silent compliance).
 */
export function decisionConflictGate(
  conflicts: DecisionConflict[],
  mode: 'interactive' | 'autopilot',
): DecisionConflictResult {
  const dispositions = conflicts.map((conflict): ConflictDisposition => {
    if (conflict.kind === 'prefer') return { conflict, route: 'justify' };
    if (conflict.level === 'method') return { conflict, route: 'align' };
    return { conflict, route: mode === 'autopilot' ? 'block' : 'ask_user' };
  });
  return {
    dispositions,
    blocked: dispositions.some((d) => d.route === 'block'),
    needsApproval: dispositions.some((d) => d.route === 'ask_user'),
    disclose: conflicts.length > 0,
  };
}

/**
 * Does any declared conflict require user approval BEFORE mutating work runs? An
 * `intent`-level hard conflict (forbid/require) does — the request itself wants
 * what an ADR forbids, so only the user can resolve it (align / supersede / drop).
 * A `method` conflict (re-routed by following the ADR) and a `prefer` conflict
 * (justified, never blocks) do not gate approval. This is the deterministic input
 * that front-loads an intent conflict to the autopilot approval gate (ADR-0020 D3),
 * so mutating nodes do not run before the user resolves it — the prevention layer
 * paired with the Stop-hook fail-closed catch.
 */
export function decisionConflictRequiresApproval(conflicts: DecisionConflict[]): boolean {
  return conflicts.some((c) => c.kind !== 'prefer' && c.level === 'intent');
}

// ── intent-conservation gate (axis-2 intent drift across the contract chain) ──

/**
 * The intent-bearing contracts a work item threads, frozen `intent` first. At
 * `finalizeInterview` time these are written *consistently from one payload*
 * (intent.goal === workItem.goal, workItem.AC === intent.AC, autopilot.root_goal
 * === intent.goal, nodes built from intent AC ids) — so the chain is conserved by
 * construction at birth. Drift is *post-finalize* divergence: the planner appends
 * nodes over waves, work-item.json can be edited, completion is assembled later.
 * `completion` is optional — it does not exist mid-run (the H3 hop is skipped).
 */
export interface IntentChainArtifacts {
  intent: IntentContract;
  workItem: WorkItem;
  graph: Autopilot;
  completion?: CompletionContract;
}

/**
 * intentDriftGate's result splits two severities the dialectic review (ACG fit)
 * established as belonging on opposite sides of ACG's deterministic→block /
 * judgment→warn boundary (practice-ingestion-map §spec-drift):
 *  - `reasons` (blocking, `pass=false`): AC id-set conservation — grow/shrink/
 *    invented refs. An id appearing or vanishing is a deterministic correctness
 *    fact, so it hard-blocks, exactly like the other deterministic gates.
 *  - `advisories` (non-blocking, never flips `pass`): goal / source_request /
 *    root_goal *string* divergence. Whether a reworded goal is genuine drift or a
 *    legitimate re-statement is a semantic judgment ACG assigns to human/LLM
 *    review — so it is surfaced (not silently dropped) but does not block a
 *    legitimate re-finalize from closing. The user sees it and decides.
 */
export interface IntentDriftResult extends GateResult {
  advisories: string[];
}

function idSet(items: { id: string }[]): Set<string> {
  return new Set(items.map((i) => i.id));
}

/** Members of `a` not in `b`, stable order. */
function missingFrom(a: Iterable<string>, b: Set<string>): string[] {
  return [...a].filter((x) => !b.has(x));
}

/**
 * Detect intent drift by checking conservation of the two intent-bearing keys —
 * the goal string and the acceptance-criterion id set — hop by hop along the
 * contract chain, against the frozen `intent`. This is the axis-2 internal check
 * the four-axis reassessment (§1 축2 gap) names: "장시간·대규모에서 본래 목적을
 * 잃지 않음" operationalized as a deterministic tripwire that fires at the hop
 * where divergence is introduced, the moment it is introduced.
 *
 * It is DETERMINISTIC (ids + string identity, never free-text semantics), so it
 * is distinct from and complementary to the reviewer's code-level regression and
 * the verifier's per-AC evidence judgment (the LLM "semantic ceiling"). Whether a
 * node's prose `purpose` actually serves an AC's *meaning*, or whether an impl
 * semantically wandered into `intent.out_of_scope`, is NOT checkable here and
 * stays with reviewer/verifier.
 *
 * Severity split (see `IntentDriftResult`): AC id-set conservation → `reasons`
 * (blocking); goal/source_request/root_goal string divergence → `advisories`
 * (non-blocking, surfaced for the user to judge).
 *
 * Hops (reasons/advisories carry stable markers H1/H2/H3 for callers/tests):
 *  - H1 intent → work-item: AC id-set equality [block] + goal/source_request
 *    string identity [advisory]. An added id is scope grow; a dropped id is
 *    scope shrink (the two physical copies are the most-missed seam). AC
 *    *statements* may be refined freely; only ids are conserved.
 *  - H2 intent → autopilot: no-shrink (every intent AC id covered by ≥1 node
 *    acceptance_refs) + no-grow (every node acceptance_refs id ∈ intent AC id
 *    set) [block]; root_goal === intent.goal [advisory].
 *  - H3 intent → completion: criterion_id set === intent AC id set [block], but
 *    ONLY when `final_verdict !== 'pass'` — on a pass `completionGate` already
 *    cross-checks completion vs work-item ids, so gating here too would
 *    double-emit (dialectic P3). On a non-pass `completionGate` is silent, so H3
 *    is the only check that a partial/blocked completion still names every
 *    criterion.
 */
export function intentDriftGate(a: IntentChainArtifacts): IntentDriftResult {
  const reasons: string[] = [];
  const advisories: string[] = [];
  const intentGoal = a.intent.goal.trim();
  const intentAcIds = idSet(a.intent.acceptance_criteria);

  // ── H1 intent → work-item ──
  if (a.workItem.goal.trim() !== intentGoal) {
    advisories.push(
      'H1: work-item goal diverges from intent goal (re-statement or drift — review)',
    );
  }
  if (a.workItem.source_request.trim() !== a.intent.source_request.trim()) {
    advisories.push('H1: work-item source_request diverges from intent (review)');
  }
  const wiAcIds = idSet(a.workItem.acceptance_criteria);
  const wiAdded = missingFrom(wiAcIds, intentAcIds);
  if (wiAdded.length > 0) {
    reasons.push(`H1: work-item AC id(s) not in intent (scope grow): ${wiAdded.join(', ')}`);
  }
  const wiDropped = missingFrom(intentAcIds, wiAcIds);
  if (wiDropped.length > 0) {
    reasons.push(
      `H1: intent AC id(s) missing from work-item (scope shrink): ${wiDropped.join(', ')}`,
    );
  }

  // ── H2 intent → autopilot ──
  if (a.graph.root_goal.trim() !== intentGoal) {
    advisories.push(
      'H2: autopilot root_goal diverges from intent goal (re-statement or drift — review)',
    );
  }
  const covered = new Set<string>();
  for (const node of a.graph.nodes) {
    for (const ref of node.acceptance_refs) covered.add(ref);
  }
  const uncovered = missingFrom(intentAcIds, covered);
  if (uncovered.length > 0) {
    reasons.push(
      `H2: intent AC id(s) addressed by no node (scope shrink): ${uncovered.join(', ')}`,
    );
  }
  const invented = missingFrom(covered, intentAcIds);
  if (invented.length > 0) {
    reasons.push(
      `H2: node acceptance_refs id(s) not in intent (scope grow): ${invented.join(', ')}`,
    );
  }

  // ── H3 intent → completion (only on a non-pass completion; pass-case owned by
  // completionGate to avoid double-emission) ──
  if (a.completion && a.completion.final_verdict !== 'pass') {
    const compIds = new Set(a.completion.acceptance.map((c) => c.criterion_id));
    const compAdded = missingFrom(compIds, intentAcIds);
    if (compAdded.length > 0) {
      reasons.push(
        `H3: completion criterion_id(s) not in intent (scope grow): ${compAdded.join(', ')}`,
      );
    }
    const compDropped = missingFrom(intentAcIds, compIds);
    if (compDropped.length > 0) {
      reasons.push(
        `H3: intent AC id(s) missing from completion (scope shrink): ${compDropped.join(', ')}`,
      );
    }
  }

  return { ...gate(reasons), advisories };
}

// ── interface/scope baseline drift gate (axis-2 temporal: frozen plan baseline) ─

/**
 * Drift ENFORCEMENT against the frozen temporal baseline the pre-mortem coverage
 * engine produces (premortem-coverage-contract §2 시간정합, contract §2 l.62). The
 * engine only PRODUCES the baseline (`approval_gate.change_surface` set by
 * `producePlanGate`) and DETECTS divergence; the reviewer/verifier stage is where
 * that baseline is consumed to flag an unconsented interface/scope change. This
 * gate is that consumer: it compares the CURRENT change surface against the FROZEN
 * baseline and blocks when they diverge (an added surface = unconsented scope grow,
 * a removed surface = scope shrink).
 *
 * It REUSES the temporal axis mechanism (`COVERAGE_AXIS_MECHANISMS.temporal.enforce`)
 * for the set/length divergence decision rather than reimplementing it — the gate
 * is the same set-equality the engine froze, now wired to enforcement. When no
 * baseline was frozen (no brief regime) the gate is a no-op pass: there is nothing
 * to drift from. Set semantics (membership + length), so order does not matter and
 * a duplicate would change length (a real surface mutation).
 */
export function interfaceBaselineDriftGate(
  baseline: readonly string[] | undefined,
  current: readonly string[],
): GateResult {
  // No frozen baseline ⇒ brief regime inactive for this graph ⇒ nothing to enforce.
  if (baseline === undefined) return gate([]);
  const conserved = COVERAGE_AXIS_MECHANISMS.temporal.enforce(baseline, current);
  if (conserved) return gate([]);
  const frozen = new Set(baseline);
  const added = current.filter((c) => !frozen.has(c));
  const removed = baseline.filter((b) => !current.includes(b));
  const reasons: string[] = [];
  if (added.length > 0) {
    reasons.push(
      `interface/scope added vs frozen baseline (unconsented grow): ${added.join(', ')}`,
    );
  }
  if (removed.length > 0) {
    reasons.push(
      `interface/scope removed vs frozen baseline (unconsented shrink): ${removed.join(', ')}`,
    );
  }
  return gate(reasons);
}
