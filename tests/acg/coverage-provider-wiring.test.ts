import { describe, expect, test } from 'bun:test';
import { assessBehaviorLock } from '~/acg/tidy/behavior-lock';
import { buildCoverageProvider } from '~/acg/tidy/coverage-provider';
import { decideUnitTidy } from '~/acg/tidy/unit-refactor';

// wi_260615889 ac-b / ac-d: the REAL coverage provider (built from a real lcov text)
// drives the L1 consumers — assessBehaviorLock (change-scoped) and decideUnitTidy
// (unit-scoped). ac-b: a covered region reaches met/full, an uncovered one unmet.
// ac-d: when coverage cannot be collected the provider is absent → fail-open to
// degraded/diff-only, never a hard block.

const lcov = (...recs: Array<[string, number, number]>) =>
  recs.map(([f, lf, lh]) => `SF:${f}\nLF:${lf}\nLH:${lh}\nend_of_record`).join('\n');

describe('ac-b: real provider → assessBehaviorLock met/full for covered, unmet for uncovered', () => {
  const provider = buildCoverageProvider('/repo', {
    collect: () => ({ ok: true, lcov: lcov(['src/covered.ts', 10, 10], ['src/cold.ts', 8, 0]) }),
  });

  test('the provider is present (not degraded by absence)', () => {
    expect(provider).toBeDefined();
  });

  test('covered region → met + autoCommit full (no longer unconditionally degraded)', async () => {
    const v = await assessBehaviorLock({
      baselineGreen: true,
      changedRegion: { files: ['src/covered.ts'] },
      coverageProvider: provider,
    });
    expect(v.status).toBe('met');
    expect(v.autoCommit).toBe('full');
  });

  test('uncovered region (executed 0 lines) → unmet + no auto-commit', async () => {
    const v = await assessBehaviorLock({
      baselineGreen: true,
      changedRegion: { files: ['src/cold.ts'] },
      coverageProvider: provider,
    });
    expect(v.status).toBe('unmet');
    expect(v.autoCommit).toBe('none');
  });
});

describe('ac-d: coverage uncollectable → fail-open (degraded/diff-only, not hard-block)', () => {
  const absent = buildCoverageProvider('/repo', {
    collect: () => ({ ok: false, reason: 'no tests / bun missing' }),
  });

  test('buildCoverageProvider returns undefined on collection failure', () => {
    expect(absent).toBeUndefined();
  });

  test('assessBehaviorLock with no provider → degraded + diff-only, NOT blocked', async () => {
    const v = await assessBehaviorLock({
      baselineGreen: true,
      changedRegion: { files: ['src/covered.ts'] },
      coverageProvider: absent, // undefined
    });
    expect(v.status).toBe('degraded');
    expect(v.autoCommit).toBe('diff-only');
    expect(v.status).not.toBe('blocked-baseline-red');
    expect(v.autoCommit).not.toBe('none');
  });

  test('decideUnitTidy with provider absent → diff-only (degrade-all), not a hard block', () => {
    const d = decideUnitTidy({
      unit: 'component:core',
      files: ['src/covered.ts'],
      baselineGreen: true,
      debt: { before: 3, after: 1 },
      behaviorGreen: true,
      coverageProviderPresent: absent !== undefined,
    });
    expect(d.autoCommit).toBe('diff-only');
    expect(d.barMet).toBe(false);
    expect(d.residualQuestions[0]).toContain('no coverage provider');
  });
});
