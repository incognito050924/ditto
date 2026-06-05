import { execFileSync } from 'node:child_process';
import type { GitState } from '~/schemas/run-manifest';

export function captureGitState(cwd: string): GitState {
  let head = '0'.repeat(40);
  let branch = '';
  let dirty = false;
  let untracked_count = 0;
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    // not a git repo or no commits; keep zero sha
  }
  try {
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
    }).trim();
  } catch {
    // ignore
  }
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
    const lines = status.split('\n').filter((line) => line.length > 0);
    dirty = lines.length > 0;
    untracked_count = lines.filter((line) => line.startsWith('??')).length;
  } catch {
    // ignore
  }
  return { head, branch, dirty, untracked_count };
}

export function listChangedFiles(
  cwd: string,
  options: { excludeDittoRuns?: boolean } = {},
): string[] {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
    return status
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => line.slice(3).trim())
      .filter((path) => path.length > 0)
      .filter((path) => !options.excludeDittoRuns || !path.startsWith('.ditto/runs/'))
      .sort();
  } catch {
    return [];
  }
}

/** Tracked files changed in the working tree vs a git ref. Empty on any error. */
export function listChangedFilesVsRef(cwd: string, ref: string): string[] {
  try {
    const out = execFileSync('git', ['diff', '--name-only', ref, '--'], { cwd, encoding: 'utf8' });
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter((p) => p.length > 0)
      .sort();
  } catch {
    return [];
  }
}

/** Resolve a ref to its 40-char sha, or throw when it does not resolve. */
export function gitRevParse(cwd: string, ref: string): string {
  return execFileSync('git', ['rev-parse', ref], { cwd, encoding: 'utf8' }).trim();
}

/** Is the working tree clean (no staged/unstaged/untracked changes)? */
export function isWorkingTreeClean(cwd: string): boolean {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim() === '';
  } catch {
    return false;
  }
}

/** Add a detached worktree at `ref` under `path` (for analyzing a past state). */
export function addDetachedWorktree(cwd: string, path: string, ref: string): void {
  execFileSync('git', ['worktree', 'add', '--detach', '--force', path, ref], {
    cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

/** Remove a worktree previously added (best effort, force). */
export function removeWorktree(cwd: string, path: string): void {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', path], {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch {
    // best effort — a leftover worktree dir is harmless scratch
  }
}

export function captureGitDiff(cwd: string): string {
  try {
    return execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd, encoding: 'utf8' });
  } catch {
    try {
      return execFileSync('git', ['diff', '--binary'], { cwd, encoding: 'utf8' });
    } catch {
      return '';
    }
  }
}
