import { describe, expect, test } from 'bun:test';

import { queueState } from '../state/queue-state';
import { evaluateStopGate } from './stop-gate';

const baseState = queueState.parse({
  round: 1,
  items: [
    {
      id: 'i1',
      kind: 'found-defect',
      exit: 'resolved',
      evidence_ref: 'ref#1',
      disposition_note: 'done',
    },
  ],
  acceptance_criteria: [{ id: 'ac-1', status: 'pass', evidence_ref: 'log#1' }],
  last_stop_hook: null,
  backstop: { turns: 1, no_progress_rounds: 0, queue_size_trend: [1] },
  blocker: null,
});

const greenInput = {
  testExitCode: 0,
  state: baseState,
  foundationCompleteEmitted: false,
  stopHookActive: false,
};

describe('evaluateStopGate — allow (green) path', () => {
  test('exit 0 when tests green, no pending, all pass-ACs have evidence', () => {
    const d = evaluateStopGate(greenInput);
    expect(d.exitCode).toBe(0);
    expect(d.reasons).toEqual([]);
  });
});

describe('evaluateStopGate — block (exit 2) paths', () => {
  test('blocks when the test runner is red', () => {
    const d = evaluateStopGate({ ...greenInput, testExitCode: 1 });
    expect(d.exitCode).toBe(2);
    expect(d.reasons.join(' ')).toContain('red');
  });

  test('blocks when a queue item is still pending (exit null)', () => {
    const state = queueState.parse({
      ...baseState,
      items: [
        {
          id: 'i2',
          kind: 'in-scope-residual',
          exit: null,
          evidence_ref: null,
          disposition_note: null,
        },
      ],
    });
    const d = evaluateStopGate({ ...greenInput, state });
    expect(d.exitCode).toBe(2);
    expect(d.reasons.join(' ')).toContain('pending');
  });

  test('blocks when an AC claims pass without live evidence', () => {
    const state = queueState.parse({
      ...baseState,
      acceptance_criteria: [
        { id: 'ac-9', status: 'pass', evidence_ref: null },
      ],
    });
    const d = evaluateStopGate({ ...greenInput, state });
    expect(d.exitCode).toBe(2);
    expect(d.reasons.join(' ')).toContain('ac-9');
  });

  test('blocks a FOUNDATION-COMPLETE emitted while a queue item is pending', () => {
    const state = queueState.parse({
      ...baseState,
      items: [
        {
          id: 'i2',
          kind: 'in-scope-residual',
          exit: null,
          evidence_ref: null,
          disposition_note: null,
        },
      ],
    });
    const d = evaluateStopGate({
      ...greenInput,
      state,
      foundationCompleteEmitted: true,
    });
    expect(d.exitCode).toBe(2);
    expect(d.reasons.join(' ').toLowerCase()).toContain('complete');
  });

  test('accumulates multiple block reasons at once', () => {
    const state = queueState.parse({
      ...baseState,
      items: [
        {
          id: 'i2',
          kind: 'in-scope-residual',
          exit: null,
          evidence_ref: null,
          disposition_note: null,
        },
      ],
      acceptance_criteria: [{ id: 'ac-9', status: 'pass', evidence_ref: null }],
    });
    const d = evaluateStopGate({ ...greenInput, testExitCode: 1, state });
    expect(d.exitCode).toBe(2);
    expect(d.reasons.length).toBeGreaterThanOrEqual(3);
  });
});

describe('evaluateStopGate — stop_hook_active is surfaced, not surrendered', () => {
  test('a repeat block (stop_hook_active) still blocks unmet conditions', () => {
    // Infinite-block avoidance is the block cap (60), NOT surrendering the gate.
    const state = queueState.parse({
      ...baseState,
      items: [
        {
          id: 'i2',
          kind: 'in-scope-residual',
          exit: null,
          evidence_ref: null,
          disposition_note: null,
        },
      ],
    });
    const d = evaluateStopGate({
      ...greenInput,
      state,
      stopHookActive: true,
    });
    expect(d.exitCode).toBe(2);
    expect(d.repeatBlock).toBe(true);
  });
});
