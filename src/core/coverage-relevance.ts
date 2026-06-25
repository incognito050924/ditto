/**
 * Relevance gate — the deterministic safety core (design §5, wi_260625l0v). The
 * grounded relevance agent (§5-2) proposes per-category judgments and an adversarial
 * refuter (§5-3) challenges each proposed skip; this module assembles the two into
 * the final {@link CategoryRelevanceVerdict}s that the seed gate (coverage-taxonomy)
 * consumes. The safety rules live HERE (deterministic) so a category can never be
 * skipped at agent discretion — only when justified AND refute-survived.
 *
 * Per ADR-0001 ditto never calls a provider directly: the judgments and refutes are
 * produced by host-delegated subagents; this module only CONSUMES their structural
 * output.
 */

import type { CategoryRelevanceVerdict } from './coverage-taxonomy';

/** Raw per-category relevance judgment from the grounded relevance agent (§5-2). */
export interface RawRelevanceJudgment {
  id: string;
  relevant: boolean;
  /** Why the category is irrelevant — becomes close_reason on a skip. */
  reason?: string;
  /** What risk survives the skip — becomes residual_risk on a skip. */
  residual_risk?: string;
}

/**
 * Adversarial refute outcome for a proposed skip (§5-3). `refuted:true` means the
 * refuter found the category IS relevant after all → the skip is overturned.
 */
export interface RelevanceRefute {
  id: string;
  refuted: boolean;
}

/**
 * Assemble final relevance verdicts from grounded judgments + adversarial refutes,
 * enforcing the §5 safety rules deterministically:
 *  - skip (relevant:false) ONLY when the judgment is not-relevant, carries
 *    reason ∧ residual_risk, AND a refute ran and did NOT overturn it;
 *  - a refuted skip flips back to relevant (§5-3);
 *  - a not-relevant judgment with no refute is NOT skipped — every skip must pass
 *    adversarial refute (§5-3);
 *  - everything else stays relevant/open (애매하면 포함, §5-1).
 */
export function assembleRelevanceVerdicts(
  judgments: readonly RawRelevanceJudgment[],
  refutes: readonly RelevanceRefute[] = [],
): CategoryRelevanceVerdict[] {
  const refuteById = new Map(refutes.map((r) => [r.id, r]));
  return judgments.map((j) => {
    const refute = refuteById.get(j.id);
    // Inline the justification + refute-survival checks so the truthy narrowing on
    // reason/residual_risk reaches the skip branch (exactOptionalPropertyTypes).
    if (
      j.relevant === false &&
      j.reason &&
      j.residual_risk &&
      refute !== undefined &&
      refute.refuted === false
    ) {
      return { id: j.id, relevant: false, reason: j.reason, residual_risk: j.residual_risk };
    }
    return { id: j.id, relevant: true };
  });
}
