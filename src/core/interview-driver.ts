import { join } from 'node:path';
import { z } from 'zod';
import type { Autopilot } from '~/schemas/autopilot';
import type { CoverageMap } from '~/schemas/coverage';
import { type IntentContract, intentAcceptanceCriterion } from '~/schemas/intent';
import {
  type InterviewBranchEdge,
  type InterviewDimension,
  type InterviewDissent,
  type InterviewState,
  type PremortemItem,
  answerSelfReport,
  dimensionState,
  infoGain,
  interviewBranchEdge,
  interviewQuestion,
  premortemItem,
  userConfirmation,
} from '~/schemas/interview-state';
import { selfAnswerAttempt } from '~/schemas/question-gate';
import type { WorkItem } from '~/schemas/work-item';
import { bootstrapAutopilot } from './autopilot-bootstrap';
import { nextCoverageNode, recordCoverageRound } from './coverage-loop';
import { DEFAULT_DRY_K, recordDryRound, serializePlanDialog } from './coverage-manager';
import { CoverageStore } from './coverage-store';
import { loadFarFieldTaxonomy, warnMalformedTaxonomy } from './coverage-taxonomy';
import { localDir } from './ditto-paths';
import { readJson, writeJson } from './fs';
import { type GateResult, type RiskAxes, deriveClosureMode, interviewReadinessGate } from './gates';
import { IntentStore } from './intent-store';
import { engageIntentDissent, mergeDissent } from './interview-dissent';
import { InterviewStore } from './interview-store';
import { loadGlossaryVocab, warnMalformedGlossary } from './knowledge-bridge';
import { type IntentFragment, fragmentKeywords } from './prism/engine';
import { OPPONENT_FANOUT_CAP, type OpponentSeamConfig } from './prism/opponent';
import {
  type OrderableItem,
  findUnexplainedIdentifiers,
  isBranchSeam,
  normalizePresentedText,
  orderByContinuity,
  validateQuestionContext,
} from './question-context';
import { WorkItemStore } from './work-item-store';

/**
 * Deep-interview driver (§6.3). Pure orchestration of InterviewState +
 * intent.json + work item AC mirror. The LLM owns *what* to ask and *how* to
 * interpret answers; the driver owns the schema-validated state machine.
 *
 * Lifecycle:
 *   start ── (record-turn)* ── check-readiness ── finalize
 *                                              ↓
 *                              writes intent.json + mirrors work item AC
 *                              and (per AC-3) calls bootstrapAutopilot
 *
 * All writes are atomic + schema-validated through the stores.
 */

const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_QUESTION_CAP = 8;
// Fan-out lever default: 1 generator = serial-equivalent (a small request stays
// lightweight, ac-4). >1 fans out parallel fresh-context generators in the SKILL loop.
const DEFAULT_GENERATORS = 1;
// Dry floor: a round whose score-gated marginal_gain falls below this is treated
// as diminishing returns. Raised from 0.05 (which almost never fired, so low-value
// tail rounds kept asking the user) to a level where a round's incremental
// information no longer justifies another user turn — closes tail rounds earlier
// without touching question quality (the floor gates termination, not the questions).
const DRY_FLOOR = 0.12;

// ── turn-marker filtering (wi_260723lny, ac-5 constraint-2) ──────────────────
// `turn_kind` classifies a recorded question as FIRED (asked at the user) or INTERNAL
// (agent-only reasoning). ABSENT ⇒ fired: every legacy question with no marker counts as a
// fired turn, so questions[]-derived accounting (questions_asked, the assumption-ratio
// denominator, the novelty dry-counter) is unchanged for pre-existing state. Internal turns
// are FILTERED OUT of every fired-turn count so a reasoning turn never pollutes the accounting
// or silently consumes a user-facing slot.
type TurnMarked = { turn_kind?: 'fired' | 'internal' | undefined };
function isFiredTurn(q: TurnMarked): boolean {
  return q.turn_kind !== 'internal';
}

/** Count of FIRED turns (legacy-absent marker = fired). */
function firedTurnCount(questions: ReadonlyArray<TurnMarked>): number {
  return questions.reduce((n, q) => (isFiredTurn(q) ? n + 1 : n), 0);
}

// ── post-answer intent summary (wi_260723lny, ac-4) ──────────────────────────
// Confirmed/open split of the intent as understood SO FAR, returned to the CLI after a user
// answer so the user sees the intent converging (deep-interview path only). Purely derived
// from the recorded dimensions — NOT persisted (no schema field) and NOT on the finalize path
// (finalizeInterview stays callable without per-answer summaries; prism finalizeFromDesignDoc
// is unaffected).
export interface IntentSummary {
  /** Resolved ambiguity dimensions — the intent points now settled. */
  confirmed: string[];
  /** Still-unresolved ambiguity dimensions — the intent points still open. */
  open: string[];
}

function summarizeIntent(state: InterviewState): IntentSummary {
  const label = (d: InterviewDimension): string => d.notes.trim() || d.id;
  return {
    confirmed: state.dimensions.filter((d) => d.state === 'resolved').map(label),
    open: state.dimensions.filter((d) => d.state !== 'resolved').map(label),
  };
}

// ── finite-termination fire-rejection counter (wi_260723lny, ac-5) ───────────
// The question CAP is removed as a terminator (see recordTurn below); the finite-termination
// backstop is a PERSISTENT MONOTONE counter of fire REJECTIONS. Both rejection paths advance
// it — recordTurn's write-path reject and the CLI check-question reject (via the exported
// recordFireRejection) — so a fire-impossible worst case cannot livelock: at bound K the
// interview transitions to a NON-terminating 'parked' surface exposing the unresolved set
// instead of rejecting forever (finalize is NOT reached, status stays 'active', NOT converged).
// The interview-state schema is frozen, so the counter lives in its own sidecar next to
// interview-state.json.
const fireRejectionState = z.object({
  attempts: z.number().int().nonnegative().default(0),
});
const FIRE_REJECTION_BOUND = DEFAULT_DRY_K;

function fireRejectionPath(repoRoot: string, workItemId: string): string {
  return join(localDir(repoRoot, 'work-items', workItemId), 'interview-fire-rejections.json');
}

async function bumpFireRejections(repoRoot: string, workItemId: string): Promise<number> {
  const path = fireRejectionPath(repoRoot, workItemId);
  let attempts = 0;
  if (await Bun.file(path).exists()) {
    try {
      attempts = (await readJson(path, fireRejectionState)).attempts;
    } catch {
      attempts = 0; // corrupt sidecar → restart the count (fail-open, never crash the fire path)
    }
  }
  const next = attempts + 1;
  await writeJson(path, fireRejectionState, { attempts: next });
  return next;
}

export interface FireRejectionResult {
  attempts: number;
  bound: number;
  parked: boolean;
  /** ALL unresolved ambiguity dimensions (NOT critical-only) — the set surfaced when parked. */
  unresolved: string[];
  /** The written non-terminating parked state; present only when parked. */
  state?: InterviewState;
}

/**
 * Record ONE fire rejection and advance the persistent monotone counter (ac-5 finite
 * termination). Shared by recordTurn's write-path reject and the CLI check-question reject (the
 * hand-off: the CLI node calls this on a rejected candidate). At bound K it writes the
 * NON-terminating 'parked' surface (exit.reason='parked', status stays 'active', finalize NOT
 * reached) exposing EVERY unresolved dimension (not critical-only), and returns parked:true — so
 * a fire-impossible worst case surfaces the unresolved set instead of livelocking on repeated
 * rejections. A subsequent successful fired turn clears the parked exit.reason via recordTurn's
 * normal write; the monotone counter is unaffected.
 */
export async function recordFireRejection(
  repoRoot: string,
  workItemId: string,
  now?: Date,
): Promise<FireRejectionResult> {
  const attempts = await bumpFireRejections(repoRoot, workItemId);
  const store = new InterviewStore(repoRoot);
  const state = await store.get(workItemId);
  const unresolved = state.dimensions.filter((d) => d.state !== 'resolved').map((d) => d.id);
  if (attempts >= FIRE_REJECTION_BOUND && state.status === 'active') {
    const parked = await store.write({
      ...state,
      updated_at: (now ?? new Date()).toISOString(),
      exit: {
        ...state.exit,
        reason: 'parked',
        closure_mode: deriveClosureMode('parked', false),
      },
    });
    return { attempts, bound: FIRE_REJECTION_BOUND, parked: true, unresolved, state: parked };
  }
  return { attempts, bound: FIRE_REJECTION_BOUND, parked: false, unresolved };
}

