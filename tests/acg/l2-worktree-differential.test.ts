import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type TracedRun,
  classifyWorktreeDifferential,
  defaultRunTraced,
  isEffectBearing,
  runL2WorktreeDifferential,
} from '~/acg/tidy/l2-worktree-differential';

// wi_260615t8o ac-2/ac-3 (ADR-0018 + dialectic-10 OBJ-B/D5) — the STANDING-code L2
// provider. It runs the unit's characterization tests in OLD (HEAD worktree) and NEW
// (working tree) under effect interception, then compares (a) the test-outcome and
// (b) the observable effect trace. Behavior preservation = both agree. The empty-trace
// case on an EFFECT-BEARING unit is "un-observed", NOT "unrefuted" (D5).

describe('isEffectBearing — does the unit route effects through a patchable channel', () => {
  test('true when source uses Bun.spawn', () => {
    expect(isEffectBearing(["const r = Bun.spawnSync(['git','status']);"])).toBe(true);
  });
  test('true when source uses node:child_process', () => {
    expect(isEffectBearing(["import { execFileSync } from 'node:child_process';"])).toBe(true);
  });
  test('false for a pure unit (no whitelisted effect channel)', () => {
    expect(isEffectBearing(['export const add = (a:number,b:number) => a+b;'])).toBe(false);
  });
});

describe('classifyWorktreeDifferential — outcome + trace differential (D5)', () => {
  const run = (testsOk: boolean, trace: TracedRun['trace']): TracedRun => ({ testsOk, trace });
  const call = (channel: string, ...args: unknown[]) => ({ channel, args });

  test('OLD baseline tests red → unverified (characterization invalid), diff-only', () => {
    const v = classifyWorktreeDifferential(run(false, []), run(true, []), true);
    expect(v.status).toBe('unverified');
    expect(v.autoCommit).toBe('diff-only');
  });

  test('OLD green but NEW tests red → refuted (behavior changed), no auto-commit', () => {
    const v = classifyWorktreeDifferential(run(true, []), run(false, []), false);
    expect(v.status).toBe('refuted');
    expect(v.autoCommit).toBe('none');
  });

  test('effect-bearing unit but OLD trace empty → D5 un-observed → unverified/diff-only', () => {
    // interception did not reach this unit's effects (e.g. node:fs named import).
    const v = classifyWorktreeDifferential(run(true, []), run(true, []), true);
    expect(v.status).toBe('unverified');
    expect(v.autoCommit).toBe('diff-only');
    expect(v.reviewHighRisk).toBe(true);
  });

  test('effect-bearing, traces present and identical → unrefuted → full', () => {
    const t = [call('Bun.spawnSync', ['git', 'add'])];
    const v = classifyWorktreeDifferential(run(true, t), run(true, t), true);
    expect(v.status).toBe('unrefuted');
    expect(v.autoCommit).toBe('full');
  });

  test('effect traces diverge → refuted, no auto-commit', () => {
    const v = classifyWorktreeDifferential(
      run(true, [call('Bun.spawnSync', ['git', 'add', 'a'])]),
      run(true, [call('Bun.spawnSync', ['git', 'add', 'b'])]),
      true,
    );
    expect(v.status).toBe('refuted');
    expect(v.autoCommit).toBe('none');
  });

  test('non-effect-bearing pure unit, both green, empty traces → unrefuted/full', () => {
    const v = classifyWorktreeDifferential(run(true, []), run(true, []), false);
    expect(v.status).toBe('unrefuted');
    expect(v.autoCommit).toBe('full');
  });
});

describe('runL2WorktreeDifferential — orchestrate OLD(HEAD-worktree)↔NEW(worktree)', () => {
  const baseDeps = {
    createWorktree: () => ({
      absolutePath: '/tmp/wt-OLD',
      relativePath: '.ditto/local/worktrees/x',
    }),
    removeWorktree: () => {},
    readUnitSources: () => ["Bun.spawnSync(['git','status'])"],
  };

  test('runs traced in OLD(worktree cwd) and NEW(repoRoot), removes worktree after', async () => {
    const cwds: string[] = [];
    let removed = false;
    const v = await runL2WorktreeDifferential(
      { repoRoot: '/repo', unitFiles: ['src/x.ts'], testPaths: ['tests/x.test.ts'] },
      {
        ...baseDeps,
        removeWorktree: () => {
          removed = true;
        },
        runTraced: (cwd) => {
          cwds.push(cwd);
          return {
            testsOk: true,
            trace: [{ channel: 'Bun.spawnSync', args: [['git', 'status']] }],
          };
        },
      },
    );
    expect(cwds).toEqual(['/tmp/wt-OLD', '/repo']); // OLD first (worktree), then NEW (repoRoot)
    expect(removed).toBe(true);
    expect(v.status).toBe('unrefuted');
    expect(v.autoCommit).toBe('full');
  });

  test('fail-open: worktree creation throws → unverified/diff-only, never throws', async () => {
    const v = await runL2WorktreeDifferential(
      { repoRoot: '/repo', unitFiles: ['src/x.ts'], testPaths: ['tests/x.test.ts'] },
      {
        ...baseDeps,
        createWorktree: () => {
          throw new Error('git worktree add failed');
        },
        runTraced: () => ({ testsOk: true, trace: [] }),
      },
    );
    expect(v.status).toBe('unverified');
    expect(v.autoCommit).toBe('diff-only');
  });

  test('defaultRunTraced really intercepts a Bun.spawnSync via the preload (seam works)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ditto-l2-it-'));
    try {
      const testFile = join(dir, 'effecty.test.ts');
      writeFileSync(
        testFile,
        [
          "import { test, expect } from 'bun:test';",
          "test('drives a whitelisted effect', () => {",
          "  const r = Bun.spawnSync(['true']);",
          '  expect(r.exitCode).toBe(0);',
          '});',
          '',
        ].join('\n'),
      );
      // repoRoot = the project root (so the preload resolves); cwd = the temp dir.
      const run = defaultRunTraced(process.cwd(), dir, [testFile], dir);
      expect(run.testsOk).toBe(true);
      // the preload recorded the Bun.spawnSync the test drove.
      expect(run.trace.some((c) => c.channel === 'Bun.spawnSync')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fail-open: a traced run throws → unverified/diff-only, worktree still removed', async () => {
    let removed = false;
    const v = await runL2WorktreeDifferential(
      { repoRoot: '/repo', unitFiles: ['src/x.ts'], testPaths: ['tests/x.test.ts'] },
      {
        ...baseDeps,
        removeWorktree: () => {
          removed = true;
        },
        runTraced: () => {
          throw new Error('bun test spawn failed');
        },
      },
    );
    expect(v.status).toBe('unverified');
    expect(v.autoCommit).toBe('diff-only');
    expect(removed).toBe(true);
  });
});
