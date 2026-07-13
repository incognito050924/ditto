import { z } from 'zod';
import { acgEvidenceKind } from './acg-common';

/**
 * ACG ReviewGraph — Review by Exception. Risk-classifies the
 * change and produces the minimal set a human must judge.
 *
 * DITTO binding: this is realized as an `acg_review` EXTENSION
 * OBJECT attached to reviewer-output — NOT a standalone wire artifact. It carries
 * no own envelope; it rides reviewer-output's schema_version/id/work_item_id.
 */

const journeyRoles = ['ui', 'user_journey'] as const;

export const acgReviewFile = z
  .object({
    path: z.string().min(1).optional().describe('Code location; required unless role is a journey'),
    journey_id: z
      .string()
      .optional()
      .describe('JourneySpec.id; required when role is ui/user_journey (OBJ-52)'),
    role: z
      .enum([
        'test_fixture',
        'private_helper',
        'service_logic',
        'public_api',
        'migration',
        'auth',
        'payment',
        'data_deletion',
        'config',
        'ui',
        'user_journey',
      ])
      .optional(),
    risk: z.enum(['low', 'medium', 'high']),
    risk_reason: z.string().min(1).describe('Empty reason = invalid classification'),
    evidence: z
      .object({
        kind: acgEvidenceKind,
        ref: z.string().optional().describe('e2e → JourneyRun (acg.journey-run.v1) reference'),
      })
      .optional()
      .describe('Evidence; may be omitted when unresolved=true'),
    unresolved: z
      .boolean()
      .default(false)
      .describe('Evidence-absence marker (OBJ-53). NOT an evidenceRef.kind — a separate flag'),
  })
  .superRefine((value, ctx) => {
    const isJourney = (journeyRoles as readonly string[]).includes(value.role ?? '');
    if (isJourney && !value.journey_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ui/user_journey role requires journey_id',
        path: ['journey_id'],
      });
    }
    if (!isJourney && !value.path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'non-journey file requires path',
        path: ['path'],
      });
    }
  })
  .describe('One risk-classified file/flow in the review graph');

export const acgReviewGraph = z
  .object({
    kind: z.literal('acg.review-graph.v1'),
    files: z.array(acgReviewFile).default([]),
    human_review_set: z
      .array(z.string().min(1))
      .default([])
      .describe('Exceptions a human must judge — not the whole diff'),
  })
  .describe('ACG ReviewGraph — acg_review extension object on reviewer-output (D3)');

export type AcgReviewGraph = z.infer<typeof acgReviewGraph>;
export type AcgReviewFile = z.infer<typeof acgReviewFile>;
