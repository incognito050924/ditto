import { describe, expect, test } from 'bun:test';

import { createEvent, type WorkItemEvent } from './events';
import { reduceEvents } from './reduce';

function statusEvent(
  seq: number,
  to: 'draft' | 'in_progress' | 'blocked' | 'partial' | 'unverified' | 'done' | 'abandoned',
  options: { actor?: string; ts?: string; closed_at?: string | null } = {},
): WorkItemEvent {
  const payload: { to: typeof to; closed_at?: string | null } = { to };
  if (options.closed_at !== undefined) payload.closed_at = options.closed_at;
  return createEvent({
    work_item_id: 'wi_x',
    seq,
    actor: options.actor ?? 'a',
    ts: options.ts ?? '2026-07-23T00:00:00.000Z',
    kind: 'status',
    payload,
  });
}

describe('reduceEvents (deterministic fold over the immutable log)', () => {
  test('empty log reduces to no status', () => {
    const state = reduceEvents([]);
    expect(state.status).toBeNull();
    expect(state.closed_at).toBeNull();
    expect(state.verdicts).toEqual({});
  });

  test('orders by (seq, actor, event_id) — ts is never a sort key', () => {
    // seq 2 carries an EARLIER ts than seq 1; input array is reversed too.
    const late = statusEvent(2, 'blocked', { ts: '2026-01-01T00:00:00.000Z' });
    const early = statusEvent(1, 'in_progress', {
      ts: '2026-12-31T23:59:59.000Z',
    });
    const state = reduceEvents([late, early]);
    expect(state.status).toBe('blocked');
  });

  test('same seq ties break by actor then event_id, deterministically', () => {
    const a = statusEvent(1, 'in_progress', { actor: 'alpha' });
    const b = statusEvent(1, 'blocked', { actor: 'beta' });
    // beta sorts after alpha → beta wins regardless of input order
    expect(reduceEvents([a, b]).status).toBe('blocked');
    expect(reduceEvents([b, a]).status).toBe('blocked');
  });

  test('duplicate event_id applies once (dedupe)', () => {
    const e = statusEvent(1, 'in_progress');
    const state = reduceEvents([e, e, e]);
    expect(state.status).toBe('in_progress');
  });

  test('terminal-first-wins: a competing second terminal is ignored', () => {
    const state = reduceEvents([
      statusEvent(1, 'in_progress'),
      statusEvent(2, 'done', { closed_at: '2026-07-23T02:00:00.000Z' }),
      statusEvent(3, 'abandoned', { closed_at: '2026-07-23T03:00:00.000Z' }),
    ]);
    expect(state.status).toBe('done');
    expect(state.closed_at).toBe('2026-07-23T02:00:00.000Z');
  });

  test('reopen: a non-terminal transition after terminal applies and drops closed_at', () => {
    const state = reduceEvents([
      statusEvent(1, 'done', { closed_at: '2026-07-23T02:00:00.000Z' }),
      statusEvent(2, 'in_progress'),
    ]);
    expect(state.status).toBe('in_progress');
    expect(state.closed_at).toBeNull();
  });

  test('verdicts fold latest-wins per criterion, criteria independent', () => {
    const verdictEvent = (
      seq: number,
      criterion_id: string,
      v: 'pass' | 'fail' | 'unverified',
    ) =>
      createEvent({
        work_item_id: 'wi_x',
        seq,
        actor: 'a',
        ts: '2026-07-23T00:00:00.000Z',
        kind: 'verdict',
        payload: {
          criterion_id,
          verdict: v,
          evidence:
            v === 'pass'
              ? [{ kind: 'test' as const, path: 'x.test.ts', summary: 'green' }]
              : [],
        },
      });
    const state = reduceEvents([
      verdictEvent(1, 'ac1', 'fail'),
      verdictEvent(2, 'ac2', 'unverified'),
      verdictEvent(3, 'ac1', 'pass'),
    ]);
    expect(state.verdicts['ac1']?.verdict).toBe('pass');
    expect(state.verdicts['ac1']?.evidence).toHaveLength(1);
    expect(state.verdicts['ac2']?.verdict).toBe('unverified');
  });
});
