import type { QueueState } from './queue-state';

/**
 * §5 park — a legible escape landing. Stamps a legible `blocker` onto the state
 * so the state itself says "awaiting decision D, done & verified up to X, resume
 * needs D's answer". Pure: never writes disk (the dispatcher persists) and never
 * throws (fail-closed = a structured refusal, matching gate house style).
 */
export interface ParkResult {
  parked: boolean;
  state: QueueState;
  reason?: string;
}

const isEmpty = (value: string): boolean =>
  value == null || value.trim().length === 0;

export function park(
  state: QueueState,
  input: { decision: string; doneSummary: string; resumeCondition: string },
): ParkResult {
  const { decision, doneSummary, resumeCondition } = input;

  if (isEmpty(decision) || isEmpty(doneSummary) || isEmpty(resumeCondition)) {
    return {
      parked: false,
      state,
      reason: 'park requires non-empty decision, doneSummary, resumeCondition',
    };
  }

  const blocker = `PARK — awaiting decision: ${decision.trim()} | done & verified: ${doneSummary.trim()} | resume when: ${resumeCondition.trim()}`;
  return { parked: true, state: { ...state, blocker } };
}
