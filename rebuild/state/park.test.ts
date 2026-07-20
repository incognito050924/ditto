import { describe, expect, it } from 'bun:test';

import { park } from './park';
import type { QueueState } from './queue-state';

const baseState = (blocker: string | null = null): QueueState => ({
  round: 1,
  items: [],
  acceptance_criteria: [],
  last_stop_hook: null,
  backstop: { turns: 0, no_progress_rounds: 0, queue_size_trend: [] },
  blocker,
});

describe('park', () => {
  it('stamps a legible blocker on valid inputs without mutating the input state', () => {
    const state = baseState(null);
    const result = park(state, {
      decision: 'D1: adopt native seam',
      doneSummary: 'invariants 1-12 green',
      resumeCondition: 'human answers D1',
    });

    expect(result.parked).toBe(true);
    expect(result.state.blocker).toBe(
      'PARK — awaiting decision: D1: adopt native seam | done & verified: invariants 1-12 green | resume when: human answers D1',
    );
    // no mutation of the original state
    expect(state.blocker).toBe(null);
  });

  it('refuses empty decision (fail-closed), returning the same state unchanged', () => {
    const state = baseState('pre-existing blocker');
    const result = park(state, {
      decision: '',
      doneSummary: 'invariants 1-12 green',
      resumeCondition: 'human answers D1',
    });

    expect(result.parked).toBe(false);
    expect(result.reason).toBe(
      'park requires non-empty decision, doneSummary, resumeCondition',
    );
    // same object reference, blocker untouched
    expect(result.state).toBe(state);
    expect(result.state.blocker).toBe('pre-existing blocker');
  });

  it('refuses whitespace-only resumeCondition', () => {
    const state = baseState(null);
    const result = park(state, {
      decision: 'D1',
      doneSummary: 'done',
      resumeCondition: '   ',
    });

    expect(result.parked).toBe(false);
    expect(result.state).toBe(state);
  });

  it('refuses empty doneSummary', () => {
    const state = baseState(null);
    const result = park(state, {
      decision: 'D1',
      doneSummary: '',
      resumeCondition: 'human answers D1',
    });

    expect(result.parked).toBe(false);
    expect(result.state).toBe(state);
  });

  it('trims leading/trailing spaces of valid parts in the blocker string', () => {
    const state = baseState(null);
    const result = park(state, {
      decision: '  D1  ',
      doneSummary: '\tinvariants green\n',
      resumeCondition: '   human answers   ',
    });

    expect(result.parked).toBe(true);
    expect(result.state.blocker).toBe(
      'PARK — awaiting decision: D1 | done & verified: invariants green | resume when: human answers',
    );
  });
});
