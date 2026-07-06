import { join } from 'node:path';
import { z } from 'zod';
import { isoDateTime, relativePath, workItemId } from '~/schemas/common';
import { localDir } from './ditto-paths';
import { ensureDir, readJson, writeJson } from './fs';

/**
 * Active-node lease (wi_26060678y) — the FLOW-enforcement primitive behind
 * "autopilot 경로 강제". A lease exists for exactly as long as one autopilot node
 * is dispatched (running): next-node creates it on pending→running, record-result
 * removes it on every terminal transition. PreToolUse reads the active leases for
 * the session's work item and ALLOWS an edit only when its path falls inside some
 * active lease's `file_scope` (an allow-list), blocking out-of-scope edits.
 *
 * This is NOT spawn proof — PreToolUse cannot observe subagent spawn; the lease is
 * the observable signal that "a node with this scope is in flight" (SKILL.md:33).
 *
 * Keyed by `node_id` (per work item) so removal at record-result is a direct
 * lookup and a leaked lease cannot accumulate. Co-located with the graph under
 * `.ditto/local/work-items/<wi>/active-leases.json`, so PreToolUse needs only the
 * work_item_id (resolved session→work_item via SessionPointerStore) to read it —
 * the lease never needs a session_id, which next-node does not have.
 */
export const activeNodeLease = z
  .object({
    node_id: z.string().min(1),
    work_item_id: workItemId,
    file_scope: z.array(relativePath),
    // Scope provenance (wi_260610iex): `declared` = the node's own file_scope —
    // an intent the hook may enforce as an allow-list. `derived` = the dispatch
    // fallback (workItem.changed_files) — a concurrency heuristic that does NOT
    // describe what the node may write, so the hook must not block on it.
    // Default `declared` keeps pre-provenance lease files enforcing as before.
    scope_source: z.enum(['declared', 'derived']).default('declared'),
    created_at: isoDateTime,
  })
  .describe('One in-flight autopilot node lease');

export type ActiveNodeLease = z.infer<typeof activeNodeLease>;

/**
 * A lease older than this (by its `created_at`) is treated as leaked and reaped on
 * read (WS-HND-T3, wi_260706kdx). A lease is supposed to live only for one node's
 * dispatch (seconds-to-minutes); record-result removes it on every terminal
 * transition. But a node that dies without that removal leaves a lease PreToolUse
 * keeps honoring as an allow-list forever. 24h is deliberately generous — far
 * beyond any real node runtime — so a live lease is NEVER reaped; only a truly
 * abandoned one is.
 */
const LEAKED_LEASE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a lease is a leaked one to reap. Content-safe: an unparseable / non-finite
 * `created_at` yields an unknown age, so we PRESERVE it (never reap on unknown age).
 */
function isLeaked(lease: ActiveNodeLease, now: number): boolean {
  const createdMs = Date.parse(lease.created_at);
  if (Number.isNaN(createdMs)) return false; // unknown age → safe-preserve
  return now - createdMs > LEAKED_LEASE_MAX_AGE_MS;
}

const leaseFile = z
  .object({
    schema_version: z.literal('0.1.0'),
    leases: z.array(activeNodeLease).default([]),
  })
  .describe('Active-node leases for one work item (node_id → lease map, as a list)');

export class ActiveNodeLeaseStore {
  constructor(public readonly repoRoot: string) {}

  private dir(workItemId: string): string {
    return localDir(this.repoRoot, 'work-items', workItemId);
  }

  private path(workItemId: string): string {
    return join(this.dir(workItemId), 'active-leases.json');
  }

  /**
   * All active leases for the work item ([] when none / unreadable).
   *
   * Reap-on-read (WS-HND-T3, wi_260706kdx): a leaked lease (owning node died
   * without record-result's removeByNode) older than LEAKED_LEASE_MAX_AGE_MS is
   * filtered out so PreToolUse stops honoring its allow-list. Only when something
   * was actually reaped is the pruned list written back — the common no-stale path
   * stays read-only. Keeps the []-on-unreadable fail-open.
   */
  async listActive(workItemId: string): Promise<ActiveNodeLease[]> {
    let leases: ActiveNodeLease[];
    try {
      leases = (await readJson(this.path(workItemId), leaseFile)).leases;
    } catch {
      return [];
    }
    const now = Date.now();
    const live = leases.filter((l) => !isLeaked(l, now));
    if (live.length !== leases.length) {
      try {
        await writeJson(this.path(workItemId), leaseFile, {
          schema_version: '0.1.0',
          leases: live,
        });
      } catch {
        // best-effort: a failed prune-write just leaves the file for a later read
      }
    }
    return live;
  }

  /** Create or replace the lease for a node (keyed by node_id). */
  async set(lease: ActiveNodeLease): Promise<void> {
    await ensureDir(this.dir(lease.work_item_id));
    const current = await this.listActive(lease.work_item_id);
    const next = [...current.filter((l) => l.node_id !== lease.node_id), lease];
    await writeJson(this.path(lease.work_item_id), leaseFile, {
      schema_version: '0.1.0',
      leases: next,
    });
  }

  /** Remove the lease for a node on its terminal transition (idempotent). */
  async removeByNode(workItemId: string, nodeId: string): Promise<void> {
    const current = await this.listActive(workItemId);
    const next = current.filter((l) => l.node_id !== nodeId);
    if (next.length === current.length) return;
    await ensureDir(this.dir(workItemId));
    await writeJson(this.path(workItemId), leaseFile, {
      schema_version: '0.1.0',
      leases: next,
    });
  }
}
