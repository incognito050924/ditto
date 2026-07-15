import { execFileSync } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { WorkItemWorktree } from '~/schemas/work-item';
import { scrubCredentials } from './chain-drive';
import { localDir } from './ditto-paths';
import { ensureDir } from './fs';
import { aheadBehind, isWorkingTreeClean, landBranchToOrigin } from './git';
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

export interface WorktreeRooting {
  /** The owning workspace `<ws>` — the repo root a worktree session must root at. */
  workspace: string;
  /** The work item id `<wi>` whose worktree this path lives inside. */
  workItemId: string;
}

/**
 * If `start` is inside a per-work-item worktree DITTO created
 * (`<ws>/.ditto/local/worktrees/<wi>[/...]`), return the owning workspace `<ws>`
 * (the segment before `.ditto/local/worktrees/`) and the work item id `<wi>`.
 * Otherwise null.
 *
 * A worktree checkout carries the tracked `.ditto/` (knowledge) with it, so a naive
 * walk-up stops at the worktree's OWN `.ditto` and roots the session inside the
 * worktree — where the main workspace's gitignored `.ditto/local` (work-items,
 * autopilot, sessions) is not checked out and is therefore invisible. Rooting back at
 * `<ws>` keeps code edits in the worktree but state in the single main source
 * (wi_260626zzx ac-1/ac-2).
 *
 * Path-segment based and deterministic (no fs access), mirroring `listRunWorktrees`'
 * prefix match: `start` is normalised to forward slashes so the `RUN_WORKTREE_PREFIX`
 * (forward-slash) test works on Windows too. `pathSep` is injectable for per-platform
 * testing; it defaults to the running platform's separator.
 */
