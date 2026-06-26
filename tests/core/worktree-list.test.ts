import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aheadBehind } from '~/core/git';
import { WorkItemStore } from '~/core/work-item-store';
import {
  createWorktreeForWorkItem,
  listWorktreesForWorkspace,
  worktreeBindingHint,
} from '~/core/worktree';

let repo: string;
let wis: WorkItemStore;
const NOW = new Date('2026-06-26T00:00:00.000Z');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'ditto@example.test']);
  git(dir, ['config', 'user.name', 'DITTO Test']);
}

async function makeWorkItem(): Promise<string> {
  const wi = await wis.create(
    {
      title: 'worktree list test',
      source_request: 'test worktree list',
      goal: 'worktree surface lists state',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'worktree exists', verdict: 'unverified', evidence: [] },
      ],
    },
    NOW,
  );
  return wi.id;
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-wt-list-'));
  initRepo(repo);
  await writeFile(join(repo, 'README.md'), 'hello\n', 'utf8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'initial']);
  wis = new WorkItemStore(repo);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('listWorktreesForWorkspace (ac-1)', () => {
  test('empty when no work item has a worktree', async () => {
    await makeWorkItem();
    expect(await listWorktreesForWorkspace(repo)).toEqual([]);
  });

  test('lists a clean worktree with work item id, branch, path, base, zero ahead/behind', async () => {
    const wi = await makeWorkItem();
    await createWorktreeForWorkItem(repo, wi);

    const list = await listWorktreesForWorkspace(repo);
    expect(list).toHaveLength(1);
    const row = list[0];
    expect(row?.work_item_id).toBe(wi);
    expect(row?.owning_repo).toBe('.');
    expect(row?.branch).toBe(`ditto/${wi}`);
    expect(row?.worktree_path).toBe(`.ditto/local/worktrees/${wi}`);
    expect(row?.exists).toBe(true);
    expect(row?.dirty).toBe(false);
    expect(row?.base).toBe('main');
    expect(row?.ahead).toBe(0);
    expect(row?.behind).toBe(0);
  });

  test('reflects a dirty worktree and ahead commits vs base', async () => {
    const wi = await makeWorkItem();
    await createWorktreeForWorkItem(repo, wi);
    const wtAbs = join(repo, '.ditto', 'local', 'worktrees', wi);
    // one commit ahead of base (main)
    git(wtAbs, ['commit', '-q', '--allow-empty', '-m', 'ahead work']);
    // and an uncommitted change → dirty
    await writeFile(join(wtAbs, 'scratch.txt'), 'wip\n', 'utf8');

    const list = await listWorktreesForWorkspace(repo);
    expect(list).toHaveLength(1);
    expect(list[0]?.dirty).toBe(true);
    expect(list[0]?.ahead).toBe(1);
    expect(list[0]?.behind).toBe(0);
  });
});

describe('aheadBehind (git helper)', () => {
  test('counts commits ahead of and behind a base ref', async () => {
    const wi = await makeWorkItem();
    await createWorktreeForWorkItem(repo, wi);
    const wtAbs = join(repo, '.ditto', 'local', 'worktrees', wi);
    git(wtAbs, ['commit', '-q', '--allow-empty', '-m', 'a1']);
    git(wtAbs, ['commit', '-q', '--allow-empty', '-m', 'a2']);
    // advance base (main) by one commit so the worktree is also 1 behind
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'base moved']);

    expect(aheadBehind(wtAbs, 'main')).toEqual({ ahead: 2, behind: 1 });
  });

  test('returns zeros on an unresolvable base ref', () => {
    expect(aheadBehind(repo, 'no-such-ref')).toEqual({ ahead: 0, behind: 0 });
  });
});

describe('worktreeBindingHint (ac-2)', () => {
  test('points at the workspace worktree absolute path and the work item id', () => {
    const hint = worktreeBindingHint(
      '/ws',
      [{ owning_repo: '.', worktree_path: '.ditto/local/worktrees/wi_x', branch: 'ditto/wi_x' }],
      'wi_x',
    );
    expect(hint).toContain('/ws/.ditto/local/worktrees/wi_x');
    expect(hint).toContain('wi_x');
  });

  test('null when there are no worktrees', () => {
    expect(worktreeBindingHint('/ws', [], 'wi_x')).toBeNull();
  });
});
