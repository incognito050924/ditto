/**
 * Low-level GitHub repo-coordinate helpers (wi_2607147jb — relocated from the work
 * command layer to break a core → cli layering inversion). Pure string / payload
 * predicates over owner/repo coordinates and Projects v2 board items, with NO gh
 * subprocess and NO store dependency — so both the CLI command layer and the
 * completion-reflection core (github-reflection.ts) import them DOWNWARD.
 */

/**
 * Canonical form of an owner/repo coordinate for the cross-repo guard (ac-13
 * BINDING). GitHub owner/name are case-insensitive; we strip a trailing `.git`
 * and surrounding space, then lowercase — so a non-canonical parse (mixed case, a
 * `.git` suffix from a remote URL) can NOT weaken the guard by making a foreign
 * repo compare unequal-yet-execute, nor the rooted repo compare equal-yet-skip.
 */
export function canonicalizeRepo(repo: string): string {
  return repo
    .trim()
    .replace(/\.git$/i, '')
    .toLowerCase();
}

/** True iff two owner/repo coordinates name the same repo (canonical compare). */
export function sameRepoCoord(a: string, b: string): boolean {
  return canonicalizeRepo(a) === canonicalizeRepo(b);
}

/** Derive the rooted repo's owner/name from `git remote get-url origin`; null when
 *  there is no origin / not a git tree (the pull guard then fails closed). */
export function parseRemoteUrlToRepo(url: string): string | null {
  const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * True iff a `gh project item-list` item is the card for (issueNumber, linkedRepo).
 * A Projects v2 board can hold cards from MULTIPLE repos, so an issue `number` alone
 * is ambiguous (two repos can each own issue #20). The REAL payload carries the owning
 * repo at the ITEM TOP LEVEL as a URL string (`item.repository = https://github.com/
 * owner/name`); `content` holds only number/title/type. So we normalize the URL to
 * owner/name (`parseRemoteUrlToRepo`) BEFORE the canonical repo compare — the raw URL
 * would not match owner/name. An absent / non-string / unparseable `repository`
 * (empty, bare host, already-normalized owner/name → parseRemoteUrlToRepo null) can
 * NOT be identified by repo, so it does NOT match: skip it — never a number-only
 * fallback, never a throw (ADR-0018 best-effort). Reused by the board read in
 * `parseBoardPosition` (cli) and the completion-reflection board read
 * (github-reflection.ts), not a duplicate.
 */
export function boardItemMatchesRepoNumber(
  item: unknown,
  issueNumber: number,
  linkedRepo: string,
): boolean {
  const content = (item as { content?: { number?: unknown } })?.content;
  if (!content || (content as { number?: unknown }).number !== issueNumber) return false;
  const repository = (item as { repository?: unknown }).repository;
  if (typeof repository !== 'string') return false;
  const normalizedRepo = parseRemoteUrlToRepo(repository);
  if (normalizedRepo === null) return false;
  return sameRepoCoord(normalizedRepo, linkedRepo);
}
