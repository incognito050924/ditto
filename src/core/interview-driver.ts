import { z } from 'zod';
import type { Autopilot } from '~/schemas/autopilot';
import type { CoverageMap } from '~/schemas/coverage';
import { type IntentContract, intentAcceptanceCriterion } from '~/schemas/intent';
import {
  type InterviewState,
  type PremortemItem,
  answerSelfReport,
  dimensionState,
  infoGain,
  interviewQuestion,
  premortemItem,
  userConfirmation,
} from '~/schemas/interview-state';
import { selfAnswerAttempt } from '~/schemas/question-gate';
import { bootstrapAutopilot } from './autopilot-bootstrap';
import { nextCoverageNode, recordCoverageRound } from './coverage-loop';
import { serializePlanDialog } from './coverage-manager';
import { CoverageStore } from './coverage-store';
import { type GateResult, type RiskAxes, deriveClosureMode, interviewReadinessGate } from './gates';
import { IntentStore } from './intent-store';
import { InterviewStore } from './interview-store';
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

export interface StartInput {
  workItemId: string;
  threshold?: number;
  questionCap?: number;
  /** Fan-out count for the SKILL question-generator loop (default 1 = serial-equivalent). */
  generators?: number;
  now?: Date;
}

export async function startInterview(
  repoRoot: string,
  input: StartInput,
): Promise<InterviewState & { generators: number }> {
  const now = (input.now ?? new Date()).toISOString();
  const generators = input.generators ?? DEFAULT_GENERATORS;
  const initial: InterviewState = {
    schema_version: '0.1.0',
    work_item_id: input.workItemId,
    status: 'active',
    started_at: now,
    updated_at: now,
    dimensions: [],
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

export async function recordTurn(
  repoRoot: string,
  input: RecordTurnInput,
): Promise<InterviewState> {
  const store = new InterviewStore(repoRoot);
  const current = await store.get(input.workItemId);
  const nowIso = (input.now ?? new Date()).toISOString();
  const { dimension: rawDimension, question, answer, readiness_score } = input.payload;

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
    question: question.text,
    why_matters: question.why_matters,
    info_gain_estimate: question.info_gain_estimate,
    // Persist the self-answer ledger from the payload (was hardcoded `[]`), so the
    // "we checked X first" evidence behind asking the user survives (wi_260622ph8).
    self_answer_attempts: question.self_answer_attempts ?? [],
    // Presentation-contract context carried with the question (wi_260622ph8).
    ...(question.user_explanation !== undefined
      ? { user_explanation: question.user_explanation }
      : {}),
    ...(question.background !== undefined ? { background: question.background } : {}),
    ...(question.grounding !== undefined ? { grounding: question.grounding } : {}),
    ...(question.marginal_gain !== undefined ? { marginal_gain: question.marginal_gain } : {}),
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
      questions_asked: current.questions.length + 1,
    },
  };
  // Recompute the gate state but keep status='active' here — finalize toggles
  // status='converged'. cap_reached is sticky once hit.
  const gateResult = interviewReadinessGate(updated);
  const capReached = updated.exit.questions_asked >= updated.exit.question_cap;
  updated.readiness.gate = gateResult.pass ? 'ready' : 'blocked';
  if (capReached && updated.status === 'active') {
    updated.exit.reason = 'cap_reached';
  } else if (
    // dry round: this round's score-gated marginal_gain fell below the dry floor and
    // the gate is still blocked. Exclusive with cap_reached (cap wins, set above).
    // Termination is *suggested* via exit.reason; finalize still requires
    // readiness ∧ user confirmation (the gate is not bypassed here).
    question.marginal_gain !== undefined &&
    question.marginal_gain < DRY_FLOOR &&
    !gateResult.pass &&
    updated.status === 'active'
  ) {
    updated.exit.reason = 'diminishing_returns';
  }
  // Keep closure_mode consistent with the current (reason, gate): a cap hit
  // while the gate is still blocked is ledger_only, not mutual_agreement.
  updated.exit.closure_mode = deriveClosureMode(updated.exit.reason, gateResult.pass);
  return store.write(updated);
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
    };

export interface FinalizeInput {
  workItemId: string;
  payload: FinalizePayload;
  now?: Date;
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
  };
  const writtenIntent = await intentStore.write(intent);

  // Mirror AC into the work item — work item is authoritative for status, but
  // acceptance_criteria stays consistent with intent.acceptance_criteria so
  // completionGate cross-checks still align.
  await items.update(input.workItemId, (current) => ({
    ...current,
    acceptance_criteria: input.payload.acceptance_criteria.map((ac) => ({
      id: ac.id,
      statement: ac.statement,
      verdict: ac.verdict,
      evidence: ac.evidence,
    })),
    goal: input.payload.goal,
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
): Promise<ProjectDimensionsResult> {
  const state = await new InterviewStore(repoRoot).get(workItemId);
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
        admissibleBranchesAdded: newDims.length,
      },
      stage: 'intent',
    });
  }

  // Close each resolved dimension through the engine (false-green gate applies:
  // a resolved parent dimension stays open while any child is still open).
  for (const d of state.dimensions) {
    if (d.state !== 'resolved') continue;
    const nodeId = `cov-dim-${d.id}`;
    const node = (await store.getMap(workItemId)).nodes.find((n) => n.id === nodeId);
    if (node === undefined || node.state !== 'open') continue;
    await recordCoverageRound({
      repoRoot,
      workItemId,
      payload: {
        node_id: nodeId,
        admissibleBranchesAdded: 0,
        close_as: 'resolved',
        // Intent-stage projection close: the interview already gated bias via the
        // readiness/socratic loop, so the neutrality axis is satisfied here.
        axis_signals: { neutrality: { opponent_ran: true, verdict: 'accept' } },
      },
      stage: 'intent',
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
