import { describe, expect, test } from 'bun:test';

import { readLegibility } from './legibility';
import type { QueueState, QueueStateItem } from './queue-state';

const baseState = (items: QueueStateItem[]): QueueState => ({
  round: 1,
  items,
  acceptance_criteria: [],
  last_stop_hook: null,
  backstop: { turns: 0, no_progress_rounds: 0, queue_size_trend: [] },
  blocker: null,
});

const item = (over: Partial<QueueStateItem>): QueueStateItem => ({
  id: 'x',
  kind: 'found-defect',
  exit: null,
  evidence_ref: null,
  disposition_note: null,
  ...over,
});

test('mixed state → counts, not settled, forgotten lists open id, exact summary', () => {
  const state = baseState([
    item({ id: 'a', exit: 'resolved' }),
    item({ id: 'b', exit: 'resolved' }),
    item({ id: 'c', exit: 'new-scope-deferral' }),
    item({ id: 'd', exit: 'escape' }),
    item({ id: 'e', exit: null }),
  ]);
  const result = readLegibility(state);
  expect(result.howFar).toEqual({
    resolved: 2,
    deferred: 1,
    escaped: 1,
    open: 1,
    total: 5,
  });
  expect(result.settled).toBe(false);
  expect(result.forgotten).toEqual(['e']);
  expect(result.summary).toBe(
    '2/5 resolved, 1 deferred, 1 escaped, 1 open — NOT settled (open: e)',
  );
});

test('all resolved → settled, no forgotten, summary ends with SETTLED', () => {
  const state = baseState([
    item({ id: 'a', exit: 'resolved' }),
    item({ id: 'b', exit: 'resolved' }),
  ]);
  const result = readLegibility(state);
  expect(result.settled).toBe(true);
  expect(result.forgotten).toEqual([]);
  expect(result.summary).toBe(
    '2/2 resolved, 0 deferred, 0 escaped, 0 open — SETTLED',
  );
});

test('empty items → all zeros, settled, empty forgotten, exact summary', () => {
  const result = readLegibility(baseState([]));
  expect(result.howFar).toEqual({
    resolved: 0,
    deferred: 0,
    escaped: 0,
    open: 0,
    total: 0,
  });
  expect(result.settled).toBe(true);
  expect(result.forgotten).toEqual([]);
  expect(result.summary).toBe(
    '0/0 resolved, 0 deferred, 0 escaped, 0 open — SETTLED',
  );
});

test('two open items → forgotten both ids in items order, summary comma-joins them', () => {
  const state = baseState([
    item({ id: 'first', exit: null }),
    item({ id: 'r', exit: 'resolved' }),
    item({ id: 'second', exit: null }),
  ]);
  const result = readLegibility(state);
  expect(result.howFar).toEqual({
    resolved: 1,
    deferred: 0,
    escaped: 0,
    open: 2,
    total: 3,
  });
  expect(result.settled).toBe(false);
  expect(result.forgotten).toEqual(['first', 'second']);
  expect(result.summary).toBe(
    '1/3 resolved, 0 deferred, 0 escaped, 2 open — NOT settled (open: first,second)',
  );
});
