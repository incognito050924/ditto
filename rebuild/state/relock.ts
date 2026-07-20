import type { QueueState, QueueStateItem } from './queue-state';
import type { QueueItemKind } from '../schemas';

export interface RelockCandidate {
  id: string;
  kind: QueueItemKind;
  note?: string;
}

export interface RelockResult {
  state: QueueState;
  added: string[];
  relocked: string[];
  skipped: string[];
}

export function relockRoute(
  state: QueueState,
  candidates: RelockCandidate[],
): RelockResult {
  const items: QueueStateItem[] = [...state.items];
  const added: string[] = [];
  const relocked: string[] = [];
  const skipped: string[] = [];

  for (const candidate of candidates) {
    const existingIndex = items.findIndex((item) => item.id === candidate.id);

    if (existingIndex === -1) {
      items.push({
        id: candidate.id,
        kind: candidate.kind,
        exit: null,
        evidence_ref: null,
        disposition_note: candidate.note ?? null,
      });
      added.push(candidate.id);
      continue;
    }

    const existing = items[existingIndex]!;
    if (existing.exit !== null) {
      // previously CLOSED → re-lock (re-open for reprocessing)
      items[existingIndex] = {
        ...existing,
        exit: null,
        evidence_ref: null,
        disposition_note: candidate.note ?? 're-locked',
      };
      relocked.push(candidate.id);
    } else {
      // already OPEN → already tracked, dedup (leave exactly as-is)
      skipped.push(candidate.id);
    }
  }

  return { state: { ...state, items }, added, relocked, skipped };
}
