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
 * gates only read what was written.
 */
export interface GateResult {
  pass: boolean;
  reasons: string[];
}

function gate(reasons: string[]): GateResult {
  return { pass: reasons.length === 0, reasons };
}

// ── stable gate identity (wi_260718srh, n3) ──────────────────────────────────
// Each deterministic gate in this file has ONE stable `gate_id` — a machine-
// attributable handle the decision log stamps on a gate-triggered entry
// (autopilot-store.ts `AutopilotDecision.gate_id`, additive-optional). The corpus
// is this HUMAN-PINNED literal set, NOT a reflective scan of "functions that return
// GateResult": the gates span three return shapes (GateResult / *Result / blocker
// string[]), so a reflective scan cannot delimit them. Every entry's key === value
// (the id IS its own key), the value set is injective, and the key set is exactly the
// gates enumerated here. Sibling classifiers SHARE their parent gate's id and get NO
// distinct id: `riskRecordBlockers` → `resolvability`, `discoveredDefectCloseBlockers`
// → `pass_close_residual`. Boolean predicates (highRiskAssumption, safeDefaultable,
// knowledgeTriggerFired, isConditionB, …) and the G7 dispatch-guard fixable-downgrade
// are NOT acceptance gates and are deliberately absent.
export const GATE_ID = {
  interview_readiness: 'interview_readiness',
  acceptance_testable: 'acceptance_testable',
  resolvability: 'resolvability',
  pass_close_residual: 'pass_close_residual',
  oracle_satisfaction: 'oracle_satisfaction',
  frozen_tests_intact: 'frozen_tests_intact',
  completion: 'completion',
  completion_evidence: 'completion_evidence',
  non_pass_termination: 'non_pass_termination',
  convergence: 'convergence',
  decision_conflict: 'decision_conflict',
  intent_drift: 'intent_drift',
  direction_fork: 'direction_fork',
  knowledge_update: 'knowledge_update',
  interface_baseline_drift: 'interface_baseline_drift',
  land: 'land',
} as const;
export type GateId = (typeof GATE_ID)[keyof typeof GATE_ID];

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
    reasons.push(`핵심(critical) 항목 미해결: ${unresolved.join(', ')}`);
  }
  // LLM self-reported readiness cannot escape the deterministic floor on ambiguity.
  const floor = deterministicFloor(ambiguityFromInterview(state));
  const capped = Math.min(state.readiness.score, 1 - floor);
  if (capped < state.readiness.threshold) {
    reasons.push(
      `준비도 ${capped.toFixed(2)}(모호성 하한 적용) < 임계값 ${state.readiness.threshold}`,
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
  if (vague.length > 0) reasons.push(`모호한 표현(vague term): ${[...new Set(vague)].join(', ')}`);
  // An AC passes the observable check when EITHER an OBSERVABLE keyword matches OR
  // the author declared a non-empty evidence_required (a named verification path is
  // a strong testability signal). VAGUE_TERMS rejection above is independent.
  const hasEvidence = (ac.evidence_required?.length ?? 0) > 0;
  if (!OBSERVABLE.test(ac.statement) && !hasEvidence)
    reasons.push('관찰·측정 가능한 완료 조건 없음(no observable/measurable predicate)');
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
            ? '에이전트가 해결 가능하다고 선언해 놓고 방치함 — 방치하지 말고 지금 해결하라'
            : '이 작업이 책임진 완료 조건을 가리키는데 아직 검증되지 않음',
        kind: 'agent_resolvable',
        userDecision: false,
      });
      continue;
    }

    if (u.resolvability === 'blocked_external' || u.resolvability === 'accepted_tradeoff') {
      if (grounded) continue;
      const kindKo = u.resolvability === 'blocked_external' ? '외부 요인 차단' : '감수한 절충';
      blockers.push({
        item: u.item,
        reason: `${kindKo} 잔여인데 근거가 없음(미근거 잔여 주장)`,
        kind: 'blocked_external',
        userDecision: false,
      });
      continue;
    }

    if (u.resolvability === 'user_decision') {
      if (grounded) continue;
      blockers.push({
        item: u.item,
        reason: '사용자 결정이 필요한 사안인데 결정 기록이 없음(사용자 승인을 받아야 함)',
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

/**
 * ac-1 (wi_260710tjd) TERMINATION-COMPLETENESS gate for the terminal-flip close
 * paths (`work done`, `autopilot complete`). Those paths flip the WI to `done`
 * BEFORE the Stop hook can enforce the residual gates — the flip trips the Stop
 * NON_TERMINAL guard, so a Stop-hook-only wire is bypassed (the "완료-판정 채널 갭",
 * cf. wi_260710676/#18). This runs the SAME IN-SCOPE AGENT-OWNED residual classifiers
 * the Stop hook already uses — `resolvabilityBlockers` over `unverified[]` and
 * `riskRecordBlockers` over `remaining_risk_records[]` — so a pass-close that SILENTLY
 * drops an agent-owned residual is blocked on the close path too. ONE label space, no
 * new field / second classifier (R11): pure reuse of the two classifiers above.
 *
 * It targets the SILENT SHRINK, not every recorded note: out-of-scope / candidate
 * follow-ups live on NEITHER surface (they are the loop's `batch_escalate`/materialized
 * ledger, not `unverified[]`/`remaining_risk_records[]`), so capture≠drive (ADR-20260627)
 * is preserved; a resolvability-absent, non-AC-referencing note releases (the default
 * release path). `non_pass_status` is a NO-OP on pass and is NOT this gate's escape
 * valve — a pass with a parked agent_resolvable residual must resolve/ground it. Returns
 * one formatted reason per blocker (empty ⇒ clean close).
 */
export function passCloseResidualBlockers(
  completion: CompletionContract,
  acceptanceIds: readonly string[],
): string[] {
  const label = (b: ResolvabilityBlocker, surface: string): string =>
    b.userDecision
      ? `${surface} 사용자 승인 대기(사용자 결정 필요) — ${b.item}: ${b.reason}`
      : `${surface} pass-close 차단(통과-종료 차단) — ${b.item}: ${b.reason}`;
  return [
    ...resolvabilityBlockers(completion.unverified, acceptanceIds).map((b) =>
      label(b, '잔여(residual)'),
    ),
    ...riskRecordBlockers(completion.remaining_risk_records, acceptanceIds).map((b) =>
      label(b, '잔여 위험 기록(residual-risk record)'),
    ),
  ];
}

// ── condition-b classifier (wi_2607148yg ac-4: fail-closed protected-intent decision) ─

/**
 * The four protected intent axes condition(b) guards: a decision adverse to (반하거나
 * 위협하는) one of these must NOT be auto-driven — it yields to a fail-closed user
 * handoff. Typed to exactly these axes so a decision outside them is simply not a
 * `ConditionBDecision` (it never reaches this gate).
 */
export type ConditionBDomain = 'security' | 'system' | 'project' | 'feature_design';

/**
 * A candidate decision the loop must make, tagged with the protected axis it touches
 * and whether it is ADVERSE to that axis's intent. WHETHER a decision touches an axis
 * and is adverse is the LLM layer's judgement (like `DecisionConflict`'s kind/level);
 * this gate is the pure fail-closed routing over the already-classified fact.
 */
export interface ConditionBDecision {
  /** The protected axis this decision touches. */
  domain: ConditionBDomain;
  /** Does the decision go against / threaten that axis's intent? (반하거나 위협) */
  adverse: boolean;
  /** Evidence for WHY this is condition-b — carried into the handoff (transparency, ac-9). */
  basis: string;
}

/**
 * Is this a condition-b decision (fail-closed)? A decision is condition-b iff it is
 * ADVERSE to a protected axis — merely touching an axis (a non-adverse change) does
 * not fail-close (else routine work in these areas would never be autonomous). The
 * `domain` is already one of the four protected axes by type; `adverse` is the fail
 * signal. Pure and deterministic (D5: 결정론 1차).
 */
export function isConditionB(d: ConditionBDecision): boolean {
  return d.adverse;
}

/**
 * Does driving a discovered defect's FIX require a condition-b decision? If so, the
 * loop must BLOCK (fail-closed handoff) instead of auto-driving — condition-b
 * DOMINATES the defect-drive: a reproduced `discovered_defect` is normally
 * materialize+drive, but the instant its fix needs a security/system/project/
 * feature-design ADVERSE decision, autonomy yields. AND-able: the loop gates its
 * can-drive on `reproduced && !defectFixRequiresConditionB(fixDecisions)`. Empty ⇒
 * no condition-b decision needed ⇒ does not block the drive.
 */
export function defectFixRequiresConditionB(fixDecisions: readonly ConditionBDecision[]): boolean {
  return fixDecisions.some(isConditionB);
}

// ── fail-handoff condition guard (wi_2607148yg ac-7: only the two conditions fail) ──

/**
 * Why the loop reached a potential user-handoff point. fail·user-handoff (ac-7) fires
 * on ONLY the two sanctioned conditions — (1) 정초 계획·방향 반전 or 진행 불가, and (2)
 * a condition-b decision is required — every other pause reason force-continues rather
 * than punting a procedure decision to the user (charter §4-8). A routine
 * `procedure_punt` (진행확인/플랜승인/AB선택) is explicitly NOT a fail.
 */
export type HandoffReason =
  | 'direction_reversed' // (1) 정초 계획·방향 반전
  | 'progress_impossible' // (1) 충돌로 진행 불가
  | 'condition_b_required' // (2) 보안·시스템·프로젝트·기능설계 결정 필요
  | 'procedure_punt'; // 진행확인/플랜승인/AB선택 — routine, NOT a fail

const FAIL_HANDOFF_REASONS: ReadonlySet<HandoffReason> = new Set([
  'direction_reversed',
  'progress_impossible',
  'condition_b_required',
]);

/**
 * Does this pause reason justify a fail·user-handoff? True ONLY for the two sanctioned
 * conditions; anything else (notably `procedure_punt`) is non-fail → the loop
 * force-continues. Default-non-fail toward autonomy: a reason not in the sanctioned set
 * keeps the run going (the intent's goal is "멈추지 않고 자율 완수" except the two
 * conditions), so a future pause reason not added to the set will not silently start
 * punting to the user. Pure and deterministic.
 */
export function isFailHandoffReason(reason: HandoffReason): boolean {
  return FAIL_HANDOFF_REASONS.has(reason);
}

// ── lightweight-close discovered-defect gate (wi_2607148yg ac-10: materialize releases) ─

/** Work-item id shape (mirrors src/schemas/common workItemId regex, id-only, global). */
const WORK_ITEM_ID_RE = /wi_[a-z0-9]{8,}/g;

/**
 * Work-item id CANDIDATES carried in a discovered-defect grounding. The grounding is a
 * free-text lossless channel (ADR-20260628), so it may read `materialized as wi_… (backlog)`
 * rather than a bare id — extract every `wi_…` token so the caller can resolve each against
 * the real store. Absent/empty grounding yields none (⇒ unmaterialized).
 */
function groundingWorkItemIds(grounding: string | undefined): string[] {
  if (typeof grounding !== 'string') return [];
  return grounding.match(WORK_ITEM_ID_RE) ?? [];
}

/**
 * All work-item id candidates referenced by discovered-defect groundings across the two
 * residual surfaces (deduped). The CLI resolves each against the store's `exists` and feeds
 * the resulting predicate to `discoveredDefectCloseBlockers` — keeping that gate pure while
 * still keying the close on a REAL materialized work item, not a free-text claim.
 */
export function discoveredDefectGroundings(completion: CompletionContract): string[] {
  const ids = new Set<string>();
  for (const u of completion.unverified) {
    if (u.resolvability === 'discovered_defect')
      for (const id of groundingWorkItemIds(u.grounding)) ids.add(id);
  }
  for (const r of completion.remaining_risk_records ?? []) {
    if (r.resolvability === 'discovered_defect')
      for (const id of groundingWorkItemIds(r.grounding)) ids.add(id);
  }
  return [...ids];
}

/**
 * Lightweight-path (`work done`) close gate for DISCOVERED DEFECTS, a sibling of the
 * `passCloseResidualBlockers` family. A `discovered_defect` residual is a real-behavior
 * bug found mid-work that must NOT be silently left ("mentioned but not persisted is
 * worthless", source intent). On the lightweight path this gate does NOT drive the fix
 * (that is the autopilot loop's job) — it only requires the defect be MATERIALIZED into a
 * REAL work item before the close. Materialization is proven by a `grounding` that carries
 * a work-item pointer (`wi_…`) which `wiExists` resolves to an actually-persisted record —
 * a fabricated/nonexistent pointer (a free-text claim, e.g. `wi_defect0001` never created)
 * does NOT release the close (ac-10, the claim-not-proof fix).
 *
 *  - UNMATERIALIZED discovered_defect (no grounding / no `wi_…` token) → BLOCKS the close.
 *  - FABRICATED grounding (a `wi_…` token that does NOT resolve via `wiExists`) → BLOCKS.
 *  - MATERIALIZED discovered_defect (≥1 grounding `wi_…` resolves) → RELEASES. GATE ONLY —
 *    never drives, never hard-blocks-until-user (the loop/backlog owns the drive).
 *
 * `wiExists` is the existence predicate the caller resolves from the store (async I/O stays
 * out of this pure gate). It reads ONLY the two residual surfaces and keys on
 * `resolvability==='discovered_defect'`, so a non-defect `out_of_scope` follow-up is
 * untouched and still releases — capture≠drive (ADR-20260627) and the ac-5 release path are
 * preserved. Returns one formatted reason per unmaterialized/fabricated defect (empty ⇒ clean).
 */
export function discoveredDefectCloseBlockers(
  completion: CompletionContract,
  wiExists: (workItemId: string) => boolean,
): string[] {
  const blockers: string[] = [];
  const check = (text: string, grounding: string | undefined): void => {
    const ids = groundingWorkItemIds(grounding);
    if (ids.length === 0) {
      blockers.push(
        `lightweight close blocked — discovered defect not materialized into a work item: ${text} — materialize it (backlog/work item) before closing 'work done' (a materialized defect releases the close)`,
      );
      return;
    }
    if (!ids.some((id) => wiExists(id))) {
      blockers.push(
        `lightweight close blocked — discovered defect grounding points to a work item that does not exist (${ids.join(
          ', ',
        )}): ${text} — the pointer must resolve to a REALLY materialized work item, not a fabricated id`,
      );
    }
  };
  for (const u of completion.unverified) {
    if (u.resolvability === 'discovered_defect') check(u.item, u.grounding);
  }
  for (const r of completion.remaining_risk_records ?? []) {
    if (r.resolvability === 'discovered_defect') check(r.risk, r.grounding);
  }
  return blockers;
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

// ── frozen-test integrity (wi_2607105qy ac-3 Part B; closes the dynamic_test hole) ─

/** One entry of the frozen red-test manifest committed into the approval gate's test_spec. */
export interface FrozenTestEntry {
  criterion_id: string;
  test_path: string;
  /** The content hash captured at freeze (test-author pass). Absent ⇒ unbound (degraded). */
  frozen_hash?: string;
}

/**
 * Frozen-test integrity (ADR-0024 freeze reuse; SAME diff = reject shape as
 * assertOracleFrozen). After approval the authored red tests are FROZEN — the implement
 * node may ONLY turn them green, never weaken or delete them. This binds completion to the
 * SPECIFIC frozen test: for each BOUND entry (one carrying a `frozen_hash`), a current
 * content hash that is MISSING (the test was deleted) or DIFFERENT (it was weakened/edited)
 * is REJECTED — closing the vacuous-green hole where a `dynamic_test` AC would otherwise
 * close on ANY evidence even after its proving test was gutted. An UNBOUND entry (no
 * frozen_hash, e.g. the file was unreadable at freeze) contributes no binding and is
 * skipped — degrade, never a false reject (ADR-0018). Pure: `currentHash(path)` is injected
 * so the check needs no filesystem.
 */
export function assertFrozenTestsIntact(
  entries: readonly FrozenTestEntry[],
  currentHash: (test_path: string) => string | undefined,
): GateResult {
  const reasons: string[] = [];
  for (const e of entries) {
    if (e.frozen_hash === undefined) continue; // unbound — degrade, not a reject
    const now = currentHash(e.test_path);
    if (now === undefined) {
      reasons.push(
        `frozen red test ${e.test_path} (${e.criterion_id}) was DELETED — a frozen test cannot be removed, only turned green (no vacuous green)`,
      );
    } else if (now !== e.frozen_hash) {
      reasons.push(
        `frozen red test ${e.test_path} (${e.criterion_id}) was WEAKENED/changed after freeze — a frozen test cannot be edited, only turned green (no vacuous green)`,
      );
    }
  }
  return gate(reasons);
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
    reasons.push(`중복된 완료 조건 id(duplicate): ${[...dupes].join(', ')}`);
  }
  const missing = expected.filter((id) => !reportedSet.has(id));
  if (missing.length > 0) reasons.push(`누락된 완료 조건(missing): ${missing.join(', ')}`);
  const extra = [...reportedSet].filter((id) => !expectedSet.has(id));
  if (extra.length > 0) reasons.push(`작업 항목에 없는 초과 완료 조건(extra): ${extra.join(', ')}`);

  if (completion.final_verdict === 'pass') {
    const notPass = completion.acceptance
      .filter((a) => a.verdict !== 'pass')
      .map((a) => a.criterion_id);
    if (notPass.length > 0) {
      reasons.push(
        `최종 판정은 pass인데 통과하지 못한 완료 조건이 있음: ${[...new Set(notPass)].join(', ')}`,
      );
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
      '최종 판정은 pass인데 실행 가능한 검증 증거가 없음 — 승인/확인(ack/approval)은 검증이 아니다',
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
    `비-통과 완료가 범위 안 완료 조건을 정직한 부분완료/차단 선언(상태·이유·근거) 없이 미검증/실패 상태로 방치함: ${parked
      .map((a) => a.criterion_id)
      .join(', ')} — 해결하거나, 정직한 부분완료/차단 선언(상태·이유·근거)을 남겨라`,
  ]);
}

// ── convergence gate (reads recorded fields only; no admissibility inference) ─

export function convergenceGate(c: Convergence): GateResult {
  const reasons: string[] = [];

  const maxScore = Math.max(...c.versions.map((v) => v.score));
  const selected = c.versions.find((v) => v.version === c.selected_version);
  if (!selected) {
    reasons.push(`선택된 버전 ${c.selected_version}이(가) 후보 목록에 없음`);
  } else if (selected.score !== maxScore) {
    reasons.push(`선택된 버전이 최고 점수 후보가 아님(선택 ${selected.score} < 최고 ${maxScore})`);
  }

  const openComputed = c.decision_ledger.filter(
    (e) => e.admissible && e.status === 'deferred',
  ).length;
  if (c.open_admissible_count !== openComputed) {
    reasons.push(`미해결 반론 수 기록값 ${c.open_admissible_count} != 계산값 ${openComputed}`);
  }

  const expectedConverged = c.gate.completion_gate === 'pass' && openComputed === 0;
  if (c.gate.converged !== expectedConverged) {
    reasons.push(
      `수렴 판정 기록값 ${c.gate.converged} != 기대값 ${expectedConverged}(완료 통과 ∧ 미해결 반론 0)`,
    );
  }
  if (!expectedConverged) {
    reasons.push('수렴 안 됨: 완료 게이트가 통과가 아니거나, 미해결 반론이 남아 있음');
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
    reasons.push('선언된 기록 계기 없이 지속 지식이 기록됨 — 과잉기록 노이즈(over-recording)');
  }
  if (t.adr_worthy_decision && d.decisions === 0) {
    reasons.push('ADR감 결정 계기가 켜졌는데 기록된 결정/ADR이 없음 — 누락(under-recording)');
  }
  if (t.new_agreed_term && d.glossary_terms === 0) {
    reasons.push('새 합의 용어 계기가 켜졌는데 추가된 용어집 항목이 없음 — 누락(under-recording)');
  }
  if (t.repeated_pattern && d.patterns + d.learnings === 0) {
    reasons.push('반복 패턴 계기가 켜졌는데 기록된 패턴/학습이 없음 — 누락(under-recording)');
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
    advisories.push('H1: 작업 항목 목표가 원 의도의 목표와 어긋남(재기술이거나 표류 — 검토 필요)');
  }
  if (a.workItem.source_request.trim() !== a.intent.source_request.trim()) {
    advisories.push('H1: 작업 항목의 원 요청이 원 의도와 어긋남(검토 필요)');
  }
  const wiAcIds = idSet(a.workItem.acceptance_criteria);
  const wiAdded = missingFrom(wiAcIds, intentAcIds);
  if (wiAdded.length > 0) {
    reasons.push(`H1: 원 의도에 없는 작업 항목 완료 조건 id(scope grow): ${wiAdded.join(', ')}`);
  }
  const wiDropped = missingFrom(intentAcIds, wiAcIds);
  if (wiDropped.length > 0) {
    reasons.push(
      `H1: 작업 항목에서 빠진 원 의도 완료 조건 id(scope shrink): ${wiDropped.join(', ')}`,
    );
  }

  // ── H2 intent → autopilot ──
  if (a.graph.root_goal.trim() !== intentGoal) {
    advisories.push(
      'H2: autopilot 최상위 목표가 원 의도의 목표와 어긋남(재기술이거나 표류 — 검토 필요)',
    );
  }
  const covered = new Set<string>();
  for (const node of a.graph.nodes) {
    for (const ref of node.acceptance_refs) covered.add(ref);
  }
  const uncovered = missingFrom(intentAcIds, covered);
  if (uncovered.length > 0) {
    reasons.push(
      `H2: 어떤 노드도 다루지 않는 원 의도 완료 조건 id(scope shrink): ${uncovered.join(', ')}`,
    );
  }
  const invented = missingFrom(covered, intentAcIds);
  if (invented.length > 0) {
    reasons.push(`H2: 원 의도에 없는 노드 완료 조건 참조 id(scope grow): ${invented.join(', ')}`);
  }

  // ── H3 intent → completion (only on a non-pass completion; pass-case owned by
  // completionGate to avoid double-emission) ──
  if (a.completion && a.completion.final_verdict !== 'pass') {
    const compIds = new Set(a.completion.acceptance.map((c) => c.criterion_id));
    const compAdded = missingFrom(compIds, intentAcIds);
    if (compAdded.length > 0) {
      reasons.push(`H3: 원 의도에 없는 완료본 완료 조건 id(scope grow): ${compAdded.join(', ')}`);
    }
    const compDropped = missingFrom(intentAcIds, compIds);
    if (compDropped.length > 0) {
      reasons.push(
        `H3: 완료본에서 빠진 원 의도 완료 조건 id(scope shrink): ${compDropped.join(', ')}`,
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
        ? 'purpose_change: 뒷받침 안 됨 — 의도 AC id 집합이 그대로(conserved)라 목적 변경이 아님'
        : 'purpose_change: 미충족(present:false 또는 근거 비어 있음)',
    );
  }

  const advantageOk = carrier.no_clear_advantage.present && hasEvidence(carrier.no_clear_advantage);
  if (!advantageOk) {
    reasons.push('no_clear_advantage: 미충족(present:false 또는 근거 비어 있음)');
  }

  const tieOk =
    carrier.intent_cannot_break_tie.present && hasEvidence(carrier.intent_cannot_break_tie);
  if (!tieOk) {
    reasons.push('intent_cannot_break_tie: 미충족(present:false 또는 근거 비어 있음)');
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
 * engine produces (axis-2 시간정합). The
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
      `고정 기준선 대비 인터페이스/범위 추가됨 — 미승인 확장(grow): ${added.join(', ')}`,
    );
  }
  if (removed.length > 0) {
    reasons.push(
      `고정 기준선 대비 인터페이스/범위 제거됨 — 미승인 축소(shrink): ${removed.join(', ')}`,
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
    `최종 판정 pass이고 상태 done인데 changed_files가 git에 커밋되지 않고 남아 있음(uncommitted) — 검증했지만 반영 안 됨(verified but not landed): ${uncommittedChangedFiles.join(
      ', ',
    )} — 종료 전에 커밋해 반영하거나, blocked로 닫아라`,
  ]);
}
