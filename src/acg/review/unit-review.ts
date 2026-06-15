/**
 * Unit-scoped review planning + aggregation (80-plan §9, WU-5). The STANDING-code
 * counterpart to the work-item-scoped `ditto acg-review`: the user names an
 * architecture unit, it is resolved to a file set via the SHARED resolver
 * (`~/acg/scope/unit-resolve`, also used by WU-4 `ditto refactor`), and this module
 * provides the DETERMINISTIC seam around the LLM reviewer runs:
 *
 *   1. planUnitReview  — DECOMPOSE the standing file set into batches that BOTH the
 *      `code-reviewer` and `security-reviewer` roles operate over, with progress and a
 *      guarantee that EVERY file is accounted for (reviewed + dropped == resolved).
 *      A file cap (PM-5) drops the overflow, but every dropped file is LOGGED — never
 *      silently truncated.
 *   2. aggregateUnitReview — AGGREGATE the reviewer-output + security-reviewer-output
 *      (the autopilot-dispatched LLM runs) into ONE unit acg_review ledger, REUSING the
 *      pure `projectReviewerOutputToAcgReview` adapter (severity→risk is code, not an
 *      LLM's hand calculation). The Stop gate then reads that one ledger.
 *
 * The actual reviewer/security-reviewer LLM passes are autopilot-dispatched owners; a
 * CLI cannot spawn them. This module is the scoping + batching + aggregation the two
 * roles feed.
 */
import { projectReviewerOutputToAcgReview } from '~/acg/review/acg-review-adapter';
import { type AcgReviewGraph, acgReviewGraph } from '~/schemas/acg-review-graph';
import type { ReviewerOutput } from '~/schemas/reviewer-output';

/** The reviewer roles that BOTH operate over the unit file set (ac-11). */
export const REVIEW_ROLES = ['code-reviewer', 'security-reviewer'] as const;
export type ReviewRole = (typeof REVIEW_ROLES)[number];

/** A single batch of files both roles review, with progress coordinates. */
export interface ReviewBatch {
  /** 1-based batch number. */
  index: number;
  /** Total batch count (for `index/total` progress). */
  total: number;
  /** The files in this batch (a slice of the reviewed set). */
  files: string[];
  /** Both reviewer roles operate over every batch (ac-11). */
  roles: ReviewRole[];
}

export interface UnitReviewPlan {
  /** The roles that operate over the unit file set (ac-11). */
  roles: ReviewRole[];
  /** The decomposed batches (ac-13). */
  batches: ReviewBatch[];
  /** Human-readable progress, e.g. `3/3 batches`. */
  progress: string;
  /** Count resolved by the scope resolver. */
  resolvedCount: number;
  /** Count actually placed into a batch (within the file cap). */
  reviewedCount: number;
  /** Files dropped by the cap — LOGGED, never silent (PM-5 / ac-13). */
  dropped: string[];
}

export interface PlanUnitReviewOptions {
  /** Files per batch (PM-5 batch decomposition). Default 25. */
  batchSize?: number | undefined;
  /**
   * Optional hard cap on the number of files reviewed (PM-5 context/cost blowup
   * guard). Overflow files are DROPPED but recorded in `dropped` — never silently
   * truncated. Absent → no cap (every resolved file is reviewed).
   */
  fileLimit?: number | undefined;
}

const DEFAULT_BATCH_SIZE = 25;

/**
 * Decompose a resolved unit file set into review batches. The invariant ac-13 names:
 * `reviewedCount + dropped.length === resolvedCount` — every file is either reviewed or
 * logged as dropped, so no file is ever silently lost.
 */
export function planUnitReview(
  resolved: readonly string[],
  options: PlanUnitReviewOptions = {},
): UnitReviewPlan {
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const resolvedCount = resolved.length;

  // PM-5 file cap: the overflow is DROPPED but LOGGED (never silent truncation).
  const reviewed =
    options.fileLimit === undefined ? [...resolved] : resolved.slice(0, options.fileLimit);
  const dropped = options.fileLimit === undefined ? [] : resolved.slice(options.fileLimit);

  const batches: ReviewBatch[] = [];
  for (let start = 0; start < reviewed.length; start += batchSize) {
    batches.push({
      index: batches.length + 1,
      total: 0, // filled below once the count is known
      files: reviewed.slice(start, start + batchSize),
      roles: [...REVIEW_ROLES],
    });
  }
  const total = batches.length;
  for (const b of batches) b.total = total;

  return {
    roles: [...REVIEW_ROLES],
    batches,
    progress: `${total}/${total} batches`,
    resolvedCount,
    reviewedCount: reviewed.length,
    dropped,
  };
}

/**
 * Aggregate the reviewer + security-reviewer outputs into ONE unit acg_review ledger.
 * Reuses the pure `projectReviewerOutputToAcgReview` adapter per output, then merges the
 * file entries and re-derives the human_review_set so the result is a single valid
 * `acgReviewGraph`. The Stop gate reads exactly one ledger; this produces it.
 */
export function aggregateUnitReview(outputs: readonly ReviewerOutput[]): AcgReviewGraph {
  const files = outputs.flatMap((o) => projectReviewerOutputToAcgReview(o).files);
  const human_review_set: string[] = [];
  for (const f of files) {
    if (f.risk === 'high' || f.unresolved === true) {
      const id = f.path ?? f.journey_id;
      if (id !== undefined && !human_review_set.includes(id)) human_review_set.push(id);
    }
  }
  return acgReviewGraph.parse({ kind: 'acg.review-graph.v1', files, human_review_set });
}
