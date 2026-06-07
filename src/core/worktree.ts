import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { relative } from 'node:path';
import { localDir } from './ditto-paths';
import { ensureDir } from './fs';

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
