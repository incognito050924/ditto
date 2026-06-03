import { z } from 'zod';
import { acgCatalogEnvelope } from './acg-common';

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
    id: z
      .string()
      .min(1)
      .describe('Stable identifier other schemas reference (e.g. jrn-process-run)'),
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
