import { z } from 'zod';
import {
  evidenceRef,
  isoDateTime,
  relativePath,
  reviewId,
  schemaVersion,
  severity,
  verdict,
  workItemId,
} from './common';

export const reviewKind = z
  .enum([
    'plan-check',
    'verifier',
    'code-reviewer',
    'security-reviewer',
    'e2e-reviewer',
    'cross-provider-reviewer',
  ])
  .describe('Which evaluator lane produced this output');

export const finding = z
  .object({
    severity: severity,
    file: relativePath.optional(),
    location: z
      .string()
      .optional()
      .describe('Line range or symbol; free-form because not all reviewers are code-based'),
    reason: z.string().min(1),
    suggested_fix: z.string().optional(),
  })
  .describe('A single concrete observation from the reviewer');

export const reviewerOutput = z
  .object({
    schema_version: schemaVersion,
    id: reviewId,
    work_item_id: workItemId,
    kind: reviewKind,
    reviewer: z
      .string()
      .min(1)
      .describe('Identifier of the reviewing profile/agent; not the generator'),
    different_provider_than_generator: z
      .boolean()
      .describe('True if reviewer ran on a different provider or model family than the generator'),
    started_at: isoDateTime,
    ended_at: isoDateTime.optional(),
    verdict: verdict,
    evidence: z.array(evidenceRef).default([]),
    findings: z.array(finding).default([]),
    unverified: z
      .array(
        z.object({
          item: z.string().min(1),
          reason: z.string().min(1),
        }),
      )
      .default([]),
    recommended_next_action: z
      .string()
      .min(1)
      .describe('A single concrete next step; not a list of options'),
    review_not_run_reason: z
      .string()
      .optional()
      .describe('Set when verdict could not be produced due to budget/availability'),
  })
  .superRefine((value, ctx) => {
    if (
      value.verdict === 'unverified' &&
      !value.review_not_run_reason &&
      value.evidence.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'verdict=unverified requires either evidence or review_not_run_reason',
        path: ['review_not_run_reason'],
      });
    }
  })
  .describe('Output contract for any reviewer/evaluator lane');

export type ReviewerOutput = z.infer<typeof reviewerOutput>;
export type Finding = z.infer<typeof finding>;
export type ReviewKind = z.infer<typeof reviewKind>;
