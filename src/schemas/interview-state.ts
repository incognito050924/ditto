import { z } from 'zod';
import { isoDateTime, schemaVersion, workItemId } from './common';
import { confidenceLevel, honestyKind } from './convergence';
import { selfAnswerAttempt } from './question-gate';

export const interviewStatus = z
  .enum(['active', 'converged', 'deferred', 'aborted'])
  .describe('Lifecycle of the deep interview');

export const dimensionState = z
  .enum(['unknown', 'partial', 'resolved'])
  .describe('Resolution state of one ambiguity dimension');

export const infoGain = z
  .enum(['high', 'medium', 'low'])
  .describe('Estimated information gain of a question');

export const interviewDimension = z
  .object({
    id: z.string().min(1),
    critical: z.boolean().default(false),
    state: dimensionState,
    ambiguity: z.number().min(0).max(1),
    resolved_by: z.array(z.string()).default([]),
    notes: z.string().default(''),
  })
  .describe('One ambiguity dimension tracked during the interview');

export const interviewQuestion = z
  .object({
    id: z.string().min(1),
    asked_at: isoDateTime,
    dimension: z.string().min(1),
    question: z.string().min(1),
    why_matters: z.string().min(1).describe('What changes depending on the answer'),
    info_gain_estimate: infoGain,
    self_answer_attempts: z.array(selfAnswerAttempt).default([]),
    answer: z.string().optional(),
    answer_kind: z.enum(['user', 'assumption']).optional(),
    ambiguity_delta: z.number().optional(),
  })
  .describe('One asked question with its self-answer attempts and outcome');

export const interviewAssumption = z
  .object({
    statement: z.string().min(1),
    label: honestyKind,
    confidence: confidenceLevel,
    because_no_answer_to: z.string().min(1).describe('Question id left unanswered'),
  })
  .describe('Assumption recorded when a question was not answered (§6.9)');

export const interviewState = z
  .object({
    schema_version: schemaVersion,
    work_item_id: workItemId,
    status: interviewStatus,
    started_at: isoDateTime,
    updated_at: isoDateTime,
    dimensions: z.array(interviewDimension).default([]),
    readiness: z.object({
      score: z.number().min(0).max(1),
      threshold: z.number().min(0).max(1),
      critical_unresolved: z.array(z.string()).default([]),
      gate: z.enum(['blocked', 'ready']),
    }),
    questions: z.array(interviewQuestion).default([]),
    assumptions: z.array(interviewAssumption).default([]),
    exit: z.object({
      reason: z.enum([
        'readiness_met',
        'diminishing_returns',
        'user_deferred',
        'user_owned_decision',
        'cap_reached',
      ]),
      question_cap: z.number().int().positive(),
      questions_asked: z.number().int().nonnegative(),
    }),
  })
  .describe('Deep interview sidecar tracking ambiguity dimensions and readiness (§6.3)');

export type InterviewState = z.infer<typeof interviewState>;
