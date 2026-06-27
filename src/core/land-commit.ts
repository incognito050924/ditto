import { execFileSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import {
  CleanupDirtyRepoError,
  type PerRepoCommit,
  commitPerSubRepo,
  relForRepo,
  subRepoAbs,
} from './cleanup-archive';
import { findOwningRepo } from './memory-scan';

/**
 * Deterministic land-commit engine (run pass → landed).
 *
 * Lands a run's `changed_files` as one `git revert`-recoverable commit per
 * owning sub-repo. Pure git/fs mechanics — no LLM, no push (push stays
 * irreversible + user-gated). The per-sub-repo commit + dirty-abort mechanics
 * are NOT re-implemented here: they live in `commitPerSubRepo` /
 * `unrelatedDirt` in cleanup-archive.ts and are reused so the two landing paths
 * cannot drift.
 *
 * Invariants (ac-1, ac-5):
 *  - Run-artifact paths under `.ditto/local/runs` are NEVER committed.
 *  - Unrelated working-tree dirt (paths outside the changeset) → abort with NO
 *    commit at all (no auto clean/stash).
 *  - Empty changeset → no-op (no commit, no error).
 *  - Re-run is idempotent: already-committed/clean paths are skipped, so a
 *    partial multi-repo commit is reconciled by committing only the rest.
 *  - A detached HEAD makes `git commit` succeed but orphans the commit (not on
 *    any branch) → durability is silently false. We DETECT detached HEAD and
 *    treat it as a land FAILURE rather than a silent success.
 *  - `git push` is never invoked.
 */

/** Run-artifact dir whose paths must never be landed. */
const RUN_ARTIFACT_PREFIX = '.ditto/local/runs/';

export type LandStatus = 'committed' | 'noop' | 'aborted_dirty' | 'aborted_detached';

export interface LandResult {
  status: LandStatus;
  /** Commits made (empty for noop / aborts). */
  commits: PerRepoCommit[];
  /** Owning-repo keys with a detached HEAD (only for status='aborted_detached'). */
  detached: string[];
  /** Unrelated dirty paths that blocked the land (only for status='aborted_dirty'). */
  dirty: { repo: string; paths: string[] }[];
}

/**
 * True when `cwd`'s HEAD is detached (not pointing at a branch). `git
 * symbolic-ref -q HEAD` exits 0 on a branch and non-zero when detached (or not
 * a repo) — either way committing there would not advance a branch.
 */
function isDetachedHead(cwd: string): boolean {
  try {
    execFileSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd, stdio: 'pipe' });
    return false;
  } catch {
    return true;
  }
}

/**
 * Land `changedFiles` (workspace-root-relative) as one commit per owning
 * sub-repo. See module docstring for the full invariant set.
 */
export async function landCommit(
  repoRoot: string,
  changedFiles: readonly string[],
  message: string,
): Promise<LandResult> {
  const root = resolve(repoRoot);

  // Drop run-artifact paths; the run dir is never part of the landed changeset.
  const landable = changedFiles.filter((p) => !p.startsWith(RUN_ARTIFACT_PREFIX));

  // Empty changeset → no-op.
  if (landable.length === 0) {
    return { status: 'noop', commits: [], detached: [], dirty: [] };
  }

  // Group sub-repo-relative paths by owning sub-repo ('.' = workspace root).
  const byRepo = new Map<string, string[]>();
  for (const p of landable) {
    const abs = join(root, p);
    const owningAbs = await findOwningRepo(abs, root);
    const key = owningAbs === null ? '.' : relative(root, owningAbs).replace(/\\/g, '/') || '.';
    const repoAbs = subRepoAbs(root, key);
    const rel = relForRepo(root, repoAbs, p);
    const group = byRepo.get(key) ?? [];
    group.push(rel);
    byRepo.set(key, group);
  }

  // Guard — detached HEAD across ALL affected sub-repos before any commit.
  // A detached commit is orphaned (durability silently false) → land FAILURE.
  const detached = [...byRepo.keys()].filter((repo) => isDetachedHead(subRepoAbs(root, repo)));
  if (detached.length > 0) {
    return { status: 'aborted_detached', commits: [], detached: detached.sort(), dirty: [] };
  }

  // Shared mechanics: Phase-1 dirty check (NO commit on dirt) + Phase-2 commit.
  try {
    const commits = commitPerSubRepo(root, byRepo, message);
    // All groups skipped (already committed) → idempotent no-op.
    return { status: commits.length > 0 ? 'committed' : 'noop', commits, detached: [], dirty: [] };
  } catch (err) {
    if (err instanceof CleanupDirtyRepoError) {
      return {
        status: 'aborted_dirty',
        commits: [],
        detached: [],
        dirty: [{ repo: err.repo, paths: err.dirty }],
      };
    }
    throw err;
  }
}
