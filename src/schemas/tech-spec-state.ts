import { z } from 'zod';
import { schemaVersion, workItemId } from './common';

/**
 * tech-spec sidecar — state of the spec co-authoring machine for one work item
 * (`.ditto/local/work-items/<id>/tech-spec-state.json`). The spec *document*
 * lives at `doc_path` (project-global, git-tracked); this sidecar carries the
 * per-developer machine state: mode, per-section review coverage, grounding
 * evidence, and the finalize stamp.
 */

export const specSectionId = z
  .enum([
    'feature',
    'summary',
    'background',
    'goals',
    'non-goals',
    'acceptance-criteria',
    'risks',
    'plan',
    'impact',
    'rejected-alternatives',
    'milestones',
    'interview-log',
    'post-build',
  ])
  .describe('Template section ids (skills/tech-spec/TEMPLATE.md, 13 sections)');

export const specGroundingEvidence = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('memory'),
      projection_id: z.string().min(1).describe('projection_id from a ditto memory query answer'),
      freshness: z.enum(['fresh', 'stale', 'absent']).optional(),
    }),
    z.object({
      kind: z.literal('acg'),
      path: z.string().min(1).describe('Path to an ACG artifact backing the claim'),
    }),
  ])
  .describe('Grounding-query evidence for factual sections (ac-9)');

export const specReviewState = z
  .enum(['pending', 'reviewed', 'skipped'])
  .describe('Per-section review coverage; skipped is recorded honestly, never as agreement');

export const specSectionRecord = z.object({
  id: specSectionId,
  review: specReviewState,
  evidence: z.array(specGroundingEvidence).default([]),
  recorded_at: z.string().min(1),
});

export const techSpecState = z
  .object({
    schema_version: schemaVersion,
    work_item_id: workItemId,
    doc_path: z.string().min(1).describe('Spec document path relative to repo root'),
    mode: z
      .enum(['stepwise', 'oneshot'])
      .describe('Writing/review rhythm; gates are mode-invariant'),
    sections: z.array(specSectionRecord).default([]),
    finalized: z
      .object({
        at: z.string().min(1),
        digest: z.string().regex(/^[0-9a-f]{64}$/),
        review_coverage: z.array(z.object({ id: specSectionId, review: specReviewState })),
      })
      .nullable()
      .default(null)
      .describe('Finalize stamp incl. per-section review coverage (design §8)'),
    updated_at: z.string().min(1),
  })
  .describe('tech-spec co-authoring machine state for one work item');

export type SpecSectionId = z.infer<typeof specSectionId>;
export type SpecGroundingEvidence = z.infer<typeof specGroundingEvidence>;
export type TechSpecState = z.infer<typeof techSpecState>;
