import { execFileSync } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { CleanupIndex } from '~/schemas/cleanup-index';
import { CleanupStore } from './cleanup-store';
import { localDir } from './ditto-paths';

/**
 * Cleanup mechanics — the deterministic teardown of a classify run folder.
 * Per ADR-0001 this is pure git/zip/fs mechanics: no LLM, no per-doc judgment.
 *
 * Two terminal actions on a run folder:
 *  - `archive` (default, reversible): zip the run folder, keep the zip, remove
 *    the folder. The zip IS the reversibility — restore from it later.
 *  - `delete` (irreversible): permanently remove the staged files + folder.
 *    Gated behind an EXPLICIT confirm; fail-closed on the auto/autopilot path.
 *
 * The auto-cleanup chain may only reach `archive` — `delete` is never auto.
 */

export class CleanupRunMissingError extends Error {
  constructor(runId: string) {
    super(`no cleanup run folder for id: ${runId}`);
    this.name = 'CleanupRunMissingError';
  }
}

export class CleanupDeleteRefusedError extends Error {
  constructor(reason: string) {
    super(`delete refused (fail-closed): ${reason}`);
    this.name = 'CleanupDeleteRefusedError';
  }
}

export class CleanupDirtyRepoError extends Error {
  constructor(
    public readonly repo: string,
    public readonly dirty: string[],
  ) {
    super(
      `refusing to commit: sub-repo "${repo}" working tree has uncommitted changes ` +
        `unrelated to this cleanup (${dirty.join(', ')}); resolve them first (no auto clean/stash)`,
    );
    this.name = 'CleanupDirtyRepoError';
  }
}

/** Absolute path to the run folder for `runId`. */
function runDir(repoRoot: string, runId: string): string {
  return localDir(repoRoot, 'cleanup', runId);
}

/** Absolute path to the archive zip for `runId`. */
export function archiveZipPath(repoRoot: string, runId: string): string {
  return localDir(repoRoot, 'cleanup', 'archive', `${runId}.zip`);
}

async function assertRunExists(repoRoot: string, runId: string): Promise<void> {
  try {
    const s = await stat(runDir(repoRoot, runId));
    if (!s.isDirectory()) throw new CleanupRunMissingError(runId);
  } catch (err) {
    if (err instanceof CleanupRunMissingError) throw err;
    throw new CleanupRunMissingError(runId);
  }
}

export interface ArchiveResult {
  run_id: string;
  zip_path: string;
  removed_run_dir: string;
}

/**
 * Archive a run folder: zip JUST that folder (no parent escape) into
 * `.ditto/local/cleanup/archive/<run-id>.zip`, then remove the folder.
 *
 * The zip is bound to the run folder by running `zip` with cwd at the cleanup
 * parent and a single relative arg `<run-id>` — the archive can only contain
 * paths under that folder. `-y` stores symlinks AS symlinks instead of
 * following them, so a symlink inside the run folder cannot pull in files from
 * outside it. The index.json lives in the run folder, so it is included.
 */
