import type { Verdict } from '../schemas/verdict';

/**
 * Test barrier verdict (unit/mock tier only — integration/E2E belong to
 * push-gate/CI, not here). Three values, because "could not run" is a
 * different truth than "ran red":
 *
 * - passed:     command ran, exit 0
 * - failed:     command ran, non-zero exit
 * - unrunnable: no command declared, spawn failed, or exit 126/127
 *
 * Completion-side disposition is deliberately ASYMMETRIC to the push side:
 * completion is reversible, so unrunnable degrades honestly to `unverified`
 * and PROCEEDS (never fabricates green, never stalls the flow); push is
 * irreversible, so the push gate fail-close-BLOCKs the same signal — that
 * disposition lives with the push gate, not here.
 */

export type BarrierOutcome = 'passed' | 'failed' | 'unrunnable';

export interface BarrierRun {
  /** Declared barrier test command; absent = nothing to run. */
  command?: string;
  exitCode?: number;
  spawnFailed?: boolean;
}

export function classifyBarrierRun(run: BarrierRun): BarrierOutcome {
  if (run.command === undefined || run.spawnFailed === true) return 'unrunnable';
  if (run.exitCode === 126 || run.exitCode === 127) return 'unrunnable';
  if (run.exitCode === 0) return 'passed';
  return 'failed';
}

export interface BarrierDisposition {
  proceed: boolean;
  /** The highest verdict the barrier allows the work item to claim. */
  verdictCap: Verdict;
}

export function barrierCompletionDisposition(
  outcome: BarrierOutcome,
): BarrierDisposition {
  switch (outcome) {
    case 'passed':
      return { proceed: true, verdictCap: 'pass' };
    case 'unrunnable':
      return { proceed: true, verdictCap: 'unverified' };
    case 'failed':
      return { proceed: false, verdictCap: 'fail' };
  }
}
