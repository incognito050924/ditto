import { z } from 'zod';
import { acgChangeEnvelope } from './acg-common';

/**
 * ACG JourneyRun (20-contracts §2.5 / §0.2) — executed-journey evidence artifact.
 *
 * DITTO binding (D4, v0-plan §3): realized via DITTO `e2eJourney`. result
 * pass/fail/blocked maps to outcome pass/fail/skipped (blocked→skipped); `flaky`
 * is a spec outcome the current e2eJourney does NOT produce (its result enum
 * lacks it) — kept here for spec completeness, mapped only once e2e adds
 * retry-detection. The adapter lives in WU-5.
 */

export const acgJourneyStepResult = z
  .object({
    step_id: z.string().min(1),
    outcome: z.enum(['pass', 'fail']),
  })
  .describe('Per-step result');

export const acgJourneyRun = z
  .object({
    ...acgChangeEnvelope('acg.journey-run.v1'),
    journey_id: z.string().min(1).describe('JourneySpec.id'),
    outcome: z.enum(['pass', 'fail', 'flaky', 'skipped']),
    step_results: z.array(acgJourneyStepResult).default([]),
    artifacts: z
      .array(z.string().min(1))
      .default([])
      .describe('screenshot/trace/console/network paths'),
  })
  .describe('ACG JourneyRun — executed user-journey evidence (binds to e2eJourney)');

export type AcgJourneyRun = z.infer<typeof acgJourneyRun>;