export interface StartInput {
  workItemId: string;
  threshold?: number;
  questionCap?: number;
  /** Fan-out count for the SKILL question-generator loop (default 1 = serial-equivalent). */
  generators?: number;
  /**
   * 기제 C (wi_260706n4w): seed each `user-intent`-disposition far-field category
   * (resolved taxonomy: floor + tier-② config) as an interview DIMENSION so the
   * user answers it at the intent stage. Seeds are non-critical + `unknown` —
   * fail-open (ac-4): an unanswered seed never blocks readiness, projects as an
   * OPEN closeable `cov-dim-*` node, and the category stays in the plan-stage
   * sweep; only an actual interview resolution closes it. Default false so every
   * existing caller is unchanged (ac-6); the CLI `deep-interview start` seam
   * enables it (same pattern as coverage-loop `seedCategories` + coverage-next).
   */
  seedUserIntentDimensions?: boolean;
  now?: Date;
}

export async function startInterview(
  repoRoot: string,
  input: StartInput,
): Promise<InterviewState & { generators: number }> {
  const now = (input.now ?? new Date()).toISOString();
  const generators = input.generators ?? DEFAULT_GENERATORS;
  // 기제 C: user-intent categories become closeable interview dimensions. The lens
  // rides `notes` so the interviewer sees the probing question and the projected
  // cov-dim node inherits it as its label (projectInterviewDimensions).
  const seededDimensions = input.seedUserIntentDimensions
    ? (await loadFarFieldTaxonomy(repoRoot, () => warnMalformedTaxonomy(repoRoot)))
        .filter((c) => c.disposition === 'user-intent')
        .map((c) => ({
          id: c.id,
          critical: false,
          state: 'unknown' as const,
          ambiguity: 1,
          resolved_by: [],
          notes: c.lens,
        }))
    : [];
  const initial: InterviewState = {
    schema_version: '0.1.0',
    work_item_id: input.workItemId,
    status: 'active',
    started_at: now,
    updated_at: now,
    dimensions: seededDimensions,
    readiness: {
      score: 0,
      threshold: input.threshold ?? DEFAULT_THRESHOLD,
      critical_unresolved: [],
      gate: 'blocked',
    },
    questions: [],
    assumptions: [],
    premortem: [],
    exit: {
      reason: 'readiness_met',
      // placeholder until a terminal closure; gate starts blocked (score 0).
      closure_mode: deriveClosureMode('readiness_met', false),
      question_cap: input.questionCap ?? DEFAULT_QUESTION_CAP,
      questions_asked: 0,
    },
  };
  // generators is a SKILL-loop lever (the fan-out count the driver agent reads),
  // not a persisted InterviewState field — return it alongside the written state
  // so the CLI/SKILL can surface the resolved value.
  const written = await new InterviewStore(repoRoot).write(initial);
  return { ...written, generators };
}

// Single JSON payload for record-turn — keeps the CLI surface narrow and lets
// the LLM batch dimension upsert + question append + answer in one call.
export const recordTurnPayload = z
  .object({
    dimension: z
      .object({
        id: z.string().min(1),
        critical: z.boolean().default(false),
        state: dimensionState.default('partial'),
        ambiguity: z.number().min(0).max(1).default(0.5),
        notes: z.string().default(''),
      })
      .describe('Dimension to upsert (created if absent, fields merged if present)'),
    question: z
      .object({
        text: z.string().min(1),
        why_matters: z.string().min(1),
        info_gain_estimate: infoGain,
        // Presentation-contract context (wi_260622ph8): the comprehensible,
        // decision-sufficient context carried WITH the question. Optional here so
        // existing callers parse unchanged; the gate (check-question) enforces
        // user_explanation before a question is asked.
        user_explanation: z.string().min(1).optional(),
        // recommended_answer (impl-di-recommended-answer, ac-1/ac-3). Optional on the payload
        // so callers parse unchanged; the check-question gate (validateQuestionContext, run on
        // the write path below) hard-requires it before a question is asked.
        recommended_answer: z.string().min(1).optional(),
        background: z.string().min(1).optional(),
        grounding: z.string().min(1).optional(),
        // Sources the agent checked before asking (§6.2). The driver persists these
        // instead of the previous hardcoded empty array, so "why we ask" is backed
        // by "what we already checked".
        self_answer_attempts: z.array(selfAnswerAttempt).optional(),
        marginal_gain: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            'Score-gated marginal information gain of this round; low value across a round is the dry signal',
          ),
        // wi_260709d00 (#14): did this round add admissible novelty? The angle-exhaustion
        // signal, carried per turn exactly like marginal_gain; the driver folds it into the
        // deterministic novelty dry-counter for the termination decision.
        novelty: z
          .boolean()
          .optional()
          .describe('Whether this round added admissible novelty (angle-exhaustion axis)'),
        // Branch-walking (wi_260713cx4, #27, ac-1). The DRIVER — holding the transcript — is
        // the only origin of a branch follow-up; the blind breadth generator stays
        // transcript-free (ac-2). `branch_edges` = dependency edges this answer opened
        // (positive pole); `branch_judgment` = the per-turn seam marker + audit trace (opened
        // + why). Both additive-optional so existing callers parse unchanged. The driver runs
        // its fail-closed referential-integrity guard on the aggregated edges before they
        // influence termination (shape ≠ integrity — zod cannot see the interview state).
        branch_edges: z.array(interviewBranchEdge).optional(),
        branch_judgment: z
          .object({ opened: z.boolean(), why: z.string().min(1).optional() })
          .optional(),
        // Turn classification (wi_260723lny, ac-5). ABSENT ⇒ 'fired'. An 'internal' turn is
        // agent-only reasoning that must NOT pollute fired-turn accounting (questions_asked,
        // assumption-ratio denominator, novelty dry-counter); the driver filters it out of every
        // fired-turn count and never applies the intent-fidelity fire-block to it.
        turn_kind: z.enum(['fired', 'internal']).optional(),
        // ac-3 layer-2 intent-fidelity judgment. WHETHER a fired question distorts / shrinks /
        // bias-injects the original intent is the LLM layer's judgment (the axis the
        // question-generator/gate prompts already express); the driver is the deterministic
        // enforcement point. Additive-optional: absent ⇒ no block (legacy callers parse
        // unchanged). `preserves_intent:false` on a fired turn blocks the fire.
        intent_fidelity: z
          .object({
            preserves_intent: z.boolean(),
            basis: z.string().min(1).optional(),
          })
          .optional(),
      })
      .describe('The asked question and why it matters'),
    answer: z
      .object({
        text: z.string().min(1),
        kind: z.enum(['user', 'assumption']),
        // An assumption is by default the agent's own guess. `delegated:true` marks
        // it as an explicit user delegation ("you decide") — the only case in which
        // an assumption-kind answer is allowed to close a CRITICAL dimension.
        delegated: z.boolean().optional(),
        ambiguity_delta: z.number().optional(),
        // User's decision-ability self-report (presentation-sufficiency signal).
        self_report: answerSelfReport.optional(),
      })
      .optional(),
    readiness_score: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('LLM self-reported readiness after this turn (floor-capped by the gate)'),
  })
  .describe('One interview turn — dimension upsert + question append + optional answer');

export type RecordTurnPayload = z.infer<typeof recordTurnPayload>;

export interface RecordTurnInput {
  workItemId: string;
  payload: RecordTurnPayload;
  now?: Date;
}

// ── Branch-walking reference graph (wi_260713cx4, #27) ───────────────────────────
//
// The branch dependency graph is the FIRST reference graph in interview-state. It is
// reconstructed from disk (each turn's questions[].branch_edges), never stored as a
// mutable aggregate — same principle as the novelty dry-counter.

/** All branch edges opened across the interview (aggregated from every turn, append-only). */
function aggregateBranchEdges(state: InterviewState): InterviewBranchEdge[] {
  return state.questions.flatMap((q) => q.branch_edges ?? []);
}

/** ids of decisions already addressed — resolved dimensions + answered questions. */
function branchResolvedIds(state: InterviewState): string[] {
  return [
    ...state.dimensions.filter((d) => d.state === 'resolved').map((d) => d.id),
    ...state.questions.filter((q) => q.answer !== undefined).map((q) => q.id),
  ];
}

/**
 * Fail-closed referential-integrity guard for the branch reference graph (input-validation
 * constraint) — mirrors the dissent/premortem membership guards (interview-state.ts:47-63):
 * zod validates edge SHAPE only; referential integrity (target ∈ known ids, no self-edge,
 * acyclic) is not shape and must be enforced HERE, before an edge influences termination.
 * Pure and TOTAL (never throws): an offending edge is DROPPED (fail-open to no-edge), so a
 * malformed graph degrades to fewer edges, never a crash or an early close. Returns the valid
 * DAG subset in input order.
 */
export function guardBranchEdges(
  edges: readonly InterviewBranchEdge[],
  knownIds: ReadonlySet<string>,
): InterviewBranchEdge[] {
  const kept: InterviewBranchEdge[] = [];
  // Adjacency over already-kept edges; a new from→to is a cycle iff `from` is reachable from `to`.
  const adj = new Map<string, Set<string>>();
  const reaches = (start: string, target: string): boolean => {
    const stack = [start];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const node = stack.pop() as string;
      if (node === target) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      for (const next of adj.get(node) ?? []) stack.push(next);
    }
    return false;
  };
  for (const e of edges) {
    if (e.from === e.to) continue; // self-edge → reject
    if (!knownIds.has(e.from) || !knownIds.has(e.to)) continue; // dangling endpoint → reject
    if (reaches(e.to, e.from)) continue; // would close a cycle → reject
    kept.push(e);
    let out = adj.get(e.from);
    if (out === undefined) {
      out = new Set();
      adj.set(e.from, out);
    }
    out.add(e.to);
  }
  return kept;
}

