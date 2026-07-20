import { z } from 'zod';

import { queueItemKind, queueExit } from '../schemas';

/**
 * Disk state model — single source of truth, re-read every round.
 * kind/exit reuse the locked queue-item enums (schema-as-SoT). On disk an item
 * that is still open carries exit: null (pending == exit null), so the item exit
 * field is the locked queueExit widened with null.
 */

// AC status is the fail-closed subset used by the completion gate.
export const acStatus = z.enum(['pass', 'unverified', 'fail']);
export type AcStatus = z.infer<typeof acStatus>;

export const queueStateItem = z
  .object({
    id: z.string().min(1),
    kind: queueItemKind,
    exit: queueExit.nullable(),
    evidence_ref: z.string().nullable(),
    disposition_note: z.string().nullable(),
  })
  .strict();
export type QueueStateItem = z.infer<typeof queueStateItem>;

export const acEntry = z
  .object({
    id: z.string().min(1),
    status: acStatus,
    evidence_ref: z.string().nullable(),
  })
  .strict();
export type AcEntry = z.infer<typeof acEntry>;

export const lastStopHook = z
  .object({
    command: z.string(),
    exit_code: z.number().int(),
    timestamp: z.string(),
    output_excerpt: z.string(),
  })
  .strict();
export type LastStopHook = z.infer<typeof lastStopHook>;

export const backstop = z
  .object({
    turns: z.number().int(),
    no_progress_rounds: z.number().int(),
    queue_size_trend: z.array(z.number().int()),
  })
  .strict();
export type Backstop = z.infer<typeof backstop>;

export const queueState = z
  .object({
    round: z.number().int(),
    items: z.array(queueStateItem),
    acceptance_criteria: z.array(acEntry),
    last_stop_hook: lastStopHook.nullable(),
    backstop,
    blocker: z.string().nullable(),
  })
  .strict();
export type QueueState = z.infer<typeof queueState>;

/** Fail-closed parse of a raw JSON state document. Throws on any schema drift. */
export function parseQueueState(raw: string): QueueState {
  return queueState.parse(JSON.parse(raw));
}

/** pending == exit null. The only definition of "still open". */
export function pendingItems(state: QueueState): QueueStateItem[] {
  return state.items.filter((item) => item.exit === null);
}

export function pendingCount(state: QueueState): number {
  return pendingItems(state).length;
}

export function isDrained(state: QueueState): boolean {
  return pendingCount(state) === 0;
}

const hasEvidence = (ref: string | null): boolean =>
  ref !== null && ref.trim().length > 0;

/**
 * ACs that claim pass but carry no live evidence reference — the over-claim the
 * Stop hook must block on. An empty or whitespace evidence_ref is no evidence.
 */
export function acsClaimingPassWithoutEvidence(state: QueueState): AcEntry[] {
  return state.acceptance_criteria.filter(
    (ac) => ac.status === 'pass' && !hasEvidence(ac.evidence_ref),
  );
}

/** state/progress.md append-only line. */
export function progressLine(round: number, item: QueueStateItem): string {
  const exit = item.exit ?? 'open';
  const note = item.disposition_note ?? '(none)';
  const evidence = hasEvidence(item.evidence_ref)
    ? (item.evidence_ref as string)
    : 'none';
  return `[round ${round}] ${item.id} ${item.kind} → ${exit}: ${note} (evidence: ${evidence})`;
}
