/**
 * WS0-T1 (wi_260706aka): the backlog projection layer.
 *
 * Recompute-on-read derivation (NO cache file — same shape as memory-project.ts:
 * pure functions do the shaping, a thin async wrapper does the IO). A backlog row
 * is the narrow `WorkItemSummary` widened with fields the backlog surface needs:
 * unresolved follow-up count, blocking reason, github issue coordinate, push-ready,
 * and the derived lineage/rollup marker.
 *
 * Enumeration is DUAL-BASE (WS0-T1 dual-base bridge): the committed Record tier
 * (`.ditto/work-items/`) UNION the legacy Run tier (`.ditto/local/work-items/`),
 * deduped by id — so `ditto work list` surfaces every active work item, not only the
 * migrated few (WS0-T4 migrates the legacy tier).
 *
 * Determinism (ac-5) is scoped to COMMITTED Records: a committed WI's fields derive
 * from its record.json folded with events/, never from the Run tier — so deleting the
 * Run tier and regenerating reproduces that committed row byte-for-byte. A legacy
 * Run-only item (never committed) legitimately disappears when the Run tier is wiped.
 *
 * Cost (required_edit 1): lineage/rollup + push-ready are computed ONCE over a single
 * backlog snapshot. `computeStemViews` builds the `follows` connected components in
 * one O(n) pass over the already-loaded map, and each row reads its stem off that
 * result — never calling the disk-reading `stem(id)` per row (which would be O(n²)
 * reads across N work items).
 */
import type { WorkItem } from '~/schemas/work-item';
import {
  WorkItemStore,
  type WorkItemSummary,
  blockingFollowUp,
  computeStemViews,
  pushReadiness,
} from './work-item-store';

/**
 * Pure projection: widen each loaded (committed) work item into a backlog row and
 * order by `updated_at` (newest first — same order as `list()`). Reuses the core
 * helpers (blockingFollowUp / pushReadiness / computeStemViews) so there is no second
 * copy of any rule. Takes the whole snapshot so the stem graph is built once.
 */
export function projectBacklogRows(items: readonly WorkItem[]): WorkItemSummary[] {
  const stems = computeStemViews(
    items.map((it) => ({
      id: it.id,
      status: it.status,
      created_at: it.created_at,
      ...(it.follows !== undefined ? { follows: it.follows } : {}),
    })),
  );
  const rows: WorkItemSummary[] = items.map((item) => {
    const stem = stems.get(item.id);
    const unresolved = (item.follow_ups ?? []).filter((f) => f.resolved !== true);
    const blocking = blockingFollowUp(item);
    const ready = pushReadiness(item, stem);
    return {
      id: item.id,
      title: item.title,
      status: item.status,
      updated_at: item.updated_at,
      unresolved_follow_ups: unresolved.length,
      ...(blocking !== undefined
        ? {
            blocking_reason: `unresolved self-caused ${blocking.severity}-severity ${blocking.kind}: "${blocking.note}"`,
          }
        : {}),
      ...(item.github_issue !== undefined
        ? { github_issue: { repo: item.github_issue.repo, number: item.github_issue.number } }
        : {}),
      push_ready: ready.ready,
      ...(stem !== undefined ? { lineage: stem } : {}),
    };
  });
  rows.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  return rows;
}

/**
 * Load the backlog once (DUAL-BASE) and project it. The ONLY IO here is
 * `listAll()` — the committed Record tier UNION the legacy Run tier, deduped by id —
 * so `ditto work list` surfaces EVERY active work item, not only the migrated few.
 * The shaping is pure and the stem graph is built once (O(n)).
 */
export async function projectBacklog(repoRoot: string): Promise<WorkItemSummary[]> {
  const store = new WorkItemStore(repoRoot);
  const items = await store.listAll();
  return projectBacklogRows(items);
}