/**
 * Value-exhaustion signal (ac-6): all value branches spent (isBranchSeam) AND the seam
 * re-survey has been dry for K rounds (recordDryRound over the per-turn branch_judgment
 * sequence). This is the GOVERNING close signal for branch-walking; it only *suggests* a close
 * (finalize still requires readiness ∧ user confirmation) and is emitted as the existing
 * 'diminishing_returns' reason — never a new enum value. FAIL-OPEN and TOTAL: any integrity
 * error, under-detection, or missing judgment yields `false`, so control falls through without
 * a close — under-detection must never cause an early close.
 */
function isValueExhausted(state: InterviewState): boolean {
  try {
    const knownIds = new Set<string>([
      ...state.dimensions.map((d) => d.id),
      ...state.questions.map((q) => q.id),
    ]);
    const edges = guardBranchEdges(aggregateBranchEdges(state), knownIds);
    const lj = state.questions[state.questions.length - 1]?.branch_judgment;
    const seam = isBranchSeam({
      edges,
      resolvedIds: branchResolvedIds(state),
      latestJudgment:
        lj !== undefined
          ? { opened: lj.opened, ...(lj.why !== undefined ? { why: lj.why } : {}) }
          : undefined,
    });
    if (!seam) return false;
    // Seam-dry counter reconstructed from disk (REUSING recordDryRound, not a hand-rolled
    // parallel counter): a turn that OPENED a branch resets; a seam turn (opened===false) is a
    // dry round; a missing judgment (opened===undefined) resets → legacy rounds never accrue
    // dry (fail-open). K = DEFAULT_DRY_K, shared with the coverage/novelty axes.
    const seamDry = state.questions.reduce(
      (counter, q) =>
        recordDryRound(counter, {
          admissibleBranchesAdded: q.branch_judgment?.opened === false ? 0 : 1,
        }),
      0,
    );
    return seamDry >= DEFAULT_DRY_K;
  } catch {
    return false; // fail-open: any error → NOT value-exhausted → interview stays open.
  }
}

/** The ordered pending branch work + the open critical branches that gate closure. */
export interface BranchWorkOrder {
  /** Pending (unresolved) dimensions in continuity order — a branch walked contiguously. */
  ordered: OrderableItem[];
  /** Open critical branch targets: value-bearing branches that MUST NOT be starved. */
  criticalBranchesOpen: string[];
}

/**
 * Order the pending interview work so a branch is WALKED CONTIGUOUSLY (orderByContinuity) with
 * region transitions only at a seam — and enforce order-NOT-drop (ac-3): a value-bearing
 * critical branch may be reordered/deferred but is NEVER dropped by breadth candidates
 * (orderByContinuity is a permutation — every pending item survives). `criticalBranchesOpen`
 * is the "cannot reach shared-understanding while such a branch is open" signal: while it is
 * non-empty, the edge target stays unresolved so isBranchSeam returns false and
 * value-exhaustion cannot fire — the branch is never silently starved. Pure.
 */
export function orderPendingBranchWork(state: InterviewState): BranchWorkOrder {
  const knownIds = new Set<string>([
    ...state.dimensions.map((d) => d.id),
    ...state.questions.map((q) => q.id),
  ]);
  const edges = guardBranchEdges(aggregateBranchEdges(state), knownIds);
  const pending: OrderableItem[] = state.dimensions
    .filter((d) => d.state !== 'resolved')
    .map((d) => ({ id: d.id, text: d.notes || d.id }));
  const ordered = orderByContinuity(pending, edges);
  const branchTargets = new Set(edges.map((e) => e.to));
  const criticalBranchesOpen = state.dimensions
    .filter((d) => d.critical && d.state !== 'resolved' && branchTargets.has(d.id))
    .map((d) => d.id);
  return { ordered, criticalBranchesOpen };
}

