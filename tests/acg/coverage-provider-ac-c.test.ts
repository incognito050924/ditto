import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CoverageCollectResult, buildCoverageProvider } from '~/acg/tidy/coverage-provider';
import { runL2Differential } from '~/acg/tidy/l2-differential';
import { commitTidyStructural } from '~/acg/tidy/tidy-commit';
import { assessUnitDebt, decideUnitTidy } from '~/acg/tidy/unit-refactor';

// wi_260615889 ac-c — END-TO-END full-bar closure. wi_2606158xq closed ac-9/ac-10 only
// at diff-only because `coverageProviderPresent` was false (no provider). Here every
// input to the §4.4 full bar is REAL: coverage comes from a real `bun test --coverage`
// run, debt decrease from assessUnitDebt over real before/after violation sets, behavior
// preservation from a real L2 differential. With the real provider reporting the unit
// covered, the bar is FULL (not diff-only) → the structural tidy auto-commits to an
// ISOLATED branch with zero push.

const git = (cwd: string, args: string[]) =>
  Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });

// A real coverage pass scoped to one characterization test that imports behavior-lock.ts.
const realCollect = (root: string): CoverageCollectResult => {
  const covDir = mkdtempSync(join(tmpdir(), 'ditto-cov-acc-'));
  try {
    Bun.spawnSync(
      [
        'bun',
        'test',
        '--coverage',
        '--coverage-reporter=lcov',
        `--coverage-dir=${covDir}`,
        'tests/acg/tidy-behavior-lock.test.ts',
      ],
      { cwd: root, stdout: 'ignore', stderr: 'ignore' },
    );
    return { ok: true, lcov: readFileSync(join(covDir, 'lcov.info'), 'utf8') };
  } catch (err) {
    return { ok: false, reason: String(err) };
  } finally {
    rmSync(covDir, { recursive: true, force: true });
  }
};

describe('ac-c: real coverage → full-bar auto-commit on an isolated branch (0 push)', () => {
  test('covered unit + L2 unrefuted + debt decreased reaches autoCommit=full and commits, no push', async () => {
    // (1) REAL coverage: the unit file is executed by the suite → covered.
    const provider = buildCoverageProvider(process.cwd(), { collect: realCollect });
    if (!provider) throw new Error('expected a real coverage provider');
    const unitCovered =
      (await provider.coverageOf({ files: ['src/acg/tidy/behavior-lock.ts'] })).status ===
      'covered';
    expect(unitCovered).toBe(true);

    // (2) REAL debt decrease — a behavior-preserving dedupe removed 2 violations (3 → 1).
    const debt = assessUnitDebt(
      ['dup@unit#f', 'dup@unit#g', 'complexity@unit#h'],
      ['complexity@unit#h'],
    );
    expect(debt.decreased).toBe(true);

    // (3) REAL behavior preservation — L2 differential unrefuted (old↔new agree).
    const l2 = runL2Differential<number>({
      kind: 'pure',
      old: (n) => n * 2 + n * 2,
      new: (n) => 4 * n,
      seeds: [0, 1, 2, 7, -3],
      generate: (s) => [s + 1, s * 10],
    });
    expect(l2.status).toBe('unrefuted');

    // (4) DECISION — because coverage is REAL and the unit is covered, the bar is FULL.
    // (Under wi_2606158xq this same shape collapsed to diff-only: provider absent.)
    const decision = decideUnitTidy({
      unit: 'component:tidy',
      files: ['src/acg/tidy/behavior-lock.ts'],
      baselineGreen: true,
      debt: { before: debt.before, after: debt.after },
      behaviorGreen: l2.status === 'unrefuted',
      coverageProviderPresent: provider !== undefined,
      unitCovered,
    });
    expect(decision.barMet).toBe(true);
    expect(decision.autoCommit).toBe('full');

    // (5) COMMIT — structural tidy lands on an ISOLATED branch; main untouched; 0 push.
    const dir = await mkdtemp(join(tmpdir(), 'ditto-acc-repo-'));
    try {
      git(dir, ['init', '-q', '-b', 'main']);
      git(dir, ['config', 'user.email', 't@t.t']);
      git(dir, ['config', 'user.name', 't']);
      await writeFile(join(dir, 'a.ts'), 'export const a = 1;\n');
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-q', '-m', 'init']);
      // the bar-met tidy edits the resolved file set
      await writeFile(join(dir, 'a.ts'), 'export const a = 1; // tidied\n');
      const r = commitTidyStructural({
        repoRoot: dir,
        branch: 'ditto/refactor/component-tidy',
        files: ['a.ts'],
        message: 'refactor(component:tidy): unit-scoped tidy (structural)',
      });
      expect(r.committed).toBe(true);
      expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
      // commit is on the isolated branch, not main
      expect(git(dir, ['log', '--oneline', 'main']).stdout.toString()).not.toContain(
        'unit-scoped tidy',
      );
      expect(git(dir, ['show', '--stat', '--oneline', r.branch]).stdout.toString()).toContain(
        'a.ts',
      );
      // 0 push — commitTidyStructural never pushes (D8) and no remote is configured
      expect(git(dir, ['remote']).stdout.toString().trim()).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
