import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
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
 * Rewrite OS path separators to forward slashes so a repo-relative path can be
 * matched against the forward-slash `RUN_WORKTREE_PREFIX`. On Windows `relative()`
 * yields backslashes, so without this the prefix test never matches and cleanup is
 * silently disabled (wi_260625x74 n4 f2). `fromSep` is injectable for per-platform
 * testing; it defaults to the running platform's separator.
 */
export function toPosixSeparators(p: string, fromSep: string = sep): string {
  return p.split(fromSep).join('/');
}

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
    const rel = toPosixSeparators(relative(root, abs));
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
 * A holder writes its pid microseconds after `mkdir`, so a lock dir that is still
 * empty (no pid file) AFTER this grace is a dead-window orphan, not a peer
 * mid-acquisition. Kept far below the 30s live-holder deadline (wi_260625x74 ac-3).
 */
const PID_WRITE_GRACE_MS = 2_000;

type LockHolderState =
  | 'alive' // do NOT reclaim — a live holder or an indistinguishable peer
  | 'dead-pid' // a pid file naming a provably-dead process → reclaim (unlink+rmdir)
  | 'empty-stale'; // empty dir older than the grace (mkdir→pid window death) → reclaim (rmdir only)

/**
 * Classify the lock holder by its pid file and the lock dir's age.
 *  - pid file present + process probes alive (signalable) or EPERM → 'alive'.
 *  - pid file present + ESRCH ("no such process") → 'dead-pid'.
 *  - pid file present but unparseable → 'alive' (conservative).
 *  - no pid file + dir younger than the grace → 'alive' (peer mid-acquisition).
 *  - no pid file + dir older than the grace → 'empty-stale' (holder died in the
 *    mkdir→pid micro-window, leaving an empty dir; ac-3).
 * Only states other than 'alive' are reclaimable.
 */
async function classifyLockHolder(lockPath: string): Promise<LockHolderState> {
  let raw: string;
  try {
    raw = await readFile(join(lockPath, 'pid'), 'utf8');
  } catch {
    // No pid file: distinguish a peer mid-acquisition (young dir) from a holder
    // that died after mkdir before writing its pid (old dir).
    try {
      const age = Date.now() - (await stat(lockPath)).mtimeMs;
      return age < PID_WRITE_GRACE_MS ? 'alive' : 'empty-stale';
    } catch {
      return 'alive'; // cannot stat (raced with a reclaim) — conservative
    }
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return 'alive'; // unparseable — conservative
  try {
    process.kill(pid, 0);
    return 'alive'; // signalable → alive
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? 'alive' : 'dead-pid'; // EPERM=alive
  }
}

/**
 * ac-4: serialize the irreversible git-worktree + meta-write critical section with
 * a repo-level mutex (atomic `mkdir` of a lock dir). `git worktree add/remove`
 * mutates the shared `.git/worktrees` registry and the work-item.json read-modify-
 * write would otherwise lost-update under concurrency, so both run under one lock.
 *
 * ac-3 (PID-liveness reclaim): the holder writes its `process.pid` into the lock dir
 * immediately after acquiring it. A waiter that hits EEXIST classifies that lock; a
 * dead holder (SIGKILL before cleanup left the `.lock` dir orphaned) is reclaimed at
 * once instead of failing closed after the deadline. The deadline still bounds the
 * wait for a *live* holder. Two reclaim shapes:
 *  - 'dead-pid' (pid file names a dead process): unlink(pid)+rmdir.
 *  - 'empty-stale' (mkdir→pid micro-window death left an EMPTY dir older than the
 *    grace): rmdir ONLY — no unlink. rmdir is non-recursive, so if a peer has since
 *    re-acquired and written its pid the dir is non-empty and rmdir fails, leaving the
 *    live lock intact. Skipping the unlink is what makes this safe: we never delete a
 *    pid we did not first observe absent. mkdir atomicity then admits one winner.
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
      const state = await classifyLockHolder(lockPath);
      if (state === 'dead-pid') {
        // Holder is provably dead → drop its pid then the dir, and retry at once.
        await unlink(pidPath).catch(() => {});
        await rmdir(lockPath).catch(() => {});
        continue;
      }
      if (state === 'empty-stale') {
        // mkdir→pid micro-window orphan: empty dir, no pid to unlink. rmdir-only is
        // self-guarding against a peer that re-acquired (non-empty dir → rmdir fails).
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
