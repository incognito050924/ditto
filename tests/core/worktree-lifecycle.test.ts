import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkItemStore } from '~/core/work-item-store';
import {
  createWorktreeForWorkItem,
  listRunWorktrees,
  removeWorktreesForWorkItem,
} from '~/core/worktree';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKTREE_MODULE = join(PROJECT_ROOT, 'src', 'core', 'worktree.ts');
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let repo: string;
let wis: WorkItemStore;
let WI: string;
const NOW = new Date('2026-06-25T00:00:00.000Z');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(dir: string): void {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'ditto@example.test']);
  git(dir, ['config', 'user.name', 'DITTO Test']);
}

async function makeWorkItem(): Promise<string> {
  const wi = await wis.create(
    {
      title: 'worktree lifecycle test',
      source_request: 'test worktree lifecycle',
      goal: 'worktree created and torn down safely',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'worktree exists', verdict: 'unverified', evidence: [] },
      ],
    },
    NOW,
  );
  return wi.id;
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-wt-life-'));
  initRepo(repo);
  await writeFile(join(repo, 'README.md'), 'hello\n', 'utf8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'initial']);
  wis = new WorkItemStore(repo);
  WI = await makeWorkItem();
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('createWorktreeForWorkItem (ac-1)', () => {
  test('creates worktree+branch by naming convention and records meta', async () => {
    const meta = await createWorktreeForWorkItem(repo, WI);
    expect(meta).toEqual([
      { owning_repo: '.', worktree_path: `.ditto/local/worktrees/${WI}`, branch: `ditto/${WI}` },
    ]);
    // worktree actually exists on disk / in git
    expect(listRunWorktrees(repo)).toEqual([`.ditto/local/worktrees/${WI}`]);
    // branch created
    expect(git(repo, ['rev-parse', '--verify', `ditto/${WI}`]).length).toBe(40);
    // meta persisted on the work item
    const item = await wis.get(WI);
    expect(item.worktrees).toEqual(meta);
  });

  test('multi-repo: nests every sub-repo worktree from its own heterogeneous base', async () => {
    // Three nested sub-repos, each on a DIFFERENT base branch (main / assets / trunk),
    // all gitignored by the workspace. detectBaseBranch has no origin here, so each
    // sub forks from its own currently-checked-out branch — proving heterogeneous bases.
    const subs: { name: string; base: string }[] = [
      { name: 'core', base: 'main' },
      { name: 'assets-pkg', base: 'assets' },
      { name: 'tools', base: 'trunk' },
    ];
    for (const { name, base } of subs) {
      const sub = join(repo, name);
      await mkdir(sub);
      initRepo(sub);
      await writeFile(join(sub, 'a.txt'), `${name}\n`, 'utf8');
      git(sub, ['add', '.']);
      git(sub, ['commit', '-q', '-m', 'sub init']);
      git(sub, ['branch', '-m', base]); // each sub on its own base branch
    }
    await writeFile(
      join(repo, '.gitignore'),
      `${subs.map((s) => `${s.name}/`).join('\n')}\n`,
      'utf8',
    );
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'ignore subs']);

    const meta = await createWorktreeForWorkItem(repo, WI);
    expect(meta).toContainEqual({
      owning_repo: '.',
      worktree_path: `.ditto/local/worktrees/${WI}`,
      branch: `ditto/${WI}`,
    });
    for (const { name, base } of subs) {
      // meta recorded for every sub-repo
      expect(meta).toContainEqual({
        owning_repo: name,
        worktree_path: `.ditto/local/worktrees/${WI}/${name}`,
        branch: `ditto/${WI}`,
      });
      // and each sub branch was forked from its own (heterogeneous) base
      const sub = join(repo, name);
      expect(git(sub, ['rev-parse', `ditto/${WI}`])).toBe(git(sub, ['rev-parse', base]));
      // the nested worktree exists on disk
      expect(existsSync(join(repo, '.ditto', 'local', 'worktrees', WI, name, 'a.txt'))).toBe(true);
    }
    // workspace '.' + 3 subs = 4 meta entries, all under the same branch
    expect(meta).toHaveLength(subs.length + 1);
    expect((await wis.get(WI)).worktrees).toEqual(meta);
  });

  test('cov-d-git-validation: rejects an option-injecting work item id', async () => {
    await expect(createWorktreeForWorkItem(repo, '-rf')).rejects.toThrow('option injection');
  });

  test('cov-d-meta-disk-consistency: a duplicate create fails and leaves no phantom meta', async () => {
    await createWorktreeForWorkItem(repo, WI);
    // a second create with the same branch must fail (branch already exists)…
    await expect(createWorktreeForWorkItem(repo, WI)).rejects.toThrow();
    // …and must not have appended a phantom/duplicate worktree to the meta
    const item = await wis.get(WI);
    expect(item.worktrees).toHaveLength(1);
  });
});