export async function recordTurn(
  repoRoot: string,
  input: RecordTurnInput,
): Promise<InterviewState & { intent_summary?: IntentSummary }> {
  const store = new InterviewStore(repoRoot);
  const current = await store.get(input.workItemId);
  // ac-3 layer-1 anchor source: the verbatim ORIGINAL user utterance lives on the Record.
  const workItem = await new WorkItemStore(repoRoot).get(input.workItemId);
  const nowIso = (input.now ?? new Date()).toISOString();
  const { dimension: rawDimension, question, answer, readiness_score } = input.payload;

  // ac-1: presentation-contract gate on the WRITE path. Reject a bad turn BEFORE persist by
  // running the existing pure validators (question-context.ts) on the USER-REACHING face
  // ONLY — question.text + question.user_explanation. A missing/blank user_explanation
  // (validateQuestionContext) or an un-glossed internal identifier surfaced to the user
  // (findUnexplainedIdentifiers) is a bad turn. SCOPE: answer.text and dimension.notes are
  // NOT checked — they legitimately carry internal vocabulary (wi_/ac-). The thrown Error
  // NAMES what tripped it (violation field+reason AND the leaked identifiers), never a bare
  // "rejected", so the caller can fix the exact surface.
  // Resolve the glossary opaque-vocab (forbidden_abbreviations) ONCE at this consumer site
  // (wi_260714aaq, #29) — this recordTurn call IS the deep-interview QUESTION face, the HARD
  // gate. Unioned with the detector's hardcoded floor; a bad glossary fails open to floor-only
  // WITH a warning (never silent, never a crash of the interview gate).
  const opaqueVocab = await loadGlossaryVocab(repoRoot, () => warnMalformedGlossary(repoRoot));
  // Display-time seam (ac-2): normalize the user-facing fields (text / user_explanation /
  // recommended_answer) via normalizePresentedText ONCE, then both VALIDATE and PERSIST the
  // SAME normalized text — closing the "validate one form, persist another" gap. why_matters /
  // background / grounding are not user-default surfaces, so they are left as-is.
  const normalizedText = normalizePresentedText(question.text);
  const normalizedUserExplanation =
    question.user_explanation !== undefined
      ? normalizePresentedText(question.user_explanation)
      : undefined;
  const normalizedRecommendedAnswer =
    question.recommended_answer !== undefined
      ? normalizePresentedText(question.recommended_answer)
      : undefined;
  const surfaceVerdict = validateQuestionContext(
    {
      text: normalizedText,
      why_matters: question.why_matters,
      user_explanation: normalizedUserExplanation,
      recommended_answer: normalizedRecommendedAnswer,
    },
    opaqueVocab,
  );
  const leakedIdentifiers = [
    ...findUnexplainedIdentifiers(normalizedText, opaqueVocab),
    ...findUnexplainedIdentifiers(normalizedUserExplanation, opaqueVocab),
  ];
  if (!surfaceVerdict.ok || leakedIdentifiers.length > 0) {
    const violations = surfaceVerdict.violations.map((v) => `${v.field}: ${v.reason}`).join('; ');
    const leaked =
      leakedIdentifiers.length > 0
        ? ` | leaked identifiers: ${[...new Set(leakedIdentifiers)].join(', ')}`
        : '';
    // Layer-1 (presentation contract) reject. Route through the finite-termination counter:
    // at bound K return the non-terminating parked surface instead of throwing (no livelock).
    const rejection = await recordFireRejection(repoRoot, input.workItemId, input.now);
    if (rejection.parked && rejection.state !== undefined) return rejection.state;
    throw new Error(
      `record-turn rejected: question surface failed the presentation contract before persist — violations: ${violations}${leaked} | fire attempts ${rejection.attempts}/${rejection.bound}`,
    );
  }

  // ac-3 layer-2 (independent of layer-1): a FIRED turn whose question would distort / shrink /
  // bias-inject the ORIGINAL intent is blocked at the write path. WHETHER a question distorts the
  // intent is the LLM layer's judgment, carried on the payload as `intent_fidelity` (the axis the
  // question-generator/gate prompts already express); this is the deterministic enforcement
  // point. Internal (non-fired) turns never reach the user, so the block does not apply to them.
  // Absent judgment ⇒ no block (fail-open, legacy callers parse unchanged). Same finite-
  // termination routing as layer-1: at bound K, park instead of throw.
  const firedTurn = question.turn_kind !== 'internal';
  if (firedTurn && question.intent_fidelity?.preserves_intent === false) {
    const basis = question.intent_fidelity.basis ? ` — ${question.intent_fidelity.basis}` : '';
    const rejection = await recordFireRejection(repoRoot, input.workItemId, input.now);
    if (rejection.parked && rejection.state !== undefined) return rejection.state;
    throw new Error(
      `record-turn rejected: fired question would distort/shrink/bias-inject the original intent (2nd-layer intent-fidelity block)${basis} | fire attempts ${rejection.attempts}/${rejection.bound}`,
    );
  }

  // Soundness invariant (deep-interview readiness gate): an agent-guessed answer
  // — assumption-kind and NOT user-delegated — must not close a CRITICAL dimension
  // as `resolved`. Otherwise the gate (gates.ts: critical && state!=='resolved')
  // cannot tell an agent's guess apart from a user's answer. We demote the state to
  // 'partial' so the existing hard-block fires; user-delegated assumptions pass.
  const existingDim = current.dimensions.find((d) => d.id === rawDimension.id);
  const isCritical = rawDimension.critical || existingDim?.critical || false;
  const isAgentGuess = answer?.kind === 'assumption' && answer.delegated !== true;
  const dimension =
    isAgentGuess && isCritical && rawDimension.state === 'resolved'
      ? { ...rawDimension, state: 'partial' as const }
      : rawDimension;
  const nextDimensions = existingDim
    ? current.dimensions.map((d) =>
        d.id === dimension.id
          ? {
              ...d,
              critical: dimension.critical || d.critical,
              state: dimension.state,
              ambiguity: dimension.ambiguity,
              notes: dimension.notes || d.notes,
              resolved_by: dimension.state === 'resolved' ? [...d.resolved_by] : d.resolved_by,
            }
          : d,
      )
    : [
        ...current.dimensions,
        {
          id: dimension.id,
          critical: dimension.critical,
          state: dimension.state,
          ambiguity: dimension.ambiguity,
          resolved_by: [],
          notes: dimension.notes,
        },
      ];

  // Append the question — id is a simple monotonic counter within the
  // interview (q001, q002, ...) so it's stable across re-reads and reviewers.
  const qId = `q${(current.questions.length + 1).toString().padStart(3, '0')}`;
  const appendedQuestion = interviewQuestion.parse({
    id: qId,
    asked_at: nowIso,
    dimension: dimension.id,
    // Persist the NORMALIZED user-facing text (ac-2) — the same form that was validated above,
    // so the presentation gate and the durable record never diverge.
    question: normalizedText,
    why_matters: question.why_matters,
    info_gain_estimate: question.info_gain_estimate,
    // Persist the self-answer ledger from the payload (was hardcoded `[]`), so the
    // "we checked X first" evidence behind asking the user survives (wi_260622ph8).
    self_answer_attempts: question.self_answer_attempts ?? [],
    // ac-3 layer-1 anchor: driver-fill the verbatim ORIGINAL user utterance from the Record into
    // the scan-EXEMPT tier (peer of why_matters / answer / dimension notes). It is NEVER an agent
    // free-text field and is NOT run through the leak scan, so §/ADR/wi_ text in the user's own
    // words never false-trips the presentation gate. Control chars are still stripped (display
    // hygiene, mirroring the user-facing normalization above); skipped when the Record's
    // source_request is empty so the schema's non-empty constraint is never tripped.
    ...(normalizePresentedText(workItem.source_request).trim().length > 0
      ? { source_anchor: normalizePresentedText(workItem.source_request) }
      : {}),
    // Turn classification (wi_260723lny, ac-5): persist the fired/internal marker so every
    // fired-turn count filters internal turns out (legacy-absent marker = fired).
    ...(question.turn_kind !== undefined ? { turn_kind: question.turn_kind } : {}),
    // Presentation-contract context carried with the question (wi_260622ph8), persisted in its
    // normalized (display-clean) form (ac-2).
    ...(normalizedUserExplanation !== undefined
      ? { user_explanation: normalizedUserExplanation }
      : {}),
    ...(normalizedRecommendedAnswer !== undefined
      ? { recommended_answer: normalizedRecommendedAnswer }
      : {}),
    ...(question.background !== undefined ? { background: question.background } : {}),
    ...(question.grounding !== undefined ? { grounding: question.grounding } : {}),
    ...(question.marginal_gain !== undefined ? { marginal_gain: question.marginal_gain } : {}),
    ...(question.novelty !== undefined ? { novelty: question.novelty } : {}),
    // Branch-walking (wi_260713cx4, #27): persist this turn's opened edges + seam judgment on
    // the append-only question. Append-only placement (not a mutable dimension field) is what
    // structurally prevents the mid-interview stale the whitelist-merge guards against — each
    // turn records its own fresh branch state; the driver reconstructs the reference graph +
    // seam-dry decision from disk (same principle as novelty / marginal_gain).
    ...(question.branch_edges !== undefined ? { branch_edges: question.branch_edges } : {}),
    ...(question.branch_judgment !== undefined
      ? {
          branch_judgment: {
            opened: question.branch_judgment.opened,
            ...(question.branch_judgment.why !== undefined
              ? { why: question.branch_judgment.why }
              : {}),
          },
        }
      : {}),
    ...(answer
      ? {
          answer: answer.text,
          answer_kind: answer.kind,
          ...(answer.ambiguity_delta !== undefined
            ? { ambiguity_delta: answer.ambiguity_delta }
            : {}),
          ...(answer.self_report !== undefined ? { answer_self_report: answer.self_report } : {}),
        }
      : {}),
  });
  // resolved_by tracking: if the answer resolves the dimension, record the q id.
  const dimensionsWithResolution =
    answer && dimension.state === 'resolved'
      ? nextDimensions.map((d) =>
          d.id === dimension.id ? { ...d, resolved_by: [...d.resolved_by, qId] } : d,
        )
      : nextDimensions;

  // Assumption ledger: an 'assumption' answer adds to assumptions[].
  const nextAssumptions =
    answer?.kind === 'assumption'
      ? [
          ...current.assumptions,
          {
            statement: answer.text,
            label: 'hypothesis' as const,
            confidence: 'medium' as const,
            because_no_answer_to: qId,
          },
        ]
      : current.assumptions;

  const updated: InterviewState = {
    ...current,
    updated_at: nowIso,
    dimensions: dimensionsWithResolution,
    questions: [...current.questions, appendedQuestion],
    assumptions: nextAssumptions,
    readiness: {
      ...current.readiness,
      ...(readiness_score !== undefined ? { score: readiness_score } : {}),
      critical_unresolved: dimensionsWithResolution
        .filter((d) => d.critical && d.state !== 'resolved')
        .map((d) => d.id),
    },
    exit: {
      ...current.exit,
      // questions_asked counts FIRED turns only (ac-5 constraint-2): an internal turn never
      // consumes a user-facing slot. Legacy-absent marker = fired, so pre-existing state counts
      // exactly as before. This is the value intent-quality-doctor D4 reads (exit.questions_asked).
      questions_asked: firedTurnCount([...current.questions, appendedQuestion]),
    },
  };
  // Recompute the gate state but keep status='active' here — finalize toggles
  // status='converged'.
  const gateResult = interviewReadinessGate(updated);
  updated.readiness.gate = gateResult.pass ? 'ready' : 'blocked';
  // Reaching this point means the turn was NOT rejected — firing is no longer impossible, so a
  // prior 'parked' fire-impossible surface (ac-5) is cleared. 'parked' is a transient marker
  // written only by the rejection path (recordFireRejection), never a terminal state.
  if (updated.exit.reason === 'parked') {
    updated.exit.reason = 'readiness_met';
  }
  // Two COMPLEMENTARY dry axes signal diminishing returns (wi_260709d00 #14), combined by
  // OR — close when EITHER is exhausted, never make closing harder (this is a user loop):
  //   • value-dry: this round's score-gated marginal_gain fell below the dry floor.
  //   • angle-dry: novelty exhausted — K consecutive rounds added no admissible novelty.
  // The novelty dry-counter is RECONSTRUCTED deterministically from disk (the recorded
  // questions[].novelty sequence) via coverage's recordDryRound — no stored cumulative
  // counter (same principle as coverage). A round with novelty!==false (true OR absent)
  // resets the counter, so legacy/unmeasured rounds never force an early close (fail-open).
  // Reconstruct the novelty dry-counter over FIRED turns only (ac-5 constraint-2): an internal
  // turn is not a fired round, so it must not advance/pollute the angle-exhaustion counter.
  const noveltyDryCounter = updated.questions
    .filter(isFiredTurn)
    .reduce(
      (counter, q) =>
        recordDryRound(counter, { admissibleBranchesAdded: q.novelty === false ? 0 : 1 }),
      0,
    );
  const valueDry = question.marginal_gain !== undefined && question.marginal_gain < DRY_FLOOR;
  const angleDry = noveltyDryCounter >= DEFAULT_DRY_K;
  // Branch-walking value-exhaustion (wi_260713cx4, #27, ac-6): a THIRD dry axis, OR'd in like
  // the others. All value branches spent (isBranchSeam) AND the seam re-survey dry for K rounds
  // → the branch tree is walked out. FAIL-OPEN by construction (isValueExhausted returns false
  // on any under-detection / error), so it can only ADD a close, never force one. Emitted as the
  // EXISTING 'diminishing_returns' — no new enum value.
  const valueExhausted = isValueExhausted(updated);
  // ac-5: the question CAP no longer TERMINATES. Termination is governed by "all raised questions
  // (unresolved ambiguity) resolved" — i.e. the readiness gate ∧ user confirmation enforced at
  // finalize; a still-blocked gate keeps the interview open regardless of questions_asked. The
  // finite-termination backstop for a fire-impossible worst case is the persistent monotone
  // fire-rejection counter (recordFireRejection → 'parked'), NOT a mechanical cap terminate. The
  // dry axes still *suggest* a diminishing-returns close; finalize is never bypassed by them.
  if ((valueDry || angleDry || valueExhausted) && !gateResult.pass && updated.status === 'active') {
    updated.exit.reason = 'diminishing_returns';
  }
  // Keep closure_mode consistent with the current (reason, gate): a diminishing close while the
  // gate is still blocked is ledger_only, not mutual_agreement.
  updated.exit.closure_mode = deriveClosureMode(updated.exit.reason, gateResult.pass);
  const written = await store.write(updated);
  // ac-4: after a USER answer, return the confirmed/open intent summary so the CLI can reflect
  // the converging intent back to the user (deep-interview path only). Additive-optional on the
  // return — the finalize path never produces or requires it (prism stays unaffected).
  return answer?.kind === 'user'
    ? { ...written, intent_summary: summarizeIntent(written) }
    : written;
}

