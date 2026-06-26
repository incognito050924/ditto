import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
let dir: string;

function ditto(args: string[]): { stdout: string; stderr: string; exitCode: number | null } {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], { cwd: dir, env: { ...process.env } });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-wt-surface-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'ditto@example.test']);
  git(['config', 'user.name', 'DITTO Test']);
  await writeFile(join(dir, 'README.md'), 'hi\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'initial']);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function startItem(): string {
  const r = ditto(['work', 'start', 'observable goal', '--request', 'do it', '--output', 'json']);
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout).work_item_id as string;
}

describe('ditto worktree list (ac-1)', () => {
  test('empty workspace prints a clear no-worktrees notice', () => {
    startItem(); // a work item without a worktree
    const r = ditto(['worktree', 'list']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('No worktrees');
  });

  test('json lists work item id, branch, path and clean git state', () => {
    const wi = startItem();
    expect(ditto(['worktree', 'create', wi]).exitCode).toBe(0);

    const r = ditto(['worktree', 'list', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const rows = JSON.parse(r.stdout).worktrees;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      work_item_id: wi,
      owning_repo: '.',
      branch: `ditto/${wi}`,
      worktree_path: `.ditto/local/worktrees/${wi}`,
      exists: true,
      dirty: false,
      base: 'main',
      ahead: 0,
      behind: 0,
    });
  });

  test('human output reflects a dirty + ahead worktree', async () => {
    const wi = startItem();
    expect(ditto(['worktree', 'create', wi]).exitCode).toBe(0);
    const wtAbs = join(dir, '.ditto', 'local', 'worktrees', wi);
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'ahead'], { cwd: wtAbs });
    await writeFile(join(wtAbs, 'scratch.txt'), 'wip\n', 'utf8');

    const r = ditto(['worktree', 'list']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(wi);
    expect(r.stdout).toContain('dirty');
    expect(r.stdout).toContain('+1/-0');
  });
});

describe('ditto worktree create guidance (ac-2)', () => {
  test('prints a cd binding hint with the worktree path and work item id', () => {
    const wi = startItem();
    const r = ditto(['worktree', 'create', wi]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('cd ');
    expect(r.stdout).toContain(`.ditto/local/worktrees/${wi}`);
    expect(r.stdout).toContain(wi);
  });
});

describe('ditto work start --worktree (ac-3)', () => {
  test('creates the worktree and records meta + prints the binding hint', () => {
    const r = ditto([
      'work',
      'start',
      'observable goal',
      '--request',
      'do it',
      '--worktree',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.worktrees).toHaveLength(1);
    expect(out.worktrees[0].branch).toBe(`ditto/${out.work_item_id}`);
    // worktree is real on disk
    const list = JSON.parse(ditto(['worktree', 'list', '--output', 'json']).stdout).worktrees;
    expect(list.some((w: { work_item_id: string }) => w.work_item_id === out.work_item_id)).toBe(
      true,
    );
  });

  test('without --worktree the work item is created but no worktree (unchanged behavior)', () => {
    const r = ditto(['work', 'start', 'observable goal', '--request', 'do it', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.worktrees).toEqual([]);
    expect(JSON.parse(ditto(['worktree', 'list', '--output', 'json']).stdout).worktrees).toEqual(
      [],
    );
  });
});

describe('ditto work status worktree display (ac-4)', () => {
  test('shows the work item worktree path+branch in human output', () => {
    const wi = startItem();
    expect(ditto(['worktree', 'create', wi]).exitCode).toBe(0);
    const r = ditto(['work', 'status', wi]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('worktrees:');
    expect(r.stdout).toContain(`ditto/${wi}`);
    expect(r.stdout).toContain(`.ditto/local/worktrees/${wi}`);
  });

  test('a work item without a worktree shows no worktrees section', () => {
    const wi = startItem();
    const r = ditto(['work', 'status', wi]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('worktrees:');
  });
});
