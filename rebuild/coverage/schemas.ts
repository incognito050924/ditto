import { z } from 'zod';

/**
 * Coverage module schemas — local to rebuild/coverage/ (kept out of the shared
 * rebuild/schemas/ index because only this capability consumes them). Two ADR
 * contracts ride on these shapes:
 *  - ADR-0023: category-complete termination + justification-close gate;
 *  - ADR-20260625: binary relevance gate (relevant → in scope, not-relevant →
 *    auditable skip).
 *
 * The coverage map is a flat node list + parent_id edges (the tree/DAG). A
 * far-field category is seeded as one node; the node set IS the per-category
 * sweep ledger, so termination and the audit report read straight off it — no
 * separate bookkeeping.
 */

/** Closure state of a coverage node. `open` = not yet swept; the other three close it. */
export const coverageNodeState = z.enum([
  'open',
  'resolved',
  'user_owned',
  'out_of_scope',
]);

export type CoverageNodeState = z.infer<typeof coverageNodeState>;

/** The three closing states (resolved swept; user_owned / out_of_scope are justified skips). */
export const CLOSED_STATES: ReadonlySet<CoverageNodeState> = new Set([
  'resolved',
  'user_owned',
  'out_of_scope',
]);

export const coverageNode = z
  .object({
    id: z.string().min(1),
    parent_id: z.string().min(1).nullable(),
    label: z.string().min(1),
    state: coverageNodeState,
    children: z.array(z.string().min(1)).default([]),
    /** WHY a non-resolved close happened — a skip must be justified, never silent (ADR-0023). */
    close_reason: z.string().min(1).optional(),
    /** WHAT risk survives the skip — distinct from close_reason (WHY). */
    residual_risk: z.string().min(1).optional(),
  })
  .strict();

export type CoverageNode = z.infer<typeof coverageNode>;

export const coverageMap = z
  .object({
    root_id: z.string().min(1),
    nodes: z.array(coverageNode).default([]),
  })
  .strict();

export type CoverageMap = z.infer<typeof coverageMap>;

/**
 * One raw per-category relevance judgment PRODUCED by a host-delegated grounded
 * agent (ADR-0001 — the engine never calls a provider; it only consumes the
 * structural output). `reason`/`residual_risk` fill in only for a proposed skip.
 */
export const rawRelevanceJudgment = z
  .object({
    id: z.string().min(1),
    relevant: z.boolean(),
    reason: z.string().min(1).optional(),
    residual_risk: z.string().min(1).optional(),
  })
  .strict();

export type RawRelevanceJudgment = z.infer<typeof rawRelevanceJudgment>;

/** One adversarial refute outcome for a proposed skip; `refuted:true` = category IS relevant. */
export const relevanceRefute = z
  .object({
    id: z.string().min(1),
    refuted: z.boolean(),
  })
  .strict();

export type RelevanceRefute = z.infer<typeof relevanceRefute>;

/**
 * The ASSEMBLED per-category verdict the seed gate consumes. A category is
 * skipped only by a well-formed `relevant:false` verdict carrying both
 * `reason` and `residual_risk`; everything else stays relevant (conservative
 * default — 애매하면 포함).
 */
export interface CategoryRelevanceVerdict {
  id: string;
  relevant: boolean;
  reason?: string;
  residual_risk?: string;
}
