import { describe, expect, test } from 'bun:test';

import { evaluateBackstop } from './backstop';

describe('evaluateBackstop — invariant 12 divergence gate', () => {
  test('healthy drain does not trip', () => {
    const decision = evaluateBackstop(
      { turns: 4, no_progress_rounds: 0, queue_size_trend: [8, 7, 6] },
      { maxNoProgressRounds: 3 },
    );
    expect(decision).toEqual({ tripped: false, reasons: [] });
  });

  test('R1 trips when no_progress_rounds reaches the limit', () => {
    const decision = evaluateBackstop(
      { turns: 9, no_progress_rounds: 3, queue_size_trend: [8, 7, 6] },
      { maxNoProgressRounds: 3 },
    );
    expect(decision.tripped).toBe(true);
    expect(decision.reasons).toHaveLength(1);
    expect(decision.reasons[0]).toContain('limit 3');
    expect(decision.reasons[0]).toContain('no_progress_rounds 3');
  });

  test('R2 trips on a non-decreasing, net-growth trend', () => {
    const decision = evaluateBackstop(
      { turns: 9, no_progress_rounds: 0, queue_size_trend: [5, 6, 7] },
      { maxNoProgressRounds: 3 },
    );
    expect(decision.tripped).toBe(true);
    expect(decision.reasons).toHaveLength(1);
    expect(decision.reasons[0]).toContain('[5, 6, 7]');
  });

  test('R2 does not trip on a plateau (no net growth)', () => {
    const decision = evaluateBackstop(
      { turns: 9, no_progress_rounds: 0, queue_size_trend: [6, 6, 6] },
      { maxNoProgressRounds: 3 },
    );
    expect(decision).toEqual({ tripped: false, reasons: [] });
  });

  test('R2 needs a full window: short trends never trip', () => {
    const one = evaluateBackstop(
      { turns: 1, no_progress_rounds: 0, queue_size_trend: [9] },
      { maxNoProgressRounds: 3 },
    );
    expect(one).toEqual({ tripped: false, reasons: [] });

    const two = evaluateBackstop(
      { turns: 2, no_progress_rounds: 0, queue_size_trend: [9, 8] },
      { maxNoProgressRounds: 3 },
    );
    expect(two).toEqual({ tripped: false, reasons: [] });
  });

  test('R1 and R2 together accumulate two reasons', () => {
    const decision = evaluateBackstop(
      { turns: 12, no_progress_rounds: 4, queue_size_trend: [5, 6, 7] },
      { maxNoProgressRounds: 3 },
    );
    expect(decision.tripped).toBe(true);
    expect(decision.reasons).toHaveLength(2);
    expect(decision.reasons[0]).toContain('no_progress_rounds 4');
    expect(decision.reasons[1]).toContain('[5, 6, 7]');
  });
});
