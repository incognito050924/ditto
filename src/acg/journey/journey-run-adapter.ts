import type { AcgJourneyRun } from '~/schemas/acg-journey-run';
import { acgJourneyRun } from '~/schemas/acg-journey-run';
import type { E2EJourney } from '~/schemas/e2e-journey';

/**
 * JourneyRun ↔ e2eJourney adapter (ACG binding D4, WU-5).
 *
 * Projects a DITTO `e2eJourney` (browser user-journey result) into the ACG
 * `acg.journey-run.v1` evidence artifact. Like the ReviewGraph adapter (D3),
 * this ONLY READS the e2eJourney type — e2eJourney is never mutated and its
 * schema additions (journey_id/work_item_id) are optional (acc-b).
 *
 * Binding rules (20-contracts §0.2 JourneyRun←e2eJourney; v0-plan WU-5):
 *  - result pass  → outcome pass
 *  - result fail  → outcome fail
 *  - result blocked → outcome skipped (a blocked run did not execute; acc-a)
 *  - artifacts (screenshots/trace/console/network) → flattened path list
 *
 * `flaky` is a JourneyRun outcome the spec defines, but the current e2eJourney
 * has no retry/flake detection (its `result` enum is pass/fail/blocked only), so
 * THIS ADAPTER NEVER PRODUCES `flaky` (acc-c). The return type of the mapper
 * below excludes it at the type level; flaky is reachable only once e2e gains
 * retry-detection and a JourneyRun is authored directly.
 */

/** JourneyRun fields the e2eJourney cannot carry; the caller supplies them. */
export interface JourneyRunContext {
  /** Work item this run belongs to; falls back to journey.work_item_id. */
  work_item_id?: string;
  /** ACG JourneySpec.id; falls back to journey.journey_id. */
  journey_id?: string;
  /** ISO timestamp of the run. The adapter is pure — the caller stamps time. */
  produced_at: string;
  /** Defaults to 'agent' (the e2e agent runs the journey). */
  produced_by?: 'agent' | 'user';
}

/**
 * e2eJourney.result → JourneyRun.outcome. Total over the e2eResult enum; the
 * return type excludes 'flaky' to encode acc-c (this path never emits flaky).
 */
export function e2eResultToOutcome(
  result: E2EJourney['result'],
): Exclude<AcgJourneyRun['outcome'], 'flaky'> {
  switch (result) {
    case 'pass':
      return 'pass';
    case 'fail':
      return 'fail';
    case 'blocked':
      return 'skipped';
  }
}

/** Flatten e2eArtifacts (screenshots[] + trace/console/network) to path strings. */
function artifactPaths(artifacts: E2EJourney['artifacts']): string[] {
  const paths = artifacts.screenshots.map((s) => s.path);
  for (const ref of [artifacts.trace, artifacts.console, artifacts.network]) {
    if (ref !== null) paths.push(ref.path);
  }
  return paths;
}

/**
 * Project an e2eJourney into an acg.journey-run.v1. Thin pure function, no I/O.
 * The returned object is validated against `acgJourneyRun` before return.
 *
 * `journey_id`/`work_item_id` resolve from the context first, then fall back to
 * the (optional) fields now on e2eJourney. JourneyRun requires both, so an
 * absent identity on both sides is rejected by the schema parse — by design.
 *
 * `step_results` is left empty: an e2eJourney records steps (action/target) and
 * assertions, but not a per-step pass/fail keyed by a stable step_id, so no
 * faithful step_result can be derived. JourneyRun.step_results defaults to [].
 */
export function projectE2EJourneyToJourneyRun(
  journey: E2EJourney,
  ctx: JourneyRunContext,
): AcgJourneyRun {
  return acgJourneyRun.parse({
    schema_version: journey.schema_version,
    kind: 'acg.journey-run.v1',
    work_item_id: ctx.work_item_id ?? journey.work_item_id,
    produced_by: ctx.produced_by ?? 'agent',
    produced_at: ctx.produced_at,
    journey_id: ctx.journey_id ?? journey.journey_id,
    outcome: e2eResultToOutcome(journey.result),
    artifacts: artifactPaths(journey.artifacts),
  });
}
