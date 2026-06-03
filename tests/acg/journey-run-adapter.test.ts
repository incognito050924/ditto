import { describe, expect, test } from 'bun:test';
import {
  type JourneyRunContext,
  e2eResultToOutcome,
  projectE2EJourneyToJourneyRun,
} from '~/acg/journey/journey-run-adapter';
import { acgJourneyRun } from '~/schemas/acg-journey-run';
import { type E2EJourney, e2eJourney } from '~/schemas/e2e-journey';

// WU-5 acceptance (v0-plan §4):
//  (a) result pass/fail/blocked → outcome pass/fail/skipped, blocked→skipped.
//  (b) journey_id/work_item_id additions do not regress existing e2e consumers.
//  (c) flaky is never produced by the adapter (type + behavior).

const baseJourney = (overrides: Partial<E2EJourney> = {}): E2EJourney =>
  e2eJourney.parse({
    schema_version: '0.1.0',
    journey: 'checkout flow',
    url: 'http://localhost:3000/cart',
    result: 'pass',
    ...overrides,
  });

const ctx: JourneyRunContext = {
  work_item_id: 'wi_abcd1234',
  journey_id: 'jrn-checkout',
  produced_at: '2026-06-03T00:00:00Z',
};

describe('journey-run-adapter (WU-5, D4)', () => {
  test('acc-a: result→outcome mapping, blocked→skipped', () => {
    expect(e2eResultToOutcome('pass')).toBe('pass');
    expect(e2eResultToOutcome('fail')).toBe('fail');
    expect(e2eResultToOutcome('blocked')).toBe('skipped');
  });

  test('acc-a: projected JourneyRun outcome follows the mapping', () => {
    expect(projectE2EJourneyToJourneyRun(baseJourney({ result: 'pass' }), ctx).outcome).toBe(
      'pass',
    );
    expect(
      projectE2EJourneyToJourneyRun(
        baseJourney({ result: 'fail', reproduction: 'reload, click pay' }),
        ctx,
      ).outcome,
    ).toBe('fail');
    expect(projectE2EJourneyToJourneyRun(baseJourney({ result: 'blocked' }), ctx).outcome).toBe(
      'skipped',
    );
  });

  test('produces a schema-valid acg.journey-run.v1', () => {
    const run = projectE2EJourneyToJourneyRun(baseJourney(), ctx);
    expect(() => acgJourneyRun.parse(run)).not.toThrow();
    expect(run.kind).toBe('acg.journey-run.v1');
    expect(run.work_item_id).toBe('wi_abcd1234');
    expect(run.journey_id).toBe('jrn-checkout');
    expect(run.produced_by).toBe('agent');
  });

  test('artifacts flatten to a path list (screenshots + trace/console/network)', () => {
    const journey = baseJourney({
      artifacts: {
        screenshots: [{ path: '.ditto/runs/r1/a.png' }, { path: '.ditto/runs/r1/b.png' }],
        trace: { path: '.ditto/runs/r1/trace.zip' },
        console: { path: '.ditto/runs/r1/console.log' },
        network: null,
      },
    });
    const run = projectE2EJourneyToJourneyRun(journey, ctx);
    expect(run.artifacts).toEqual([
      '.ditto/runs/r1/a.png',
      '.ditto/runs/r1/b.png',
      '.ditto/runs/r1/trace.zip',
      '.ditto/runs/r1/console.log',
    ]);
  });

  test('acc-c: never emits flaky for any e2e result', () => {
    for (const result of ['pass', 'fail', 'blocked'] as const) {
      const j = baseJourney(result === 'fail' ? { result, reproduction: 'steps' } : { result });
      expect(projectE2EJourneyToJourneyRun(j, ctx).outcome).not.toBe('flaky');
    }
  });

  test('identity falls back to e2eJourney fields when ctx omits them', () => {
    const journey = baseJourney({ journey_id: 'jrn-from-journey', work_item_id: 'wi_99887766' });
    const run = projectE2EJourneyToJourneyRun(journey, { produced_at: '2026-06-03T00:00:00Z' });
    expect(run.journey_id).toBe('jrn-from-journey');
    expect(run.work_item_id).toBe('wi_99887766');
  });

  test('throws when neither ctx nor journey supplies identity', () => {
    expect(() =>
      projectE2EJourneyToJourneyRun(baseJourney(), { produced_at: '2026-06-03T00:00:00Z' }),
    ).toThrow();
  });
});

describe('e2eJourney schema additions (WU-5, acc-b regression)', () => {
  test('pre-ACG e2eJourney (no journey_id/work_item_id) stays valid', () => {
    const parsed = e2eJourney.parse({
      schema_version: '0.1.0',
      journey: 'legacy journey',
      url: 'http://localhost:3000',
      result: 'pass',
    });
    expect(parsed.journey_id).toBeUndefined();
    expect(parsed.work_item_id).toBeUndefined();
    // existing superRefine behavior unchanged
    expect(parsed.reproduction).toBeNull();
  });

  test('new fields are accepted when present', () => {
    const parsed = e2eJourney.parse({
      schema_version: '0.1.0',
      journey: 'checkout',
      journey_id: 'jrn-checkout',
      work_item_id: 'wi_abcd1234',
      url: 'http://localhost:3000',
      result: 'pass',
    });
    expect(parsed.journey_id).toBe('jrn-checkout');
    expect(parsed.work_item_id).toBe('wi_abcd1234');
  });

  test('existing fail-requires-reproduction refinement still fires', () => {
    expect(() =>
      e2eJourney.parse({
        schema_version: '0.1.0',
        journey: 'x',
        url: 'http://localhost:3000',
        result: 'fail',
      }),
    ).toThrow();
  });
});
