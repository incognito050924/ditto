/**
 * ⑧ Tidy commit (80-plan §6/§8, ADR-0017 D8). When a tidy item meets the §4.4
 * bar, the structural change is committed AUTOMATICALLY — but only on an ISOLATED
 * branch and NEVER pushed. Local commits are reversible (git reset/revert), so
 * with push forbidden the irreversibility risk is low; pushing is intentionally
 * absent here (D8 — push 절대 금지).
 */
export interface TidyCommitInput {
  repoRoot: string;
  /** Isolated branch the tidy commits accumulate on (never main, never pushed). */
  branch: string;
  /** Repo-relative paths to stage (the tidy diff). */
  files: string[];
  /** Commit message — the caller marks it structural (Tidy First). */
  message: string;
}

export interface TidyCommitResult {
  committed: boolean;
  branch: string;
  sha: string | null;
  reason?: string;
}

function git(repoRoot: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(['git', ...args], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
  return {
    code: r.exitCode,
    stdout: r.stdout?.toString() ?? '',
    stderr: r.stderr?.toString() ?? '',
  };
}

/**
 * Create or switch to the isolated branch, stage exactly `files`, and make one
 * structural commit. No push. Returns committed=false (not an error) when nothing
 * is staged, so an empty tidy never produces an empty commit.
 */
export function commitTidyStructural(input: TidyCommitInput): TidyCommitResult {
  const { repoRoot, branch, files, message } = input;

  const exists =
    git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).code === 0;
  const checkout = exists
    ? git(repoRoot, ['checkout', branch])
    : git(repoRoot, ['checkout', '-b', branch]);
  if (checkout.code !== 0) {
    return {
      committed: false,
      branch,
      sha: null,
      reason: `checkout failed: ${checkout.stderr.trim()}`,
    };
  }

  if (files.length > 0) {
    const add = git(repoRoot, ['add', '--', ...files]);
    if (add.code !== 0) {
      return { committed: false, branch, sha: null, reason: `add failed: ${add.stderr.trim()}` };
    }
  }

  // Nothing staged → no empty commit (an empty tidy is a no-op, not a failure).
  if (git(repoRoot, ['diff', '--cached', '--name-only']).stdout.trim().length === 0) {
    return { committed: false, branch, sha: null, reason: 'nothing staged to commit' };
  }

  const commit = git(repoRoot, ['commit', '-m', message]);
  if (commit.code !== 0) {
    return {
      committed: false,
      branch,
      sha: null,
      reason: `commit failed: ${commit.stderr.trim()}`,
    };
  }
  // Intentionally NEVER pushes (D8). The isolated branch is reviewed as a PR.
  const sha = git(repoRoot, ['rev-parse', 'HEAD']).stdout.trim();
  return { committed: true, branch, sha };
}
