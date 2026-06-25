import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { WorkItemWorktree } from '~/schemas/work-item';
import { localDir } from './ditto-paths';
import { ensureDir } from './fs';
import { isWorkingTreeClean } from './git';
import { fileExists } from './hosts/shared';
import { WorkItemStore } from './work-item-store';

export interface WorktreeHandle {
  absolutePath: string;
  relativePath: string;
}

export async function createWorktreeForRun(
  repoRoot: string,
  runId: string,
): Promise<WorktreeHandle> {
  const relativePath = `${RUN_WORKTREE_PREFIX}${runId}`;
  const absolutePath = localDir(repoRoot, 'worktrees', runId);
  await ensureDir(localDir(repoRoot, 'worktrees'));
  execFileSync('git', ['worktree', 'add', '--detach', absolutePath, 'HEAD'], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return { absolutePath, relativePath };
}

const RUN_WORKTREE_PREFIX = '.ditto/local/worktrees/';

/**
 * Repo-relative paths of the per-run worktrees DITTO created (`.ditto/local/worktrees/*`),
 * parsed from `git worktree list --porcelain`. Read-only and deterministic — the
 * cleanup planner uses it to know what teardown work exists. Other worktrees
 * (the main one, anything outside `.ditto/local/worktrees/`) are never listed.
 */
export function listRunWorktrees(repoRoot: string): string[] {
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // `git worktree list` reports realpaths; repoRoot may be a symlinked path
  // (e.g. macOS /var → /private/var), so resolve it too before computing the
  // relative path — otherwise the prefix match silently finds nothing.
  const root = realpathSync(repoRoot);
  const paths: string[] = [];
  for (const line of out.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const abs = line.slice('worktree '.length).trim();
    const rel = relative(root, abs);
    if (rel.startsWith(RUN_WORKTREE_PREFIX)) paths.push(rel);
  }
  return paths;
}

/**
 * Tear down one run worktree (`git worktree remove`). NOT forced: git refuses to
 * remove a worktree with uncommitted changes, so unmerged work is never silently
 * destroyed — the caller surfaces the refusal as a skipped item. Throws on git
 * failure (including the dirty-worktree refusal) so the caller can classify it.
 */
export function removeRunWorktree(repoRoot: string, relativePath: string): void {
  execFileSync('git', ['worktree', 'remove', relativePath], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

// ── Per-work-item worktree lifecycle (wi_260625k0w: ac-1 / ac-2 / ac-4) ──────

/** Branch name DITTO checks out for a work item's worktree(s). */
const WORK_ITEM_BRANCH_PREFIX = 'ditto/';

/**
 * cov-d-git-validation: branch names and sub-repo names flow into git argv.
 * execFileSync passes an array (no shell), so there is no shell injection — but a
 * `-`-prefixed token would still be parsed as a git OPTION (option injection). We
 * reject it; constructed paths also use `--` to end option parsing at the call site.
 */
function assertSafeArg(value: string, label: string): void {
  if (value.startsWith('-')) {
    throw new Error(`${label} must not start with '-' (git option injection): ${value}`);
  }
}

/**
 * Base ref a new work-item branch forks from: the remote default branch when an
 * `origin` exists (so multi-repo sub-repos each fork from their own main/master/…),
 * else the currently checked-out branch. Per-repo, so heterogeneous bases work.
 */
function detectBaseBranch(cwd: string): string {
  try {
    const ref = execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (ref.length > 0) return ref;
  } catch {
    // no origin / no default ref — fall back to the current branch
  }
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

/**
 * Direct child directories of `repoRoot` that are themselves git repos (have a
 * `.git` entry). Hidden dirs (`.git`, `.ditto`, …) are skipped, so the workspace
 * repo's own metadata is never mistaken for a sub-repo. Sorted for determinism.
 */
async function detectSubRepos(repoRoot: string): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(repoRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const subs: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    if (await fileExists(join(repoRoot, e.name, '.git'))) subs.push(e.name);
  }
  return subs.sort();
}

/**
 * Is the recorded lock holder still a live process? Reads the holder PID written
 * inside the lock dir and probes it with signal 0. Returns true (conservative —
 * do NOT reclaim) when the holder cannot be proven dead: no pid file yet (a peer is
 * mid-acquisition between mkdir and the pid write), an unparseable pid, or EPERM
 * (the process exists but is owned by another user). Only an explicit ESRCH ("no
 * such process") is treated as dead.
 */
async function isLockHolderAlive(lockPath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(join(lockPath, 'pid'), 'utf8');
  } catch {
    return true; // holder mid-acquisition (pid not written yet) — treat as live
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return true; // unparseable — conservative
  try {
    process.kill(pid, 0);
    return true; // signalable → alive
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // EPERM=alive, ESRCH=dead
  }
}

/**
 * ac-4: serialize the irreversible git-worktree + meta-write critical section with
 * a repo-level mutex (atomic `mkdir` of a lock dir). `git worktree add/remove`
 * mutates the shared `.git/worktrees` registry and the work-item.json read-modify-
 * write would otherwise lost-update under concurrency, so both run under one lock.
 *
 * ac-3 (PID-liveness reclaim): the holder writes its `process.pid` into the lock dir
 * immediately after acquiring it. A waiter that hits EEXIST probes that pid; a dead
 * holder (SIGKILL before cleanup left the `.lock` dir orphaned) is reclaimed at once
 * instead of failing closed after the deadline. The deadline still bounds the wait
 * for a *live* holder. Reclaim is unlink(pid)+rmdir (never recursive): if a live peer
 * has already re-acquired and written its pid, the dir is non-empty so rmdir fails and
 * the live lock is never destroyed; mkdir atomicity then admits exactly one winner.
 */
async function withWorktreeLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const dir = localDir(repoRoot, 'worktrees');
  await ensureDir(dir);
  const lockPath = join(dir, '.lock');
  const pidPath = join(lockPath, 'pid');
  const deadlineMs = 30_000;
  const start = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      // Record holder liveness id right away so a peer can detect a dead holder.
      await writeFile(pidPath, String(process.pid), 'utf8');
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (!(await isLockHolderAlive(lockPath))) {
        // Holder is provably dead → reclaim the stale lock and retry immediately.
        await unlink(pidPath).catch(() => {});
        await rmdir(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() - start > deadlineMs) {
        throw new Error(
          `worktree lock held >${deadlineMs}ms (${lockPath}); another worktree op in flight`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  try {
    return await fn();
  } finally {
    // Drop the pid file before the dir so rmdir sees an empty dir (best effort: a
    // dead-holder reclaim above is the recovery path if this never runs).
    await unlink(pidPath).catch(() => {});
    await rmdir(lockPath).catch(() => {});
  }
}

function addWorktree(cwd: string, branch: string, absPath: string, base: string): void {
  // `-b <branch>` before `--`; `--` ends option parsing so the path/base cannot be
  // read as options (cov-d-git-validation).
  execFileSync('git', ['worktree', 'add', '-b', branch, '--', absPath, base], {
    cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

/**
 * ac-1: create the work item's worktree(s)+branch by naming convention
 * (`.ditto/local/worktrees/<wi>` on branch `ditto/<wi>`) and record the meta on the
 * work item. Single-repo → one entry (`owning_repo='.'`). Multi-repo → one nested
 * sub-repo worktree per detected sub-repo, each forked from its own base branch.
 *
 * cov-d-meta-disk-consistency: atomic-or-nothing. If any sub-repo worktree fails,
 * every worktree+branch created in this call is rolled back (force-removed) and the
 * error is rethrown, so the work-item meta is never left pointing at phantom
 * worktrees. Meta is written only after all worktrees exist, under the same lock.
 */
export async function createWorktreeForWorkItem(
  repoRoot: string,
  workItemId: string,
): Promise<WorkItemWorktree[]> {
  assertSafeArg(workItemId, 'work item id');
  const branch = `${WORK_ITEM_BRANCH_PREFIX}${workItemId}`;
  return withWorktreeLock(repoRoot, async () => {
    const workspaceRel = `${RUN_WORKTREE_PREFIX}${workItemId}`;
    const workspaceAbs = localDir(repoRoot, 'worktrees', workItemId);
    await ensureDir(localDir(repoRoot, 'worktrees'));

    const created: { cwd: string; abs: string; branch: string }[] = [];
    const meta: WorkItemWorktree[] = [];
    try {
      addWorktree(repoRoot, branch, workspaceAbs, detectBaseBranch(repoRoot));
      created.push({ cwd: repoRoot, abs: workspaceAbs, branch });
      meta.push({ owning_repo: '.', worktree_path: workspaceRel, branch });

      for (const sub of await detectSubRepos(repoRoot)) {
        assertSafeArg(sub, 'sub-repo name');
        const subMainCheckout = join(repoRoot, sub);
        const subAbs = join(workspaceAbs, sub);
        addWorktree(subMainCheckout, branch, subAbs, detectBaseBranch(subMainCheckout));
        created.push({ cwd: subMainCheckout, abs: subAbs, branch });
        meta.push({ owning_repo: sub, worktree_path: `${workspaceRel}/${sub}`, branch });
      }
    } catch (err) {
      // Roll back in reverse (nested sub-repo worktrees before the workspace one).
      for (const c of [...created].reverse()) {
        try {
          execFileSync('git', ['worktree', 'remove', '--force', '--', c.abs], {
            cwd: c.cwd,
            stdio: ['ignore', 'ignore', 'ignore'],
          });
        } catch {
          // best effort rollback
        }
        try {
          execFileSync('git', ['branch', '-D', '--', c.branch], {
            cwd: c.cwd,
            stdio: ['ignore', 'ignore', 'ignore'],
          });
        } catch {
          // best effort rollback
        }
      }
      throw err;
    }

    const store = new WorkItemStore(repoRoot);
    await store.update(workItemId, (cur) => ({ ...cur, worktrees: meta }));
    return meta;
  });
}

/** A branch has commits not reachable from the owning repo's HEAD (would be lost). */
function branchHasUnmergedCommits(cwd: string, branch: string): boolean {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    const tip = execFileSync('git', ['rev-parse', branch], { cwd, encoding: 'utf8' }).trim();
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', tip, head], {
        cwd,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return false; // tip reachable from HEAD → fully merged
    } catch {
      return true; // not an ancestor → unmerged commits exist
    }
  } catch {
    return true; // unresolvable branch/HEAD → treat as unmerged (fail safe)
  }
}

export interface WorktreeRemovalResult {
  removed: WorkItemWorktree[];
  /** Worktrees left intact because they were dirty/unmerged and not force-approved. */
  blocked: { worktree: WorkItemWorktree; reason: string }[];
}

/**
 * ac-2: tear down a work item's worktree(s). A worktree with uncommitted/untracked
 * changes OR a branch with unmerged commits is BLOCKED — never deleted without
 * explicit approval (`force`). Clean+merged worktrees are removed (`git worktree
 * remove`, then `git branch -d`). With `force` the removal is unconditional
 * (`-f` / `-D`) — the explicit approval.
 *
 * cov-d-meta-disk-consistency: the work-item meta drops ONLY the worktrees actually
 * removed, so a partial teardown (some blocked) leaves accurate meta. Sub-repo
 * worktrees are torn down before the workspace one (they nest inside it). All under
 * the ac-4 lock.
 */
export async function removeWorktreesForWorkItem(
  repoRoot: string,
  workItemId: string,
  opts: { force?: boolean } = {},
): Promise<WorktreeRemovalResult> {
  assertSafeArg(workItemId, 'work item id');
  const force = opts.force ?? false;
  return withWorktreeLock(repoRoot, async () => {
    const store = new WorkItemStore(repoRoot);
    const item = await store.get(workItemId);
    // Nested sub-repo worktrees first, workspace ('.') last.
    const ordered = [...item.worktrees].sort(
      (a, b) => (a.owning_repo === '.' ? 1 : 0) - (b.owning_repo === '.' ? 1 : 0),
    );
    const removed: WorkItemWorktree[] = [];
    const blocked: { worktree: WorkItemWorktree; reason: string }[] = [];
    for (const wt of ordered) {
      const ownerCwd = wt.owning_repo === '.' ? repoRoot : join(repoRoot, wt.owning_repo);
      const wtAbs = join(repoRoot, wt.worktree_path);
      const dirty = !isWorkingTreeClean(wtAbs);
      const unmerged = branchHasUnmergedCommits(ownerCwd, wt.branch);
      if ((dirty || unmerged) && !force) {
        const why = [dirty ? 'uncommitted changes' : null, unmerged ? 'unmerged commits' : null]
          .filter(Boolean)
          .join(' + ');
        blocked.push({ worktree: wt, reason: `${why}; refusing to delete without --force` });
        continue;
      }
      try {
        const removeArgs = ['worktree', 'remove'];
        if (force) removeArgs.push('--force');
        removeArgs.push('--', wtAbs);
        execFileSync('git', removeArgs, { cwd: ownerCwd, stdio: ['ignore', 'ignore', 'pipe'] });
        execFileSync('git', ['branch', force ? '-D' : '-d', '--', wt.branch], {
          cwd: ownerCwd,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        removed.push(wt);
      } catch (err) {
        blocked.push({
          worktree: wt,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (removed.length > 0) {
      await store.update(workItemId, (cur) => ({
        ...cur,
        worktrees: cur.worktrees.filter(
          (w) => !removed.some((r) => r.worktree_path === w.worktree_path),
        ),
      }));
    }
    return { removed, blocked };
  });
}
