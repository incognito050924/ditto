import { z } from 'zod';
import {
  autopilotId,
  evidenceRef,
  isoDateTime,
  relativePath,
  schemaVersion,
  workItemId,
} from './common';

// A handoff's anchor. Two disjoint scopes with DIFFERENT required-field sets,
// discriminated on `kind`: a work_item handoff is keyed by work_item_id (the
// historical shape, now nested here); a session handoff is keyed by session_id and
// is NOT tied to any work item, so it parses on its own required set. Kept to
// exactly these two kinds — no speculative scope kinds.
export const handoffScope = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('work_item'),
        work_item_id: workItemId,
      })
      .describe('Anchored to a work item — required key is work_item_id'),
    z
      .object({
        kind: z.literal('session'),
        session_id: z
          .string()
          .min(1)
          .describe('The session this handoff resumes — its own required key, no work_item_id'),
      })
      .describe('Anchored to a session, not a work item — required key is session_id'),
  ])
  .describe('Handoff anchor: work_item (work_item_id) or session (session_id)');

export type HandoffScope = z.infer<typeof handoffScope>;

const handoffObject = z
  .object({
    schema_version: schemaVersion,
    scope: handoffScope,
    autopilot_id: autopilotId
      .optional()
      .describe('Same autopilot_id the next session resumes under (§6.10)'),
    from_context: z
      .string()
      .min(1)
      .describe('Where this handoff is written from: session/agent and its state'),
    to_owner: z.string().min(1).optional().describe('Profile or handle expected to pick up'),
    original_intent: z.string().min(1).describe('Original user intent'),
    current_state: z.string().min(1).describe('Where things stand now'),
    decisions_made: z.array(z.string()).default([]),
    // ac-6 (wi_260627jhh): critical_decisions / irreversible_risks are SEPARATE
    // structural fields, additive over decisions_made (NOT a rename). Both are
    // `.default([])` so an OLD serialized handoff missing them still parses. The
    // substance (rationale / why_irreversible) is preserved INLINE — these are the
    // 재호출 불가 tier that cannot be re-derived, so they are kept, not pointered.
    critical_decisions: z
      .array(
        z.object({
          decision: z.string().min(1),
          rationale: z.string().min(1).describe('Why this decision was made (preserved inline)'),
        }),
      )
      .default([])
      .describe('Decisions that cannot be re-derived from the codebase — kept inline'),
    irreversible_risks: z
      .array(
        z.object({
          risk: z.string().min(1),
          why_irreversible: z
            .string()
            .min(1)
            .describe('Why this risk cannot be undone (preserved inline)'),
        }),
      )
      .default([])
      .describe('Risks whose substance is non-recoverable — kept inline, not pointer-only'),
    // wi_2607148yg (ac-9): the user-decision block for a fail / condition-(b)
    // (보안·시스템·프로젝트·기능설계 의도) blocked handoff — each entry pairs the
    // concrete decision the user must make with its options and the agent's CURRENT
    // interpretation (its lean + reading), so the handoff hands off a decision to
    // make, not just a dead end. Additive + OPTIONAL at the schema level (`.default([])`):
    // a legacy handoff written before this change omits it and parses unchanged.
    //
    // The required-WHEN-blocked enforcement (reject an EMPTY block on a fail/blocked
    // handoff) is n2-handoff's to wire via `.superRefine`, NOT here — mirroring the
    // conditional-require precedent: `completion-contract.ts` keeps `non_pass_status`
    // additive/optional and pushes the required-on-non-pass check to the gate
    // (`gates.ts` non_pass_status) so a legacy on-disk artifact is never retro-rejected
    // and fail-closed. n2-handoff should refine on ITS chosen blocked-handoff
    // discriminator (this schema has no status field today), requiring
    // `user_decision_block` non-empty only for a condition-(b)/fail handoff.
    user_decision_block: z
      .array(
        z.object({
          decision: z.string().min(1).describe('The decision the user must make'),
          options: z
            .array(z.string().min(1))
            .min(1)
            .describe('Concrete options/choices offered to the user'),
          agent_interpretation: z
            .string()
            .min(1)
            .describe("The agent's current reading / lean on the decision"),
        }),
      )
      .default([])
      .describe(
        'Decisions the user must make on a fail/condition-(b) handoff; enforced non-empty when blocked by n2-handoff superRefine (additive/optional here)',
      ),
    changed_files: z.array(relativePath).default([]),
    evidence_refs: z
      .array(evidenceRef)
      .default([])
      .describe('Inline summaries/hashes/commands, not raw artifacts'),
    failed_or_unverified: z.array(z.string()).default([]),
    open_threads: z.array(z.string()).default([]),
    next_first_check: z.string().min(1).describe('What the next agent checks first'),
    forbidden_scope_creep: z.array(z.string()).default([]),
    artifact_available: z
      .boolean()
      .default(true)
      .describe('False when raw artifacts are absent from this clone/session (§6.10)'),
    created_at: isoDateTime,
  })
  .describe('Minimal context for resuming across session/context/agent boundaries (§6.10)');

// Back-compat (ac-5): an OLD on-disk handoff carries a top-level `work_item_id` and
// NO `scope` discriminator. A z.discriminatedUnion requires the discriminant to be
// present, so normalize BEFORE the union parse — an absent `scope` with a top-level
// `work_item_id` is lifted to `scope: {kind:'work_item', work_item_id}`. New files
// (which already carry `scope`) pass through untouched; the stray top-level
// work_item_id is then stripped by the object parse.
export const handoff = z
  .preprocess((raw) => {
    if (
      raw !== null &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      (raw as Record<string, unknown>).scope === undefined &&
      (raw as Record<string, unknown>).work_item_id !== undefined
    ) {
      const obj = raw as Record<string, unknown>;
      return { ...obj, scope: { kind: 'work_item', work_item_id: obj.work_item_id } };
    }
    return raw;
  }, handoffObject)
  .describe('Minimal context for resuming across session/context/agent boundaries (§6.10)');

export type Handoff = z.infer<typeof handoff>;
