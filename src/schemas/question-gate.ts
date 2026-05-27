import { z } from 'zod';
import { schemaVersion, workItemId } from './common';

export const selfAnswerSource = z
  .enum(['code', 'docs', 'repo-artifact', 'web', 'memory'])
  .describe('Where the agent tried to answer the question before asking the user');

export const selfAnswerAttempt = z
  .object({
    source: selfAnswerSource,
    result: z
      .string()
      .min(1)
      .describe('Evidence found, or the reason the source did not resolve it'),
  })
  .describe('One self-answer attempt that must precede asking the user (§6.2)');

export const questionGateDecision = z
  .enum(['ask', 'do_not_ask', 'answer_with_assumption', 'deep_interview'])
  .describe('Outcome of the question gate evaluation');

export const questionGate = z
  .object({
    schema_version: schemaVersion,
    work_item_id: workItemId,
    question: z.string().min(1).describe('The question the agent considered asking the user'),
    why_needed: z.string().min(1).describe('Why only the user can answer this'),
    self_answer_attempts: z
      .array(selfAnswerAttempt)
      .default([])
      .describe('Sources checked before asking; gate cannot be ask without these'),
    decision: questionGateDecision,
    risk_if_not_asked: z
      .string()
      .min(1)
      .describe('How the implementation result changes if this is not asked'),
  })
  .describe(
    'Pre-ask judgement that blocks unnecessary and responsibility-shifting questions (§6.2)',
  );

export type QuestionGate = z.infer<typeof questionGate>;
export type SelfAnswerAttempt = z.infer<typeof selfAnswerAttempt>;
