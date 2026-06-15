import { describe, expect, test } from 'bun:test';
import { runL2Differential } from '~/acg/tidy/l2-differential';
import { assessUnitDebt, decideUnitTidy } from '~/acg/tidy/unit-refactor';

// WU-4 ac-9: after a behavior-preserving refactor, the unit's ABSOLUTE fitness
// violation COUNT must DECREASE and behavior-preservation must be green. Per the N8
// finding (no coverage provider wired), full-bar L1 cannot be 'met' on standing code;
// behavior-preservation is therefore shown via the AVAILABLE evidence — the existing
// suite stays green AND the L2 differential is unrefuted (old↔new agree). This test
// pins both halves concretely.

describe('ac-9: absolute debt DECREASES + behavior-preservation green (L2 unrefuted)', () => {
  // A unit that, before tidy, has 3 duplication/complexity violations.
  const beforeViolations = ['dup@unit/a.ts#f', 'dup@unit/a.ts#g', 'complexity@unit/b.ts#h'];
  // After a behavior-preserving dedupe/extract the unit has 1 — debt decreased.
  const afterViolations = ['complexity@unit/b.ts#h'];

  test('absolute unit debt decreased: 3 → 1, removed = 2', () => {
    const debt = assessUnitDebt(beforeViolations, afterViolations);
    expect(debt.before).toBe(3);
    expect(debt.after).toBe(1);
    expect(debt.removed).toBe(2);
    expect(debt.decreased).toBe(true);
  });

  test('behavior preserved: L2 differential unrefuted (old↔new agree on every input)', () => {
    // The refactored unit function: old computes a value one way, new a tidier way;
    // they must agree (behavior-preserving). L2 unrefuted = available behavior evidence.
    const oldFn = (n: number) => n * 2 + n * 2;
    const newFn = (n: number) => 4 * n; // dedupe of `n*2 + n*2`
    const verdict = runL2Differential<number>({
      kind: 'pure',
      old: oldFn,
      new: newFn,
      seeds: [0, 1, 2, 7, -3],
      generate: (s) => [s + 1, s * 10],
    });
    expect(verdict.status).toBe('unrefuted');
  });

  test('the unit decision records debtDecreased + behaviorGreen (ac-9 evidence)', () => {
    const debt = assessUnitDebt(beforeViolations, afterViolations);
    const l2 = runL2Differential<number>({
      kind: 'pure',
      old: (n) => n * 2 + n * 2,
      new: (n) => 4 * n,
      seeds: [0, 1, 2, 7, -3],
    });
    const behaviorGreen = l2.status === 'unrefuted';
    const decision = decideUnitTidy({
      unit: 'component:unit',
      files: ['unit/a.ts', 'unit/b.ts'],
      baselineGreen: true, // existing suite green
      debt: { before: debt.before, after: debt.after },
      behaviorGreen,
      // N8: no provider wired → diff-only, but the ac-9 evidence is still recorded.
    });
    expect(decision.debtDecreased).toBe(true);
    expect(decision.behaviorGreen).toBe(true);
    expect(decision.autoCommit).toBe('diff-only'); // N8 default
  });

  test('an L2-REFUTED refactor (behavior changed) is NOT behavior-green → no full bar', () => {
    const l2 = runL2Differential<number>({
      kind: 'pure',
      old: (n) => n * 2 + n * 2,
      new: (n) => 5 * n, // wrong dedupe — behavior changed
      seeds: [1, 2, 7],
    });
    expect(l2.status).toBe('refuted');
    const decision = decideUnitTidy({
      unit: 'component:unit',
      files: ['unit/a.ts'],
      baselineGreen: true,
      debt: { before: 3, after: 1 },
      behaviorGreen: l2.status === 'unrefuted',
      coverageProviderPresent: true,
      unitCovered: true,
    });
    expect(decision.barMet).toBe(false); // behavior not green → not auto-tidy-eligible
  });
});
