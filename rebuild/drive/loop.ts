import { decideGate, type QueueItem } from '../schemas';

/**
 * The thin drive-loop step (foundation first slice, ac-6). It disposes exactly
 * ONE queue item by running the fail-closed evidence gate: a pass outcome backed
 * by non-empty grounds resolves the item; anything else leaves it open (block).
 * The orchestration engine stays thin — this is the whole step.
 */
export interface DriveStepResult {
  item: QueueItem;
  disposed: boolean;
  grounds?: string;
}

export function driveStep(
  item: QueueItem,
  signal: {
    outcome?: 'pass' | 'fail';
    grounds?: string;
    route?: 'new-scope-deferral' | 'escape';
  },
): DriveStepResult {
  const gate = decideGate(signal);
  if (gate.decision === 'pass') {
    // decideGate guarantees non-empty grounds on pass, but GateResult types it
    // optional (string | undefined). Include the key only when present so the
    // optional DriveStepResult.grounds stays exactOptionalPropertyTypes-clean.
    return {
      item: { ...item, exit: 'resolved' },
      disposed: true,
      ...(gate.grounds !== undefined ? { grounds: gate.grounds } : {}),
    };
  }
  // Gate blocked. A caller may still route the item out the other two doors —
  // but only with non-empty grounds (fail-closed, same bar as decideGate).
  const grounds = signal.grounds;
  if (signal.route && grounds && grounds.trim().length > 0) {
    return { item: { ...item, exit: signal.route }, disposed: true, grounds };
  }
  // No door earned: keep the item open (exit undefined) — no over-claim.
  return { item, disposed: false };
}
