import type { CompletionContract } from '~/schemas/completion-contract';
import type { Convergence } from '~/schemas/convergence';
import type { ClosureMode } from '~/schemas/convergence';
import type { InterviewState } from '~/schemas/interview-state';
import type { WorkItem } from '~/schemas/work-item';

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

const OBSERVABLE =
  /\b(returns?|rejects?|responds?|displays?|shows?|exits?|equals?|matches?|contains?|within|less than|greater than|at most|at least|status|code|\d)/i;

export function acceptanceTestable(ac: { statement: string }): GateResult {
  const reasons: string[] = [];
  const lower = ac.statement.toLowerCase();
  const vague = VAGUE_TERMS.filter((t) => lower.includes(t));
  if (vague.length > 0) reasons.push(`vague term(s): ${[...new Set(vague)].join(', ')}`);
  if (!OBSERVABLE.test(ac.statement)) reasons.push('no observable/measurable predicate found');
  return gate(reasons);
}

// ── completion gate (cross-checks completion against the work item) ─────────

export function completionGate(item: WorkItem, completion: CompletionContract): GateResult {
  const reasons: string[] = [];
  // The AC-set cross-check applies when a completion claims success (plan §2 M0.4).
  if (completion.final_verdict === 'pass') {
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
