import {
  acsClaimingPassWithoutEvidence,
  pendingCount,
  type QueueState,
} from '../state/queue-state';

/**
 * Pure completion gate. Given the test-runner result, the parsed disk state, and
 * whether a completion token was emitted, decide whether Claude may stop.
 *
 * fail-closed: stop is allowed (exit 0) ONLY when tests are green, the queue has
 * no pending item, and no acceptance criterion claims pass without live evidence.
 * Any doubt blocks (exit 2). Infinite-block avoidance is the block cap (60), NOT
 * surrendering the gate when stop_hook_active repeats — a repeat block is
 * surfaced (repeatBlock) but still blocks unmet conditions.
 */
export interface StopGateInput {
  testExitCode: number;
  state: QueueState;
  foundationCompleteEmitted: boolean;
  stopHookActive: boolean;
}

export interface StopGateDecision {
  exitCode: 0 | 2;
  reasons: string[];
  repeatBlock: boolean;
}

export function evaluateStopGate(input: StopGateInput): StopGateDecision {
  const reasons: string[] = [];

  if (input.testExitCode !== 0) {
    reasons.push(`tests red (runner exit ${input.testExitCode})`);
  }

  const pending = pendingCount(input.state);
  if (pending > 0) {
    reasons.push(`pending queue items: ${pending} (exit == null)`);
  }

  const overclaims = acsClaimingPassWithoutEvidence(input.state);
  if (overclaims.length > 0) {
    const ids = overclaims.map((ac) => ac.id).join(', ');
    reasons.push(`AC claims pass without live evidence: ${ids}`);
  }

  // A completion token emitted while any block condition holds is a false
  // completion — call it out explicitly so the transcript names the over-claim.
  if (input.foundationCompleteEmitted && reasons.length > 0) {
    reasons.push(
      'FOUNDATION-COMPLETE emitted while gate conditions are unmet (false completion)',
    );
  }

  const exitCode: 0 | 2 = reasons.length > 0 ? 2 : 0;
  return { exitCode, reasons, repeatBlock: input.stopHookActive };
}
