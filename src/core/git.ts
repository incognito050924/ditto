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

/**
 * Decode git's C-quoted porcelain path (core.quotepath=true wraps a non-ASCII or
 * special-char path in double quotes with octal `\nnn` byte escapes) back to its
 * real utf-8 name. A path git did NOT quote is returned verbatim — including a
 * collapsed whole-untracked-directory entry's trailing slash. Only the untracked
 * baseline path needs this so the captured path is BYTE-identical to the unquoted
 * utf-8 path an owner later reports (wi_260710s4j).
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

export function listChangedFiles(
  cwd: string,
  options: { excludeDittoRuns?: boolean; untrackedOnly?: boolean } = {},
): string[] {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
    const lines = status.split('\n').filter((line) => line.length > 0);
    // untrackedOnly: keep only the `??` cohort (a tracked-but-modified file is in-scope
    // work, never foreign baseline dirt) and dequote its path so the byte form matches
    // the unquoted utf-8 path consumers compare against; a collapsed untracked-dir entry
    // keeps its trailing slash verbatim.
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

/** Full working-tree diff vs a ref (text). Empty string on any error. */
export function diffVsRef(cwd: string, ref: string): string {
  try {
    return execFileSync('git', ['diff', ref, '--'], { cwd, encoding: 'utf8' });
  } catch {
    return '';
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

/**
 * Commits the working tree at `cwd` is ahead of / behind `base`. Uses
 * `git rev-list --left-right --count base...HEAD`: left = commits in base not HEAD
 * (behind), right = commits in HEAD not base (ahead). Returns {ahead:0,behind:0} on
 * any error (unresolvable ref, not a repo), matching the other helpers here.
 */
export function aheadBehind(cwd: string, base: string): { ahead: number; behind: number } {
  try {
    const out = execFileSync('git', ['rev-list', '--left-right', '--count', `${base}...HEAD`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const [behind, ahead] = out.split(/\s+/).map((n) => Number.parseInt(n, 10));
    return { ahead: ahead || 0, behind: behind || 0 };
  } catch {
    return { ahead: 0, behind: 0 };
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

export interface GitPushResult {
  ok: boolean;
  /** git's stderr on failure (credentials already scrubbed by the caller). */
  stderr: string;
}

/**
 * Push `ref` to `remote` from `cwd`. argv-array, NO force, with `--`
 * end-of-options so a hostile ref cannot smuggle a flag (mirrors the
 * end-of-options `--` other git.ts helpers use). Returns a structured result
 * instead of throwing so the caller can graceful-degrade (any non-zero push
 * exit → push-skipped, not an error). Never force-pushes.
 */
export function gitPush(cwd: string, remote: string, ref: string): GitPushResult {
  try {
    // argv-array; `--` ends options so `ref`/`remote` can never be read as a flag.
    // NO `--force` — a non-fast-forward must fail, not clobber the remote.
    execFileSync('git', ['push', remote, '--', ref], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stderr: '' };
  } catch (err) {
    const stderr =
      err && typeof err === 'object' && 'stderr' in err && (err as { stderr?: unknown }).stderr
        ? String((err as { stderr: unknown }).stderr)
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, stderr };
  }
}

// ─── Direct-to-origin land of a work-item branch (wi_2607156f8) ──────────────
// The worktree LAND path pushes a work-item branch's commits straight to the
// remote default branch — it never merges into the shared local checkout. On a
// non-fast-forward rejection it fetches + rebases (linear, NO merge commit) onto
// `refs/remotes/origin/<default>` and re-pushes, bounded by a retry cap; a rebase
// conflict aborts and surfaces. Every git subprocess carries a PER-ATTEMPT timeout
// so a hung call fails that attempt (feeding the retry) instead of blocking forever.
// NEVER --force.

/** How a failed `git push` is classified from its raw output (drives retry vs surface). */
export type PushRejectionClass = 'non-ff' | 'push-gate' | 'auth-network';

/**
 * Classify a failed push from git's combined stderr/stdout:
 *  - 'non-ff'       — the remote moved ahead (`[rejected] … (fetch first)` /
 *                     `non-fast-forward`): recoverable by fetch+rebase+re-push.
 *  - 'push-gate'    — a client pre-push gate declined (DITTO's `push-gate:` message):
 *                     a real failure, never retried.
 *  - 'auth-network' — anything else (auth/permission/network/unknown): a real failure.
 * A non-FF marker wins over the others so a rejection we CAN recover from is retried.
 */
export function classifyPushRejection(output: string): PushRejectionClass {
  if (/non-fast-forward|fetch first|\bstale info\b/i.test(output)) return 'non-ff';
  if (/push-gate:|pre-push hook/i.test(output)) return 'push-gate';
  return 'auth-network';
}

export type LandToOriginStatus =
  | 'landed'
  | 'push-gate-rejected'
  | 'auth-or-network-failed'
  | 'non-ff-retry-exhausted'
  | 'rebase-conflict';

export interface LandToOriginResult {
  status: LandToOriginStatus;
  /** raw git output on failure (the caller credential-scrubs before reporting). Empty on landed. */
  reason: string;
}

/**
 * Per-attempt wall clock for the LANDING push. The push fires the pre-push gate
 * (`.githooks/pre-push` → `ditto push-gate` → the recipe test_command, a full suite that
 * legitimately runs for minutes), which itself force-kills a hung suite at its own
 * ~10-minute internal budget (`PUSH_GATE_TIMEOUT_MS`). This bound must therefore CLEAR
 * that gate with margin: a shorter cap SIGTERMs the push MID-GATE, before the ref update,
 * so a would-be success is misread as a hung/non-FF attempt and the land never completes.
 * Kept finite so a genuinely hung push still fails eventually.
 */
export const LAND_PUSH_TIMEOUT_MS = 11 * 60 * 1000; // 11 min — exceeds the push-gate's ~10-min internal timeout
/**
 * Per-attempt wall clock for the pure recovery steps (`git fetch` / `git rebase`). These
 * do NOT run the pre-push gate, so a genuine network/git hang there should fail FAST and
 * feed the bounded retry — this is where the hung-subprocess protection actually applies.
 */
export const LAND_RECOVERY_TIMEOUT_MS = 120_000;
/** Default bound on fetch+rebase+re-push recovery attempts after a non-FF rejection. */
export const LAND_MAX_RETRIES = 3;

interface GitRun {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a git subprocess with a per-attempt timeout; a timeout is reported (never thrown). */
function runGitBounded(cwd: string, args: string[], timeoutMs: number): GitRun {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout, stderr: '', timedOut: false };
  } catch (err) {
    const e = err as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      killed?: boolean;
      signal?: string;
      code?: string;
    };
    // execFileSync kills a run that exceeds `timeout` (killed=true / SIGTERM / ETIMEDOUT).
    const timedOut = e.killed === true || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT';
    return {
      ok: false,
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      timedOut,
    };
  }
}

/**
 * Push `branch`'s commits to `origin/<defaultBranch>` (refspec `branch:defaultBranch`,
 * force-free, `--` end-of-options). On a non-fast-forward rejection: fetch
 * `origin <defaultBranch>` → rebase the branch onto `refs/remotes/origin/<defaultBranch>`
 * (LINEAR, no merge commit) → re-push, up to `maxRetries` times. A rebase CONFLICT →
 * `git rebase --abort` + `rebase-conflict`. A hung subprocess (per-attempt timeout) fails
 * THAT attempt and feeds the retry. A push-gate decline / auth / network rejection is a
 * real failure surfaced by class. NEVER force-pushes; the caller must have validated
 * `branch`/`defaultBranch` (assertSafeArg) — the argv also ends options with `--`.
 */
export function landBranchToOrigin(
  cwd: string,
  branch: string,
  defaultBranch: string,
  opts: { maxRetries?: number; pushTimeoutMs?: number; recoveryTimeoutMs?: number } = {},
): LandToOriginResult {
  const maxRetries = opts.maxRetries ?? LAND_MAX_RETRIES;
  // The push runs the pre-push gate so it needs the long budget; fetch/rebase do not.
  const pushTimeout = opts.pushTimeoutMs ?? LAND_PUSH_TIMEOUT_MS;
  const recoveryTimeout = opts.recoveryTimeoutMs ?? LAND_RECOVERY_TIMEOUT_MS;
  const refspec = `${branch}:${defaultBranch}`;
  const originRef = `refs/remotes/origin/${defaultBranch}`;

  // attempt 0 = the initial push; up to `maxRetries` fetch+rebase+re-push recoveries.
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const push = runGitBounded(cwd, ['push', 'origin', '--', refspec], pushTimeout);
    if (push.ok) return { status: 'landed', reason: '' };

    if (!push.timedOut) {
      const cls = classifyPushRejection(`${push.stderr}\n${push.stdout}`);
      if (cls === 'push-gate') {
        return { status: 'push-gate-rejected', reason: push.stderr || push.stdout };
      }
      if (cls === 'auth-network') {
        return { status: 'auth-or-network-failed', reason: push.stderr || push.stdout };
      }
    }
    // non-FF (or a hung push) → recover then retry, unless the retry budget is spent.
    if (attempt >= maxRetries) {
      return {
        status: 'non-ff-retry-exhausted',
        reason: push.stderr || push.stdout || 'push retries exhausted',
      };
    }
    const terminal = recoverForRetry(cwd, defaultBranch, originRef, recoveryTimeout);
    if (terminal) return terminal;
  }
  return { status: 'non-ff-retry-exhausted', reason: 'push retries exhausted' };
}

/**
 * One fetch+rebase recovery step before a re-push. Returns a TERMINAL result to stop
 * (a rebase conflict, or a non-timeout fetch failure), or null to proceed to the next
 * push attempt. A hung fetch/rebase (timeout) is aborted and returns null so the
 * retry loop continues rather than blocking. NEVER leaves a rebase in progress.
 */
function recoverForRetry(
  cwd: string,
  defaultBranch: string,
  originRef: string,
  timeout: number,
): LandToOriginResult | null {
  const fetched = runGitBounded(cwd, ['fetch', 'origin', '--', defaultBranch], timeout);
  if (!fetched.ok) {
    if (fetched.timedOut) return null; // hung fetch → feed the retry
    return { status: 'auth-or-network-failed', reason: fetched.stderr || fetched.stdout };
  }
  const rebased = runGitBounded(cwd, ['rebase', originRef], timeout);
  if (rebased.ok) return null; // rebased onto origin/<default> → retry the push
  runGitBounded(cwd, ['rebase', '--abort'], timeout); // best effort — never leave a rebase mid-flight
  if (rebased.timedOut) return null; // hung rebase (now aborted) → feed the retry
  // git writes CONFLICT (content) lines to STDOUT; keep both so the reason is populated.
  return { status: 'rebase-conflict', reason: `${rebased.stdout}\n${rebased.stderr}`.trim() };
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
