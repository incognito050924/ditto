import type { z } from 'zod';
import type { verdict } from '~/schemas/common';
import {
  type Convergence,
  type DecisionLedgerEntry,
  convergence as convergenceSchema,
} from '~/schemas/convergence';
import { localDir } from './ditto-paths';
import { readJson, writeJson } from './fs';
import { deriveClosureMode } from './gates';

type Verdict = z.infer<typeof verdict>;

/**
 * Convergence ledger runtime (M3.3). The admissibility *judgment* is made
 * upstream (LLM) and lands in each entry's `admissible` flag; this module owns
 * the deterministic *recording* and ratchet: argmax selection, open-admissible
 * count, and the two-gate `converged` flag. Output satisfies the M0.4
 * `convergenceGate` invariants by construction.
 */
export interface ConvergenceInput {
  workItemId: string;
  targetRef: string;
  roundCap: number;
  roundsRun: number;
  versions: Convergence['versions'];
  ledger: DecisionLedgerEntry[];
  completionGateVerdict: Verdict;
  nextHandoffPath?: string;
}

function recompute(
  versions: Convergence['versions'],
  ledger: DecisionLedgerEntry[],
  completionGateVerdict: Verdict,
  roundCap: number,
  roundsRun: number,
  nextHandoffPath: string | undefined,
  workItemId: string,
): Omit<Convergence, 'schema_version' | 'work_item_id' | 'target_ref'> & {
  versions: Convergence['versions'];
} {
  const maxScore = Math.max(...versions.map((v) => v.score));
  // argmax: first version achieving the max score (ratchet keeps the best, not the last).
  const selected = versions.find((v) => v.score === maxScore)?.version ?? versions[0]?.version ?? 1;
  const openAdmissible = ledger.filter((e) => e.admissible && e.status === 'deferred').length;
  const converged = completionGateVerdict === 'pass' && openAdmissible === 0;
  const reason: Convergence['exit']['reason'] = converged
    ? 'converged'
    : roundsRun >= roundCap
      ? 'cap_reached'
      : 'blocked';
  return {
    round_cap: roundCap,
    rounds_run: roundsRun,
    versions,
    selected_version: selected,
    decision_ledger: ledger,
    open_admissible_count: openAdmissible,
    gate: {
      completion_gate: completionGateVerdict,
      convergence_gate: openAdmissible === 0 ? 'no_open_admissible' : 'open_admissible',
      converged,
    },
    exit: {
      reason,
      closure_mode: deriveClosureMode(reason, converged),
      verdict_delegated_to_completion: true,
      // cap_reached/blocked without convergence requires a handoff path (§5).
      next_handoff_path: converged
        ? null
        : (nextHandoffPath ?? `.ditto/local/work-items/${workItemId}/handoff.md`),
    },
  };
}

export function buildConvergence(input: ConvergenceInput): Convergence {
  const derived = recompute(
    input.versions,
    input.ledger,
    input.completionGateVerdict,
    input.roundCap,
    input.roundsRun,
    input.nextHandoffPath,
    input.workItemId,
  );
  return convergenceSchema.parse({
    schema_version: '0.1.0',
    work_item_id: input.workItemId,
    target_ref: input.targetRef,
    ...derived,
  });
}

export class ConvergenceStore {
  constructor(public readonly repoRoot: string) {}

  private path(workItemId: string): string {
    return localDir(this.repoRoot, 'work-items', workItemId, 'convergence.json');
  }

  async exists(workItemId: string): Promise<boolean> {
    return Bun.file(this.path(workItemId)).exists();
  }

  async get(workItemId: string): Promise<Convergence> {
    return readJson(this.path(workItemId), convergenceSchema);
  }

  async write(c: Convergence): Promise<Convergence> {
    return writeJson(this.path(c.work_item_id), convergenceSchema, c);
  }

  /**
   * Append a ledger entry and re-derive the gate fields. Append-only: a reversal
   * is a new entry with a `supersedes` pointer, never an in-place edit (§4.2).
   */
  async appendLedgerEntry(workItemId: string, entry: DecisionLedgerEntry): Promise<Convergence> {
    const current = await this.get(workItemId);
    const ledger = [...current.decision_ledger, entry];
    const derived = recompute(
      current.versions,
      ledger,
      current.gate.completion_gate,
      current.round_cap,
      current.rounds_run,
      current.exit.next_handoff_path ?? undefined,
      workItemId,
    );
    return this.write(
      convergenceSchema.parse({
        schema_version: '0.1.0',
        work_item_id: workItemId,
        target_ref: current.target_ref,
        ...derived,
      }),
    );
  }
}
