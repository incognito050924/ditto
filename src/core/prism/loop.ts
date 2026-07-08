import type { PrismDecision } from '~/schemas/prism';
import {
  type DivergenceVerdict,
  type PrismRound,
  type PrismRoundSignature,
  detectDivergence,
} from './engine';
import {
  type OpponentSeamConfig,
  type OpponentSeamOutcome,
  engageDialecticCritique,
  engageIndependentDissent,
} from './opponent';
import type { PrismStore } from './store';

/**
 * Prism divergence-round driver (wi_260707oi1, node oi1-compile-wiring, ac-10).
 *
 * The pure `detectDivergence` (engine.ts) already names the meaningless-divergence
 * shapes and the admissible re-challenge, and the decision KINDS already exist in the
 * schema. What was missing was the FIRING: nothing turned a detected divergence into a
 * durable, decision-grade record. This is that seam — the interview/prism loop runs a
 * round through it and the verdict is EMITTED (never silent):
 *   - an admissible re-challenge (new evidence) → a `challenge_admit` Record-tier
 *     decision (the challenge is admitted as a visible item, once);
 *   - a meaningless divergence (쳇바퀴 / trivial streak / decided-conflict-no-evidence)
 *     → an `early_exit` Record-tier decision (the loop stops early rather than spin).
 * No divergence → no record. Impure by design (it writes the Record tier), which is why
 * it lives here and not in the pure engine.
 */
export interface DivergenceRoundInput {
  workItemId: string;
  round: PrismRound;
  history: readonly PrismRoundSignature[];
  now?: Date;
}

export interface DivergenceRoundResult {
  verdict: DivergenceVerdict;
  /** The decision-grade record emitted this round (absent when the round just continues). */
  decision?: PrismDecision;
}

export async function runDivergenceRound(
  store: PrismStore,
  input: DivergenceRoundInput,
): Promise<DivergenceRoundResult> {
  const verdict = detectDivergence(input.round, input.history);
  const recordedAt = (input.now ?? new Date()).toISOString();

  // An admissible re-challenge (new grounding evidence) is admitted as a visible item.
  if (verdict.action === 'challenge-node') {
    const decision = await store.appendDecision({
      schema_version: '0.1.0',
      work_item_id: input.workItemId,
      kind: 'challenge_admit',
      ...(input.round.challenge ? { node_id: input.round.challenge.decided_id } : {}),
      reason: verdict.reason,
      recorded_at: recordedAt,
    });
    return { verdict, decision };
  }

  // A flagged meaningless divergence stops the loop early — recorded, not silently spun.
  if (verdict.diverged) {
    const decision = await store.appendDecision({
      schema_version: '0.1.0',
      work_item_id: input.workItemId,
      kind: 'early_exit',
      reason: verdict.reason,
      recorded_at: recordedAt,
    });
    return { verdict, decision };
  }

  return { verdict };
}

/**
 * Model-assist opponent drivers (wi_260708tzs, node tzs-opponent) — the store I/O
 * boundary that WIRES the pure opponent seam (opponent.ts) into the prism loop, so a
 * production caller (the prism CLI) can actually invoke it (no dead wire). This is the
 * impure half (mirrors runDivergenceRound above): opponent.ts computes the record-back
 * over an in-memory map; these drivers own the Run-tier persistence.
 *
 * OBJ-2 single-writer contract: each driver reads the map ONCE and writes it back in
 * EXACTLY ONE `store.writeMap` (a full-replace — a racing second writer would clobber).
 * The seam awaits its host-delegated calls SEQUENTIALLY, so there is never a concurrent
 * fan-out of writeMap. The Run-tier issue-map annotation the write persists IS the
 * durable, measurable trace of the guard firing (OBJ-4) — recorded WITHOUT touching the
 * committed-base decisions tier (OFF-LIMITS, wi_260708cdl) and WITHOUT a new
 * prismDecisionKind enum value (OBJ-5).
 */
export async function runOpponentCritiqueRound(
  store: PrismStore,
  workItemId: string,
  config: OpponentSeamConfig,
): Promise<OpponentSeamOutcome> {
  const prism = await store.getMap(workItemId);
  const outcome = await engageDialecticCritique(prism, config);
  await store.writeMap(outcome.prism);
  return outcome;
}

export async function runOpponentDissentRound(
  store: PrismStore,
  workItemId: string,
  config: OpponentSeamConfig,
): Promise<OpponentSeamOutcome> {
  const prism = await store.getMap(workItemId);
  const outcome = await engageIndependentDissent(prism, config);
  await store.writeMap(outcome.prism);
  return outcome;
}
