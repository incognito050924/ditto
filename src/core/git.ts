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

/** Files changed in the working tree vs a git ref (committed + uncommitted). */
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

/** File content at a git ref, or null when the path did not exist there. */
export function gitShowFile(cwd: string, ref: string, path: string): string | null {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], { cwd, encoding: 'utf8' });
  } catch {
    return null;
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
