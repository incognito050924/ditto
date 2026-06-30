import { z } from 'zod';
import { acgCatalogEnvelope } from './acg-common';
import { storySpecId } from './acg-story-spec';
import { journeyDslId } from './journey-dsl';

/**
 * JourneySpec lifecycle status (additive, optional — pre-existing catalog entries
 * with no status still parse). Four states, not a single "awaiting": a journey is
 * spec'd first, then awaits validation, becomes validated, or is superseded.
 */
export const acgJourneyStatus = z
  .enum(['spec_first', 'awaiting_validation', 'validated', 'superseded'])
  .describe('Journey lifecycle status (spec_first → awaiting_validation → validated | superseded)');

/**
 * ACG JourneySpec (20-contracts §2.5) — first-class spec of a user journey. A
 * per-repo catalog (like ArchitectureSpec); ImpactGraph/ReviewGraph/JourneyRun
 * reference it by `id`. A journey is a flow, not a file (OBJ-20).
 */

export const acgJourneyStep = z
  .object({
    step_id: z.string().min(1),
    intent: z.string().min(1).describe('What the user achieves at this step'),
    expected_outcome: z.string().optional(),
  })
  .describe('One step of a journey, with a stable step_id');

export const acgJourneySpec = z
  .object({
    ...acgCatalogEnvelope('acg.journey-spec.v1'),
    id: journeyDslId.describe(
      'Stable journey identifier (jrn-<kebab>) other schemas reference (e.g. jrn-process-run)',
    ),
    status: acgJourneyStatus.optional(),
    story_id: storySpecId
      .optional()
      .describe('Back-link to the story (us- id) this journey belongs to (traceability anchor)'),
    title: z.string().optional(),
    owner: z.string().min(1).describe('Product owner of the journey — freshness/judgment subject'),
    steps: z.array(acgJourneyStep).default([]),
    surfaces: z
      .array(z.string().min(1))
      .default([])
      .describe('Code/product surfaces (route/component/endpoint) this journey touches'),
    fixtures: z.array(z.string().min(1)).default([]),
    evidence_requirement: z.object({
      kind: z.enum(['e2e', 'screen', 'manual']),
      must_pass_steps: z.array(z.string().min(1)).default([]),
    }),
    freshness: z
      .object({
        last_validated: z.string().datetime({ offset: true }).optional(),
        stale_after_days: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .describe('ACG JourneySpec — first-class user-journey catalog entry');

export type AcgJourneySpec = z.infer<typeof acgJourneySpec>;
