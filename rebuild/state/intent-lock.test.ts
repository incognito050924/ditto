import { describe, expect, test } from 'bun:test';

import {
  captureIntentLock,
  checkIntentLock,
  parseIntentLock,
} from './intent-lock';

// AC clause (guardrail ①, ac-2): the AC set is frozen at a capture-window and no
// in-run move may reduce/change/exempt a frozen AC. Additions (found scope) are
// allowed; removals are rejected fail-closed. Edge cases pinned: dedup/sort/trim
// at capture, expansion allowed, reduction/change/exemption blocked, the lock is
// immutable (check never mutates it, capture never aliases its input), and the
// persisted lock parses fail-closed.

describe('captureIntentLock', () => {
  test('freezes the AC set — deduped, trimmed, sorted', () => {
    const lock = captureIntentLock(['ac-2', 'ac-1', ' ac-2 ', 'ac-1', '  ']);
    expect(lock.criteria).toEqual(['ac-1', 'ac-2']);
  });

  test('does not alias its input array (frozen after capture)', () => {
    const input = ['ac-1', 'ac-2'];
    const lock = captureIntentLock(input);
    input.push('ac-3');
    expect(lock.criteria).toEqual(['ac-1', 'ac-2']);
  });
});

describe('checkIntentLock', () => {
  test('a proposal preserving every frozen AC is admissible', () => {
    const lock = captureIntentLock(['ac-1', 'ac-2']);
    const check = checkIntentLock(lock, ['ac-1', 'ac-2']);
    expect(check.admissible).toBe(true);
    expect(check.removed).toEqual([]);
    expect(check.added).toEqual([]);
  });

  test('adding a new AC (expansion) is allowed', () => {
    const lock = captureIntentLock(['ac-1', 'ac-2']);
    const check = checkIntentLock(lock, ['ac-1', 'ac-2', 'ac-3']);
    expect(check.admissible).toBe(true);
    expect(check.removed).toEqual([]);
    expect(check.added).toEqual(['ac-3']);
  });

  // NEGATIVE PATH — the guardrail. Dropping a frozen AC is a reduction.
  test('reducing the frozen set is rejected fail-closed', () => {
    const lock = captureIntentLock(['ac-1', 'ac-2']);
    const check = checkIntentLock(lock, ['ac-1']);
    expect(check.admissible).toBe(false);
    expect(check.removed).toEqual(['ac-2']);
    expect(check.reason).toBeDefined();
  });

  // Change = swap a frozen AC for a different one: the dropped one is a removal.
  test('changing (swapping) a frozen AC is rejected', () => {
    const lock = captureIntentLock(['ac-1', 'ac-2']);
    const check = checkIntentLock(lock, ['ac-1', 'ac-9']);
    expect(check.admissible).toBe(false);
    expect(check.removed).toEqual(['ac-2']);
    expect(check.added).toEqual(['ac-9']);
  });

  // Exempt = drop a specific frozen AC from scope: same fail-closed refusal.
  test('exempting a frozen AC is rejected (frozen set immutable)', () => {
    const lock = captureIntentLock(['ac-1', 'ac-2', 'ac-3']);
    const exempted = lock.criteria.filter((id) => id !== 'ac-2');
    const check = checkIntentLock(lock, exempted);
    expect(check.admissible).toBe(false);
    expect(check.removed).toEqual(['ac-2']);
  });

  test('dropping the entire frozen set lists every removal', () => {
    const lock = captureIntentLock(['ac-1', 'ac-2']);
    const check = checkIntentLock(lock, []);
    expect(check.admissible).toBe(false);
    expect(check.removed).toEqual(['ac-1', 'ac-2']);
  });

  test('checking never mutates the lock', () => {
    const lock = captureIntentLock(['ac-1', 'ac-2']);
    checkIntentLock(lock, ['ac-1']);
    checkIntentLock(lock, ['ac-1', 'ac-2', 'ac-3']);
    expect(lock.criteria).toEqual(['ac-1', 'ac-2']);
  });
});

describe('parseIntentLock', () => {
  test('round-trips a valid persisted lock', () => {
    const lock = captureIntentLock(['ac-1', 'ac-2']);
    expect(parseIntentLock(JSON.stringify(lock))).toEqual(lock);
  });

  test('rejects an unknown field fail-closed (strict)', () => {
    expect(() =>
      parseIntentLock(JSON.stringify({ criteria: ['ac-1'], extra: true })),
    ).toThrow();
  });
});
