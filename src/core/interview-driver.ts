import { z } from 'zod';
import type { Autopilot } from '~/schemas/autopilot';
import { type IntentContract, intentAcceptanceCriterion } from '~/schemas/intent';
import {
  type InterviewState,
  dimensionState,
  infoGain,
  interviewQuestion,
} from '~/schemas/interview-state';
import { bootstrapAutopilot } from './autopilot-bootstrap';
import { IntentStore } from './intent-store';
import { InterviewStore } from './interview-store';
import { type GateResult, type RiskAxes, interviewReadinessGate } from './gates';
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

export interface StartInput {
  workItemId: string;
  threshold?: number;
  questionCap?: number;
  now?: Date;
}

export async function startInterview(
  repoRoot: string,
  input: StartInput,
): Promise<InterviewState> {
  const now = (input.now ?? new Date()).toISOString();
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
    exit: {
      reason: 'readiness_met',
      question_cap: input.questionCap ?? DEFAULT_QUESTION_CAP,
      questions_asked: 0,
    },
  };
  return new InterviewStore(repoRoot).write(initial);
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
      })
      .describe('The asked question and why it matters'),
    answer: z
      .object({
        text: z.string().min(1),
        kind: z.enum(['user', 'assumption']),
        ambiguity_delta: z.number().optional(),
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
  const { dimension, question, answer, readiness_score } = input.payload;

  // Upsert dimension by id; preserve resolved_by history.
  const existingDim = current.dimensions.find((d) => d.id === dimension.id);
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
    self_answer_attempts: [],
    ...(answer
      ? {
          answer: answer.text,
          answer_kind: answer.kind,
          ...(answer.ambiguity_delta !== undefined
            ? { ambiguity_delta: answer.ambiguity_delta }
            : {}),
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
  }
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
  const gate = interviewReadinessGate(state);
  if (!gate.pass) {
    return { status: 'not_ready', gate };
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

  // Mark interview converged.
  await interviewStoreInstance.write({
    ...state,
    status: 'converged',
    updated_at: (input.now ?? new Date()).toISOString(),
    readiness: { ...state.readiness, gate: 'ready' },
    exit: { ...state.exit, reason: 'readiness_met' },
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
