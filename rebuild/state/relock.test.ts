import { describe, expect, test } from 'bun:test';

import type { QueueState, QueueStateItem } from './queue-state';
import { relockRoute } from './relock';

const baseState = (items: QueueStateItem[]): QueueState => ({
  round: 1,
  items,
  acceptance_criteria: [],
  last_stop_hook: null,
  backstop: { turns: 0, no_progress_rounds: 0, queue_size_trend: [] },
  blocker: null,
});

test('brand-new candidate id is appended as a pending item', () => {
  const state = baseState([]);
  const result = relockRoute(state, [{ id: 'x', kind: 'found-defect' }]);

  expect(result.added).toEqual(['x']);
  expect(result.relocked).toEqual([]);
  expect(result.skipped).toEqual([]);

  const added = result.state.items.find((i) => i.id === 'x');
  expect(added).toEqual({
    id: 'x',
    kind: 'found-defect',
    exit: null,
    evidence_ref: null,
    disposition_note: null,
  });

  // input state untouched (no mutation)
  expect(state.items.length).toBe(0);
});

test('candidate matching a CLOSED item re-locks it (exit/evidence cleared)', () => {
  const closed: QueueStateItem = {
    id: 'd1',
    kind: 'found-defect',
    exit: 'resolved',
    evidence_ref: 'x',
    disposition_note: 'was fixed',
  };
  const state = baseState([closed]);
  const result = relockRoute(state, [{ id: 'd1', kind: 'found-defect' }]);

  expect(result.relocked).toEqual(['d1']);
  expect(result.added).toEqual([]);
  expect(result.skipped).toEqual([]);

  const now = result.state.items.find((i) => i.id === 'd1');
  expect(now?.exit).toBeNull();
  expect(now?.evidence_ref).toBeNull();
  expect(now?.disposition_note).toBe('re-locked');
  expect(now?.kind).toBe('found-defect');

  // original input item unchanged (no mutation)
  expect(closed.exit).toBe('resolved');
  expect(closed.evidence_ref).toBe('x');
  expect(result.state.items.length).toBe(1);
});

test('candidate matching an OPEN item is skipped and left as-is', () => {
  const open: QueueStateItem = {
    id: 'o1',
    kind: 'in-scope-residual',
    exit: null,
    evidence_ref: null,
    disposition_note: 'tracking',
  };
  const state = baseState([open]);
  const result = relockRoute(state, [{ id: 'o1', kind: 'found-defect', note: 'ignored' }]);

  expect(result.skipped).toEqual(['o1']);
  expect(result.added).toEqual([]);
  expect(result.relocked).toEqual([]);

  const now = result.state.items.find((i) => i.id === 'o1');
  expect(now).toEqual(open);
  expect(result.state.items.length).toBe(1);
});

test('mixed batch routes each id to the correct bucket', () => {
  const closed: QueueStateItem = {
    id: 'c',
    kind: 'found-defect',
    exit: 'resolved',
    evidence_ref: 'ev',
    disposition_note: null,
  };
  const open: QueueStateItem = {
    id: 'o',
    kind: 'unverified-ac',
    exit: null,
    evidence_ref: null,
    disposition_note: null,
  };
  const state = baseState([closed, open]);
  const result = relockRoute(state, [
    { id: 'n', kind: 'found-defect' },
    { id: 'c', kind: 'found-defect' },
    { id: 'o', kind: 'unverified-ac' },
  ]);

  expect(result.added).toEqual(['n']);
  expect(result.relocked).toEqual(['c']);
  expect(result.skipped).toEqual(['o']);
});

test('input state and its item objects are never mutated', () => {
  const closed: QueueStateItem = {
    id: 'c',
    kind: 'found-defect',
    exit: 'resolved',
    evidence_ref: 'ev',
    disposition_note: 'done',
  };
  const inputItems = [closed];
  const state = baseState(inputItems);
  relockRoute(state, [
    { id: 'n', kind: 'found-defect' },
    { id: 'c', kind: 'found-defect' },
  ]);

  // input array identity/length and item object fields unchanged
  expect(state.items).toBe(inputItems);
  expect(state.items.length).toBe(1);
  expect(closed.exit).toBe('resolved');
  expect(closed.evidence_ref).toBe('ev');
  expect(closed.disposition_note).toBe('done');
});

test('duplicate brand-new ids in one call are deduped (first added, rest skipped)', () => {
  const state = baseState([]);
  const result = relockRoute(state, [
    { id: 'dup', kind: 'found-defect' },
    { id: 'dup', kind: 'found-defect' },
  ]);

  expect(result.added).toEqual(['dup']);
  expect(result.skipped).toEqual(['dup']);
  expect(result.relocked).toEqual([]);
  expect(result.state.items.filter((i) => i.id === 'dup').length).toBe(1);
});
