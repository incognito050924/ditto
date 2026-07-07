import type { PrismDecision } from '~/schemas/prism';
import {
  type DivergenceVerdict,
  type PrismRound,
  type PrismRoundSignature,
  detectDivergence,
} from './engine';
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
