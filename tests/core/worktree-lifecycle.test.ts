import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, rmdir, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkItemStore } from '~/core/work-item-store';
import {
  createWorktreeForWorkItem,
  landWorktreesForWorkItem,
  listRunWorktrees,
  parseWorktreePath,
  removeWorktreesForWorkItem,
  toPosixSeparators,
} from '~/core/worktree';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKTREE_MODULE = join(PROJECT_ROOT, 'src', 'core', 'worktree.ts');
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let repo: string;
let wis: WorkItemStore;
let WI: string;
let origins: string[];
const NOW = new Date('2026-06-25T00:00:00.000Z');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(dir: string): void {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'ditto@example.test']);
  git(dir, ['config', 'user.name', 'DITTO Test']);
}

/**
 * Give `repo` a LOCAL bare `origin` whose default branch is `defaultBranch`, then push
 * `defaultBranch` so `refs/remotes/origin/<defaultBranch>` is set locally. No network —
 * a file-path bare repo is real git. The land + teardown gates (landed-to-origin) need
 * a real origin to resolve the remote default and confirm a branch has landed.
 */
async function attachOrigin(defaultBranch = 'main'): Promise<string> {
  const originDir = await mkdtemp(join(tmpdir(), 'ditto-wt-origin-'));
  execFileSync('git', ['init', '--bare', '-b', defaultBranch, originDir], { encoding: 'utf8' });
  git(repo, ['branch', '-M', defaultBranch]); // name the current branch as the default
  git(repo, ['remote', 'add', 'origin', originDir]);
  git(repo, ['push', '-q', 'origin', defaultBranch]);
  origins.push(originDir);
  return originDir;
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
  origins = [];
  initRepo(repo);
  await writeFile(join(repo, 'README.md'), 'hello\n', 'utf8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'initial']);
  wis = new WorkItemStore(repo);
  WI = await makeWorkItem();
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  for (const o of origins) await rm(o, { recursive: true, force: true });
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

describe('removeWorktreesForWorkItem (ac-2 safety, C4 landed-to-origin gate)', () => {
  test('blocks an uncommitted-change worktree and never deletes it without --force', async () => {
    await attachOrigin(); // branch is landed (== origin/main); only dirtiness should block
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

  test('blocks an UNLANDED-commits worktree without --force (never force-deletes it)', async () => {
    await attachOrigin();
    await createWorktreeForWorkItem(repo, WI);
    const wtAbs = join(repo, '.ditto', 'local', 'worktrees', WI);
    // A commit that was NOT pushed to origin → the branch tip is not reachable from
    // origin/main → the teardown must refuse (it would otherwise destroy unlanded work).
    git(wtAbs, ['commit', '-q', '--allow-empty', '-m', 'unlanded work']);

    const res = await removeWorktreesForWorkItem(repo, WI, { force: false });
    expect(res.removed).toEqual([]);
    expect(res.blocked[0]?.reason).toContain('unlanded commits');
    expect(listRunWorktrees(repo)).toEqual([`.ditto/local/worktrees/${WI}`]);
    // the branch (with its unlanded commit) survives
    expect(git(repo, ['rev-parse', '--verify', `ditto/${WI}`]).length).toBe(40);
  });

  test('a no-origin worktree cannot be confirmed landed → blocked without --force (fail-safe)', async () => {
    // No origin attached: the land can never be confirmed, so teardown fails safe
    // (preserve) rather than destroy possibly-unlanded work.
    await createWorktreeForWorkItem(repo, WI);
    const res = await removeWorktreesForWorkItem(repo, WI, { force: false });
    expect(res.removed).toEqual([]);
    expect(res.blocked[0]?.reason).toContain('unlanded commits');
    expect(listRunWorktrees(repo)).toEqual([`.ditto/local/worktrees/${WI}`]);
  });

  test('removes a clean, LANDED worktree and drops it from meta', async () => {
    await attachOrigin();
    await createWorktreeForWorkItem(repo, WI); // branch == origin/main → already landed
    const res = await removeWorktreesForWorkItem(repo, WI, { force: false });
    expect(res.blocked).toEqual([]);
    expect(res.removed).toHaveLength(1);
    expect(listRunWorktrees(repo)).toEqual([]);
    expect((await wis.get(WI)).worktrees).toEqual([]);
    // branch deleted too
    expect(() => git(repo, ['rev-parse', '--verify', `ditto/${WI}`])).toThrow();
  });

  test('C4: a branch LANDED to origin (pushed, NOT locally merged) is removable', async () => {
    // The crux of C4: local main HEAD is NEVER moved by a land (no local merge), so the
    // OLD local-HEAD ancestry gate would read this pushed branch as "unmerged" and BLOCK
    // teardown (orphan on every success). The gate must instead confirm landed-to-origin.
    await attachOrigin();
    await createWorktreeForWorkItem(repo, WI);
    const wtAbs = join(repo, '.ditto', 'local', 'worktrees', WI);
    await writeFile(join(wtAbs, 'feature.txt'), 'work\n', 'utf8');
    git(wtAbs, ['add', '.']);
    git(wtAbs, ['commit', '-q', '-m', 'feature work']);
    // Land it to origin (push branch:main) — local main is left untouched.
    const land = await landWorktreesForWorkItem(repo, WI);
    expect(land.allLanded).toBe(true);
    // repo's LOCAL main is NOT updated by the land (proves teardown can't be keyed on it).
    expect(git(repo, ['rev-parse', 'main'])).not.toBe(git(repo, ['rev-parse', `ditto/${WI}`]));

    const res = await removeWorktreesForWorkItem(repo, WI, { force: false });
    expect(res.blocked).toEqual([]);
    expect(res.removed).toHaveLength(1);
    expect(listRunWorktrees(repo)).toEqual([]);
  });

  test('--force removes a dirty/unlanded worktree (explicit approval)', async () => {
    await createWorktreeForWorkItem(repo, WI);
    const wtAbs = join(repo, '.ditto', 'local', 'worktrees', WI);
    git(wtAbs, ['commit', '-q', '--allow-empty', '-m', 'unlanded work']);
    await writeFile(join(wtAbs, 'dirty.txt'), 'uncommitted\n', 'utf8');

    const res = await removeWorktreesForWorkItem(repo, WI, { force: true });
    expect(res.removed).toHaveLength(1);
    expect(res.blocked).toEqual([]);
    expect(listRunWorktrees(repo)).toEqual([]);
    expect((await wis.get(WI)).worktrees).toEqual([]);
  });
});

describe('landWorktreesForWorkItem — direct-to-origin land', () => {
  test('pushes the branch commits straight to origin/<default> and does NOT touch local main', async () => {
    await attachOrigin();
    const localMainBefore = git(repo, ['rev-parse', 'main']);
    await createWorktreeForWorkItem(repo, WI);
    const wtAbs = join(repo, '.ditto', 'local', 'worktrees', WI);
    await writeFile(join(wtAbs, 'feature.txt'), 'work\n', 'utf8');
    git(wtAbs, ['add', '.']);
    git(wtAbs, ['commit', '-q', '-m', 'feature work']);
    const branchTip = git(wtAbs, ['rev-parse', 'HEAD']);

    const res = await landWorktreesForWorkItem(repo, WI);
    expect(res.allLanded).toBe(true);
    expect(res.anyLanded).toBe(true);
    expect(res.outcomes.map((o) => o.status)).toEqual(['landed']);
    // origin/main now holds the branch tip (the push landed it).
    expect(git(repo, ['rev-parse', 'refs/remotes/origin/main'])).toBe(branchTip);
    // …but LOCAL main is untouched — landing never merges into the shared checkout.
    expect(git(repo, ['rev-parse', 'main'])).toBe(localMainBefore);
  });

  test('no origin → a distinct benign skip (never a wrong-branch push)', async () => {
    await createWorktreeForWorkItem(repo, WI); // no origin attached
    const res = await landWorktreesForWorkItem(repo, WI);
    expect(res.allLanded).toBe(false);
    expect(res.anyLanded).toBe(false);
    expect(res.outcomes[0]?.status).toBe('skipped-no-origin');
    expect(res.outcomes[0]?.reason).toContain('no origin');
  });

  test('degenerate origin default == work-item branch → skip, never push branch:branch', async () => {
    // A misconfigured origin whose default branch IS the work-item branch would make
    // `push ditto/<wi>:ditto/<wi>` — a self-push. It must be refused as a skip.
    await createWorktreeForWorkItem(repo, WI);
    const originDir = await mkdtemp(join(tmpdir(), 'ditto-wt-origin-deg-'));
    execFileSync('git', ['init', '--bare', '-b', `ditto/${WI}`, originDir], { encoding: 'utf8' });
    git(repo, ['remote', 'add', 'origin', originDir]);
    git(repo, ['push', '-q', 'origin', `HEAD:refs/heads/ditto/${WI}`]);
    origins.push(originDir);

    const res = await landWorktreesForWorkItem(repo, WI);
    expect(res.outcomes[0]?.status).toBe('skipped-no-origin');
    expect(res.outcomes[0]?.reason).toContain('degenerate');
  });
});

describe('worktree op serialization (ac-4)', () => {
  test('concurrent create + remove do not corrupt the work-item meta', async () => {
    // Two work items so each create targets a distinct branch; run create and a
    // remove of the first concurrently. Under the lock the meta writes serialize,
    // so the surviving work item ends with exactly its own worktree.
    await createWorktreeForWorkItem(repo, WI);
    const WI2 = await makeWorkItem();

    // force the remove (this test is about lock serialization / meta integrity, not the
    // land gate — a clean no-origin worktree would otherwise fail-safe block).
    const [, removal] = await Promise.all([
      createWorktreeForWorkItem(repo, WI2),
      removeWorktreesForWorkItem(repo, WI, { force: true }),
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

  // wi_260625x74 ac-3: the mkdir→pid micro-window. A holder that died AFTER mkdir
  // but BEFORE writing its pid leaves an EMPTY lock dir. Once that dir is older than
  // the pid-write grace it is provably a dead-window orphan and must be reclaimed
  // (not waited out to the 30s deadline). rmdir is non-recursive, so a peer that
  // re-acquired and wrote a pid makes the dir non-empty and survives.
  test('reclaims a stale EMPTY lock left by the mkdir→pid micro-window', async () => {
    const lockPath = lockDir(repo);
    await mkdir(lockPath, { recursive: true }); // empty: holder died before pid write
    const old = new Date(Date.now() - 60_000); // backdate beyond the pid-write grace
    await utimes(lockPath, old, old);
    expect(existsSync(join(lockPath, 'pid'))).toBe(false);

    const t0 = Date.now();
    const meta = await createWorktreeForWorkItem(repo, WI);
    expect(Date.now() - t0).toBeLessThan(5000); // reclaimed, not deadline-waited
    expect(meta).toHaveLength(1);
    expect(existsSync(lockPath)).toBe(false); // lock released after the op
  });

  test('does NOT immediately reclaim a YOUNG empty lock (mid-acquisition window)', async () => {
    const lockPath = lockDir(repo);
    await mkdir(lockPath, { recursive: true }); // empty + fresh: a peer just did mkdir
    let settled = false;
    const op = createWorktreeForWorkItem(repo, WI).then((r) => {
      settled = true;
      return r;
    });
    await delay(200); // well under the pid-write grace
    expect(settled).toBe(false); // treated as mid-acquisition, not reclaimed
    expect(existsSync(lockPath)).toBe(true);

    // release the empty lock → the waiting op acquires and completes
    await rmdir(lockPath).catch(() => {});
    const meta = await op;
    expect(settled).toBe(true);
    expect(meta).toHaveLength(1);
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
        // force the remove (registry-integrity test, not the land gate — a clean
        // no-origin worktree would otherwise fail-safe block).
        runWorker(scriptPath, 'remove', WI, 'force'),
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

// wi_260625x74 n4 (f2): on Windows `relative()` yields backslash separators, so a raw
// `rel.startsWith('.ditto/local/worktrees/')` (forward-slash prefix) never matches and
// listRunWorktrees returns [], silently disabling cleanup. The rel is normalized to
// posix separators before the prefix test. path.win32 lets us assert this on any OS.
describe('toPosixSeparators (listRunWorktrees Windows separator)', () => {
  const PREFIX = '.ditto/local/worktrees/';

  test('Windows backslash rel normalizes and matches the forward-slash prefix', () => {
    const rel = win32.relative('D:\\repo', 'D:\\repo\\.ditto\\local\\worktrees\\run_x');
    expect(rel).toBe('.ditto\\local\\worktrees\\run_x'); // backslash on Windows
    const norm = toPosixSeparators(rel, win32.sep);
    expect(norm).toBe('.ditto/local/worktrees/run_x');
    expect(norm.startsWith(PREFIX)).toBe(true);
  });

  test('POSIX rel is unchanged (no regression)', () => {
    expect(toPosixSeparators('.ditto/local/worktrees/run_x', '/')).toBe(
      '.ditto/local/worktrees/run_x',
    );
  });
});

// wi_260626zzx ac-1/ac-2: parseWorktreePath maps a path inside a per-work-item
// worktree (`<ws>/.ditto/local/worktrees/<wi>[/...]`) to its owning workspace `<ws>`
// and the work item id `<wi>`. Pure/deterministic (no fs), so it runs on any path
// shape and platform. Non-worktree paths return null so rooting stays unchanged.
describe('parseWorktreePath (worktree session rooting)', () => {
  const wtPrefix = '.ditto/local/worktrees';

  test('worktree root → owning workspace + work item id', () => {
    expect(parseWorktreePath(`/Users/x/dev/proj/${wtPrefix}/wi_abc`, posix.sep)).toEqual({
      workspace: '/Users/x/dev/proj',
      workItemId: 'wi_abc',
    });
  });

  test('nested path inside the worktree → same workspace + wi (first segment only)', () => {
    expect(parseWorktreePath(`/Users/x/dev/proj/${wtPrefix}/wi_abc/src/core`, posix.sep)).toEqual({
      workspace: '/Users/x/dev/proj',
      workItemId: 'wi_abc',
    });
  });

  test('nested sub-repo worktree cwd → still the owning workspace (not the sub-repo)', () => {
    expect(
      parseWorktreePath(`/Users/x/dev/proj/${wtPrefix}/wi_abc/subrepo/lib`, posix.sep),
    ).toEqual({ workspace: '/Users/x/dev/proj', workItemId: 'wi_abc' });
  });

  test('plain repo cwd → null (no worktree segment, rooting unchanged)', () => {
    expect(parseWorktreePath('/Users/x/dev/proj/src/core', posix.sep)).toBeNull();
  });

  test('a path with .ditto/local but not the worktrees prefix → null', () => {
    expect(
      parseWorktreePath('/Users/x/dev/proj/.ditto/local/work-items/wi_abc', posix.sep),
    ).toBeNull();
  });

  test('worktrees prefix with no <wi> segment → null', () => {
    expect(parseWorktreePath(`/Users/x/dev/proj/${wtPrefix}/`, posix.sep)).toBeNull();
  });

  test('Windows backslash worktree path → owning workspace with native separators', () => {
    expect(
      parseWorktreePath('D:\\dev\\proj\\.ditto\\local\\worktrees\\wi_abc\\src', win32.sep),
    ).toEqual({ workspace: 'D:\\dev\\proj', workItemId: 'wi_abc' });
  });
});
