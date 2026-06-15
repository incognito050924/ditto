import { describe, expect, test } from 'bun:test';
import { type UnitTidyInput, assessUnitDebt, decideUnitTidy } from '~/acg/tidy/unit-refactor';

// WU-4 ac-9 / ac-10. Unit-scoped refactor of STANDING code (baseline = HEAD):
//  - ac-9: ABSOLUTE fitness debt (the unit's own violation COUNT before/after) must
//          DECREASE, and behavior-preservation (L1 + medium+ L2) must be green.
//  - ac-10: provider-presence-FIRST gating (N8 finding) — no coverage provider wired
//           ⇒ degrade-all ⇒ diff-only default + bar-miss items become NARROW residual
//           questions (never a bulk diff). Bar-MET items commit to an isolated branch.

describe('assessUnitDebt — absolute unit debt before/after (ac-9)', () => {
  test('decreased: before > after → decreased=true, removed count is concrete', () => {
    const r = assessUnitDebt(['dup@a#f', 'dup@a#g', 'complexity@b#h'], ['dup@a#g']);
    expect(r.before).toBe(3);
    expect(r.after).toBe(1);
    expect(r.removed).toBe(2);
    expect(r.decreased).toBe(true);
  });

  test('not decreased: after >= before → decreased=false (no gaming credit)', () => {
    const r = assessUnitDebt(['dup@a#f'], ['dup@a#f', 'complexity@b#h']);
    expect(r.decreased).toBe(false);
    expect(r.removed).toBe(0);
  });
});

describe('decideUnitTidy — provider-presence-first gating (ac-10, N8)', () => {
  const base: UnitTidyInput = {
    unit: 'component:acg',
    files: ['src/acg/x.ts', 'src/acg/y.ts'],
    baselineGreen: true,
    debt: { before: 3, after: 1 },
    behaviorGreen: true,
    // coverageProviderPresent omitted → absent
  };

  test('no provider → degrade-all: autoCommit diff-only, no bar-met commit, residual question', () => {
    const d = decideUnitTidy(base);
    expect(d.autoCommit).toBe('diff-only');
    expect(d.barMet).toBe(false);
    // bar-miss surfaces as a NARROW residual question, never a bulk diff
    expect(d.residualQuestions.length).toBeGreaterThanOrEqual(1);
    expect(d.residualQuestions[0]).toContain('no coverage provider');
    // ac-9 evidence still computed: debt decreased + behavior green
    expect(d.debtDecreased).toBe(true);
    expect(d.behaviorGreen).toBe(true);
  });

  test('baseline red → blocked (tidy cannot start), no commit', () => {
    const d = decideUnitTidy({ ...base, baselineGreen: false });
    expect(d.autoCommit).toBe('none');
    expect(d.barMet).toBe(false);
    expect(d.residualQuestions.some((q) => q.includes('baseline'))).toBe(true);
  });

  test('provider present + covered + behavior green + debt decreased → full bar, bar-met commit', () => {
    const d = decideUnitTidy({
      ...base,
      coverageProviderPresent: true,
      unitCovered: true,
    });
    expect(d.autoCommit).toBe('full');
    expect(d.barMet).toBe(true);
    expect(d.residualQuestions).toEqual([]);
  });

  test('provider present but unit uncovered → unmet: not bar-met, narrow residual question (not bulk diff)', () => {
    const d = decideUnitTidy({
      ...base,
      coverageProviderPresent: true,
      unitCovered: false,
    });
    expect(d.barMet).toBe(false);
    expect(d.autoCommit).not.toBe('full');
    expect(d.residualQuestions.length).toBeGreaterThanOrEqual(1);
  });

  test('provider present + covered but behavior NOT green → not bar-met (preservation gate)', () => {
    const d = decideUnitTidy({
      ...base,
      coverageProviderPresent: true,
      unitCovered: true,
      behaviorGreen: false,
    });
    expect(d.barMet).toBe(false);
    expect(d.autoCommit).not.toBe('full');
  });
});
