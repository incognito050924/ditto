import { setGithubLink, type GithubLinkInput } from '../record/store';
import type { WorkItemRecord } from '../schemas/work-item-record';
import type { RepoCoord } from './coord';

/**
 * Layer 2 of the SoT 3-layer contract (ADR-20260628 D3): the issue↔work-item
 * linkage. The work-item side is the record store (dep A3) — this module is the
 * thin adapter that binds a GitHub coordinate onto a Record and recovers it. No
 * gh access lives here; linkage is pure local state.
 */

/** Bind `coord` onto work item `wiId`'s Record. Returns the updated Record. */
export function linkIssue(
  repoRoot: string,
  wiId: string,
  coord: GithubLinkInput,
): Promise<WorkItemRecord> {
  return setGithubLink(repoRoot, wiId, coord);
}

/**
 * Recover the linked `owner/repo#n` coordinate from a Record, or null when the
 * item is unlinked or the link is incomplete (repo or number missing — the
 * placeholder github field allows either alone).
 */
export function getLinkedCoord(record: WorkItemRecord): RepoCoord | null {
  const gh = record.github;
  if (!gh || gh.repo === undefined || gh.number === undefined) return null;
  return { repo: gh.repo, number: gh.number };
}
