import { describe, expect, test } from 'bun:test';
import { assertFrozenTestsIntact } from '~/core/gates';

/**
 * WHY THIS FILE EXISTS (wi_2607105qy N2 ac-3 Part B — frozen-test integrity):
 *
 * After approval the authored red tests are FROZEN: the implement node may only turn them
 * green, never weaken or delete them. This closes the vacuous-green hole where a
 * `dynamic_test` AC closed on ANY evidence even if the test that was supposed to prove it
 * was gutted. The binding reuses the assertOracleFrozen shape (diff = reject): a frozen
 * test whose current content hash is MISSING (deleted) or DIFFERENT (weakened) is rejected.
 *
 * PURE: the check takes the frozen manifest + a `currentHash` lookup, so it is unit-tested
 * without a filesystem.
 */

const entry = (criterion_id: string, test_path: string, frozen_hash?: string) => ({
  criterion_id,
  test_path,
  ...(frozen_hash ? { frozen_hash } : {}),
});

describe('assertFrozenTestsIntact (pure; diff/missing = reject)', () => {
  test('an unchanged frozen test (current hash == frozen hash) ⇒ ok', () => {
    const res = assertFrozenTestsIntact(
      [entry('ac-1', 'tests/a.test.ts', 'HASH_A')],
      () => 'HASH_A',
    );
    expect(res.pass).toBe(true);
    expect(res.reasons).toEqual([]);
  });

  test('a DELETED frozen test (current hash undefined) ⇒ reject', () => {
    const res = assertFrozenTestsIntact(
      [entry('ac-1', 'tests/a.test.ts', 'HASH_A')],
      () => undefined,
    );
    expect(res.pass).toBe(false);
    expect(res.reasons.join(' ')).toContain('tests/a.test.ts');
    expect(res.reasons.join(' ').toLowerCase()).toContain('delet');
  });

  test('a WEAKENED frozen test (current hash differs) ⇒ reject', () => {
    const res = assertFrozenTestsIntact(
      [entry('ac-1', 'tests/a.test.ts', 'HASH_A')],
      () => 'HASH_DIFFERENT',
    );
    expect(res.pass).toBe(false);
    expect(res.reasons.join(' ')).toContain('tests/a.test.ts');
  });

  test('an UNBOUND entry (no frozen_hash — degraded freeze) is skipped, never a false reject', () => {
    // A test whose hash could not be captured at freeze contributes no binding (ADR-0018:
    // degrade, never hard-fail on absence). It must not reject completion.
    const res = assertFrozenTestsIntact([entry('ac-1', 'tests/a.test.ts')], () => undefined);
    expect(res.pass).toBe(true);
  });

  test('a mixed manifest rejects only the broken bound entries', () => {
    const res = assertFrozenTestsIntact(
      [
        entry('ac-1', 'tests/a.test.ts', 'HASH_A'), // intact
        entry('ac-2', 'tests/b.test.ts', 'HASH_B'), // deleted
        entry('ac-3', 'tests/c.test.ts'), // unbound → skipped
      ],
      (p) => (p === 'tests/a.test.ts' ? 'HASH_A' : undefined),
    );
    expect(res.pass).toBe(false);
    expect(res.reasons.join(' ')).toContain('tests/b.test.ts');
    expect(res.reasons.join(' ')).not.toContain('tests/a.test.ts');
    expect(res.reasons.join(' ')).not.toContain('tests/c.test.ts');
  });

  test('an empty manifest ⇒ ok (nothing frozen to protect)', () => {
    expect(assertFrozenTestsIntact([], () => undefined).pass).toBe(true);
  });
});
