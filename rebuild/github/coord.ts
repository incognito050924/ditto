/**
 * The `owner/repo#n` GitHub coordinate — the single identity that unifies self /
 * cross-repo backlog items (ADR-20260628-github-backlog-sot D4). Pure string
 * predicates: NO gh subprocess, NO store dependency, so every layer below
 * (backlog read, work-item linkage, completion mirror) imports them DOWNWARD.
 */

/** A GitHub issue coordinate: `repo` is the `owner/name` pair, `number` the issue #. */
export interface RepoCoord {
  /** `owner/name` (e.g. `octo/app`). */
  repo: string;
  /** The issue number (positive integer). */
  number: number;
}

/**
 * Parse an `owner/repo#n` token. Returns null on any malformed token — a slashless
 * repo, a missing/non-decimal number, an extra path segment, or embedded `#`/space —
 * so a bad coordinate can never masquerade as a real one.
 */
export function parseCoord(raw: string): RepoCoord | null {
  const m = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(raw.trim());
  if (!m) return null;
  return { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
}

/** Render a coordinate back to its `owner/repo#n` token (inverse of parseCoord). */
export function formatCoord(coord: RepoCoord): string {
  return `${coord.repo}#${coord.number}`;
}

/**
 * Canonical form of an `owner/name` repo for identity compares. GitHub owner/name
 * are case-insensitive; strip a trailing `.git` (from a remote URL) and surrounding
 * space, then lowercase — so a non-canonical spelling can NOT make the same repo
 * compare unequal.
 */
export function canonicalizeRepo(repo: string): string {
  return repo.trim().replace(/\.git$/i, '').toLowerCase();
}

/** True iff two `owner/name` coordinates name the same repo (canonical compare). */
export function sameRepoCoord(a: string, b: string): boolean {
  return canonicalizeRepo(a) === canonicalizeRepo(b);
}
