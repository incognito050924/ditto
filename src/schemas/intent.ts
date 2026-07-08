import { z } from 'zod';
import { evidenceRequiredKind, schemaVersion, workItemId } from './common';
import { acceptanceCriterion } from './work-item';

// Re-exported from common.ts (moved there so the work-item base AC can reference it
// without an import cycle). Kept exported here for existing intent-side consumers.
export { evidenceRequiredKind };

export const questionPolicy = z
  .enum(['ask_only_if_user_only_can_answer', 'ask_freely', 'never_ask'])
  .default('ask_only_if_user_only_can_answer')
  .describe('How freely the agent may ask the user questions for this work item');

// wi_2607069bk §1.2 Finding E: `evidence_required` is now inherited from the base
// work-item AC (Record SoT), so the intent sidecar AC is a derived view — no local
// re-declaration. Shape is identical to before (base carries evidence_required),
// so intent.json parses unchanged.
export const intentAcceptanceCriterion = acceptanceCriterion.describe(
  'Acceptance criterion in the intent sidecar; reuses work-item criterion shape',
);

// Stamped by the spec-document compile/finalize path (the spec document is the
// source; intent is its one-way compile artifact). Additive + optional:
// interview-finalized intents never carry it (design §5 zero-diff).
export const sourceDigest = z
  .object({
    doc_path: z.string().min(1).describe('Spec document path relative to repo root'),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe('Digest over the compile-input sections (요약·목표·비목표·완료 조건·위험)'),
  })
  .describe('Freshness stamp linking intent.json to the spec document it was compiled from');

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
    // ac-4 (T1, wi_2606266az): one-time batch materialization record for the
    // out-of-scope `follow_up_candidates` above. ac-4 requires those follow-ups be
    // materialized in ONE user-approved batch (per-item drip = SLOP), so the
    // consumer (a later loop node) needs a place to record the one-time approval and
    // the work items it created — the latter back-links like work-item
    // followUp.materialized_wi and makes re-runs idempotent. Additive + OPTIONAL: a
    // legacy intent.json omits it and parses unchanged; `follow_up_candidates` is
    // itself NOT redesigned (stays a bare string[]).
    follow_up_materialization: z
      .object({
        batch_approved: z
          .boolean()
          .default(false)
          .describe(
            'User granted the one-time batch approval to materialize out-of-scope follow-ups',
          ),
        materialized_wis: z
          .array(workItemId)
          .default([])
          .describe(
            'Work items the batch materialization created; non-empty makes re-runs idempotent (back-link)',
          ),
      })
      .optional()
      .describe(
        'One-time batch materialization record for follow_up_candidates (ac-4); absent on legacy intents',
      ),
    question_policy: questionPolicy,
    source_digest: sourceDigest.optional(),
  })
  .describe('Sidecar that preserves original intent and guards against scope creep (§6.1)');

export type IntentContract = z.infer<typeof intentContract>;
