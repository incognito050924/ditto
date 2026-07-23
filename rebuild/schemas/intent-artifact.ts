import { z } from 'zod';

import { acOracle } from './oracle';
import { declaredRisk } from './work-item-record';

/**
 * The intent artifact — the output of intent formation, bound to EXACTLY one
 * work item (one intent = one unit; fan-out that keeps the frozen root goal
 * and AC id-set is re-planning, not a new intent).
 *
 * AC↔oracle convergence is structural, not aspirational: every acceptance
 * criterion carries its own oracle (criterion_id matching), so the completion
 * currency exists from the moment intent locks — a criterion that cannot say
 * how a machine would re-evaluate it is not ready to be a criterion.
 */

export const intentCriterion = z
  .object({
    id: z.string().min(1),
    statement: z.string().min(1),
    oracle: acOracle,
  })
  .strict()
  .refine((c) => c.oracle.criterion_id === c.id, {
    message: 'criterion.oracle.criterion_id must match the criterion id',
  });
export type IntentCriterion = z.infer<typeof intentCriterion>;

export const intentArtifact = z
  .object({
    work_item_id: z.string().min(1),
    root_goal: z.string().min(1),
    criteria: z.array(intentCriterion).min(1),
    risks: z.array(declaredRisk),
  })
  .strict()
  .refine(
    (a) => new Set(a.criteria.map((c) => c.id)).size === a.criteria.length,
    { message: 'criterion ids must be unique within one intent' },
  );
export type IntentArtifact = z.infer<typeof intentArtifact>;
