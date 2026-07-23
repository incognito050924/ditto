import { execFileSync } from 'node:child_process';

/**
 * Decode git's C-quoted porcelain path (core.quotepath=true wraps a non-ASCII or
 * special-char path in double quotes with octal `\nnn` byte escapes) back to its
 * real utf-8 name. A path git did NOT quote is returned verbatim — including a
 * collapsed whole-untracked-directory entry's trailing slash.
 */
function dequotePorcelainPath(raw: string): string {
  if (!(raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2)) return raw;
  const inner = raw.slice(1, -1);
  const bytes: number[] = [];
  const cEscapes: Record<string, number | undefined> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92 };
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] ?? '';
    if (ch === '\\') {
      const next = inner[i + 1] ?? '';
      if (next >= '0' && next <= '7') {
        bytes.push(Number.parseInt(inner.slice(i + 1, i + 4), 8));
        i += 3;
      } else {
        bytes.push(cEscapes[next] ?? next.charCodeAt(0));
        i += 1;
      }
    } else {
      bytes.push(ch.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Working-tree changes from `git status --porcelain`, sorted. Empty on any error
 * (e.g. not a git repo).
 *  - untrackedOnly: keep only the `??` cohort (a tracked-but-modified file is
 *    in-scope work, never foreign baseline dirt) and dequote each path so the byte
 *    form matches the unquoted utf-8 path consumers compare against; a collapsed
 *    untracked-dir entry keeps its trailing slash verbatim.
 *  - excludeDittoRuns: drop `.ditto/local/runs/` scratch artifacts.
 */
export function listChangedFiles(
  cwd: string,
  options: { excludeDittoRuns?: boolean; untrackedOnly?: boolean } = {},
): string[] {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
    const lines = status.split('\n').filter((line) => line.length > 0);
    if (options.untrackedOnly) {
      return lines
        .filter((line) => line.startsWith('??'))
        .map((line) => dequotePorcelainPath(line.slice(3)))
        .filter((path) => path.length > 0)
        .filter((path) => !options.excludeDittoRuns || !path.startsWith('.ditto/local/runs/'))
        .sort();
    }
    return lines
      .map((line) => line.slice(3).trim())
      .filter((path) => path.length > 0)
      .filter((path) => !options.excludeDittoRuns || !path.startsWith('.ditto/local/runs/'))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Working-tree diff vs HEAD (binary-safe). When HEAD does not resolve (a repo
 * with no commits) fall back to the index diff; empty string outside a repo.
 */
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

/** Is the working tree clean (no staged/unstaged/untracked changes)? False on any error. */
export function isWorkingTreeClean(cwd: string): boolean {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim() === '';
  } catch {
    return false;
  }
}

/** Resolve a ref to its 40-char sha, or throw when it does not resolve. */
export function gitRevParse(cwd: string, ref: string): string {
  return execFileSync('git', ['rev-parse', ref], { cwd, encoding: 'utf8' }).trim();
}

/** Full working-tree diff vs a ref (text). Empty string on any error. */
export function diffVsRef(cwd: string, ref: string): string {
  try {
    return execFileSync('git', ['diff', ref, '--'], { cwd, encoding: 'utf8' });
  } catch {
    return '';
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
