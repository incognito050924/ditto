import { formatCoord, parseCoord, type RepoCoord } from './coord';
import type { BacklogReader } from './gh';

/**
 * Layer 1 of the SoT 3-layer contract (ADR-20260628 D3): the backlog is READ
 * from GitHub, which owns it. This is a read-only projection — it fetches issues
 * through the injected reader and stamps each with its `owner/repo#n` coordinate
 * (D4). It never writes GitHub and never throws: a reader degradation or an
 * unparseable coordinate becomes a notice, never a failure (ADR-0018).
 */

export interface BacklogItem {
  coord: RepoCoord;
  /** The canonical `owner/repo#n` token — the linkage key. */
  coordString: string;
  title: string;
  state: 'open' | 'closed';
}

export interface BacklogView {
  items: BacklogItem[];
  notices: string[];
}

export function readBacklog(reader: BacklogReader): BacklogView {
  const read = reader.listIssues();
  if (!read.ok) {
    return {
      items: [],
      notices: [`Backlog read degraded (${read.reason}) — no issues fetched.`],
    };
  }
  const items: BacklogItem[] = [];
  const notices: string[] = [];
  for (const issue of read.value) {
    const coord = parseCoord(`${issue.repo}#${issue.number}`);
    if (coord === null) {
      notices.push(
        `Backlog: skipped an issue with an invalid coordinate (repo=${issue.repo}, number=${issue.number}).`,
      );
      continue;
    }
    items.push({
      coord,
      coordString: formatCoord(coord),
      title: issue.title,
      state: issue.state,
    });
  }
  return { items, notices };
}
