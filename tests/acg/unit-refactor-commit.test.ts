import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitTidyStructural } from '~/acg/tidy/tidy-commit';
import { decideUnitTidy } from '~/acg/tidy/unit-refactor';

// WU-4 ac-10 (commit half): when a unit reaches the §4.4 full bar, the structural tidy
// is committed to an ISOLATED branch with NO push. This is the controlled bar-met case
// (the CLI default degrades to diff-only because no coverage provider is wired, N8). We
// drive a full-bar decision, route bar-met files through commitTidyStructural, and
// assert the commit landed on an isolated branch, main is untouched, and push count = 0.

const git = (cwd: string, args: string[]) =>
  Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ditto-unitcommit-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@t.t']);
  git(dir, ['config', 'user.name', 't']);
  await writeFile(join(dir, 'a.ts'), 'export const a = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

describe('unit refactor bar-met → isolated-branch commit, no push (ac-10)', () => {
  test('full-bar decision commits to an isolated branch; main untouched; 0 push', async () => {
    const resolvedFiles = ['a.ts'];
    const decision = decideUnitTidy({
      unit: 'component:core',
      files: resolvedFiles,
      baselineGreen: true,
      debt: { before: 3, after: 1 }, // absolute debt decreased
      behaviorGreen: true,
      coverageProviderPresent: true, // controlled: a provider IS wired in this case
      unitCovered: true,
    });
    expect(decision.barMet).toBe(true);
    expect(decision.autoCommit).toBe('full');

    const dir = await repo();
    try {
      // The bar-met tidy edits the resolved file set.
      await writeFile(join(dir, 'a.ts'), 'export const a = 1; // tidied\n');
      const r = commitTidyStructural({
        repoRoot: dir,
        branch: 'ditto/refactor/component-core',
        files: resolvedFiles,
        message: 'refactor(component:core): unit-scoped tidy (structural)',
      });
      expect(r.committed).toBe(true);
      expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
      // commit is on the isolated branch
      const show = git(dir, ['show', '--stat', '--oneline', r.branch]).stdout.toString();
      expect(show).toContain('a.ts');
      // main is untouched (auto-commit did not land on main)
      const mainLog = git(dir, ['log', '--oneline', 'main']).stdout.toString();
      expect(mainLog).not.toContain('unit-scoped tidy');
      // NO push: no remote was configured and commitTidyStructural never pushes (D8)
      expect(git(dir, ['remote']).stdout.toString().trim()).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
