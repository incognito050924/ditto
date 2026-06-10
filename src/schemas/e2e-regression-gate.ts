import { z } from 'zod';
import { journeyDslId } from './journey-dsl';

/**
 * 회귀 게이트 기록 (wi_260610p9h ac-7, `.ditto/local/work-items/<wi>/regression-gate.json`).
 *
 * The record is the no-escape guarantee: `selected` (what the diff × surfaces
 * crossing picked) and `journey_results` (what actually happened per journey)
 * are persisted together, so a verifier can mechanically detect "it was on the
 * list but failed / was blocked / never ran" — none of which may close as pass.
 */

export const regressionSelectedJourney = z
  .object({
    id: journeyDslId,
    name: z.string().min(1).describe('Human-facing journey name (selection is presented by name)'),
    description: z.string().min(1).describe('Journey purpose (presented alongside name)'),
    journey_file: z.string().min(1).describe('Repo-relative .journey.md path'),
    generated_spec: z
      .string()
      .min(1)
      .describe('Repo-relative conventional e2e/generated/<slug>.spec.ts path'),
    matched_surfaces: z
      .array(z.string())
      .default([])
      .describe('component: surfaces that intersected the diff ([] for user-added journeys)'),
    missing_generated: z
      .boolean()
      .default(false)
      .describe('True when the conventional generated spec is absent (broken derivative)'),
  })
  .describe('One journey selected into the regression gate');

export type RegressionSelectedJourney = z.infer<typeof regressionSelectedJourney>;

export const regressionJourneyOutcome = z
  .enum(['pass', 'fail', 'blocked', 'not_run'])
  .describe('Per-journey outcome inside the gate (not_run = selected but spec missing)');

export type RegressionJourneyOutcome = z.infer<typeof regressionJourneyOutcome>;

export const regressionInvalidJourney = z
  .object({
    file: z.string().min(1).describe('Repo-relative .journey.md path that failed to parse'),
    error: z.string().min(1).describe('Why the journey could not be parsed'),
  })
  .describe('A journey the selection could not parse — persisted, never silently dropped');

export const regressionGateFailure = z
  .object({
    journey_id: z.string().min(1).describe('Failing journey id (jrn-… or (unmapped))'),
    case: z.string().min(1).describe('Failing case name from the test title'),
  })
  .describe('One journey·case failure observed by the gate run');

export const regressionGateRecord = z
  .object({
    work_item: z.string().min(1).describe('Work item the gate ran for'),
    run_id: z.string().min(1).describe('verifyGenerated run id (.ditto/local/runs/<run_id>/)'),
    changed_paths: z.array(z.string()).describe('Diff paths the selection crossed against'),
    selected: z
      .array(regressionSelectedJourney)
      .describe('The impacted (or user-adjusted) journey list — the no-escape set'),
    auto_selected: z
      .array(journeyDslId)
      .default([])
      .describe(
        'Journey ids the diff × surfaces crossing picked automatically — diffable against selected when the user adjusted',
      ),
    journey_results: z
      .array(
        z.object({
          journey_id: z.string().min(1),
          result: regressionJourneyOutcome,
        }),
      )
      .describe('Per-journey outcome — lets a verifier detect selected-but-not-passed'),
    invalid_journeys: z
      .array(regressionInvalidJourney)
      .default([])
      .describe('Unparsable journeys found during selection — any entry forces a non-pass gate'),
    result: z
      .enum(['pass', 'fail', 'blocked'])
      .describe('Gate verdict: pass only when every selected journey ran and passed'),
    failures: z.array(regressionGateFailure).default([]).describe('Observed journey·case failures'),
    reason: z.string().min(1).describe('Why the gate landed on this result'),
    recorded_at: z.string().min(1).describe('ISO timestamp of the record'),
  })
  .describe('Regression gate record (.ditto/local/work-items/<wi>/regression-gate.json)');

export type RegressionGateRecord = z.infer<typeof regressionGateRecord>;
