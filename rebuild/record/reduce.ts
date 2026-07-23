import type { Evidence } from '../schemas/evidence';
import type { Verdict } from '../schemas/verdict';
import {
  isTerminalStatus,
  type WorkItemStatus,
} from '../schemas/work-item-record';
import type { WorkItemEvent } from './events';

/**
 * Deterministic fold over the immutable event log.
 *
 * Ordering is (seq, actor, event_id) — wall-clock `ts` is NEVER a sort key, so
 * two replicas that hold the same event set always reduce to the same state.
 * Duplicate `event_id`s (e.g. a retried append merged from another checkout)
 * apply once.
 *
 * Status fold is latest-wins EXCEPT terminal-first-wins: done/abandoned are
 * exclusive — once a terminal status lands, a competing second terminal is
 * ignored. A non-terminal transition after terminal DOES apply: that is the
 * one legitimate exit (reopen), and it drops `closed_at`.
 */

export interface ReducedCriterionVerdict {
  verdict: Verdict;
  evidence: Evidence[];
}

export interface ReducedState {
  status: WorkItemStatus | null;
  closed_at: string | null;
  verdicts: Record<string, ReducedCriterionVerdict>;
}

function compareEvents(a: WorkItemEvent, b: WorkItemEvent): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (a.actor !== b.actor) return a.actor < b.actor ? -1 : 1;
  if (a.event_id !== b.event_id) return a.event_id < b.event_id ? -1 : 1;
  return 0;
}

export function reduceEvents(events: WorkItemEvent[]): ReducedState {
  const seen = new Set<string>();
  const ordered = [...events]
    .sort(compareEvents)
    .filter((e) => !seen.has(e.event_id) && seen.add(e.event_id));

  const state: ReducedState = { status: null, closed_at: null, verdicts: {} };
  for (const event of ordered) {
    if (event.kind === 'status') {
      const alreadyTerminal =
        state.status !== null && isTerminalStatus(state.status);
      if (alreadyTerminal && isTerminalStatus(event.payload.to)) {
        continue; // terminal-first-wins: competing second terminal ignored
      }
      state.status = event.payload.to;
      state.closed_at = event.payload.closed_at ?? null;
    } else {
      state.verdicts[event.payload.criterion_id] = {
        verdict: event.payload.verdict,
        evidence: event.payload.evidence,
      };
    }
  }
  return state;
}
