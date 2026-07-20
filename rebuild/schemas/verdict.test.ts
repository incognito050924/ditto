import { describe, expect, test } from 'bun:test';

import { verdict } from './verdict';

describe('verdict', () => {
  test('accepts exactly pass/fail/partial/unverified', () => {
    expect(verdict.options).toEqual(['pass', 'fail', 'partial', 'unverified']);
    for (const value of ['pass', 'fail', 'partial', 'unverified'] as const) {
      expect(verdict.parse(value)).toBe(value);
    }
  });

  test('rejects any other value', () => {
    expect(verdict.safeParse('done').success).toBe(false);
    expect(verdict.safeParse('block').success).toBe(false);
    expect(verdict.safeParse('').success).toBe(false);
  });
});
