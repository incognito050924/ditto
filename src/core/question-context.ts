import { z } from 'zod';
import { selfAnswerAttempt } from '~/schemas/question-gate';

/**
 * Presentation-contract gate (wi_260622ph8). A deep-interview question may only be
 * ASKED of the user once it carries the comprehensible, decision-sufficient context
 * the user needs to answer: a plain-language why-we-ask + what-the-answer-decides
 * (`user_explanation`) on top of the value statement (`why_matters`). The
 * question-generator emits this context; the driver runs THIS check on each gate-
 * selected candidate BEFORE presenting it (Q3: "generator emit + gate 하드검사") —
 * an under-contextualized candidate is rejected (regenerate), never shown.
 *
 * This checks structural PRESENCE of the contract fields, not content quality — the
 * LLM gate already scores quality; this guarantees the user-facing context exists at
 * all, so the success proxy ("structural contract satisfied", Q1) is enforceable.
 *
 * `background` / `grounding` are the progressive-disclosure tiers (Q2: "always plain
 * + progressive disclosure") — optional by design, expanded on demand, so they are
 * NOT hard-required here.
 */
export const questionContextCandidate = z
  .object({
    text: z.string().min(1),
    why_matters: z.string().min(1),
    user_explanation: z.string().optional(),
    // recommended_answer (impl-di-recommended-answer, ac-1). `.optional()` in the schema but
    // hard-required by validateQuestionContext below — same optional-schema / gate-required
    // treatment as user_explanation, so a question is never ASKED without a suggested answer.
    recommended_answer: z.string().optional(),
    background: z.string().optional(),
    grounding: z.string().optional(),
    self_answer_attempts: z.array(selfAnswerAttempt).optional(),
  })
  .describe('A gate-selected question candidate checked against the presentation contract');

export type QuestionContextCandidate = z.infer<typeof questionContextCandidate>;

export interface ContextViolation {
  field: string;
  reason: string;
}

export interface QuestionContextVerdict {
  ok: boolean;
  violations: ContextViolation[];
}

const isBlank = (s: string | undefined): boolean => s === undefined || s.trim().length === 0;

// --- ac-1 (D1): internal-identifier gloss detection ---------------------------
//
// An internal identifier surfaced on the user-reaching face (text + user_explanation)
// without a plain-language gloss leaks DITTO-internal vocabulary at the user. We
// detect a CLOSED whitelist of identifier shapes (NOT a broad \w+ — that regressed on
// Korean before): ac-{n} · T-{n} · D{n} · (wi|orch|memevt|adr)_{lowhex…}. A token is
// "glossed" when a ±40-char window carries a parenthetical OR a colon/dash separator
// followed by an explanatory word (Korean ≥2 syllables or a Latin word ≥3 letters).
// Code blocks (``` fenced ```) and inline `code` are stripped first.

const IDENTIFIER_PATTERNS: readonly RegExp[] = [
  /ac-\d+/g,
  /T-\d+/g,
  /D\d+/g,
  // `prism` added (wi_260707oi1 ac-3, 2nd defense): a leaked prism issue-map node id
  // (prism_<lowhex>) is caught on the user-reaching face just like wi/orch/etc.
  /(?:wi|orch|memevt|adr|prism)_[0-9a-z]+/g,
];

// An explanatory word: a Korean run (≥2 syllables) or a Latin word (≥3 letters). Short
// identifier fragments (e.g. "T", "D1") do not qualify, so "ac-1 (T-2)" stays unglossed.
const EXPLANATORY_WORD = '[가-힣]{2,}|[A-Za-z]{3,}';

const stripCode = (s: string): string => s.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');

// Unicode-safe boundaries: before = start | non-[A-Za-z0-9_-]; after = end | non-[A-Za-z0-9_].
const hasIdentifierBoundary = (text: string, start: number, end: number): boolean => {
  const before = start === 0 || !/[A-Za-z0-9_-]/.test(text[start - 1] ?? '');
  const after = end === text.length || !/[A-Za-z0-9_]/.test(text[end] ?? '');
  return before && after;
};