describe('removeWorktreesForWorkItem (ac-2 safety)', () => {
  test('blocks an uncommitted-change worktree and never deletes it without --force', async () => {
    await createWorktreeForWorkItem(repo, WI);
    const wtAbs = join(repo, '.ditto', 'local', 'worktrees', WI);
    await writeFile(join(wtAbs, 'dirty.txt'), 'uncommitted\n', 'utf8');

    const res = await removeWorktreesForWorkItem(repo, WI, { force: false });
    expect(res.removed).toEqual([]);
    expect(res.blocked).toHaveLength(1);
    expect(res.blocked[0]?.reason).toContain('uncommitted changes');
    // still on disk
    expect(listRunWorktrees(repo)).toEqual([`.ditto/local/worktrees/${WI}`]);
    // meta unchanged
    expect((await wis.get(WI)).worktrees).toHaveLength(1);
  });

  test('blocks an unmerged-commits worktree without --force', async () => {
    await createWorktreeForWorkItem(repo, WI);
    const wtAbs = join(repo, '.ditto', 'local', 'worktrees', WI);
    git(wtAbs, ['commit', '-q', '--allow-empty', '-m', 'unmerged work']);

    const res = await removeWorktreesForWorkItem(repo, WI, { force: false });
    expect(res.removed).toEqual([]);
    expect(res.blocked[0]?.reason).toContain('unmerged commits');
    expect(listRunWorktrees(repo)).toEqual([`.ditto/local/worktrees/${WI}`]);
  });

  test('removes a clean, merged worktree and drops it from meta', async () => {
    await createWorktreeForWorkItem(repo, WI);
    const res = await removeWorktreesForWorkItem(repo, WI, { force: false });
    expect(res.blocked).toEqual([]);
    expect(res.removed).toHaveLength(1);
    expect(listRunWorktrees(repo)).toEqual([]);
    expect((await wis.get(WI)).worktrees).toEqual([]);
    // branch deleted too
    expect(() => git(repo, ['rev-parse', '--verify', `ditto/${WI}`])).toThrow();
  });

  test('--force removes a dirty/unmerged worktree (explicit approval)', async () => {
    await createWorktreeForWorkItem(repo, WI);
    const wtAbs = join(repo, '.ditto', 'local', 'worktrees', WI);
    git(wtAbs, ['commit', '-q', '--allow-empty', '-m', 'unmerged work']);
    await writeFile(join(wtAbs, 'dirty.txt'), 'uncommitted\n', 'utf8');

    const res = await removeWorktreesForWorkItem(repo, WI, { force: true });
    expect(res.removed).toHaveLength(1);
    expect(res.blocked).toEqual([]);
    expect(listRunWorktrees(repo)).toEqual([]);
    expect((await wis.get(WI)).worktrees).toEqual([]);
  });
});

describe('worktree op serialization (ac-4)', () => {
  test('concurrent create + remove do not corrupt the work-item meta', async () => {
    // Two work items so each create targets a distinct branch; run create and a
    // remove of the first concurrently. Under the lock the meta writes serialize,
    // so the surviving work item ends with exactly its own worktree.
    await createWorktreeForWorkItem(repo, WI);
    const WI2 = await makeWorkItem();

    const [, removal] = await Promise.all([
      createWorktreeForWorkItem(repo, WI2),
      removeWorktreesForWorkItem(repo, WI, { force: false }),
    ]);

    expect(removal.removed).toHaveLength(1);
    // WI fully torn down, WI2 fully present — neither meta clobbered the other
    expect((await wis.get(WI)).worktrees).toEqual([]);
    expect((await wis.get(WI2)).worktrees).toEqual([
      { owning_repo: '.', worktree_path: `.ditto/local/worktrees/${WI2}`, branch: `ditto/${WI2}` },
    ]);
    expect(listRunWorktrees(repo).sort()).toEqual([`.ditto/local/worktrees/${WI2}`]);
  });
});

describe('worktree lock PID-liveness reclaim (ac-3)', () => {
  const lockDir = (r: string) => join(r, '.ditto', 'local', 'worktrees', '.lock');

  test('reclaims a stale lock whose holder process is dead', async () => {
    const lockPath = lockDir(repo);
    await mkdir(lockPath, { recursive: true });
    // A guaranteed-dead pid: spawn a trivial process; spawnSync reaps it, so by the
    // time it returns the pid no longer maps to a live process (process.kill → ESRCH).
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    expect(deadPid).toBeGreaterThan(0);
    await writeFile(join(lockPath, 'pid'), String(deadPid), 'utf8');
    expect(existsSync(lockPath)).toBe(true);

    // The op must reclaim the stale lock and finish well under the 30s live-holder
    // deadline — proving reclaim, not deadline expiry.
    const t0 = Date.now();
    const meta = await createWorktreeForWorkItem(repo, WI);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(meta).toHaveLength(1);
    // lock fully released after the op
    expect(existsSync(lockPath)).toBe(false);
  });

  test('does not reclaim a live holder lock', async () => {
    const lockPath = lockDir(repo);
    await mkdir(lockPath, { recursive: true });
    // The current test process is alive, so this lock must NOT be reclaimed.
    await writeFile(join(lockPath, 'pid'), String(process.pid), 'utf8');

    let settled = false;
    const op = createWorktreeForWorkItem(repo, WI).then((r) => {
      settled = true;
      return r;
    });
    await delay(200);
    // still blocked behind the live lock — never reclaimed
    expect(settled).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(join(lockPath, 'pid'))).toBe(true);

    // release the live lock → the waiting op now acquires and completes
    await unlink(join(lockPath, 'pid'));
    await rmdir(lockPath);
    const meta = await op;
    expect(settled).toBe(true);
    expect(meta).toHaveLength(1);
  });
});