export interface CheckReadinessResult {
  state: InterviewState;
  gate: GateResult;
  /** Critical dimension ids still unresolved; empty when gate passes. */
  critical_unresolved: string[];
  cap_reached: boolean;
}

export async function checkReadiness(
  repoRoot: string,
  workItemId: string,
): Promise<CheckReadinessResult> {
  const state = await new InterviewStore(repoRoot).get(workItemId);
  const gate = interviewReadinessGate(state);
  return {
    state,
    gate,
    critical_unresolved: state.dimensions
      .filter((d) => d.critical && d.state !== 'resolved')
      .map((d) => d.id),
    cap_reached: state.exit.questions_asked >= state.exit.question_cap,
  };
}

// Finalize payload — the intent fields synthesized by the LLM from the
// interview record. driver enforces IntentContract schema and the work-item-id
// invariant; the LLM owns the semantic content.
export const finalizePayload = z
  .object({
    goal: z.string().min(1).describe('Verifiable goal in project terms'),
    in_scope: z.array(z.string()).default([]),
    out_of_scope: z.array(z.string()).default([]),
    acceptance_criteria: z.array(intentAcceptanceCriterion).min(1),
    unknowns: z.array(z.string()).default([]),
    follow_up_candidates: z.array(z.string()).default([]),
    question_policy: z
      .enum(['ask_only_if_user_only_can_answer', 'ask_freely', 'never_ask'])
      .default('ask_only_if_user_only_can_answer'),
    risk: z
      .object({
        non_local: z.boolean().default(false),
        irreversible: z.boolean().default(false),
        unaudited: z.boolean().default(false),
      })
      .default({ non_local: false, irreversible: false, unaudited: false }),
    approved_source: z.enum(['approved_spec', 'issue', 'prd', 'user']).optional(),
    // 축1 종료의 2차 게이트. Required so the AND (readiness ∧ user confirmation) is
    // impossible to bypass by omission: finalize fails closed when this is absent
    // or confirmed=false, even if the readiness gate passed.
    user_confirmation: userConfirmation,
  })
  .describe('Intent fields synthesized after the interview is ready');

export type FinalizePayload = z.infer<typeof finalizePayload>;

export type FinalizeResult =
  | {
      status: 'finalized';
      intent: IntentContract;
      autopilot: Autopilot;
    }
  | {
      status: 'not_ready';
      gate: GateResult;
    }
  // Readiness gate passed (1차) but the user has not confirmed (2차). Distinct from
  // not_ready: the system is ready, the human AND-condition is missing. No artifact
  // is written — the axis-1 closure needs both halves (charter §4-8: value to user).
  | {
      status: 'not_confirmed';
      gate: GateResult;
    }
  // Readiness + user confirmation both met, but a CRITICAL dimension carries an engaged
  // high-impact intent-dissent the user has not acknowledged (wi_260709mqt). The opponent
  // found a stronger/more-accurate reading of the intent; finalize fails closed until the
  // user re-confirms against it. host_absent (opponent never ran) does NOT reach here.
  | {
      status: 'blocked_by_dissent';
      gate: GateResult;
      blocking: Array<{ dimension: string; text: string }>;
    };

export interface FinalizeInput {
  workItemId: string;
  payload: FinalizePayload;
  /**
   * Stamped onto intent.source_digest when the intent was compiled from a spec/design
   * document (the prism → deep-interview compile path). Absent for a plain interview
   * finalize (design §5 zero-diff): the intent carries no source_digest and the
   * autopilot digest-freshness gate stays dormant. Keeps finalizeInterview the SINGLE
   * intent.json writer (ac-7) — the prism compile routes THROUGH it, never around it.
   */
  sourceDigest?: { doc_path: string; sha256: string };
  now?: Date;
}

/**
 * Reduce a full RiskAxes (all three booleans, defaulted) to the sparse
 * `declared_risk` shape the work item stores — only the TRUE flags, or `undefined`
 * when none is set. Same semantics as `work start --risk ""` (records nothing), so
 * an all-false interview risk never falsely trips the high-risk gate.
 */
function declaredRiskFromAxes(risk: RiskAxes): WorkItem['declared_risk'] {
  const flags: NonNullable<WorkItem['declared_risk']> = {};
  if (risk.non_local) flags.non_local = true;
  if (risk.irreversible) flags.irreversible = true;
  if (risk.unaudited) flags.unaudited = true;
  return Object.keys(flags).length > 0 ? flags : undefined;
}

/**
 * Finalize: gate the interview, write intent.json, mirror the AC into the work
 * item, and (per AC-3) call bootstrapAutopilot in the same in-process call so
 * one ditto-deep-interview-finalize invocation produces both intent.json AND
 * autopilot.json deterministically. Idempotent: a second finalize call will
 * re-validate and re-write both artifacts (with a fresh autopilot_id).
 */
