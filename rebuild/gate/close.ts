import { finalizeWorkItem, loadWorkItem } from '../record/store';
import type { GateResult } from '../schemas/gate-result';
import type { AcOracle } from '../schemas/oracle';
import type {
  ReEntry,
  WorkItemRecord,
  WorkItemStatus,
} from '../schemas/work-item-record';
import {
  barrierCompletionDisposition,
  classifyBarrierRun,
  type BarrierDisposition,
  type BarrierOutcome,
  type BarrierRun,
} from './barrier';
import {
  decisionConflictGate,
  type DecisionConflict,
  type DecisionConflictGateResult,
  type GateMode,
} from './decision-conflict';
import { oracleSatisfaction } from './oracle-satisfaction';
import {
  openRiskStatements,
  passCloseResidualGate,
  unverifiedCriterionIds,
  type ResidualGateResult,
} from './residual';

/**
 * The rebuild completion path: a PASS-close is admissible only when every
 * gate agrees — per-AC oracle satisfaction AND barrier passed AND zero
 * in-scope residue AND no blocking decision conflict. Anything less lands
 * honestly as a non-pass status (with a mandatory re_entry contract) on the
 * A3 record store — evidence and the landing are recorded, never a stall:
 *
 * - intent-level conflict → blocked   (fail-closed, no live wait)
 * - barrier failed        → partial   (work demonstrably not done)
 * - barrier unrunnable    → unverified (honest degrade, still proceeds)
 * - residue / unsatisfied or missing oracle → unverified
 */

export class MissingReEntryError extends Error {
  constructor(id: string, landing: WorkItemStatus) {
    super(
      `pass-close for ${id} is blocked and must land as "${landing}", which requires a re_entry contract — provide inputs.re_entry`,
    );
    this.name = 'MissingReEntryError';
  }
}

export interface CloseInputs {
  actor: string;
  mode: GateMode;
  /**
   * Per-AC oracles — the completion currency (ADR-0024). Optional: when
   * omitted, the oracles landed on the record by the intent lock are used;
   * explicit entries override the record's per criterion_id.
   */
  oracles?: AcOracle[];
  /** Barrier run result; running it is the caller's job (engine judges only). */
  barrier: BarrierRun;
  /** Conflicts as judged by the host LLM (the gate only routes/discloses). */
  conflicts?: DecisionConflict[];
  /** Declared risks not yet disposed, if the caller tracks them beyond the record. */
  open_risks?: string[];
  /** Required whenever the landing is non-pass. */
  re_entry?: ReEntry;
}

export interface CloseOutcome {
  final_status: WorkItemStatus;
  gates: {
    barrier: { outcome: BarrierOutcome; disposition: BarrierDisposition };
    conflicts: DecisionConflictGateResult;
    residual: ResidualGateResult;
    oracles: Record<string, GateResult>;
  };
  record: WorkItemRecord;
}

export async function closeWorkItemWithGates(
  repoRoot: string,
  id: string,
  inputs: CloseInputs,
): Promise<CloseOutcome> {
  const { record, view } = await loadWorkItem(repoRoot, id);

  const barrierOutcome = classifyBarrierRun(inputs.barrier);
  const barrier = {
    outcome: barrierOutcome,
    disposition: barrierCompletionDisposition(barrierOutcome),
  };
  const conflicts = decisionConflictGate(inputs.conflicts ?? [], inputs.mode);

  const activeCriteria = view.acceptance_criteria.filter(
    (c) => c.superseded !== true,
  );
  const oracleById = new Map<string, AcOracle>();
  for (const criterion of view.acceptance_criteria) {
    if (criterion.oracle !== undefined) {
      oracleById.set(criterion.id, criterion.oracle);
    }
  }
  for (const oracle of inputs.oracles ?? []) {
    oracleById.set(oracle.criterion_id, oracle);
  }
  const oracleResults: Record<string, GateResult> = {};
  for (const criterion of activeCriteria) {
    const oracle = oracleById.get(criterion.id);
    // presence-gated: an AC without an oracle can never close pass
    oracleResults[criterion.id] =
      oracle === undefined
        ? { decision: 'block' }
        : oracleSatisfaction(oracle, criterion.evidence);
  }
  const allOraclesSatisfied = activeCriteria.every(
    (c) => oracleResults[c.id]?.decision === 'pass',
  );

  const residual = passCloseResidualGate({
    unverified: unverifiedCriterionIds(view.acceptance_criteria),
    open_risks: [
      ...openRiskStatements(record.risks),
      ...(inputs.open_risks ?? []),
    ],
  });

  const passAdmissible =
    barrier.outcome === 'passed' &&
    conflicts.decision === 'pass' &&
    residual.decision === 'pass' &&
    allOraclesSatisfied;

  // Non-pass landing cascade — most-specific truth first.
  const landing: WorkItemStatus = passAdmissible
    ? 'done'
    : conflicts.decision === 'block'
      ? 'blocked'
      : barrier.outcome === 'failed'
        ? 'partial'
        : 'unverified';

  if (landing !== 'done' && inputs.re_entry === undefined) {
    throw new MissingReEntryError(id, landing);
  }

  const finalized = await finalizeWorkItem(repoRoot, id, {
    status: landing,
    actor: inputs.actor,
    ...(landing !== 'done' && inputs.re_entry !== undefined
      ? { re_entry: inputs.re_entry }
      : {}),
  });

  return {
    final_status: landing,
    gates: { barrier, conflicts, residual, oracles: oracleResults },
    record: finalized,
  };
}
