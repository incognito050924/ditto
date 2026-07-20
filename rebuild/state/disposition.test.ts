import { describe, expect, test } from 'bun:test';

import { dispositionCompleteness } from './disposition';
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

test('all items properly dispositioned → complete, no gaps', () => {
  const state = baseState([
    item({ id: 'a', exit: 'resolved', evidence_ref: 'ref: test green' }),
    item({ id: 'b', exit: 'new-scope-deferral', disposition_note: 'backlogged' }),
    item({ id: 'c', exit: 'escape', disposition_note: 'handed off' }),
  ]);
  const result = dispositionCompleteness(state);
  expect(result.complete).toBe(true);
  expect(result.gaps).toEqual([]);
});

test('open item (exit null) → gap "still open", complete false, id matches', () => {
  const state = baseState([item({ id: 'open-1', exit: null })]);
  const result = dispositionCompleteness(state);
  expect(result.complete).toBe(false);
  expect(result.gaps).toEqual([
    { id: 'open-1', reason: 'still open (no disposition)' },
  ]);
});

test('resolved item with evidence_ref null → gap "resolved without evidence"', () => {
  const state = baseState([
    item({ id: 'r-null', exit: 'resolved', evidence_ref: null }),
  ]);
  const result = dispositionCompleteness(state);
  expect(result.complete).toBe(false);
  expect(result.gaps).toEqual([
    { id: 'r-null', reason: 'resolved without evidence' },
  ]);
});

test('resolved item with whitespace evidence_ref → gap (whitespace is not evidence)', () => {
  const state = baseState([
    item({ id: 'r-ws', exit: 'resolved', evidence_ref: '   ' }),
  ]);
  const result = dispositionCompleteness(state);
  expect(result.complete).toBe(false);
  expect(result.gaps).toEqual([
    { id: 'r-ws', reason: 'resolved without evidence' },
  ]);
});

test('deferral/escape with null disposition_note → gap mentions exit and disposition_note', () => {
  const state = baseState([
    item({ id: 'd-1', exit: 'new-scope-deferral', disposition_note: null }),
    item({ id: 'e-1', exit: 'escape', disposition_note: null }),
  ]);
  const result = dispositionCompleteness(state);
  expect(result.complete).toBe(false);
  expect(result.gaps).toEqual([
    { id: 'd-1', reason: 'routed to new-scope-deferral without disposition_note' },
    { id: 'e-1', reason: 'routed to escape without disposition_note' },
  ]);
});

test('mixed: 2 good + 2 bad → exactly 2 gaps with the right ids', () => {
  const state = baseState([
    item({ id: 'good-r', exit: 'resolved', evidence_ref: 'ref: green' }),
    item({ id: 'bad-open', exit: null }),
    item({ id: 'good-d', exit: 'new-scope-deferral', disposition_note: 'later' }),
    item({ id: 'bad-r', exit: 'resolved', evidence_ref: '  ' }),
  ]);
  const result = dispositionCompleteness(state);
  expect(result.complete).toBe(false);
  expect(result.gaps).toEqual([
    { id: 'bad-open', reason: 'still open (no disposition)' },
    { id: 'bad-r', reason: 'resolved without evidence' },
  ]);
});
