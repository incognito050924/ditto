import { z } from 'zod';

/**
 * Guardrail ① — intent-lock. Freezes the acceptance-criteria SET at a
 * capture-window and BLOCKS any in-run attempt to reduce / change / exempt that
 * frozen set. This is what stops an autonomous loop from silently shrinking its
 * own goal mid-run: additions (found scope) are fine, removals never are.
 *
 * Distinct from relock (queue-item RE-OPENING): relock reopens closed queue
 * items for reprocessing; intent-lock freezes the goal's AC membership. Same
 * house style (pure, immutable, fail-closed = structured refusal, zod-validated
 * for the persisted lock), but no shared re-open path.
 */

export const intentLock = z
  .object({
    criteria: z.array(z.string().min(1)),
  })
  .strict();
export type IntentLock = z.infer<typeof intentLock>;

export interface IntentLockCheck {
  admissible: boolean;
  removed: string[];
  added: string[];
  reason?: string;
}

export function parseIntentLock(raw: string): IntentLock {
  return intentLock.parse(JSON.parse(raw));
}

const normalize = (ids: string[]): string[] =>
  [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))].sort();

/**
 * Freeze the AC set at the capture-window. Deduped, trimmed, sorted, and copied
 * so the lock never aliases (or is mutated through) the caller's array.
 */
export function captureIntentLock(criteriaIds: string[]): IntentLock {
  return { criteria: normalize(criteriaIds) };
}

/**
 * Enforce the frozen intent against a proposed AC set. Fail-closed: any frozen
 * AC missing from the proposal is a reduction/change/exemption and makes the
 * move inadmissible. Additions (ids not in the frozen set) are allowed and only
 * reported. Pure — never mutates the lock, never throws.
 */
export function checkIntentLock(
  lock: IntentLock,
  proposedIds: string[],
): IntentLockCheck {
  const proposed = new Set(proposedIds.map((id) => id.trim()));
  const frozen = new Set(lock.criteria);
  const removed = lock.criteria.filter((id) => !proposed.has(id));
  const added = normalize(proposedIds).filter((id) => !frozen.has(id));

  if (removed.length === 0) {
    return { admissible: true, removed, added };
  }
  return {
    admissible: false,
    removed,
    added,
    reason: `intent-lock violation: frozen acceptance criteria may not be reduced/changed/exempted (removed: ${removed.join(', ')})`,
  };
}
