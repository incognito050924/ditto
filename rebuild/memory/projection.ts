import { createHash } from 'node:crypto';

import type { MemoryEvent } from '../schemas/memory-event';
import { reduceEvents } from './reduce';

/**
 * Read-visibility is ONE rule shared by every runtime read surface (projection
 * and query alike): expose only APPROVED chain heads whose sensitivity is not
 * `secret` (ADR-0013 round-2 R1 — "same rule, different index"). A secret head
 * never leaves the SoT into a projection; a pending or superseded event is
 * never visible.
 */
export function visibleHeads(events: MemoryEvent[]): MemoryEvent[] {
  return reduceEvents(events).approvedHeads.filter((e) => e.sensitivity !== 'secret');
}

/** One node in the serving projection — a visible head surfaced for reading/serving. */
export interface ProjectionNode {
  event_id: string;
  event_type: MemoryEvent['event_type'];
  /** The event's text — for decision events seeded from ADRs this is the adrGist served upstream. */
  text: string;
}

export interface MemoryProjection {
  projection_id: string;
  generated_at: string;
  set_hash: string;
  nodes: ProjectionNode[];
}

/**
 * Build the serving projection from the event log: reduce to visible heads and
 * expose them as serving nodes. `projection_id` is a pure function of the
 * visible head set (via set_hash), so an unchanged head set yields an unchanged
 * id regardless of input order. `now` is an injectable clock seam.
 */
export function projectMemory(
  events: MemoryEvent[],
  options: { now?: Date } = {},
): MemoryProjection {
  const heads = visibleHeads(events);
  const setHash = createHash('sha256')
    .update(heads.map((e) => e.event_id).join('\n'))
    .digest('hex');
  const projectionId = `proj_${createHash('sha256').update(setHash).digest('hex').slice(0, 12)}`;
  const now = options.now ?? new Date();
  return {
    projection_id: projectionId,
    generated_at: now.toISOString(),
    set_hash: setHash,
    nodes: heads.map((e) => ({ event_id: e.event_id, event_type: e.event_type, text: e.text })),
  };
}
