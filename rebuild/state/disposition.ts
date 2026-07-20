import type { QueueState, QueueStateItem } from './queue-state';

export interface DispositionGap {
  id: string;
  reason: string;
}

export interface DispositionCompleteness {
  complete: boolean;
  gaps: DispositionGap[];
}

const isMissing = (value: string | null): boolean =>
  value === null || value.trim().length === 0;

function itemGap(item: QueueStateItem): DispositionGap | null {
  if (item.exit === null) {
    return { id: item.id, reason: 'still open (no disposition)' };
  }
  if (item.exit === 'resolved' && isMissing(item.evidence_ref)) {
    return { id: item.id, reason: 'resolved without evidence' };
  }
  if (
    (item.exit === 'new-scope-deferral' || item.exit === 'escape') &&
    isMissing(item.disposition_note)
  ) {
    return {
      id: item.id,
      reason: `routed to ${item.exit} without disposition_note`,
    };
  }
  return null;
}

/**
 * §5 disposition-completeness gate. Beyond pending==0: every item must be
 * PROPERLY closed with the justification its door requires (fail-closed —
 * null/whitespace counts as missing). Pure, deterministic, never throws.
 */
export function dispositionCompleteness(
  state: QueueState,
): DispositionCompleteness {
  const gaps = state.items
    .map(itemGap)
    .filter((gap): gap is DispositionGap => gap !== null);
  return { complete: gaps.length === 0, gaps };
}
