/**
 * event → IR reducer (increment #5, design §10-4b / F3 — OBJ-1/2/3).
 *
 * SoT events are immutable per-entity files; pending→approved (or reject /
 * supersede) is a NEW event carrying `supersedes` (§10-2 F2). So the CURRENT
 * state of a logical event is the HEAD of its supersedes chain, not a single
 * id. This reducer resolves those chains and keeps only approved heads, which
 * is what projection feeds into the IR/serving graph (without it, approval
 * state is invisible to query — OBJ-2).
 *
 * `setHash` (OBJ-3) is the sorted sha256 of the emitted approved head event_id
 * set — the freshness boundary. projection records it in the manifest; a later
 * `status` compares the current reduced-set hash against the recorded one to
 * decide fresh/stale (single `memory_event_until` is meaningless on a chain).
 *
 * Pure & deterministic: no clock, no IO, no input-order dependence.
 */
import { createHash } from 'node:crypto';
import type { MemoryEvent } from '~/schemas/memory-event';

export interface ReducedEvents {
  /** Approved head events (one per logical chain), sorted by event_id. */
  approvedHeads: MemoryEvent[];
  /** sha256 over the sorted approved head event_id set — the freshness boundary. */
  setHash: string;
}

/**
 * Resolve supersession chains to heads, keep only approved heads, and hash the
 * emitted set.
 *
 * Head = an event that no other event supersedes. `supersedes` points at the
 * PRIOR event, so the newest event in a chain is the one whose id appears in no
 * other event's `supersedes`. Each chain contributes at most one head; we emit
 * the head only when its status is `approved` (pending/rejected/superseded are
 * excluded — design §10-4b step 2).
 */
export function reduceEvents(events: MemoryEvent[]): ReducedEvents {
  // Ids that are superseded by some other event are not heads.
  const supersededIds = new Set<string>();
  for (const e of events) {
    if (e.supersedes) supersededIds.add(e.supersedes);
  }

  const approvedHeads = events
    .filter((e) => !supersededIds.has(e.event_id) && e.status === 'approved')
    .sort((a, b) => (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0));

  const setHash = createHash('sha256')
    .update(approvedHeads.map((e) => e.event_id).join('\n'))
    .digest('hex');

  return { approvedHeads, setHash };
}
