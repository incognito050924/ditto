import { describe, expect, test } from 'bun:test';

import { queueExit, queueItem, queueItemKind } from './queue-item';

describe('queueItem', () => {
  test('kind is exactly found-defect/in-scope-residual/unverified-ac', () => {
    expect(queueItemKind.options).toEqual([
      'found-defect',
      'in-scope-residual',
      'unverified-ac',
    ]);
  });

  test('exit is exactly resolved/new-scope-deferral/escape', () => {
    expect(queueExit.options).toEqual([
      'resolved',
      'new-scope-deferral',
      'escape',
    ]);
  });

  test('an item without exit is open', () => {
    const parsed = queueItem.parse({ id: 'q-1', kind: 'found-defect' });
    expect(parsed.exit).toBeUndefined();
  });

  test('accepts each of the three exit doors', () => {
    for (const exit of ['resolved', 'new-scope-deferral', 'escape'] as const) {
      const parsed = queueItem.parse({
        id: 'q-1',
        kind: 'unverified-ac',
        exit,
      });
      expect(parsed.exit).toBe(exit);
    }
  });

  test('rejects any other exit value', () => {
    expect(
      queueItem.safeParse({ id: 'q-1', kind: 'found-defect', exit: 'done' })
        .success,
    ).toBe(false);
  });

  test('rejects unknown keys', () => {
    expect(
      queueItem.safeParse({ id: 'q-1', kind: 'found-defect', note: 'x' })
        .success,
    ).toBe(false);
  });

  test('requires a non-empty id', () => {
    expect(
      queueItem.safeParse({ id: '', kind: 'found-defect' }).success,
    ).toBe(false);
  });
});
