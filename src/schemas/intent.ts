import { z } from 'zod';
import { schemaVersion, workItemId } from './common';
import { acceptanceCriterion } from './work-item';

export const evidenceRequiredKind = z
  .enum(['test', 'diff', 'browser', 'doc', 'log'])
  .describe('Kind of evidence required to verify an acceptance criterion');

export const questionPolicy = z
  .enum(['ask_only_if_user_only_can_answer', 'ask_freely', 'never_ask'])
  .default('ask_only_if_user_only_can_answer')
  .describe('How freely the agent may ask the user questions for this work item');

export const intentAcceptanceCriterion = acceptanceCriterion
  .extend({
    evidence_required: z.array(evidenceRequiredKind).default([]),
  })
  .describe('Acceptance criterion in the intent sidecar; reuses work-item criterion shape');

export const intentContract = z
  .object({
    schema_version: schemaVersion,
    work_item_id: workItemId,
    source_request: z.string().min(1).describe('Verbatim original user request'),
    goal: z.string().min(1).describe('Verifiable goal in project terms'),
    in_scope: z.array(z.string()).default([]),
    out_of_scope: z.array(z.string()).default([]),
    acceptance_criteria: z.array(intentAcceptanceCriterion).min(1),
    unknowns: z.array(z.string()).default([]),
    follow_up_candidates: z
      .array(z.string())
      .default([])
      .describe('Out-of-scope improvement ideas captured but not acted on (§6.1)'),
    question_policy: questionPolicy,
  })
  .describe('Sidecar that preserves original intent and guards against scope creep (§6.1)');

export type IntentContract = z.infer<typeof intentContract>;
