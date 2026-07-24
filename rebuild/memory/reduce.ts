import { createHash } from 'node:crypto';

import type { MemoryEvent } from '../schemas/memory-event';

/**
 * Resolve the current approved-head set from an immutable event log via the
 * supersedes chain (ADR-0013 D3/R3). A supersedes edge only takes effect when
 * the superseding event is EFFECTIVE — itself approved, or transitively
 * superseded by an approved event. Without this, a pending or rejected
 * correction would silently retract an approved fact; the §4-5 symmetry is that
 * pending events can neither ADD (only approved events are heads) nor REMOVE
 * (only an effective superseder retracts) a fact.
 *
 * A head is an event that no OTHER effective event supersedes. `approvedHeads`
 * keeps only the approved heads (what projections serve). `setHash` is the
 * sha256 of the sorted head id set — the freshness boundary key.
 */

export interface ReduceResult {
  approvedHeads: MemoryEvent[];
  setHash: string;
}

export function reduceEvents(events: MemoryEvent[]): ReduceResult {
  // byTarget[x] = events whose `supersedes` points at x (the events that supersede x).
  const byTarget = new Map<string, MemoryEvent[]>();
  for (const e of events) {
    if (e.supersedes !== undefined) {
      const bucket = byTarget.get(e.supersedes) ?? [];
      bucket.push(e);
      byTarget.set(e.supersedes, bucket);
    }
  }

  // effective(e): e contributes to the chain's outcome — it is approved, or some
  // event that supersedes it is effective. Memoized with an in-progress guard so
  // a supersedes cycle terminates (a node still being computed counts as false).
  const memo = new Map<string, boolean>();
  const inProgress = new Set<string>();
  function effective(e: MemoryEvent): boolean {
    const cached = memo.get(e.event_id);
    if (cached !== undefined) return cached;
    if (inProgress.has(e.event_id)) return false;
    inProgress.add(e.event_id);
    const result =
      e.status === 'approved' ||
      (byTarget.get(e.event_id) ?? []).some((f) => effective(f));
    inProgress.delete(e.event_id);
    memo.set(e.event_id, result);
    return result;
  }

  // A head is superseded by no effective event.
  const heads = events.filter(
    (e) => !(byTarget.get(e.event_id) ?? []).some((f) => effective(f)),
  );
  const approvedHeads = heads
    .filter((e) => e.status === 'approved')
    .sort((a, b) => (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0));

  const setHash = createHash('sha256')
    .update(approvedHeads.map((e) => e.event_id).join('\n'))
    .digest('hex');

  return { approvedHeads, setHash };
}