const isGlossed = (text: string, start: number, end: number): boolean => {
  const before = text.slice(Math.max(0, start - 40), start);
  const after = text.slice(end, end + 40);
  // "(설명…" or ": 설명" / "- 설명" / "— 설명" directly after the token.
  if (new RegExp(`^\\s*[（(][^)）]*?(?:${EXPLANATORY_WORD})`).test(after)) return true;
  if (new RegExp(`^\\s*[:：\\-—–][^\\n]*?(?:${EXPLANATORY_WORD})`).test(after)) return true;
  // token wrapped in parens with an explanatory word before it: "설명…(token)".
  if (
    new RegExp(`(?:${EXPLANATORY_WORD})[^()（）]*[（(][^()（）]*$`).test(before) &&
    /^\s*[)）]/.test(after)
  ) {
    return true;
  }
  return false;
};

/**
 * Returns the unglossed internal identifiers surfaced in `s` (after stripping code).
 * Pure and deterministic — the unit of evidence for ac-1.
 */
export function findUnexplainedIdentifiers(s: string | undefined): string[] {
  if (s === undefined) return [];
  const text = stripCode(s);
  const found: string[] = [];
  for (const pattern of IDENTIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
      const start = m.index;
      const end = start + m[0].length;
      if (!hasIdentifierBoundary(text, start, end)) continue;
      if (!isGlossed(text, start, end)) found.push(m[0]);
    }
  }
  return found;
}

/**
 * Returns `{ ok, violations }`. `ok` is true only when every required context field
 * is present and non-blank. Pure and deterministic — the unit of evidence for ac-2.
 */
export function validateQuestionContext(
  candidate: QuestionContextCandidate,
): QuestionContextVerdict {
  const violations: ContextViolation[] = [];
  if (isBlank(candidate.user_explanation)) {
    violations.push({
      field: 'user_explanation',
      reason:
        'a plain-language why-we-ask + what-the-answer-decides (user language, no raw code/jargon) is required before asking the user',
    });
  }
  if (isBlank(candidate.recommended_answer)) {
    violations.push({
      field: 'recommended_answer',
      reason:
        'a suggested answer (the agent’s recommended default, in user language) is required before asking the user',
    });
  }
  if (isBlank(candidate.why_matters)) {
    violations.push({
      field: 'why_matters',
      reason: 'the value of the answer (what it decides) must be stated',
    });
  }
  // ac-1 (D1): the user-reaching face (text + user_explanation) must not leak an
  // un-glossed internal identifier. background/grounding/self_answer_attempts are not
  // user-default surfaces, so they are excluded from this check.
  const leaked = [
    ...findUnexplainedIdentifiers(candidate.text),
    ...findUnexplainedIdentifiers(candidate.user_explanation),
  ];
  if (leaked.length > 0) {
    violations.push({
      field: 'unexplained_identifier',
      reason: `internal identifier(s) ${[...new Set(leaked)].join(', ')} surfaced to the user with no inline gloss — restate in user language or add a (parenthetical / colon) explanation`,
    });
  }
  return { ok: violations.length === 0, violations };
}

// --- ac-2 (impl-di-recommended-answer): deep-interview single-fire selector ---
//
// Deterministic top-1 reduction for the DEEP-INTERVIEW path only. Returns AT MOST ONE
// candidate: the highest `info_gain_estimate` (the infoGain enum ranks high > medium > low;
// src/schemas/interview-state.ts:14). info_gain is a 3-value enum, so TIES ARE ROUTINE — the
// tiebreak MUST be deterministic: stable INPUT ORDER (first candidate among equals wins,
// enforced by the STRICT `>` below). Empty → empty; single → that one. Pure and unit-testable.
// This limit lives on the deep-interview path ONLY — it is deliberately NOT added to the
// shared question-round `scoredQuestion` schema (consumed by prism, which stays multi-select).
const INFO_GAIN_RANK: Record<'high' | 'medium' | 'low', number> = { high: 3, medium: 2, low: 1 };

