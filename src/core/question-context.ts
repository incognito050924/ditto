import { z } from 'zod';
import { fragmentKeywords } from '~/core/prism/engine';
import type { InterviewBranchEdge } from '~/schemas/interview-state';
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

// --- ac-1 (wi_260714aaq, #29): curated opaque-vocab leak detection ------------
//
// Beyond the shape-based IDENTIFIER_PATTERNS, a CLOSED, CURATED list of opaque internal
// vocabulary is also flagged when surfaced un-glossed on the question face. Membership is by
// CURATION, never a broad matcher ("opaque to a fresh user"): this hardcoded FLOOR is
// UNION'd with the glossary's `forbidden_abbreviations`, which are RESOLVED BY THE CALLER and
// INJECTED (this module stays PURE — no file read; the doc contract above is the ac-1 unit of
// evidence). The FLOOR holds (1) axis names as EXACT-LITERAL phrases — never broad-token/`\w+`,
// which regressed on Korean (see IDENTIFIER_PATTERNS note above); (2) a small EXPLICIT set of
// coined compounds (NOT open-ended); (3) curated schema field names in their UNDERSCORE form.
// The underscore form matters: the per-turn banner uses the SPACE form ("acceptance criteria")
// which must NOT be caught — only the schema/code form "acceptance_criteria" leaks.
//
// Glossary `aliases` and the glossary `term`s are DELIBERATELY EXCLUDED (coverage OBJ-1):
// aliases are "surface forms users/agents have USED" and include common words
// (event/source/projection/stem); terms include common words (run/evidence/request) — either
// would invert the field contract and false-positive on ordinary prose.
export const OPAQUE_VOCAB_FLOOR: readonly string[] = [
  // (1) axis names — EXACT-LITERAL phrases (Korean-safe; never a broad token match).
  '정합성 2축',
  'DITTO 기능 4축',
  // (2) coined compounds — a small explicit list, NOT open-ended.
  'supersedes chain',
  'surface projection',
  'follow-up materialization',
  // (3) curated schema field names in UNDERSCORE form (the space form must NOT match).
  'acceptance_criteria',
  'source_request',
  'drifted_sources',
];

// Scan for LITERAL opaque-vocab occurrences via indexOf — never a regex, so a metachar-bearing
// glossary entry can neither break the pattern nor backtrack (ReDoS/injection sidestepped
// entirely). A hit must satisfy the same identifier-boundary + ±40-char gloss rules as the
// shape-based patterns, so a nearby gloss lets it pass just like an identifier.
function findLiteralOpaqueVocab(text: string, vocab: readonly string[]): string[] {
  const found: string[] = [];
  for (const term of vocab) {
    if (term.length === 0) continue;
    for (let idx = text.indexOf(term); idx !== -1; idx = text.indexOf(term, idx + 1)) {
      const start = idx;
      const end = idx + term.length;
      if (!hasIdentifierBoundary(text, start, end)) continue;
      if (!isGlossed(text, start, end)) found.push(term);
    }
  }
  return found;
}

/**
 * Returns the unglossed internal identifiers surfaced in `s` (after stripping code): the
 * shape-based IDENTIFIER_PATTERNS PLUS the curated opaque-vocab — the hardcoded
 * {@link OPAQUE_VOCAB_FLOOR} unioned with the caller-injected `opaqueVocab` (the glossary's
 * forbidden_abbreviations, resolved by the caller so this stays pure). Pure and deterministic —
 * the unit of evidence for ac-1.
 */
export function findUnexplainedIdentifiers(
  s: string | undefined,
  opaqueVocab: readonly string[] = [],
): string[] {
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
  // Curated opaque vocabulary: the hardcoded floor + the caller-resolved glossary set.
  found.push(...findLiteralOpaqueVocab(text, OPAQUE_VOCAB_FLOOR));
  found.push(...findLiteralOpaqueVocab(text, opaqueVocab));
  return found;
}

/**
 * Returns `{ ok, violations }`. `ok` is true only when every required context field
 * is present and non-blank. Pure and deterministic — the unit of evidence for ac-2.
 */