describe('cross-process worktree concurrency (ac-1)', () => {
  // Worker run in a SEPARATE OS process via bun. It imports the real worktree module
  // (WT_MODULE) and performs one op, so the contention is on the on-disk lock across
  // genuine processes — not a single-process Promise.all. cwd=PROJECT_ROOT lets bun
  // resolve the `~/*` tsconfig paths inside the imported module.
  const WORKER_SRC = [
    'const [op, repo, wi, force] = process.argv.slice(2);',
    'const mod = await import(process.env.WT_MODULE);',
    "if (op === 'create') { await mod.createWorktreeForWorkItem(repo, wi); }",
    "else { await mod.removeWorktreesForWorkItem(repo, wi, { force: force === 'force' }); }",
  ].join('\n');

  function runWorker(
    scriptPath: string,
    op: string,
    wi: string,
    force?: 'force',
  ): Promise<{ code: number | null; pid: number | undefined; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [scriptPath, op, repo, wi, force ?? ''], {
        cwd: PROJECT_ROOT,
        env: { ...process.env, WT_MODULE: WORKTREE_MODULE },
      });
      let stderr = '';
      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      const pid = child.pid;
      child.on('close', (code) => resolve({ code, pid, stderr }));
    });
  }

  test('two real processes create+remove concurrently without corrupting the registry/meta', async () => {
    // WI already exists (beforeEach) — pre-create its worktree so a concurrent remove
    // has something to tear down. Then two more work items for the concurrent creates.
    await createWorktreeForWorkItem(repo, WI);
    const WI1 = await makeWorkItem();
    const WI2 = await makeWorkItem();

    const scriptDir = await mkdtemp(join(tmpdir(), 'ditto-wt-worker-'));
    const scriptPath = join(scriptDir, 'worker.mjs');
    await writeFile(scriptPath, WORKER_SRC, 'utf8');

    try {
      const results = await Promise.all([
        runWorker(scriptPath, 'create', WI1),
        runWorker(scriptPath, 'create', WI2),
        runWorker(scriptPath, 'remove', WI), // clean → removable without force
      ]);

      // every worker was a distinct real OS process, separate from this test process
      const pids = results.map((r) => r.pid);
      for (const p of pids) {
        expect(p).toBeGreaterThan(0);
        expect(p).not.toBe(process.pid);
      }
      expect(new Set(pids).size).toBe(3);
      // all succeeded
      for (const r of results) {
        expect(r.stderr).toBe('');
        expect(r.code).toBe(0);
      }

      // git's shared registry is intact and lists exactly the two surviving worktrees
      expect(listRunWorktrees(repo).sort()).toEqual(
        [`.ditto/local/worktrees/${WI1}`, `.ditto/local/worktrees/${WI2}`].sort(),
      );
      // `.git/worktrees` registry parses cleanly and matches
      const registered = git(repo, ['worktree', 'list', '--porcelain'])
        .split('\n')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => l.slice('worktree '.length));
      expect(registered.some((p) => p.endsWith(`worktrees/${WI1}`))).toBe(true);
      expect(registered.some((p) => p.endsWith(`worktrees/${WI2}`))).toBe(true);
      expect(registered.some((p) => p.endsWith(`worktrees/${WI}`))).toBe(false);

      // each work item's meta is correct — no lost-update clobber between processes
      expect((await wis.get(WI)).worktrees).toEqual([]);
      expect((await wis.get(WI1)).worktrees).toEqual([
        {
          owning_repo: '.',
          worktree_path: `.ditto/local/worktrees/${WI1}`,
          branch: `ditto/${WI1}`,
        },
      ]);
      expect((await wis.get(WI2)).worktrees).toEqual([
        {
          owning_repo: '.',
          worktree_path: `.ditto/local/worktrees/${WI2}`,
          branch: `ditto/${WI2}`,
        },
      ]);
    } finally {
      await rm(scriptDir, { recursive: true, force: true });
    }
  }, 30_000);
});