export async function finalizeInterview(
  repoRoot: string,
  input: FinalizeInput,
): Promise<FinalizeResult> {
  const interviewStoreInstance = new InterviewStore(repoRoot);
  const intentStore = new IntentStore(repoRoot);
  const items = new WorkItemStore(repoRoot);

  const state = await interviewStoreInstance.get(input.workItemId);
  // 축1 종료 게이트 = readiness(1차) ∧ user confirmation(2차) — both required, made
  // explicit here. The readiness gate is the system half; the user confirmation is
  // the human half. Either missing fails closed and writes no artifact.
  const gate = interviewReadinessGate(state);
  if (!gate.pass) {
    return { status: 'not_ready', gate };
  }
  if (!input.payload.user_confirmation.confirmed) {
    return { status: 'not_confirmed', gate };
  }

  // Critical high-impact dissent gate (wi_260709mqt, ac-3). Keys off the persisted
  // dimension.dissent record (a durable snapshot the projection wrote) — NOT off the
  // neutrality axis (which the projection clamps to 'accept', so 'blocked' never leaks
  // there to livelock coverage; the BLOCK lives here instead). A critical dimension with
  // an ENGAGED high-impact dissent the user has not acknowledged fails closed before any
  // artifact is written. host_absent (opponent never ran) leaves no engaged dissent, so a
  // fresh interview is NOT blocked (ADR-0018 D2); a prior engaged block is carried forward
  // by mergeDissent at projection time (the host cannot be dropped to bypass it). Reading
  // the snapshot (never re-invoking the non-deterministic opponent) keeps the gate stable
  // across resume/retry/CI.
  const blocking = state.dimensions.filter(
    (d) =>
      d.critical &&
      d.dissent?.status === 'engaged' &&
      d.dissent.impact === 'high' &&
      d.dissent.acknowledged !== true,
  );
  if (blocking.length > 0) {
    return {
      status: 'blocked_by_dissent',
      gate,
      blocking: blocking.map((d) => ({ dimension: d.id, text: d.dissent?.text ?? '' })),
    };
  }

  const workItem = await items.get(input.workItemId);
  const intent: IntentContract = {
    schema_version: '0.1.0',
    work_item_id: input.workItemId,
    source_request: workItem.source_request,
    goal: input.payload.goal,
    in_scope: input.payload.in_scope,
    out_of_scope: input.payload.out_of_scope,
    acceptance_criteria: input.payload.acceptance_criteria,
    unknowns: input.payload.unknowns,
    follow_up_candidates: input.payload.follow_up_candidates,
    question_policy: input.payload.question_policy,
    // ac-6: when the intent was compiled from a spec/design document, bind it to that
    // document by digest. The preserved autopilot digest-freshness gate reads this and
    // blocks execution if a compile-input section changed after finalize.
    ...(input.sourceDigest ? { source_digest: input.sourceDigest } : {}),
  };
  const writtenIntent = await intentStore.write(intent);

  // Mirror AC into the work item — work item is authoritative for status, but
  // acceptance_criteria stays consistent with intent.acceptance_criteria so
  // completionGate cross-checks still align.
  // wi_260710y87: risk declared through the interview (payload.risk) is the heavy
  // path's own risk-capture channel, and declared_risk is the ONE persisted risk
  // signal every gate reads — the loop's producePlanGate highRisk (autopilot-loop.ts),
  // the Stop hook risk yield, the lightweight-close override gate, the heavy-path
  // nudge. Without persisting it here, bootstrap's INITIAL pending gate gets re-computed
  // from an empty declared_risk in the loop and auto-waives a high-risk plan to
  // not_required. Persist only the TRUE flags (same idiom as `work start --risk ""` →
  // records nothing), so an all-false risk leaves declared_risk unset.
  const declaredRisk = declaredRiskFromAxes(input.payload.risk);
  await items.update(input.workItemId, (current) => ({
    ...current,
    acceptance_criteria: input.payload.acceptance_criteria.map((ac) => ({
      id: ac.id,
      statement: ac.statement,
      verdict: ac.verdict,
      evidence: ac.evidence,
    })),
    goal: input.payload.goal,
    ...(declaredRisk !== undefined ? { declared_risk: declaredRisk } : {}),
  }));

  // Mark interview converged and record the user confirmation as durable evidence
  // of the 2차 gate (who confirmed, in their own words, when).
  const nowIso = (input.now ?? new Date()).toISOString();
  await interviewStoreInstance.write({
    ...state,
    status: 'converged',
    updated_at: nowIso,
    readiness: { ...state.readiness, gate: 'ready' },
    user_confirmation: {
      confirmed: true,
      statement: input.payload.user_confirmation.statement,
      confirmed_at: input.payload.user_confirmation.confirmed_at ?? nowIso,
    },
    exit: {
      ...state.exit,
      reason: 'readiness_met',
      closure_mode: deriveClosureMode('readiness_met', true),
    },
  });

  const refreshedItem = await items.get(input.workItemId);
  const risk: RiskAxes = input.payload.risk;
  const boot = await bootstrapAutopilot(repoRoot, {
    workItem: refreshedItem,
    intent: writtenIntent,
    risk,
    ...(input.payload.approved_source ? { approvedSource: input.payload.approved_source } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  if (boot.status !== 'created') {
    // Hard error: AC mirror succeeded but autopilot bootstrap rejected. Surface
    // reasons so the caller (CLI) can render them; the intent.json is already
    // persisted, so `ditto autopilot bootstrap` can retry without re-interview.
    throw new Error(
      `interview finalized but bootstrapAutopilot failed (${boot.status}): ${boot.reasons.join('; ')}`,
    );
  }
  return { status: 'finalized', intent: writtenIntent, autopilot: boot.graph };
}

/**
 * Acknowledge a critical dimension's intent-dissent (wi_260709mqt, ac-3): the user has
 * re-confirmed the intent against the opponent's dissent. Flips `dissent.acknowledged=true`
 * so the finalize block passes on the next finalize. The minimal unblock seam for the
 * dissent gate — no new framework, just the one durable field the gate reads.
 */
export async function acknowledgeIntentDissent(
  repoRoot: string,
  workItemId: string,
  dimensionId: string,
  now?: Date,
): Promise<InterviewState> {
  const store = new InterviewStore(repoRoot);
  const state = await store.get(workItemId);
  return store.write({
    ...state,
    updated_at: (now ?? new Date()).toISOString(),
    dimensions: state.dimensions.map((d) =>
      d.id === dimensionId && d.dissent !== undefined
        ? { ...d, dissent: { ...d.dissent, acknowledged: true } }
        : d,
    ),
  });
}

/**
 * Record host-delegated intent-dissent verdicts onto interview-state (wi_260709x5w). The
 * `dissent-record` CLI's record-back primitive — mirrors prism `opponent-record`'s in-memory
 * fold, but onto `interviewDimension.dissent` instead of the prism map. Copy-adapts the
 * ENGAGED branch of {@link engageIntentDissent} (interview-dissent.ts): a non-empty (trimmed)
 * text becomes an engaged `revise` dissent whose `impact` keys off `dimension.critical`
 * (`high` on a critical dim → the finalize block trigger); a whitespace-only text degrades to
 * `host_absent` (ADR-0018, never a false engaged stamp). {@link mergeDissent} keeps a prior
 * engaged high-impact unacknowledged block sticky. Fail-closed: any verdict whose
 * `dimension_id` ∉ state.dimensions returns `{status:'foreign'}` and writes NOTHING (never an
 * orphan dissent the finalize gate can't map). EXACTLY ONE write (single-writer), mirroring
 * {@link acknowledgeIntentDissent}'s persist pattern.
 */
export type RecordIntentDissentResult =
  | { status: 'recorded'; state: InterviewState; engaged: string[]; degraded: string[] }
  | { status: 'foreign'; foreign: string[] };

export async function recordIntentDissent(
  repoRoot: string,
  workItemId: string,
  verdicts: Array<{ dimension_id: string; text: string }>,
  now?: Date,
): Promise<RecordIntentDissentResult> {
  const store = new InterviewStore(repoRoot);
  const state = await store.get(workItemId);
  const byId = new Map(state.dimensions.map((d) => [d.id, d]));
  const foreign = [...new Set(verdicts.map((v) => v.dimension_id).filter((id) => !byId.has(id)))];
  if (foreign.length > 0) {
    return { status: 'foreign', foreign };
  }
  const updates = new Map<string, InterviewDissent>();
  const engaged: string[] = [];
  const degraded: string[] = [];
  for (const v of verdicts) {
    const dim = byId.get(v.dimension_id);
    if (dim === undefined) continue; // unreachable — the foreign guard above already exited.
    const outcome: InterviewDissent =
      v.text.trim().length > 0
        ? {
            status: 'engaged',
            verdict: 'revise',
            impact: dim.critical ? 'high' : 'low',
            text: v.text.trim(),
            acknowledged: false,
          }
        : { status: 'host_absent', acknowledged: false };
    updates.set(v.dimension_id, mergeDissent(dim.dissent, outcome));
    (outcome.status === 'engaged' ? engaged : degraded).push(v.dimension_id);
  }
  const next = await store.write({
    ...state,
    updated_at: (now ?? new Date()).toISOString(),
    dimensions: state.dimensions.map((d) => {
      const u = updates.get(d.id);
      return u !== undefined ? { ...d, dissent: u } : d;
    }),
  });
  return { status: 'recorded', state: next, engaged, degraded };
}

/**
 * Project the Deep Interview `dimensions` onto the coverage tree and drive the
 * SHARED pre-mortem coverage engine for the INTENT stage (premortem-coverage §3.2,
 * §6.3, §9). This does NOT fork a second engine: it reuses `nextCoverageNode`
 * (seeds coverage.json root = original intent) and `recordCoverageRound` (the same
 * append-only `addNode`, false-green `coverageClosureGate`, dry counter, axis
 * enforcement). Each interview dimension becomes a `derived` coverage node under
 * the root; a `resolved` dimension is closed through the engine's `close_as` path
 * so the §3.2 false-green invariant (a parent cannot project resolved while a
 * child is open) is enforced by the engine, not re-implemented here.
 *
 * On termination the engine writes `.ditto/local/runs/<wi>/intent-dialog.md`
 * (stage:'intent') and returns the dialog path. The terminal sweep is driven
 * deterministically from the recorded interview state — no fresh LLM judges are
 * spawned here (code computes/gates; the main agent owns any judge fan-out, same
 * division as the plan stage).
 */
export interface ProjectDimensionsResult {
  map: CoverageMap;
  intentDialogPath?: string;
}

export async function projectInterviewDimensions(
  repoRoot: string,
  workItemId: string,
  // Optional trailing arg (wi_260709mqt): the host-delegated opponent seam config. Absent
  // (every existing 2-arg caller) → the intent-dissent opponent degrades to host_absent
  // (ADR-0018), so critical dimensions honestly deferral-close instead of faking a
  // resolved-with-opponent close. Present → the opponent is driven on critical dims only.
  opponentConfig?: OpponentSeamConfig,
): Promise<ProjectDimensionsResult> {
  const interviewStore = new InterviewStore(repoRoot);
  const state = await interviewStore.get(workItemId);
  const store = new CoverageStore(repoRoot);

  // Seed coverage.json (root = original intent) via the shared engine. The intent
  // stage gets the far-field LENS injection (§8-1, inside nextCoverageNode) so the
  // interview sees every far-field domain, but it does NOT pass `seedCategories`:
  // this terminal sweep is driven deterministically from recorded interview state
  // (no fresh category judges here), so seeding category NODES would leave them
  // permanently open and the intent dialog could never terminate. The
  // category-complete hard sweep (§8-2) belongs to the autopilot PLAN stage, which
  // deep-interview reaches transitively via bootstrapAutopilot (wi_260622vjo ac-5).
  await nextCoverageNode({ repoRoot, workItemId });

  // Append each dimension as a derived child of the root (append-only, §3.2).
  // Skip ids already present so projection is idempotent across re-runs.
  let map = await store.getMap(workItemId);
  const existingIds = new Set(map.nodes.map((n) => n.id));
  const newDims = state.dimensions.filter((d) => !existingIds.has(`cov-dim-${d.id}`));
  if (newDims.length > 0) {
    await recordCoverageRound({
      repoRoot,
      workItemId,
      payload: {
        node_id: map.root_id,
        derived_nodes: newDims.map((d) => ({
          id: `cov-dim-${d.id}`,
          parent_id: map.root_id,
          label: d.notes || d.id,
          origin: 'derived' as const,
          depth_weight: d.critical ? 1 : 0,
        })),
        discovered_nodes: [],
        admissibleBranchesAdded: newDims.length,
      },
      stage: 'intent',
    });
  }

  // Close each resolved dimension through the engine (false-green gate applies:
  // a resolved parent dimension stays open while any child is still open).
  //
  // wi_260709mqt — the previous blanket `axis_signals.neutrality = {opponent_ran:true,
  // verdict:'accept'}` is REMOVED: it claimed an opponent ran for EVERY dimension without
  // one (a structural false-green on coverage's only adversarial axis). Now:
  //   • CRITICAL dim → drive the intent-dissent opponent (localization: critical only).
  //       - engaged → real judgment; close 'resolved' with the neutrality signal CLAMPED
  //         to 'accept' (never 'blocked' → the shared axis can't livelock); the BLOCK is
  //         enforced at finalize via the persisted dissent, not on the axis.
  //       - host_absent → NO opponent ran; do NOT stamp opponent_ran (that resurrects the
  //         fake). Honest deferral close (out_of_scope) — a deferral needs no neutrality
  //         (coverage-loop §), so the shared engine is untouched.
  //   • NON-CRITICAL dim → the socratic interview loop (readiness + user Q&A) IS the
  //     neutrality provider; non-critical scope needs no spawned adversary. The signal is
  //     kept but scoped + self-describing (socratic-provenance), NOT a blanket claim.
  const dissentUpdates = new Map<string, InterviewDissent>();
  for (const d of state.dimensions) {
    if (d.state !== 'resolved') continue;
    const nodeId = `cov-dim-${d.id}`;
    const node = (await store.getMap(workItemId)).nodes.find((n) => n.id === nodeId);
    if (node === undefined || node.state !== 'open') continue;

    if (d.critical) {
      const outcome = opponentConfig
        ? await engageIntentDissent(d, opponentConfig)
        : ({ status: 'host_absent', acknowledged: false } as InterviewDissent);
      // Fail-closed carry-forward: a prior engaged high-impact block is never erased by a
      // later host_absent run (the host cannot be dropped to bypass a real dissent).
      const merged = mergeDissent(d.dissent, outcome);
      dissentUpdates.set(d.id, merged);

      if (merged.status === 'engaged') {
        await recordCoverageRound({
          repoRoot,
          workItemId,
          payload: {
            node_id: nodeId,
            derived_nodes: [],
            discovered_nodes: [],
            admissibleBranchesAdded: 0,
            close_as: 'resolved',
            // Real opponent judgment. Clamp verdict to 'accept' so a dissent never leaks
            // 'blocked' into the shared neutrality axis; the block lives at finalize.
            axis_signals: { neutrality: { opponent_ran: true, verdict: 'accept' } },
          },
          stage: 'intent',
        });
      } else {
        await recordCoverageRound({
          repoRoot,
          workItemId,
          payload: {
            node_id: nodeId,
            derived_nodes: [],
            discovered_nodes: [],
            admissibleBranchesAdded: 0,
            // host_absent: honest deferral (no adversarial settlement claimed, ADR-0018).
            close_as: 'out_of_scope',
            close_reason:
              'intent-dissent opponent host absent — critical dimension deferral-closed, no neutrality claimed (ADR-0018)',
          },
          stage: 'intent',
        });
      }
    } else {
      await recordCoverageRound({
        repoRoot,
        workItemId,
        payload: {
          node_id: nodeId,
          derived_nodes: [],
          discovered_nodes: [],
          admissibleBranchesAdded: 0,
          close_as: 'resolved',
          // Non-critical: settled by the socratic interview loop (readiness/user Q&A) —
          // the documented neutrality provider for non-adversarial scope, NOT a spawned
          // opponent claim. The critical branch above owns the real adversarial path.
          axis_signals: { neutrality: { opponent_ran: true, verdict: 'accept' } },
        },
        stage: 'intent',
      });
    }
  }

  // Persist the dissent record-back onto interview-state (durable snapshot so finalize +
  // resume read the same verdict without re-invoking the non-deterministic opponent).
  if (dissentUpdates.size > 0) {
    const fresh = await interviewStore.get(workItemId);
    await interviewStore.write({
      ...fresh,
      updated_at: new Date().toISOString(),
      dimensions: fresh.dimensions.map((d) => {
        const next = dissentUpdates.get(d.id);
        return next !== undefined ? { ...d, dissent: next } : d;
      }),
    });
  }

  map = await store.getMap(workItemId);

  // Always render intent-dialog.md from the projected tree + interview record
  // (§6/§9) — REUSING serializePlanDialog with kind:'intent-dialog'. Unlike the
  // engine's terminal write (which fires only on full breadth+depth termination),
  // the intent dialog is produced on every projection so the user can correct
  // thin/open scope before the readiness gate closes. Not a fork: same serializer,
  // same CoverageStore, same markdown sections.
  const closedItems = map.nodes
    .filter((n) => n.state !== 'open')
    .map((n) => ({ id: n.id, label: n.label, state: n.state }));
  const openItems = map.nodes
    .filter((n) => n.state === 'open')
    .map((n) => ({ id: n.id, label: n.label, state: n.state }));
  const userQa = state.questions
    .filter((q) => q.answer !== undefined && q.answer_kind === 'user')
    .map((q) => ({
      question: q.question,
      why_matters: q.why_matters,
      answer: q.answer ?? '',
    }));
  const assumptions = state.assumptions.map((a) => ({
    statement: a.statement,
    label: a.label,
    because_no_answer_to: a.because_no_answer_to,
  }));
  const markdown = serializePlanDialog({
    workItemId,
    userQa,
    selfAnswers: [],
    assumptions,
    closedItems,
    openItems,
    kind: 'intent-dialog',
  });
  await store.writeIntentDialog(workItemId, markdown);

  return { map, intentDialogPath: `.ditto/local/runs/${workItemId}/intent-dialog.md` };
}

// Pre-mortem promotion payload — the surfaced risk items the LLM enumerated for
// the risk_reversibility dimension. The driver enforces the §5 promotion rule
// (irreversible OR blast_radius>=high MUST land somewhere) and records the items
// into interview-state.json; the LLM owns the scenario content.
export const promotePremortemPayload = z
  .object({
    items: z.array(premortemItem).min(1),
  })
  .describe('Pre-mortem items to record + promote into the interview state (§5)');

export type PromotePremortemPayload = z.infer<typeof promotePremortemPayload>;

export interface PromotePremortemResult {
  state: InterviewState;
  /** Items requiring promotion (irreversible/high-blast) left at promoted_to:'none'. */
  unpromoted: PremortemItem[];
}

/** An item that §5 forces to be promoted (irreversible OR blast_radius>=high). */
function requiresPromotion(item: PremortemItem): boolean {
  return (
    item.reversibility === 'irreversible' ||
    item.blast_radius === 'high' ||
    item.blast_radius === 'critical'
  );
}

/** blast_radius>=high — the §17 localization: ONLY these items face the lightweight opponent. */
function isHighBlast(item: PremortemItem): boolean {
  return item.blast_radius === 'high' || item.blast_radius === 'critical';
}

/**
 * Pre-mortem 승격 (deep-interview §5 — previously unimplemented per coverage §9).
 * Records the surfaced pre-mortem items into interview-state.json and enforces
 * the §5 promotion rule: every irreversible / high-blast item MUST be promoted to
 * one of ac | out_of_scope | user_owned_decision (not merely recorded). An item
 * that requires promotion but is left `promoted_to:'none'` is returned in
 * `unpromoted` so the caller fails closed — this is the mechanism that closes the
 * `risk_reversibility` dimension instead of recording risk and moving on.
 */
export async function promotePremortem(
  repoRoot: string,
  workItemId: string,
  payload: PromotePremortemPayload,
  now?: Date,
): Promise<PromotePremortemResult> {
  const store = new InterviewStore(repoRoot);
  const state = await store.get(workItemId);
  const unpromoted = payload.items.filter(
    (item) => requiresPromotion(item) && item.promoted_to === 'none',
  );
  const nowIso = (now ?? new Date()).toISOString();
  const written = await store.write({
    ...state,
    updated_at: nowIso,
    premortem: [...state.premortem, ...payload.items],
  });
  return { state: written, unpromoted };
}

/**
 * Record host-delegated pre-mortem refutation verdicts onto interview-state (wi_260709d3m,
 * #17 AC-2). The `premortem-refute-record` CLI's record-back primitive — the premortem twin
 * of {@link recordIntentDissent}: a non-empty (trimmed) text becomes an `engaged` refutation;
 * a whitespace-only text degrades to `host_absent` (ADR-0018, never a false engaged stamp).
 *
 * Fail-closed (writes NOTHING when any verdict is foreign): a verdict whose `index` is out of
 * range OR points at a NON-high-blast item is rejected. The high-blast guard makes the §17
 * localization ("blast_radius>=high 항목에 한해 opponent") provable at the write boundary — a
 * mis-wired caller cannot silently attach a refutation to a trivial item. EXACTLY ONE write
 * (single-writer), mirroring {@link recordIntentDissent}'s persist pattern.
 */
export type RecordPremortemRefutationResult =
  | { status: 'recorded'; state: InterviewState; engaged: number[]; degraded: number[] }
  | { status: 'foreign'; foreign: number[] };

export async function recordPremortemRefutation(
  repoRoot: string,
  workItemId: string,
  verdicts: Array<{ index: number; text: string }>,
  now?: Date,
): Promise<RecordPremortemRefutationResult> {
  const store = new InterviewStore(repoRoot);
  const state = await store.get(workItemId);
  const foreign = [
    ...new Set(
      verdicts
        .map((v) => v.index)
        .filter((i) => {
          const item = state.premortem[i];
          return item === undefined || !isHighBlast(item);
        }),
    ),
  ];
  if (foreign.length > 0) {
    return { status: 'foreign', foreign };
  }
  const updates = new Map<number, PremortemItem['refutation']>();
  const engaged: number[] = [];
  const degraded: number[] = [];
  for (const v of verdicts) {
    const outcome: PremortemItem['refutation'] =
      v.text.trim().length > 0
        ? { status: 'engaged', text: v.text.trim() }
        : { status: 'host_absent' };
    updates.set(v.index, outcome);
    (outcome.status === 'engaged' ? engaged : degraded).push(v.index);
  }
  const written = await store.write({
    ...state,
    updated_at: (now ?? new Date()).toISOString(),
    premortem: state.premortem.map((item, i) => {
      const u = updates.get(i);
      return u !== undefined ? { ...item, refutation: u } : item;
    }),
  });
  return { status: 'recorded', state: written, engaged, degraded };
}

// ── A1 achieve-vs-characterize semantic critic (intent layer, wi_260709hzg #15) ──
//
// Port of prism's A1 (src/core/prism/opponent.ts engageSemanticCritique + engine.ts
// deriveFragmentMappings) from the RISK/plan layer to the INTENT layer. Two deterministic
// primitives here (fragment decomposition + fragment↔dimension mapping) feed the host, which
// runs the model critic per covered pair; the verdict folds back via
// {@link recordIntentSemanticCritique}. ADVISORY and NON-blocking — the readiness gate
// (gates.ts interviewReadinessGate) never reads `dimension.semantic_*`, so a `characterize`
// verdict surfaces the intent-fulfilment gap without hard-blocking the loop (prism A1 alike).

/**
 * Split the original intent text (WI Record source_request / goal) into deterministic clause
 * fragments with stable ids (`frag[0]`, `frag[1]`, …). Splits on newlines and sentence
 * terminators; blank clauses are dropped (a blank fragment can never be "achieved" by a
 * dimension). Pure — the intent-layer analogue of prism's `buildIntentFragments`, which
 * decomposes structured {goal, in_scope}; here the interview-time intent is a single free-text
 * request, so we clause-split it instead.
 */
export function deriveIntentFragments(intentText: string): IntentFragment[] {
  return intentText
    .split(/[\n.;!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((text, i) => ({ id: `frag[${i}]`, text }));
}

/** One covered (fragment, dimension) pair — the intent-layer twin of prism's FragmentMapping. */
export interface DimensionMapping {
  fragment_id: string;
  dimension_id: string;
}

/**
 * Deterministic fragment↔dimension mapping (no model call). A fragment maps to a RESOLVED
 * dimension when a distinctive keyword of the fragment appears as a WHOLE TOKEN of the
 * dimension's `notes` — reusing prism's exact {@link fragmentKeywords} tokenizer so the
 * wi_260708jnp whole-token lesson (a keyword must not match a word-INTERNAL substring, e.g.
 * `core` in `score`) is honored, not re-derived. Only `resolved` dimensions are covered — an
 * open/partial dimension has no achieve-vs-characterize claim to critique yet. Pure.
 */
export function deriveDimensionMappings(
  fragments: readonly IntentFragment[],
  dimensions: readonly InterviewDimension[],
): DimensionMapping[] {
  const dimTokens = dimensions
    .filter((d) => d.state === 'resolved')
    .map((d) => ({ id: d.id, tokens: new Set(fragmentKeywords(d.notes)) }));
  const mappings: DimensionMapping[] = [];
  for (const frag of fragments) {
    const keywords = fragmentKeywords(frag.text);
    if (keywords.length === 0) continue;
    for (const dim of dimTokens) {
      if (keywords.some((kw) => dim.tokens.has(kw))) {
        mappings.push({ fragment_id: frag.id, dimension_id: dim.id });
      }
    }
  }
  return mappings;
}

/** One target the host critiques — a covered pair carrying the fragment text + dimension label. */
export interface IntentSemanticTarget {
  fragment_id: string;
  fragment_text: string;
  dimension_id: string;
  label: string;
}

/**
 * Select the covered (fragment, dimension) pairs to critique this run, applying the per-run
 * {@link OPPONENT_FANOUT_CAP} ceiling (reused so intent-layer cost stays bounded exactly like
 * prism's A1). Returns the capped targets + the count left for a later run. Pure.
 */
export function selectIntentSemanticTargets(
  fragments: readonly IntentFragment[],
  dimensions: readonly InterviewDimension[],
  cap: number = OPPONENT_FANOUT_CAP,
): { targets: IntentSemanticTarget[]; skipped_by_cap: number } {
  const byId = new Map(dimensions.map((d) => [d.id, d]));
  const mappings = deriveDimensionMappings(fragments, dimensions);
  const fragText = new Map(fragments.map((f) => [f.id, f.text]));
  const all = mappings.map((m) => ({
    fragment_id: m.fragment_id,
    fragment_text: fragText.get(m.fragment_id) ?? '',
    dimension_id: m.dimension_id,
    label: byId.get(m.dimension_id)?.notes || m.dimension_id,
  }));
  return { targets: all.slice(0, cap), skipped_by_cap: Math.max(0, all.length - cap) };
}

/**
 * Record host-delegated A1 semantic-critic verdicts onto interview-state (wi_260709hzg #15).
 * The `semantic-record` CLI's record-back primitive — mirrors {@link recordIntentDissent} but
 * writes the SEPARATE advisory `semantic_status`/`semantic_critique` fields (never `dissent`,
 * so per-seam degrade attribution stays clean). A non-empty (trimmed) text → `engaged`; a
 * whitespace-only text → `host_absent` (ADR-0018, never a false engaged stamp). Fail-closed:
 * any verdict whose `dimension_id` ∉ state.dimensions returns `{status:'foreign'}` and writes
 * NOTHING. EXACTLY ONE write (single-writer). ADVISORY — nothing this writes gates finalize.
 */
export type RecordIntentSemanticResult =
  | { status: 'recorded'; state: InterviewState; engaged: string[]; degraded: string[] }
  | { status: 'foreign'; foreign: string[] };

export async function recordIntentSemanticCritique(
  repoRoot: string,
  workItemId: string,
  verdicts: Array<{ dimension_id: string; text: string }>,
  now?: Date,
): Promise<RecordIntentSemanticResult> {
  const store = new InterviewStore(repoRoot);
  const state = await store.get(workItemId);
  const byId = new Map(state.dimensions.map((d) => [d.id, d]));
  const foreign = [...new Set(verdicts.map((v) => v.dimension_id).filter((id) => !byId.has(id)))];
  if (foreign.length > 0) {
    return { status: 'foreign', foreign };
  }
  const updates = new Map<
    string,
    Pick<InterviewDimension, 'semantic_status' | 'semantic_critique'>
  >();
  const engaged: string[] = [];
  const degraded: string[] = [];
  for (const v of verdicts) {
    if (v.text.trim().length > 0) {
      updates.set(v.dimension_id, {
        semantic_status: 'engaged',
        semantic_critique: v.text.trim(),
      });
      engaged.push(v.dimension_id);
    } else {
      updates.set(v.dimension_id, { semantic_status: 'host_absent' });
      degraded.push(v.dimension_id);
    }
  }
  const written = await store.write({
    ...state,
    updated_at: (now ?? new Date()).toISOString(),
    dimensions: state.dimensions.map((d) => {
      const u = updates.get(d.id);
      return u !== undefined ? { ...d, ...u } : d;
    }),
  });
  return { status: 'recorded', state: written, engaged, degraded };
}
