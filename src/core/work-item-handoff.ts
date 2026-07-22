import { existsSync } from 'node:fs';
import { containScopePath } from './coverage-oracle';

/**
 * changed_files collection survivors of the `work done` close path.
 *
 * The handoff writer that used to live here (`writeWorkItemHandoff` + its
 * private completion builder, the `ditto work handoff` engine) was REMOVED
 * (wi_260722g7h ac-split): handoff issuance is severed from scoring/closure,
 * handoffs are strictly user-initiated, and the completion build +
 * done/partial transition live exclusively on the `work done` path
 * (completion-store.ts `assembleCompletionFromWorkItem` / autopilot-complete.ts
 * for the graph path). What remains here is the deterministic changed_files
 * machinery `work done` (and the semantic surfaces) still consume.
 */

/**
 * Try a list of refs in order and return the first one git understands.
 * Returns null when none are valid.
 */
export function pickBaseRef(repoRoot: string, candidates: string[]): string | null {
  for (const ref of candidates) {
    const proc = Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode === 0) return ref;
  }
  return null;
}

export interface CollectedChanges {
  /**
   * The DETERMINISTIC changed_files set: the committed `base...HEAD` diff ∪ the
   * caller's explicit declaration. The whole-working-tree scan is NOT a source
   * (wi_260719ayc) — foreign/uncommitted dirt can never pollute this set.
   */
  files: string[];
  /**
   * The committed `git diff` exited non-zero — env breakage (shallow clone /
   * unresolvable merge-base), NOT a clean empty diff. The caller must fail-closed
   * on this rather than treat it as "no files changed" (wi_260719ayc ac-(c)).
   */
  diffErrored: boolean;
  /**
   * GUARD, not a source: *tracked* working-tree edits that fall OUTSIDE
   * (committed diff ∪ declared ∪ started_untracked_baseline). Their presence means
   * real uncommitted, undeclared work — the caller fail-closes on it so a partial
   * under-commit (committed A + uncommitted-undeclared tracked B) cannot close
   * pass. These paths are NEVER folded into `files` — that would re-pollute
   * changed_files, the exact bug this module fixes. Only meaningful for a live
   * HEAD (`head === null`); untracked (`??`) dirt is excluded (it is not a tracked
   * edit and is exactly what must not gate).
   */
  extraTrackedDirt: string[];
}

/**
 * Sanitize an untrusted list of declared repo-relative paths (the `--changed`
 * input) by REUSING `containScopePath` (rejects absolute / `..`-escaping /
 * repoRoot-escape / git pathspec-magic like `:(exclude)`), COMPOSED with: reject a
 * leading `-` (option-injection defense-in-depth — these paths reach `git add` as
 * positional args), reject empty/whitespace-only tokens, dedup, and SKIP paths that
 * do not exist under the repo (dropped, not hard-rejected — a bad token is a hard
 * reject the caller surfaces, a merely-missing path is silently ignored). One
 * sanitizer, not a 4th ad-hoc filter (wi_260719ayc ac-(C)).
 */
export function sanitizeDeclaredPaths(
  raw: readonly string[],
  repoRoot: string,
): { accepted: string[]; rejected: { path: string; reason: string }[] } {
  const accepted = new Set<string>();
  const rejected: { path: string; reason: string }[] = [];
  for (const token of raw) {
    const trimmed = token.trim();
    if (trimmed.length === 0) {
      rejected.push({ path: token, reason: 'empty/whitespace-only token' });
      continue;
    }
    if (trimmed.startsWith('-')) {
      rejected.push({ path: token, reason: 'leading `-` (option-injection) rejected' });
      continue;
    }
    const contained = containScopePath(trimmed, repoRoot);
    if (!contained.ok) {
      rejected.push({ path: token, reason: contained.detail });
      continue;
    }
    // Skip a declared path that does not exist under the repo (dropped silently —
    // e.g. a typo; a genuine deletion simply is not carried in changed_files).
    if (!existsSync(contained.abs)) continue;
    accepted.add(trimmed);
  }
  return { accepted: Array.from(accepted), rejected };
}

/**
 * Collect the DETERMINISTIC changed_files set from the committed `base...HEAD` diff
 * ∪ the caller's `declared` paths (already sanitized). The whole-working-tree
 * `git status` scan is NO LONGER a source (wi_260719ayc) — in a shared tree it made
 * foreign uncommitted dirt indistinguishable from this work's edits. The tree is
 * consulted only as a GUARD (`extraTrackedDirt`) to fail-closed on uncommitted,
 * undeclared tracked work. If `head` is an explicit ref, the working tree is not
 * consulted at all — the caller is asking about a frozen commit range.
 */
export function collectChangedFiles(
  repoRoot: string,
  base: string | null,
  head: string | null,
  // #36 (wi_260713u4k): the run's `started_untracked_baseline` — untracked (`??`) dirt
  // that predated this run. Still excluded (defensively) from the deterministic set and
  // from the guard, though with the scan removed nothing untracked reaches `files` anyway.
  baseline: readonly string[] = [],
  declared: readonly string[] = [],
): CollectedChanges {
  const excluded = new Set(baseline);
  const set = new Set<string>();
  let diffErrored = false;
  if (base !== null) {
    const headSpec = head ?? 'HEAD';
    const diff = Bun.spawnSync(
      ['git', 'diff', '--name-only', '--diff-filter=ACMR', `${base}...${headSpec}`],
      { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' },
    );
    if (diff.exitCode === 0) {
      const text = diff.stdout?.toString() ?? '';
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (t.length > 0) set.add(t);
      }
    } else {
      // (c) A non-zero `git diff` is env breakage (shallow clone / unresolvable
      // merge-base), NOT a clean empty diff — surface it so the caller fails closed
      // instead of silently reporting "no files changed".
      diffErrored = true;
    }
  }
  // Declared paths are an explicit SOURCE (symmetric with the autopilot owner-report).
  for (const p of declared) set.add(p);

  const files = Array.from(set).filter(
    (p) => !p.startsWith('/') && !p.includes('..') && !excluded.has(p),
  );

  // (b) Working tree as a GUARD, not a source. head이 명시되면 working tree status는
  // 의미 없음 (과거 commit 범위 정정 시나리오).
  const extraTrackedDirt: string[] = [];
  if (head === null) {
    const status = Bun.spawnSync(['git', 'status', '--porcelain'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (status.exitCode === 0) {
      const known = new Set(files);
      const text = status.stdout?.toString() ?? '';
      for (const line of text.split('\n')) {
        if (line.length === 0) continue;
        // `??` untracked / `!!` ignored: NOT a tracked edit → not mutation evidence.
        const code = line.slice(0, 2);
        if (code === '??' || code === '!!') continue;
        // porcelain line format: XY <path>  or  XY <orig> -> <new>
        const trimmed = line.replace(/^..\s*/, '').trim();
        if (trimmed.length === 0) continue;
        const arrow = trimmed.indexOf(' -> ');
        const path = arrow === -1 ? trimmed : trimmed.slice(arrow + 4);
        if (path.startsWith('/') || path.includes('..')) continue;
        if (known.has(path) || excluded.has(path)) continue;
        extraTrackedDirt.push(path);
      }
    }
  }
  return { files, diffErrored, extraTrackedDirt };
}