export async function archiveRun(repoRoot: string, runId: string): Promise<ArchiveResult> {
  await assertRunExists(repoRoot, runId);
  const zip = archiveZipPath(repoRoot, runId);
  await mkdir(dirname(zip), { recursive: true });
  // Overwrite any stale zip for the same id so the operation is idempotent.
  await rm(zip, { force: true });
  // cwd = the cleanup parent; the only path arg is the run folder name → the
  // archive is structurally confined to that folder.
  execFileSync('zip', ['-r', '-q', '-y', zip, runId], {
    cwd: localDir(repoRoot, 'cleanup'),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const folder = runDir(repoRoot, runId);
  await rm(folder, { recursive: true, force: true });
  return { run_id: runId, zip_path: zip, removed_run_dir: folder };
}

/**
 * Irreversible-git approval gate idiom (mirrors `cleanupApprovalGate` in
 * autopilot-cleanup.ts): only an explicit confirm clears delete. There is no
 * weaker "small reversible" waiver — permanent deletion never qualifies. On any
 * non-interactive/autopilot path `confirm` is false, so it stays refused
 * (fail-closed).
 */
export function deleteApprovalGate(confirm: boolean): { allowed: boolean; reason: string } {
  if (confirm) return { allowed: true, reason: 'explicit operator confirm' };
  return {
    allowed: false,
    reason: 'permanent delete needs an explicit confirm token; auto/autopilot refuses without one',
  };
}

export interface DeleteResult {
  run_id: string;
  removed_run_dir: string;
}

/**
 * Permanently remove a run folder + its staged files. Irreversible → requires
 * `confirm`. Without it this THROWS (fail-closed) before touching anything.
 */
export async function deleteRun(
  repoRoot: string,
  runId: string,
  confirm: boolean,
): Promise<DeleteResult> {
  await assertRunExists(repoRoot, runId);
  const gate = deleteApprovalGate(confirm);
  if (!gate.allowed) throw new CleanupDeleteRefusedError(gate.reason);
  const folder = runDir(repoRoot, runId);
  await rm(folder, { recursive: true, force: true });
  return { run_id: runId, removed_run_dir: folder };
}

/** Absolute path of a sub-repo from its index `owning_repo` (null = workspace root). */
export function subRepoAbs(repoRoot: string, owningRepo: string | null): string {
  if (owningRepo === null || owningRepo === '.') return resolve(repoRoot);
  return isAbsolute(owningRepo) ? owningRepo : join(repoRoot, owningRepo);
}

/**
 * Working-tree paths in `cwd` (porcelain, repo-relative) that are NOT in
 * `allowed`. The cleanup's own removals (the entries' original paths) are
 * expected — anything else is unrelated dirt that must block the commit.
 */
export function unrelatedDirt(cwd: string, allowed: ReadonlySet<string>): string[] {
  let status = '';
  try {
    // `--untracked-files=all` lists individual files rather than collapsing a
    // wholly-untracked directory to its top entry. This keeps the dirt check at the
    // same granularity as the paths in `allowed` (always individual files), so the
    // land byproduct-absorb side and this dirt-check side agree (wi_260627lus). The
    // abort decision is unchanged: any path not in `allowed` is still dirt.
    status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd,
      encoding: 'utf8',
    });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of status.split('\n')) {
    if (line.length === 0) continue;
    // Porcelain v1: 2 status cols + space, then the path. Rename uses "old -> new".
    const path = line.slice(3).trim();
    const parts = path.split(' -> ');
    const real = (parts.length > 1 ? parts[parts.length - 1] : path)?.trim() ?? path;
    if (!allowed.has(real)) out.push(real);
  }
  return out.sort();
}

export interface PerRepoCommit {
  /** owning_repo key (null → '.') */
  repo: string;
  /** commit sha, or the unchanged HEAD when the group had nothing to commit */
  sha: string;
  paths: string[];
}

export interface CommitResult {
  commits: PerRepoCommit[];
}

/**
 * Commit a set of paths PER owning sub-repo (one commit each) so every sub-repo
 * is independently `git revert`-recoverable. `pathsByRepo` keys are owning_repo
 * values ('.' = workspace root) and values are sub-repo-relative paths.
 *
 * Dirty-tree abort: if ANY affected sub-repo has working-tree changes beyond the
 * supplied paths, abort with NO commit at all — no auto `git clean`, no stash.
 * The check runs across all sub-repos FIRST (Phase 1), then commits (Phase 2).
 *
 * Idempotent: a sub-repo with nothing staged for its paths after `git add`
 * (already committed / clean) is skipped, so re-running reconciles a partial
 * multi-repo commit instead of failing on an empty commit.
 *
 * This is the shared landing primitive used by both cleanup (`commitCleanup`)
 * and the run land-commit step — keep the per-sub-repo mechanics here so the two
 * callers cannot drift apart.
 */