export function validateQuestionContext(
  candidate: QuestionContextCandidate,
  // Caller-resolved glossary opaque-vocab (forbidden_abbreviations), unioned with the
  // hardcoded floor inside findUnexplainedIdentifiers. Default [] = floor-only.
  opaqueVocab: readonly string[] = [],
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
    ...findUnexplainedIdentifiers(candidate.text, opaqueVocab),
    ...findUnexplainedIdentifiers(candidate.user_explanation, opaqueVocab),
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

// --- ac-4 (wi_260713cx4, #27): branch-walking seam-detection --------------------
//
// A SEAM is where the current branch opens no further value-bearing dependent decision —
// the branch is exhausted, which is what licenses a blind full re-survey. This is the
// DRIVER-side judgment (the blind breadth generator stays transcript-free, ac-2). It reads
// the reference graph the driver aggregated from each turn's `branch_edges` (already
// integrity-guarded upstream) plus the latest turn's `branch_judgment`.
//
// FAIL-OPEN is the load-bearing property (failure-recovery / boundary-edge): `true` (seam →
// dry) is returned ONLY on a positive, corroborated signal. Any ambiguity or under-detection
// returns `false` (NOT a seam), so control falls through to the UNCONDITIONAL cap backstop —
// under-detection must never cause an early close. Concretely, a seam requires ALL of:
//   1. a per-turn judgment was actually recorded (undefined = detection didn't run → fail-open),
//   2. that judgment's `opened === false` (the schema's seam marker: this turn opened nothing),
//   3. no deferred value branch is still pending — every edge target (`to`) is already resolved.
// If any earlier-opened branch target remains unaddressed, a value branch still remains → not dry.
export interface BranchSeamInput {
  /** The aggregated reference graph (from→to edges), already integrity-guarded by the driver. */
  edges: readonly InterviewBranchEdge[];
  /** ids of dimensions/questions already answered/resolved (addressed decisions). */
  resolvedIds: readonly string[];
  /** The latest turn's per-turn branch judgment; `undefined` when the turn recorded none. */
  latestJudgment?: { opened: boolean; why?: string } | undefined;
}

export function isBranchSeam(input: BranchSeamInput): boolean {
  // (1) fail-open: no per-turn judgment recorded → detection didn't run / ambiguous → NOT dry.
  if (input.latestJudgment === undefined) return false;
  // (2) fail-open: the latest turn positively opened a further value branch → still walking.
  if (input.latestJudgment.opened) return false;
  // (3) a deferred value branch still pending (its target unaddressed) → NOT a seam.
  const resolved = new Set(input.resolvedIds);
  const hasPendingValueBranch = input.edges.some((e) => !resolved.has(e.to));
  if (hasPendingValueBranch) return false;
  // opened=false AND no pending value branch remains → SEAM (branch exhausted).
  return true;
}

// --- ac-5 (wi_260713cx4, #27): branch-walking continuity-ordering ---------------
//
// Order the pending questions/dimensions (branch follow-ups + fresh breadth) so a branch is
// WALKED CONTIGUOUSLY and region transitions happen only at a seam (after a whole branch is
// done), preferring topical adjacency to minimize context-switch cost. Pure and deterministic.
//
//  - A "branch" = the pending items connected (transitively, direction-ignored) by the
//    dependency edges. Items in the same branch are emitted together.
//  - Within a branch, order by dependency: `from` before `to` (topological). The driver
//    guards acyclicity upstream; any residual cycle degrades to stable input order.
//  - Between branches (the region switch, only ever at a branch boundary) pick greedily the
//    next branch with the most shared whole-token keywords with the just-finished branch —
//    reusing prism's `fragmentKeywords` whole-token tokenizer (wi_260708jnp "core in score"
//    lesson: never a word-internal substring match). Ties break by stable input order.
export interface OrderableItem {
  id: string;
  /** Topical text (label / notes / question) used for adjacency scoring. */
  text: string;
}

export function orderByContinuity(
  items: readonly OrderableItem[],
  edges: readonly InterviewBranchEdge[],
): OrderableItem[] {
  if (items.length === 0) return [];
  const index = new Map(items.map((it, i) => [it.id, i]));

  // Union-find over pending ids, joined by edges whose BOTH endpoints are pending items.
  const parent = new Map<string, string>(items.map((it) => [it.id, it.id]));
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) as string;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const e of edges) {
    if (index.has(e.from) && index.has(e.to)) union(e.from, e.to);
  }

  // Group items by component, preserving first-appearance order for the component and members.
  const components = new Map<string, OrderableItem[]>();
  const componentOrder: string[] = [];
  for (const it of items) {
    const root = find(it.id);
    let bucket = components.get(root);
    if (bucket === undefined) {
      bucket = [];
      components.set(root, bucket);
      componentOrder.push(root);
    }
    bucket.push(it);
  }

  // Order members within a component by dependency (from before to); stable on input order.
  const orderWithin = (members: OrderableItem[]): OrderableItem[] => {
    if (members.length <= 1) return members;
    const memberIds = new Set(members.map((m) => m.id));
    const indegree = new Map(members.map((m) => [m.id, 0]));
    const outgoing = new Map<string, string[]>(members.map((m) => [m.id, []]));
    for (const e of edges) {
      if (memberIds.has(e.from) && memberIds.has(e.to)) {
        indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
        (outgoing.get(e.from) as string[]).push(e.to);
      }
    }
    const byId = new Map(members.map((m) => [m.id, m]));
    // Ready = indegree 0, drained in stable input order (Kahn's algorithm).
    const ready = members.filter((m) => (indegree.get(m.id) ?? 0) === 0).map((m) => m.id);
    const out: OrderableItem[] = [];
    const emitted = new Set<string>();
    while (ready.length > 0) {
      const id = ready.shift() as string;
      if (emitted.has(id)) continue;
      emitted.add(id);
      out.push(byId.get(id) as OrderableItem);
      for (const to of (outgoing.get(id) as string[])
        .slice()
        .sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0))) {
        indegree.set(to, (indegree.get(to) ?? 0) - 1);
        if ((indegree.get(to) ?? 0) === 0) ready.push(to);
      }
    }
    // Degrade (residual cycle): append any not-yet-emitted members in stable input order.
    for (const m of members) if (!emitted.has(m.id)) out.push(m);
    return out;
  };

  const tokensOf = (members: OrderableItem[]): Set<string> =>
    new Set(members.flatMap((m) => fragmentKeywords(m.text)));

  // Walk components: start at the first (input-order) component, then greedily pick the next
  // by max whole-token overlap with the just-placed one; ties by stable input order.
  const remaining = new Set(componentOrder);
  const result: OrderableItem[] = [];
  let current = componentOrder[0] as string;
  while (true) {
    remaining.delete(current);
    const members = orderWithin(components.get(current) as OrderableItem[]);
    result.push(...members);
    if (remaining.size === 0) break;
    const currentTokens = tokensOf(members);
    let bestRoot: string | undefined;
    let bestOverlap = -1;
    for (const root of componentOrder) {
      if (!remaining.has(root)) continue;
      const candTokens = tokensOf(components.get(root) as OrderableItem[]);
      let overlap = 0;
      for (const t of candTokens) if (currentTokens.has(t)) overlap += 1;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestRoot = root;
      }
    }
    current = bestRoot as string;
  }
  return result;
}
