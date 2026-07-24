import type {
  CategoryRelevanceVerdict,
  RawRelevanceJudgment,
  RelevanceRefute,
} from './schemas';

/**
 * Binary relevance gate — the deterministic safety core (ADR-20260625). A
 * grounded agent proposes per-category judgments and an adversary refutes each
 * proposed skip; this assembler is where a category's life-or-death is decided,
 * so it can never be at agent discretion. Pure.
 *
 * The §5 safety rules, enforced here:
 *  1. conservative default — anything not a well-formed, refute-survived skip
 *     stays relevant (애매하면 포함);
 *  2. justification required — a skip must carry both `reason` (→ close_reason)
 *     and `residual_risk`;
 *  3. adversarial refute — a skip stands only when a refute ran AND did not
 *     overturn it (`refuted:false`); a refuted skip flips back to relevant, and
 *     a skip with no refute at all is not honored.
 *
 * Per ADR-0001 ditto never calls a provider directly: `judgments`/`refutes` are
 * the structural output of host-delegated subagents; this only consumes them.
 */
export function assembleRelevanceVerdicts(
  judgments: readonly RawRelevanceJudgment[],
  refutes: readonly RelevanceRefute[] = [],
): CategoryRelevanceVerdict[] {
  const refuteById = new Map(refutes.map((r) => [r.id, r]));
  return judgments.map((j) => {
    const refute = refuteById.get(j.id);
    if (
      j.relevant === false &&
      j.reason !== undefined &&
      j.residual_risk !== undefined &&
      refute !== undefined &&
      refute.refuted === false
    ) {
      return {
        id: j.id,
        relevant: false,
        reason: j.reason,
        residual_risk: j.residual_risk,
      };
    }
    return { id: j.id, relevant: true };
  });
}
