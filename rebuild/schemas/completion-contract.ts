import { z } from 'zod';

import { evidence } from './evidence';
import { verdict, type Verdict } from './verdict';

export const acVerdict = z.object({
  criterion_id: z.string().min(1),
  verdict,
  evidence: z.array(evidence),
});

export type AcVerdict = z.infer<typeof acVerdict>;

/**
 * Invariant 1: a work item is "done" only when every acceptance criterion is
 * pass AND carries at least one evidence reference. Anything short of that can
 * never derive to 'pass'.
 */
export function deriveFinalVerdict(criteria: AcVerdict[]): Verdict {
  if (criteria.length === 0) return 'unverified';
  if (criteria.some((c) => c.verdict === 'fail')) return 'fail';
  const allPassWithEvidence = criteria.every(
    (c) => c.verdict === 'pass' && c.evidence.length > 0,
  );
  return allPassWithEvidence ? 'pass' : 'unverified';
}

export const completionContract = z
  .object({
    work_item_id: z.string().min(1),
    criteria: z.array(acVerdict).min(1),
    final_verdict: verdict,
  })
  .refine((c) => c.final_verdict === deriveFinalVerdict(c.criteria), {
    message:
      'final_verdict must equal the value derived from criteria (no over-claim)',
  });

export type CompletionContract = z.infer<typeof completionContract>;
