import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ensureDir } from './fs';

export interface WorktreeHandle {
  absolutePath: string;
  relativePath: string;
}

export async function createWorktreeForRun(
  repoRoot: string,
  runId: string,
): Promise<WorktreeHandle> {
  const relativePath = `.ditto/worktrees/${runId}`;
  const absolutePath = join(repoRoot, relativePath);
  await ensureDir(join(repoRoot, '.ditto', 'worktrees'));
  execFileSync('git', ['worktree', 'add', '--detach', absolutePath, 'HEAD'], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return { absolutePath, relativePath };
}
