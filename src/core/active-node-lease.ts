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
    created_at: isoDateTime,
  })
  .describe('One in-flight autopilot node lease');

export type ActiveNodeLease = z.infer<typeof activeNodeLease>;

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

  /** All active leases for the work item ([] when none / unreadable). */
  async listActive(workItemId: string): Promise<ActiveNodeLease[]> {
    try {
      return (await readJson(this.path(workItemId), leaseFile)).leases;
    } catch {
      return [];
    }
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
