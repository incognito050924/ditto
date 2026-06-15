import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitTidyStructural } from '~/acg/tidy/tidy-commit';

const git = (cwd: string, args: string[]) =>
  Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ditto-tidycommit-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@t.t']);
  git(dir, ['config', 'user.name', 't']);
  await writeFile(join(dir, 'a.ts'), 'export const a = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

describe('commitTidyStructural — ⑧ tidy commit (WU-3, D8): isolated branch, no push', () => {
  test('commits the staged files on an isolated branch and returns a sha', async () => {
    const dir = await repo();
    try {
      await writeFile(join(dir, 'b.ts'), 'export const b = 2;\n');
      const r = commitTidyStructural({
        repoRoot: dir,
        branch: 'ditto/tidy',
        files: ['b.ts'],
        message: 'tidy: structural cleanup (structural)',
      });
      expect(r.committed).toBe(true);
      expect(r.branch).toBe('ditto/tidy');
      expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
      // the commit is on the isolated branch and includes b.ts
      const show = git(dir, ['show', '--stat', '--oneline', 'ditto/tidy']).stdout.toString();
      expect(show).toContain('b.ts');
      // main is untouched (the tidy commit did not land on main)
      const mainLog = git(dir, ['log', '--oneline', 'main']).stdout.toString();
      expect(mainLog).not.toContain('structural cleanup');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('returns committed=false when nothing is staged (no empty commit)', async () => {
    const dir = await repo();
    try {
      const r = commitTidyStructural({
        repoRoot: dir,
        branch: 'ditto/tidy',
        files: [],
        message: 'tidy: nothing',
      });
      expect(r.committed).toBe(false);
      expect(r.sha).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('reuses an existing isolated branch (accumulates tidy commits)', async () => {
    const dir = await repo();
    try {
      await writeFile(join(dir, 'b.ts'), 'export const b = 2;\n');
      commitTidyStructural({
        repoRoot: dir,
        branch: 'ditto/tidy',
        files: ['b.ts'],
        message: 'tidy 1',
      });
      await writeFile(join(dir, 'c.ts'), 'export const c = 3;\n');
      const r2 = commitTidyStructural({
        repoRoot: dir,
        branch: 'ditto/tidy',
        files: ['c.ts'],
        message: 'tidy 2',
      });
      expect(r2.committed).toBe(true);
      const count = git(dir, ['rev-list', '--count', 'ditto/tidy']).stdout.toString().trim();
      expect(count).toBe('3'); // init + tidy 1 + tidy 2
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