export function commitPerSubRepo(
  repoRoot: string,
  pathsByRepo: ReadonlyMap<string, readonly string[]>,
  message: string,
): PerRepoCommit[] {
  // Phase 1 — dirty check across ALL affected sub-repos before any commit.
  for (const [repo, paths] of pathsByRepo) {
    const abs = subRepoAbs(repoRoot, repo);
    const dirt = unrelatedDirt(abs, new Set(paths));
    if (dirt.length > 0) throw new CleanupDirtyRepoError(repo, dirt);
  }

  // Phase 2 — one commit per sub-repo (skip a sub-repo with nothing staged).
  const commits: PerRepoCommit[] = [];
  for (const [repo, paths] of pathsByRepo) {
    const abs = subRepoAbs(repoRoot, repo);
    for (const p of paths) {
      execFileSync('git', ['add', '--all', '--', p], { cwd: abs, stdio: 'pipe' });
    }
    const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--', ...paths], {
      cwd: abs,
      encoding: 'utf8',
    }).trim();
    if (staged === '') continue; // already committed / clean → idempotent skip
    execFileSync('git', ['commit', '-m', message, '--', ...paths], { cwd: abs, stdio: 'pipe' });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: abs, encoding: 'utf8' }).trim();
    commits.push({ repo, sha, paths: [...paths] });
  }
  return commits;
}

/**
 * Commit the cleanup result PER affected sub-repo (one commit each) so each is
 * independently `git revert`-recoverable (ac-10). Affected sub-repos are the
 * distinct `owning_repo`s of the index entries. The committed change is the
 * removal of each entry's `original_path` (the doc was moved out during classify
 * staging, so it shows as a deletion in its owning sub-repo).
 *
 * Delegates the dirty-abort + per-sub-repo commit mechanics to the shared
 * `commitPerSubRepo` helper.
 */
export function commitCleanup(
  repoRoot: string,
  index: CleanupIndex,
  message: string,
): CommitResult {
  // Group original paths by owning sub-repo (sub-repo-relative).
  const byRepo = new Map<string, string[]>();
  for (const e of index.entries) {
    const key = e.owning_repo ?? '.';
    const abs = subRepoAbs(repoRoot, e.owning_repo);
    // original_path is workspace-root-relative; re-relativize to the sub-repo.
    const rel = relForRepo(repoRoot, abs, e.original_path);
    const group = byRepo.get(key) ?? [];
    group.push(rel);
    byRepo.set(key, group);
  }
  return { commits: commitPerSubRepo(repoRoot, byRepo, message) };
}

/** Re-express a workspace-relative path as relative to a sub-repo abs dir. */
export function relForRepo(repoRoot: string, repoAbs: string, workspaceRelPath: string): string {
  const abs = join(repoRoot, workspaceRelPath);
  const rel = abs.startsWith(`${repoAbs}/`) ? abs.slice(repoAbs.length + 1) : workspaceRelPath;
  return rel.replace(/\\/g, '/');
}

/**
 * The auto-cleanup chain entry point: archive ONLY. The auto path can never reach
 * delete — this function physically cannot delete (it calls `archiveRun`). Used
 * by classify.ts's auto-cleanup wiring (ac-6).
 */
export async function autoChainArchive(repoRoot: string, runId: string): Promise<ArchiveResult> {
  return archiveRun(repoRoot, runId);
}

export interface RestoreResult {
  run_id: string;
  original_path: string;
}

/** Thin passthrough over the store restore primitive. */
export async function restoreDoc(
  repoRoot: string,
  runId: string,
  originalPath: string,
): Promise<RestoreResult> {
  const store = new CleanupStore(repoRoot);
  const entry = await store.restore(runId, originalPath);
  return { run_id: runId, original_path: entry.original_path };
}