export function parseWorktreePath(start: string, pathSep: string = sep): WorktreeRooting | null {
  const posixPath = toPosixSeparators(start, pathSep);
  const marker = `/${RUN_WORKTREE_PREFIX}`; // '/.ditto/local/worktrees/'
  const idx = posixPath.indexOf(marker);
  if (idx <= 0) return null; // not inside a run worktree (or no owning workspace before it)
  const workspacePosix = posixPath.slice(0, idx);
  const workItemId = posixPath.slice(idx + marker.length).split('/')[0];
  if (!workItemId) return null; // `<ws>/.ditto/local/worktrees/` with no `<wi>` segment
  return { workspace: workspacePosix.split('/').join(pathSep), workItemId };
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
  let entries: Dirent<string>[];
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

// ── Read-only worktree surface (wi_260626hux: ac-1 list / ac-2 binding hint) ──

/** One worktree's live state for `ditto worktree list`. */
export interface WorktreeStatus {
  work_item_id: string;
  owning_repo: string;
  branch: string;
  /** Worktree checkout path, relative to the workspace repo root. */
  worktree_path: string;
  /** false when the meta points at a directory that is no longer on disk. */
  exists: boolean;
  /**
   * true when the worktree is on disk under `.ditto/local/worktrees/` but recorded
   * in NO work-item meta (porcelain ∖ meta): work item archived/abandoned, meta
   * dropped out-of-band, or an external `git worktree add`. work_item_id/owning_repo
   * are unknown ('') and base/ahead/behind are not computed.
   */
  orphan: boolean;
  dirty: boolean;
  /** Base branch ahead/behind is measured against (per owning repo, same as create-time). */
  base: string;
  ahead: number;
  behind: number;
}

/**
 * ac-1: every per-work-item worktree recorded across the workspace's work items,
 * with its live git state. The work-item meta (`worktrees[]`) is the source of
 * truth for what exists; ahead/behind is measured against each owning repo's base
 * (the same `detectBaseBranch` the worktree was forked from), computed inside the
 * worktree checkout. A meta entry whose dir was removed out-of-band is reported with
 * `exists:false` rather than crashing the listing. Read-only.
 */
export async function listWorktreesForWorkspace(repoRoot: string): Promise<WorktreeStatus[]> {
  const store = new WorkItemStore(repoRoot);
  const summaries = await store.list();
  const rows: WorktreeStatus[] = [];
  for (const s of summaries) {
    let item: Awaited<ReturnType<typeof store.get>>;
    try {
      item = await store.get(s.id);
    } catch {
      continue; // malformed work item — skip in the listing
    }
    for (const wt of item.worktrees) {
      const wtAbs = join(repoRoot, wt.worktree_path);
      if (!(await fileExists(wtAbs))) {
        rows.push({
          work_item_id: item.id,
          owning_repo: wt.owning_repo,
          branch: wt.branch,
          worktree_path: wt.worktree_path,
          exists: false,
          orphan: false,
          dirty: false,
          base: '',
          ahead: 0,
          behind: 0,
        });
        continue;
      }
      const ownerCwd = wt.owning_repo === '.' ? repoRoot : join(repoRoot, wt.owning_repo);
      const base = detectBaseBranch(ownerCwd);
      const { ahead, behind } = aheadBehind(wtAbs, base);
      rows.push({
        work_item_id: item.id,
        owning_repo: wt.owning_repo,
        branch: wt.branch,
        worktree_path: wt.worktree_path,
        exists: true,
        orphan: false,
        dirty: !isWorkingTreeClean(wtAbs),
        base,
        ahead,
        behind,
      });
    }
  }

  // porcelain ∖ meta: on-disk run worktrees not bound to any work-item meta → ORPHAN.
  // The list surface would otherwise hide these leaks (the porcelain truth lives in
  // listRunWorktrees, previously used only by cleanup).
  const metaPaths = new Set(rows.map((r) => toPosixSeparators(r.worktree_path)));
  let onDisk: string[];
  try {
    onDisk = listRunWorktrees(repoRoot);
  } catch {
    onDisk = []; // not a git repo / git unavailable — meta rows still list
  }
  for (const rel of onDisk) {
    if (metaPaths.has(rel)) continue;
    const wtAbs = join(repoRoot, rel);
    rows.push({
      work_item_id: '',
      owning_repo: '',
      branch: readWorktreeBranch(wtAbs),
      worktree_path: rel,
      exists: true,
      orphan: true,
      dirty: !isWorkingTreeClean(wtAbs),
      base: '',
      ahead: 0,
      behind: 0,
    });
  }
  return rows;
}

/** Checked-out branch of a worktree ('HEAD' if detached, '' if unresolvable). */
function readWorktreeBranch(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

/**
 * ac-2: next-step guidance after a worktree is created — opening a session inside it
 * auto-binds to the owning work item (parseWorktreePath rooting). Points at the
 * workspace ('.') worktree (the one that nests any sub-repo worktrees), as an
 * absolute path. Null when there is no worktree to point at.
 */
export function worktreeBindingHint(
  repoRoot: string,
  worktrees: WorkItemWorktree[],
  workItemId: string,
): string | null {
  const ws = worktrees.find((w) => w.owning_repo === '.') ?? worktrees[0];
  if (!ws) return null;
  return `→ cd ${join(repoRoot, ws.worktree_path)} 후 거기서 세션을 열면 자동으로 이 work item(${workItemId})에 바인딩됩니다`;
}

export interface WorktreeRemovalResult {
  removed: WorkItemWorktree[];
  /** Worktrees left intact because they were dirty/unlanded and not force-approved. */
  blocked: { worktree: WorkItemWorktree; reason: string }[];
}

/**
 * ac-2 / C4: tear down a work item's worktree(s). A worktree with uncommitted/untracked
 * changes OR a branch NOT yet LANDED to origin/<default> is BLOCKED — never deleted
 * without explicit approval (`force`). "Landed" = the branch tip is reachable from
 * `refs/remotes/origin/<default>` (branchLandedToOrigin), NOT local-HEAD ancestry: a
 * land PUSHES and never merges into the shared local checkout, so a local-HEAD check
 * would read every landed branch as "unmerged" and orphan its worktree. A confirmed-
 * landed (or force-approved) branch's local ref is dropped with `-D` — the commits are
 * durably on origin, so the local ref is redundant; a branch whose push FAILED stays
 * blocked and is never force-deleted.
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
      // C4: "removable" now means LANDED to origin/<default> (durable), not merged into
      // the local checkout (which a push never touches).
      const unlanded = !branchLandedToOrigin(ownerCwd, wt.branch);
      if ((dirty || unlanded) && !force) {
        const why = [dirty ? 'uncommitted changes' : null, unlanded ? 'unlanded commits' : null]
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
        // `-D` (not `-d`): we only reach here for a branch that is LANDED to origin
        // (commits durable there) or force-approved, so `-d`'s local-merge check — which
        // a pushed-but-not-locally-merged branch always fails — is exactly the wrong gate.
        execFileSync('git', ['branch', '-D', '--', wt.branch], {
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

// ── Direct-to-origin land of a work item's worktree branch(es) (wi_2607156f8) ──
// The one net-new git NETWORK mutation of the worktree-sequential driver. It lives
// here (not git.ts) to reach the module-private helpers a safe land needs:
// withWorktreeLock, assertSafeArg, and the per-owning-repo ordering. Landing PUSHES a
// work-item branch's commits straight to origin/<default> — it NEVER merges into the
// shared local checkout, so a land can't touch the main working tree. The teardown
// gate (removeWorktreesForWorkItem) reads the SAME signal a land confirms: the branch
// tip reachable from `refs/remotes/origin/<default>` (branchLandedToOrigin), NOT
// local-HEAD ancestry (which never reflects a push).

/**
 * The remote's default branch, resolved FROM THE REMOTE via
 * `git ls-remote --symref origin HEAD` (`ref: refs/heads/<default>\tHEAD`). Returns
 * null when there is no origin, or origin/HEAD is unset/unresolvable/stale (no real
 * branch to name). This is the LAND destination, so it is derived from the REMOTE —
 * never the local-checkout fallback `detectBaseBranch` uses (which could name a branch
 * that is not the remote default and mis-target the push).
 */
function resolveOriginDefaultBranch(cwd: string): string | null {
  let out: string;
  try {
    out = execFileSync('git', ['ls-remote', '--symref', 'origin', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null; // no origin / cannot reach it
  }
  // `ref: refs/heads/<default>\tHEAD` names the default; a following `<sha>\tHEAD` line
  // proves it resolves to a real commit (an empty/unborn remote HEAD has no sha line).
  const ref = out.match(/^ref:\s+refs\/heads\/(.+?)\s+HEAD$/m)?.[1]?.trim();
  const hasSha = /^[0-9a-f]{40}\s+HEAD$/m.test(out);
  if (!ref || !hasSha) return null; // unset / unresolvable / stale
  return ref;
}

/**
 * Has `branch` LANDED on the remote default — is its tip reachable from
 * `refs/remotes/origin/<default>`? After a successful `git push origin branch:default`
 * the local tracking ref is updated to the pushed tip, so this is true for a landed
 * branch and FALSE for one whose push failed (or never happened) — the teardown safety
 * signal (C4). No origin / no default → false (fail-safe: never confirm a land we
 * cannot verify, so an unlanded worktree is preserved, never force-deleted).
 */
function branchLandedToOrigin(cwd: string, branch: string): boolean {
  const def = resolveOriginDefaultBranch(cwd);
  if (def === null) return false;
  try {
    execFileSync('git', ['rev-parse', '--verify', branch], {
      cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    execFileSync('git', ['merge-base', '--is-ancestor', branch, `refs/remotes/origin/${def}`], {
      cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/** Per owning-repo land outcome status (C5: distinct failure classes, never collapsed). */
export type LandStatus =
  | 'landed' // pushed to origin/<default> (or already reachable there — idempotent)
  | 'skipped-no-origin' // no origin / undeterminable-or-stale / degenerate default (benign)
  | 'push-gate-rejected'
  | 'auth-or-network-failed'
  | 'non-ff-retry-exhausted'
  | 'rebase-conflict';

export interface WorktreeLandOutcome {
  worktree: WorkItemWorktree;
  status: LandStatus;
  reason?: string;
}

export interface WorktreeLandResult {
  outcomes: WorktreeLandOutcome[];
  /** every owning repo's branch is landed on origin/<default> (teardown precondition). */
  allLanded: boolean;
  /** at least one owning repo actually landed (partial-land signal for C1). */
  anyLanded: boolean;
}

/** A benign outcome is "nothing to fix here" — never a force-delete, never a failure. */
function isBenignLand(status: LandStatus): boolean {
  return status === 'landed' || status === 'skipped-no-origin';
}

/**
 * Land ONE owning repo's `branch` to origin, from its worktree checkout `wtAbs`
 * (where `branch` is checked out, so a non-FF rebase acts on it). SELF-GUARDS:
 *  - no origin / undeterminable-or-stale default / default == branch (degenerate) →
 *    a distinct 'skipped-no-origin' (never a wrong-branch push).
 *  - already reachable from origin/<default> → 'landed' (idempotent resume).
 * Otherwise `landBranchToOrigin` pushes (force-free, non-FF fetch+rebase+re-push with a
 * bounded, per-attempt-timed retry). Its raw git output is credential-SCRUBBED (C6)
 * before it enters the reported reason.
 */
function landBranchOwning(wtAbs: string, branch: string): { status: LandStatus; reason?: string } {
  assertSafeArg(branch, 'branch');
  const def = resolveOriginDefaultBranch(wtAbs);
  if (def === null) {
    return {
      status: 'skipped-no-origin',
      reason:
        'no origin, or origin default is unset/unresolvable/stale — cannot land; push manually',
    };
  }
  if (def === branch) {
    return {
      status: 'skipped-no-origin',
      reason: `origin default (${def}) equals the work-item branch — degenerate, refusing to push`,
    };
  }
  assertSafeArg(def, 'origin default branch');
  if (branchLandedToOrigin(wtAbs, branch)) return { status: 'landed' }; // idempotent resume
  const res = landBranchToOrigin(wtAbs, branch, def);
  if (res.status === 'landed') return { status: 'landed' };
  // C6: scrub the git output before it enters the reported reason / ledger.
  return { status: res.status, reason: scrubCredentials(res.reason) };
}

/**
 * Land every worktree branch a work item owns to origin/<default>. Sub-repo branches
 * first, the workspace ('.') branch last (deterministic order, C1), under the same
 * repo-level lock as create/remove. Landing is NON-ATOMIC and IRREVERSIBLE (a push
 * can't be rolled back), so on the FIRST hard failure it STOPS and reports which repos
 * already landed — never all-or-nothing (C1). Benign no-origin skips do not stop the
 * sweep. `allLanded` is the teardown precondition; `anyLanded` flags a partial land.
 */
export async function landWorktreesForWorkItem(
  repoRoot: string,
  workItemId: string,
): Promise<WorktreeLandResult> {
  assertSafeArg(workItemId, 'work item id');
  return withWorktreeLock(repoRoot, async () => {
    const store = new WorkItemStore(repoRoot);
    const item = await store.get(workItemId);
    // Nested sub-repo worktrees first, workspace ('.') last (mirror removal order).
    const ordered = [...item.worktrees].sort(
      (a, b) => (a.owning_repo === '.' ? 1 : 0) - (b.owning_repo === '.' ? 1 : 0),
    );
    const outcomes: WorktreeLandOutcome[] = [];
    for (const wt of ordered) {
      const wtAbs = join(repoRoot, wt.worktree_path);
      const r = landBranchOwning(wtAbs, wt.branch);
      outcomes.push({
        worktree: wt,
        status: r.status,
        ...(r.reason !== undefined ? { reason: r.reason } : {}),
      });
      // A hard failure stops the sweep: further pushes only add irreversible partial
      // state. A benign skip (no origin) is not a failure, so it does not stop.
      if (!isBenignLand(r.status)) break;
    }
    const allLanded =
      outcomes.length === ordered.length && outcomes.every((o) => o.status === 'landed');
    const anyLanded = outcomes.some((o) => o.status === 'landed');
    return { outcomes, allLanded, anyLanded };
  });
}
