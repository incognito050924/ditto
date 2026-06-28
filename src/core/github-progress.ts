import type { WorkItem } from '~/schemas/work-item';
import {
  type AutopilotDecision,
  type AutopilotStore,
  isDecisivePost,
  synthesizeDecisionId,
} from './autopilot-store';
import type { GhClient } from './gh-client';
import { sanitizeFragment } from './github-redaction';
import type { WorkItemStore } from './work-item-store';

/**
 * G8 progress posting (wi_260628d79, ac-9/10/11/12). Posts autopilot decision-log
 * DECISIONS (not routine churn) to the linked GitHub issue, through ONE serialized
 * path shared by both writers — the autopilot DIRECT post (fired from recordResult)
 * and the manual `ditto work sync-issue` rollup — so a concurrent run cannot
 * lost-update `posted_decision_ids` into a duplicate comment.
 *
 * Idempotency rests on three load-bearing pre-mortem constraints:
 *   1. each decision gets a SYNTHESIZED id with a per-occurrence discriminator (its
 *      append-positional index) — two distinct same-content decisions get different
 *      ids (no under-post), a re-read of the same line gets the same id (dedups).
 *   2. the mark step re-reads the latest work item INSIDE the store mutator before
 *      writing, so a stale snapshot cannot clobber a concurrent writer's marks.
 *   3. the external-post -> local-mark sequence is non-atomic: the id is computed
 *      BEFORE posting and a pre-post check skips already-posted ids, so a
 *      post-success-then-mark-fail re-run does not double-post; on post FAILURE the
 *      marking is HELD (not written) so a later sync-issue rolls the decision up.
 *
 * Every gh failure degrades to a notice (ADR-0018) — it never throws, so a posting
 * failure can NOT affect the autopilot execution / completion path (ac-11).
 */

export interface ProgressDeps {
  client: GhClient;
  store: WorkItemStore;
  aps: AutopilotStore;
}

/** The resolved post target (ac-12): the issue to comment on, an optional child
 *  prefix, and the work item that OWNS the link (where posted_decision_ids lives). */
interface PostTarget {
  repo: string;
  number: number;
  /** `[<childId>] ` when posting a child's decisions to its parent's issue; else ''. */
  prefix: string;
  /** The WI whose github_issue carries posted_decision_ids for this issue. */
  link_owner_id: string;
}

export type PostDecisionsResult =
  | { kind: 'posted'; posted_ids: string[]; comment_count: 1; target: PostTarget }
  | { kind: 'no_new'; posted_ids: []; comment_count: 0; target: PostTarget }
  | { kind: 'skipped'; posted_ids: []; comment_count: 0; notice: string }
  | { kind: 'degraded'; posted_ids: []; comment_count: 1; target: PostTarget; notice: string };

/**
 * Resolve the post target for a work item's decisions (ac-12 child resolution):
 *   (1) own `github_issue` link FIRST (prefix '');
 *   (2) else the PARENT WI's issue with a `[<child>]` prefix;
 *   (3) else null -> skip (no link, ac-11/ac-12).
 */
async function resolveTarget(store: WorkItemStore, workItemId: string): Promise<PostTarget | null> {
  const item: WorkItem = await store.get(workItemId);
  if (item.github_issue) {
    return {
      repo: item.github_issue.repo,
      number: item.github_issue.number,
      prefix: '',
      link_owner_id: workItemId,
    };
  }
  if (item.parent_id) {
    const parent = await store.get(item.parent_id);
    if (parent.github_issue) {
      return {
        repo: parent.github_issue.repo,
        number: parent.github_issue.number,
        prefix: `[${workItemId}] `,
        link_owner_id: item.parent_id,
      };
    }
  }
  return null;
}

/** A short, human label for one decision line in the comment body. */
function decisionLabel(d: AutopilotDecision): string {
  const parts: string[] = [d.decision];
  if (d.disposition) parts.push(d.disposition);
  if (d.failure_class) parts.push(d.failure_class);
  return parts.join('/');
}

/** Build the ONE rollup comment body for the selected decisions (ac-9 single comment).
 *  The structure (heading, child prefix, ts, label) is allow-listed; the only free-text
 *  field — the decision `reason` — is routed through the redaction sanitizer (ac-15) so
 *  an internal absolute path / raw log / token in a reason never reaches a public issue. */
function buildProgressComment(
  workItemId: string,
  prefix: string,
  entries: { d: AutopilotDecision }[],
): string {
  const lines = [`## ${prefix}ditto: autopilot decisions — ${workItemId}`, ''];
  for (const { d } of entries) {
    lines.push(`- ${d.ts} · \`${decisionLabel(d)}\` — ${sanitizeFragment(d.reason)}`);
  }
  return lines.join('\n');
}

/**
 * Post every UNPOSTED decisive decision for `workItemId` to its target issue in ONE
 * comment and mark them. The single serialized writer both the autopilot direct-post
 * hook and `work sync-issue` route through.
 */
export async function postUnpostedDecisions(
  deps: ProgressDeps,
  workItemId: string,
): Promise<PostDecisionsResult> {
  // (3) no link on this WI nor its parent -> skip + notice (ac-11/ac-12), never error.
  const target = await resolveTarget(deps.store, workItemId);
  if (!target) {
    return {
      kind: 'skipped',
      posted_ids: [],
      comment_count: 0,
      notice: `${workItemId} has no linked GitHub issue (own or parent) — progress post skipped.`,
    };
  }

  // (2) re-read the link OWNER for the freshest posted_decision_ids before selecting.
  const linkOwner = await deps.store.get(target.link_owner_id);
  const postedSet = new Set(linkOwner.github_issue?.posted_decision_ids ?? []);

  // (1) synthesize a per-occurrence id for every decision-log entry (index = the
  // append-positional discriminator), then keep only DECISIVE, not-yet-posted ones.
  const decisions = await deps.aps.readDecisions(workItemId);
  const unposted = decisions
    .map((d, i) => ({ d, id: synthesizeDecisionId(d, i) }))
    .filter(({ d, id }) => isDecisivePost(d) && !postedSet.has(id));
  if (unposted.length === 0) {
    return { kind: 'no_new', posted_ids: [], comment_count: 0, target };
  }

  // (3) compute ids BEFORE posting; post ONE rollup comment (reasons redacted, ac-15).
  const body = buildProgressComment(workItemId, target.prefix, unposted);
  const res = deps.client.issueComment(target.repo, target.number, body);
  if (!res.ok) {
    // HOLD the marking: do NOT write posted ids, so a later sync-issue rolls them up.
    return {
      kind: 'degraded',
      posted_ids: [],
      comment_count: 1,
      target,
      notice: `issue comment degraded (${res.reason}) — decisions held for a later sync, not marked.`,
    };
  }

  // Mark AFTER a confirmed post; the mutator re-reads `cur` (the latest on-disk work
  // item) and SET-MERGES, so a concurrent writer's marks are never clobbered (2).
  const newIds = unposted.map((u) => u.id);
  await deps.store.update(target.link_owner_id, (cur) => {
    const gi = cur.github_issue;
    if (!gi) return cur; // defensive: link resolved through it, so this never fires
    const merged = new Set([...(gi.posted_decision_ids ?? []), ...newIds]);
    return { ...cur, github_issue: { ...gi, posted_decision_ids: [...merged] } };
  });
  return { kind: 'posted', posted_ids: newIds, comment_count: 1, target };
}
