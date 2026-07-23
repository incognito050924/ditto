import { describe, expect, test } from 'bun:test';

import { verdict } from './verdict';

describe('verdict', () => {
  test('accepts exactly pass/fail/unverified (3-value contract)', () => {
    expect(verdict.options).toEqual(['pass', 'fail', 'unverified']);
    for (const value of ['pass', 'fail', 'unverified'] as const) {
      expect(verdict.parse(value)).toBe(value);
    }
  });

  test('rejects any other value, including the retired partial', () => {
    expect(verdict.safeParse('partial').success).toBe(false);
    expect(verdict.safeParse('done').success).toBe(false);
    expect(verdict.safeParse('block').success).toBe(false);
    expect(verdict.safeParse('').success).toBe(false);
  });
});