export function selectSingleFire<T extends { info_gain_estimate: 'high' | 'medium' | 'low' }>(
  candidates: readonly T[],
): T[] {
  let best: T | undefined;
  for (const c of candidates) {
    if (
      best === undefined ||
      INFO_GAIN_RANK[c.info_gain_estimate] > INFO_GAIN_RANK[best.info_gain_estimate]
    ) {
      best = c;
    }
  }
  return best === undefined ? [] : [best];
}

// --- ac-5 (D4): briefing threshold -------------------------------------------
//
// Budget for an AskUserQuestion option `description`, measured in UTF-8 BYTES because
// the host truncates the description by bytes, not UTF-16 code units — so a Korean
// (3-bytes/syllable) explanation that looks short by char count still overflows and
// must brief. No host-documented hard limit was found in this repo or the bundled
// skills/docs as of 2026-06; this is a CONSERVATIVE default (D4: "못 찾으면 보수적
// 기본값+주석"). Kept at 160 BYTES rather than raised to preserve a char-capacity: since
// the root cause is byte truncation, the smaller (byte) budget is the safe side —
// it errs toward briefing rather than risking a silently truncated option. Revise if
// the host publishes an exact byte limit.
export const OPTION_DESCRIPTION_BUDGET = 160;

/**
 * True when the rendered option description is too long to fit the option UI and the
 * user should be briefed first. `rendered` = user_explanation (falling back to text).
 * Measured in UTF-8 bytes to match the host's byte-based truncation. Pure and
 * limit-agnostic (the caller may pass any limit, interpreted as a byte budget).
 */
export function needsBriefing(
  rendered: string,
  limit: number = OPTION_DESCRIPTION_BUDGET,
): boolean {
  return Buffer.byteLength(rendered, 'utf8') > limit;
}

// --- ac-4 (D2): reviewer routing + regeneration cap (judgment logic only) -----
//
// Per-question regeneration cap (fixed, small). Distinct from deep-interview's
// question_cap (total question count) — do not reuse that. The reviewer is the
// session-blind context-reviewer (D5); spawning is the SKILL node's job. These pure
// functions are only the judgment: who gets reviewed, and what terminal/next state the
// cap implies. Honesty over silence: a failed/absent review degrades visibly
// ('unverified-degraded'), never a silent ask or a stall (ADR-0018 D1/D2).
export const REVIEW_REGENERATE_CAP = 2;

export type ReviewRouting = { action: 'review' } | { action: 'skip-review' };

/** critical questions need the session-blind reviewer; others skip it. */
export function routeForReview(input: { critical: boolean }): ReviewRouting {
  return input.critical ? { action: 'review' } : { action: 'skip-review' };
}

export type ReviewDecision =
  | { status: 'reviewed' }
  | { status: 'regenerate'; attempt: number }
  | { status: 'unverified-degraded'; reason: 'cap-exhausted' | 'reviewer-unavailable' };

/**
 * Decide the review outcome for one critical question:
 *  - reviewer passed                       → 'reviewed'
 *  - reviewer unavailable (spawn failed)   → 'unverified-degraded' (reviewer-unavailable)
 *  - cap (2) already exhausted             → 'unverified-degraded' (cap-exhausted)
 *  - otherwise                             → 'regenerate' (attempt = regenerations + 1)
 */
export function resolveReviewDecision(input: {
  passed: boolean;
  regenerations: number;
  reviewerAvailable: boolean;
}): ReviewDecision {
  if (input.passed) return { status: 'reviewed' };
  if (!input.reviewerAvailable) {
    return { status: 'unverified-degraded', reason: 'reviewer-unavailable' };
  }
  if (input.regenerations >= REVIEW_REGENERATE_CAP) {
    return { status: 'unverified-degraded', reason: 'cap-exhausted' };
  }
  return { status: 'regenerate', attempt: input.regenerations + 1 };
}
