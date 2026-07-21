import { describe, expect, test } from 'bun:test';

import type { Legibility } from './legibility';
import { runEfficacy } from './net-efficacy';

// ac-7 / guardrail ⑤ — net-efficacy proves a run made NET improvement, not
// just process-cleanliness. netProgress = (openAfter < openBefore) AND
// testGreenAfter, where `open` = readLegibility().howFar.open (items with
// exit===null). These tests pin the four decisive cases so a resolve-1-relock-1
// churn round (open unchanged) is observably distinct from a net-improving run.

const leg = (open: number): Legibility => ({
  howFar: { resolved: 0, deferred: 0, escaped: 0, open, total: open },
  settled: open === 0,
  forgotten: [],
  summary: '',
});

test('net-improving run: open strictly decreased AND tests green → netProgress true', () => {
  const result = runEfficacy(leg(3), leg(1), true);
  expect(result.openBefore).toBe(3);
  expect(result.openAfter).toBe(1);
  expect(result.testGreenAfter).toBe(true);
  expect(result.netProgress).toBe(true);
});

test('churn: resolve-1-relock-1 nets openAfter==openBefore → netProgress false (even with green tests)', () => {
  const result = runEfficacy(leg(2), leg(2), true);
  expect(result.openBefore).toBe(2);
  expect(result.openAfter).toBe(2);
  expect(result.testGreenAfter).toBe(true);
  expect(result.netProgress).toBe(false);
});

test('red run: open decreased but tests red → netProgress false', () => {
  const result = runEfficacy(leg(3), leg(1), false);
  expect(result.testGreenAfter).toBe(false);
  expect(result.netProgress).toBe(false);
});

test('regression: open increased → netProgress false', () => {
  const result = runEfficacy(leg(1), leg(3), true);
  expect(result.openBefore).toBe(1);
  expect(result.openAfter).toBe(3);
  expect(result.netProgress).toBe(false);
});
