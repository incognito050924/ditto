import type { z } from 'zod';
import type { Autopilot } from '~/schemas/autopilot';
import type { evidenceRef, verdict, workItemStatus } from '~/schemas/common';
import type { CompletionContract } from '~/schemas/completion-contract';
import type { Convergence } from '~/schemas/convergence';
import type { ClosureMode } from '~/schemas/convergence';
import type { DirectionForkCarrier } from '~/schemas/direction-fork-carrier';
import type { IntentContract } from '~/schemas/intent';
import type { InterviewState } from '~/schemas/interview-state';
import type { AcOracle, WorkItem } from '~/schemas/work-item';
import { COVERAGE_AXIS_MECHANISMS } from './coverage-manager';

type EvidenceRef = z.infer<typeof evidenceRef>;
type Verdict = z.infer<typeof verdict>;
type WorkItemStatus = z.infer<typeof workItemStatus>;

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
  /\b(returns?|rejects?|responds?|displays?|shows?|exits?|equals?|matches?|contains?|within|less than|greater than|at most|at least|status|code)\b|\d|반환|거부|응답|표시|노출|종료|같음|일치|포함|통과|실패|생성|갱신|호출|강등|재현|무효화|필터|정렬|병합|집계|분할|렌더|차단/i;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function acceptanceTestable(ac: {
  statement: string;
  evidence_required?: string[];
}): GateResult {
  const reasons: string[] = [];
  const lower = ac.statement.toLowerCase();
  // Word-boundary match: 'breakfast' must not hit 'fast', 'improvement' must not
  // hit 'improve'. Multi-word phrases ('user friendly') keep \b around the whole.
  const vague = VAGUE_TERMS.filter((t) => new RegExp(`\\b${escapeRegex(t)}\\b`).test(lower));
  if (vague.length > 0) reasons.push(`vague term(s): ${[...new Set(vague)].join(', ')}`);
  // An AC passes the observable check when EITHER an OBSERVABLE keyword matches OR
  // the author declared a non-empty evidence_required (a named verification path is
  // a strong testability signal). VAGUE_TERMS rejection above is independent.
  const hasEvidence = (ac.evidence_required?.length ?? 0) > 0;
  if (!OBSERVABLE.test(ac.statement) && !hasEvidence)
    reasons.push('no observable/measurable predicate found');
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

// ── residual-risk-record classifier (ac-3: shares the resolvability default-DENY) ─

/** One structured residual-risk record (ac-3) as declared in the completion contract. */
export type RemainingRiskRecord = NonNullable<CompletionContract['remaining_risk_records']>[number];

/**
 * Classify the ac-3 structured residual-risk records the SAME way `unverified`
 * items are classified — by REUSING `resolvabilityBlockers` over the shared
 * resolvability label space (R11: one enum, not a parallel field). The two residual
 * surfaces (`unverified[]` and `remaining_risk_records[]`) therefore route through a
 * single default-DENY policy; there is no second classifier to drift.
 *
 *  - `agent_resolvable` → ALWAYS blocks (auto-fix it; surfacing what the agent can
 *    resolve is the anti-pattern). grounding does not excuse it.
 *  - `blocked_external` | `accepted_tradeoff` | `user_decision` → release ONLY with
 *    grounding (default-deny on an ungrounded residual claim); `user_decision` is
 *    flagged a user-decision surface when it blocks.
 *  - R5: a risk blocked by an optional tool's absence is declared `blocked_external`
 *    + grounding (ADR-0018 graceful-degrade) and therefore releases — it is NEVER
 *    `agent_resolvable` (the agent cannot resolve a missing external tool).
 *
 * Each record is mapped onto the `UnverifiedItem` shape the classifier reads (its
 * `risk` text fills both `item` and `reason`, so the structural owned-AC-id check
 * still applies). Absent records (`undefined`, the legacy completion shape) → [].
 */
export function riskRecordBlockers(
  records: readonly RemainingRiskRecord[] | undefined,
  acceptanceIds: readonly string[],
): ResolvabilityBlocker[] {
  if (!records || records.length === 0) return [];
  const asUnverified: UnverifiedItem[] = records.map((r) => ({
    item: r.risk,
    reason: r.risk,
    out_of_scope: false,
    ...(r.resolvability ? { resolvability: r.resolvability } : {}),
    ...(r.grounding ? { grounding: r.grounding } : {}),
  }));
  return resolvabilityBlockers(asUnverified, acceptanceIds);
}

// ── per-AC oracle satisfaction (ADR-0024 §3 ③ JUDGE; consumed by deriveAcVerdicts) ─

/**
 * Is an AC's oracle SATISFIED by the evidence that already closes it? Pure, reads
 * ONLY the passed-in evidence refs — it NEVER runs a scanner/test (static = a
 * RECORDED re-scan ref only; ADR-0018 graceful-degrade: absent analyzer/evidence
 * stays non-pass, never auto-pass). The closure DECISION lives in
 * autopilot-complete (`nodeVerdictFor`); this helper only classifies whether the
 * recorded evidence meets the oracle's re-evaluability class and emits `reasons`
 * naming the unmet oracle (transparency, ADR-0024:35).
 *
 * `closingEvidence` is the same union the AC-closing rule already gathers
 * (top-level + per-AC `evidence_refs`), so a satisfied oracle implies closing
 * evidence existed — presence is a precondition, not a separate check.
 *
 *  - `dynamic_test` → satisfied by ANY closing evidence ref (reuses the existing
 *    closing-evidence rule; an executed/runnable ref). No new constraint vs. the
 *    legacy behavior.
 *  - `static_scan`  → satisfied ONLY by a RECORDED re-scan ref (kind file /
 *    artifact / command). A note-only ack ("looks clean") is NOT a re-scan.
 *  - `soft_judgment`→ satisfied by ANY closing evidence ref incl. a review /
 *    decision `note`.
 */
const STATIC_SCAN_KINDS: ReadonlySet<EvidenceRef['kind']> = new Set([
  'file',
  'artifact',
  'command',
]);

export function oracleSatisfaction(
  acId: string,
  oracle: AcOracle,
  closingEvidence: readonly EvidenceRef[],
): GateResult {
  const satisfied = ((): boolean => {
    switch (oracle.verification_method) {
      case 'dynamic_test':
        return closingEvidence.length > 0;
      case 'static_scan':
        return closingEvidence.some((e) => STATIC_SCAN_KINDS.has(e.kind));
      case 'soft_judgment':
        return closingEvidence.length > 0;
    }
  })();
  if (satisfied) return gate([]);
  return gate([
    `${acId}: ${oracle.verification_method} oracle unsatisfied (no closing evidence meets the oracle; not closed to pass)`,
  ]);
}

// ── positive per-AC attestation (ac-6; gate↔score: ONE derived-verdict input) ──

/** Positive attestation state for one AC, derived ONLY from its already-derived verdict. */
export type AttestationState =
  | 'verified-by-evidence' // closed by evidence (derived `pass`)
  | 'reasoned-honest-partial' // honest progress / not-yet-proven (derived `partial` | `unverified`)
  | 'blocked-for-user'; // a hard failure the run cannot self-resolve (derived `fail`)

/**
 * The minimal derived-verdict shape the attestation reads. Both `deriveAcVerdicts`
 * output and a completion's `acceptance[]` satisfy it, so the attestation consumes
 * the SAME single source the closure decision used (no parallel input).
 */
export interface DerivedAcVerdict {
  criterion_id: string;
  verdict: Verdict;
  notes?: string;
}

export interface AcAttestation {
  criterion_id: string;
  state: AttestationState;
  /** The reasoning/evidence note carried straight from the SAME derived verdict. */
  basis?: string;
}

const ATTESTATION_OF: Record<Verdict, AttestationState> = {
  pass: 'verified-by-evidence',
  partial: 'reasoned-honest-partial',
  unverified: 'reasoned-honest-partial',
  fail: 'blocked-for-user',
};

/**
 * Build a positive per-AC attestation from the ALREADY-derived verdicts. CRITICAL
 * (charter §2 gate↔score): the attestation reads the SAME per-AC verdicts the
 * closure decision used — it consumes `deriveAcVerdicts`/`oracleSatisfaction` output
 * (the source `assembleCompletionFromGraph` writes into `completion.acceptance`) and
 * does NOT recompute a parallel verdict from the graph. So a `verified-by-evidence`
 * attestation can never disagree with the verdict that closed the AC.
 *
 * The 4 verdicts fold into 3 attestation states: `pass` → verified-by-evidence;
 * `partial`/`unverified` → reasoned-honest-partial (honest progress, basis carried
 * from the derived note); `fail` → blocked-for-user (a defect the run cannot
 * self-resolve, surfaced rather than silently parked). Order/ids are preserved 1:1.
 */
export function attestAcVerdicts(derived: readonly DerivedAcVerdict[]): AcAttestation[] {
  return derived.map((d) => ({
    criterion_id: d.criterion_id,
    state: ATTESTATION_OF[d.verdict],
    ...(d.notes ? { basis: d.notes } : {}),
  }));
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

// ── non-pass termination gate (ac-1, CORE R1: enumerate acceptance[].verdict) ──

/**
 * The central leak fix. `completionGate` only enumerates per-AC verdicts when
 * `final_verdict === 'pass'`, and the residual gate reads only `completion.unverified[]`
 * — so a NON-pass completion that PARKS an in-scope criterion at `unverified`/`fail`
 * WITHOUT mirroring it into `unverified[]` slips both and terminates at exit 0.
 *
 * This gate enumerates `acceptance[].verdict` DIRECTLY (not `unverified[]`): on a
 * non-pass completion, any in-scope criterion whose verdict is `unverified`/`fail`
 * is a parked criterion. It BLOCKS unless the completion carries an HONEST
 * partial/blocked declaration — `non_pass_status` (state partial|blocked, with
 * reason + grounding, which the schema guarantees present whenever the object
 * exists). That declaration is the legitimate terminate (progress made / cannot
 * proceed, grounded in an oracle); its absence is the silent park. A declared
 * `partial` verdict is itself an honest signal, not a silent park, so it is not in
 * the parked set (only `unverified`/`fail` are).
 *
 * ADR-20260626 D2 stays alive: block the SILENT park, allow the HONEST terminate.
 * Pass completions are owned by `completionGate` + the schema superRefine (every AC
 * must be pass), so this gate no-ops on them. The required-when-non-pass constraint
 * lives HERE (a recoverable gate reason), NOT in the schema superRefine, so legacy
 * on-disk non-pass completions still PARSE (R10).
 */
export function nonPassTerminationGate(completion: CompletionContract): GateResult {
  if (completion.final_verdict === 'pass') return gate([]);
  const parked = completion.acceptance.filter(
    (a) => a.verdict === 'unverified' || a.verdict === 'fail',
  );
  if (parked.length === 0) return gate([]);
  // An honest partial/blocked declaration unlocks the non-pass terminate; the schema
  // guarantees reason + grounding present whenever the object is present.
  if (completion.non_pass_status) return gate([]);
  return gate([
    `non-pass completion parks in-scope criterion/criteria at unverified/fail without an honest partial/blocked declaration (non_pass_status): ${parked
      .map((a) => a.criterion_id)
      .join(', ')} — resolve them or declare non_pass_status{state,reason,grounding}`,
  ]);
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

// ── direction-fork gate (wi_260707loq: autonomy stop is purpose-fork-only) ────

/**
 * The optional deterministic corroboration for `directionForkGate`'s `purpose_change`
 * condition (the `where applicable` path). REUSES the exact AC id-set conservation
 * `intentDriftGate` applies (`missingFrom` over the id sets): a fork genuinely
 * changes the frozen purpose iff the chosen path's AC id-set DIVERGES from the
 * intent's (a grow or a shrink). When supplied, this deterministic fact — not the
 * node's self-report — decides whether purpose_change holds, so a fork that conserves
 * the id-set can never masquerade as a purpose change (root goal: stop only for
 * purpose-CHANGING forks). Omitted → not applicable, and the carrier's `present`
 * self-report stands.
 */
export interface PurposeChangeCheck {
  /** Frozen intent AC id-set. */
  intentAcIds: readonly string[];
  /** AC id-set the chosen fork path would address. */
  forkAcIds: readonly string[];
}

export interface DirectionForkResult extends GateResult {
  /**
   * Per-condition satisfaction: `present` ∧ non-empty `basis` (and, for
   * purpose_change where applicable, corroborated by AC id-set divergence). The Stop
   * hook uses `pass` to yield-vs-continue and this map / `reasons` to name a gap.
   */
  conditions: {
    purpose_change: boolean;
    no_clear_advantage: boolean;
    intent_cannot_break_tie: boolean;
  };
}

/**
 * Validate a direction-fork carrier: a fork YIELDS (pass=true → Stop hook exit0,
 * ac-2) ONLY when all three conditions are present AND carry non-empty evidence —
 * 목적 변경 ∧ 명확한 우위 없음 ∧ 최초 의도로 tie 해소 불가. Any missing / evidence-less
 * condition fails the gate (→ force-continue exit2) and is NAMED in `reasons`, so
 * the Stop hook can tell the user which condition was absent.
 *
 * Mirrors `decisionConflictGate`: pure and deterministic (D5: 결정론 1차), reading only
 * already-recorded carrier fields with no I/O. It does NOT judge whether a fork
 * exists — that is the LLM layer's declaration — only whether the declared evidence
 * is complete.
 *
 * `purposeCheck` (optional, `where applicable`): reuses intentDriftGate's AC id-set
 * conservation to corroborate purpose_change deterministically (see PurposeChangeCheck).
 * Omitted → the carrier's self-reported `present` stands.
 */
export function directionForkGate(
  carrier: DirectionForkCarrier,
  purposeCheck?: PurposeChangeCheck,
): DirectionForkResult {
  const reasons: string[] = [];
  const hasEvidence = (c: { basis: string }): boolean => c.basis.trim().length > 0;

  // purpose_change: evidence is always required; PRESENCE is the deterministic
  // id-set conservation fact where applicable, else the carrier's self-report.
  let purposeChanged: boolean;
  let purposeConserved = false;
  if (purposeCheck) {
    const grew = missingFrom(purposeCheck.forkAcIds, new Set(purposeCheck.intentAcIds));
    const shrank = missingFrom(purposeCheck.intentAcIds, new Set(purposeCheck.forkAcIds));
    purposeChanged = grew.length > 0 || shrank.length > 0;
    purposeConserved = !purposeChanged;
  } else {
    purposeChanged = carrier.purpose_change.present;
  }
  const purposeOk = purposeChanged && hasEvidence(carrier.purpose_change);
  if (!purposeOk) {
    reasons.push(
      purposeConserved
        ? 'purpose_change: not corroborated — the intent AC id-set is conserved (no purpose change)'
        : 'purpose_change: missing (present:false or empty basis)',
    );
  }

  const advantageOk = carrier.no_clear_advantage.present && hasEvidence(carrier.no_clear_advantage);
  if (!advantageOk) {
    reasons.push('no_clear_advantage: missing (present:false or empty basis)');
  }

  const tieOk =
    carrier.intent_cannot_break_tie.present && hasEvidence(carrier.intent_cannot_break_tie);
  if (!tieOk) {
    reasons.push('intent_cannot_break_tie: missing (present:false or empty basis)');
  }

  return {
    ...gate(reasons),
    conditions: {
      purpose_change: purposeOk,
      no_clear_advantage: advantageOk,
      intent_cannot_break_tie: tieOk,
    },
  };
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

// ── last-mile land gate (ac-3: verified→landed; no uncommitted pass termination) ─

/**
 * The last-mile Stop gate: a `done` work item closing at `final_verdict=pass`
 * must have its own `changed_files` already landed in git — a pass that exits
 * while its changed files sit UNCOMMITTED is the "verified-but-not-landed" leak
 * the work item exists to close. It BLOCKS exactly that termination.
 *
 * PURE / deterministic (D5: 결정론 1차): this predicate NEVER shells out to git.
 * The actual git state — which of the work item's `changed_files` are still
 * uncommitted — is gathered by the CALLER (the Stop hook in stop.ts) and passed
 * in as `uncommittedChangedFiles`. The gate only decides, given that set, whether
 * the termination is admissible. A non-empty set means a pass is trying to exit
 * over unlanded changes.
 *
 * Exemption (preserves T1 ac-1: honest partial/blocked termination): the gate is
 * a no-op for ANY status other than `done` AND any verdict other than `pass`. A
 * `partial`/`blocked`/`unverified` close — the honest "made progress / cannot
 * proceed" terminate — must NEVER be blocked here, because landing was never
 * claimed; only a `done ∧ pass` close asserts the work landed. When the land step
 * cannot legitimately commit, the run closes `blocked` (not `done`), which this
 * exemption lets terminate.
 */
export function landGate(
  status: WorkItemStatus,
  finalVerdict: Verdict,
  uncommittedChangedFiles: readonly string[],
): GateResult {
  // Only a done ∧ pass close asserts the work landed; everything else is exempt
  // (honest partial/blocked/unverified termination is never blocked here).
  if (status !== 'done' || finalVerdict !== 'pass') return gate([]);
  if (uncommittedChangedFiles.length === 0) return gate([]);
  return gate([
    `final_verdict=pass and status=done but changed_files remain uncommitted in git (verified but not landed): ${uncommittedChangedFiles.join(
      ', ',
    )} — land them (commit) before terminating, or close blocked`,
  ]);
}
