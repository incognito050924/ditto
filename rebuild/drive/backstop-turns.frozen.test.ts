import { describe, expect, test } from 'bun:test';

import { evaluateBackstop } from './backstop';

/**
 * FROZEN ORACLE — first self-host demo task (wi_2607201id).
 *
 * WHY THIS TEST EXISTS: rebuild/drive/backstop.ts carries a `backstop.turns`
 * field (state/queue-state.ts) that evaluateBackstop never reads — a dead field.
 * This oracle encodes the demo AC: the dead `turns` field must become a LIVE
 * divergence trip, so the negative backstop can also escape on a raw turn budget
 * (not only on no-progress / non-draining trend).
 *
 * RED BEFORE THE DEMO: the current evaluateBackstop ignores `turns` and takes no
 * `maxTurns` option, so the at-limit case below does NOT trip → assertion RED.
 * GREEN ONLY AFTER the drive loop edits backstop.ts to add an OPTIONAL
 * `opts.maxTurns` and push a `turns N >= limit M` reason when turns >= maxTurns.
 *
 * FROZEN: this file is hash-frozen in the outer loop's oraclePaths; the drive
 * loop MUST NOT edit it — it earns green by editing backstop.ts alone.
 *
 * EDGE CASES PINNED:
 *  - at the limit (turns == maxTurns) trips (>= is inclusive);
 *  - below the limit does not trip the turns rule;
 *  - maxTurns is OPTIONAL — omitting it keeps the existing R1/R2 behavior intact
 *    (so backstop.test.ts, which never passes maxTurns, still passes).
 */
describe('backstop.turns divergence trip (frozen demo oracle)', () => {
  test('turns >= maxTurns trips with a turns reason (inclusive, at the limit)', () => {
    const decision = evaluateBackstop(
      { turns: 3, no_progress_rounds: 0, queue_size_trend: [3, 2, 1] },
      { maxNoProgressRounds: 5, maxTurns: 3 },
    );
    expect(decision.tripped).toBe(true);
    expect(
      decision.reasons.some((r) => r.includes('turns 3') && r.includes('limit 3')),
    ).toBe(true);
  });

  test('turns below maxTurns does not trip the turns rule', () => {
    const decision = evaluateBackstop(
      { turns: 2, no_progress_rounds: 0, queue_size_trend: [3, 2, 1] },
      { maxNoProgressRounds: 5, maxTurns: 3 },
    );
    expect(decision.reasons.some((r) => r.includes('turns'))).toBe(false);
  });

  test('omitting maxTurns keeps the pre-existing behavior (no turns rule)', () => {
    const decision = evaluateBackstop(
      { turns: 99, no_progress_rounds: 0, queue_size_trend: [3, 2, 1] },
      { maxNoProgressRounds: 5 },
    );
    expect(decision).toEqual({ tripped: false, reasons: [] });
  });
});
