/**
 * Code↔SoT freshness detection (ADR-0015). Two axes:
 *   - axis-1 (SoT↔derived): the projection's set hash moved, or a source's
 *     captured content_hash moved (`dirty_sources`) ⇒ `stale`.
 *   - axis-2 (code↔SoT): an owning repo's HEAD diverged from the git_commit the
 *     source was captured at ⇒ `code_drift`; the owning tree is dirty ⇒
 *     `code_dirty`.
 * Priority (intentional): code_drift > stale > code_dirty > fresh. code_drift
 * (HEAD diverged = memory built from other code) is the worst trust defect;
 * stale MUST outrank code_dirty, because the dev tree is almost always dirty and
 * a dirty label must never mask a stale projection. A non-git source (no
 * git_commit, e.g. a snapshot) drifts by content_hash move only — it never
 * raises code_drift/code_dirty. This is a PURE decision function: the real git
 * signals (HEAD, porcelain) are injected so the priority logic is deterministic.
 */

export type Freshness = 'fresh' | 'stale' | 'absent' | 'code_drift' | 'code_dirty';

export interface SourceRevision {
  source_id: string;
  /** Owning repo, root-relative ('.'); groups sources for per-repo git signals. */
  repo?: string;
  /** content_hash at capture time (drives axis-1 dirty_sources). */
  hash: string;
  /** Commit the source was captured at; absent for non-git (snapshot) sources. */
  git_commit?: string;
}

export interface CurrentSource {
  source_id: string;
  repo?: string;
  content_hash: string;
}

export interface FreshnessInput {
  manifest: { serving_version: string; source_revisions: SourceRevision[] } | null;
  currentSetHash: string;
  currentSources: CurrentSource[];
  /** Injected: current HEAD of an owning repo, or null when unresolvable. */
  headOf: (repo: string) => string | null;
  /** Injected: whether an owning repo's working tree is dirty. */
  isDirty: (repo: string) => boolean;
}

export interface FreshnessResult {
  freshness: Freshness;
  dirty_sources: string[];
  drifted_sources: string[];
  drifted_repos: string[];
}

function repoOf(s: { repo?: string }): string {
  return s.repo ?? '.';
}

export function detectFreshness(input: FreshnessInput): FreshnessResult {
  if (input.manifest === null) {
    return { freshness: 'absent', dirty_sources: [], drifted_sources: [], drifted_repos: [] };
  }

  const revs = input.manifest.source_revisions;
  const currentHash = new Map(input.currentSources.map((s) => [s.source_id, s.content_hash]));

  // axis-1: a source whose captured content_hash no longer matches the current one.
  const dirty_sources = revs
    .filter((r) => {
      const now = currentHash.get(r.source_id);
      return now !== undefined && now !== r.hash;
    })
    .map((r) => r.source_id)
    .sort();
  const setHashMoved = input.manifest.serving_version !== input.currentSetHash;
  const stale = setHashMoved || dirty_sources.length > 0;

  // axis-2: per owning repo, HEAD divergence ⇒ code_drift; dirty tree ⇒ code_dirty.
  // Only git-backed sources (with a git_commit) participate.
  const repos = [...new Set(revs.map(repoOf))].sort();
  const driftedRepos = new Set<string>();
  let anyDirty = false;
  for (const repo of repos) {
    const gitRevs = revs.filter((r) => repoOf(r) === repo && r.git_commit !== undefined);
    if (gitRevs.length === 0) continue;
    const head = input.headOf(repo);
    if (head !== null && gitRevs.some((r) => r.git_commit !== head)) {
      driftedRepos.add(repo);
    }
    if (input.isDirty(repo)) anyDirty = true;
  }
  const drifted_sources = revs
    .filter((r) => driftedRepos.has(repoOf(r)))
    .map((r) => r.source_id)
    .sort();
  const drifted_repos = [...driftedRepos].sort();

  const freshness: Freshness =
    driftedRepos.size > 0 ? 'code_drift' : stale ? 'stale' : anyDirty ? 'code_dirty' : 'fresh';

  return { freshness, dirty_sources, drifted_sources, drifted_repos };
}
