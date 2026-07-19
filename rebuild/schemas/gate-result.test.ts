import { describe, expect, test } from 'bun:test';

import { decideGate, gateResult } from './gate-result';

describe('decideGate (fail-closed)', () => {
  test('undefined outcome => block', () => {
    expect(decideGate({}).decision).toBe('block');
  });

  test('outcome fail => block', () => {
    expect(decideGate({ outcome: 'fail', grounds: 'because' }).decision).toBe(
      'block',
    );
  });

  test('outcome pass but no grounds => block', () => {
    expect(decideGate({ outcome: 'pass' }).decision).toBe('block');
  });

  test('outcome pass with blank grounds => block', () => {
    expect(decideGate({ outcome: 'pass', grounds: '   ' }).decision).toBe(
      'block',
    );
  });

  test('outcome pass with real grounds => pass', () => {
    const result = decideGate({ outcome: 'pass', grounds: 'all tests green' });
    expect(result.decision).toBe('pass');
    expect(result.grounds).toBe('all tests green');
  });
});

describe('gateResult', () => {
  test('accepts a valid gate result', () => {
    expect(gateResult.parse({ decision: 'block' }).decision).toBe('block');
  });

  test('rejects unknown keys', () => {
    const result = gateResult.safeParse({ decision: 'pass', extra: 1 });
    expect(result.success).toBe(false);
  });

  test('rejects an invalid decision value', () => {
    expect(gateResult.safeParse({ decision: 'allow' }).success).toBe(false);
  });
});
