import { z } from 'zod';
import { isoDateTime, relativePath, schemaVersion } from './common';

/**
 * Index for a doc-cleanup classify run. Mirrors the per-entity manifest style
 * of `handoff.ts` and reuses shared primitives from `common.ts`.
 *
 * The index is append-only friendly: each classified doc is one entry in
 * `entries[]`, written as it is staged so a crash mid-run leaves a 1:1
 * correspondence between moved files and recorded entries.
 */

/** How a doc was disposed; also the name of its action subfolder. */
export const cleanupAction = z
  .enum(['delete-candidate', 'quarantine', 'absorb-then-discard', 'unclassified'])
  .describe('Disposition of a classified doc; matches the action subfolder name');

/** Whether the run considers tracked, untracked, or both kinds of files. */
export const cleanupTrackedFilter = z
  .enum(['tracked-only', 'include-untracked', 'untracked-only'])
  .describe('Which git-tracking status of files the run classifies');

/** One signal justifying a classification. At least one is required per entry. */
export const cleanupBasisSignal = z
  .object({
    kind: z
      .enum(['orphan', 'stale', 'contradiction'])
      .describe('Class of signal that motivated the action'),
    detail: z.string().min(1).describe('Human-readable basis for this signal'),
  })
  .describe('A single justification signal for a classification');

/** Snapshot of the run parameters (kept verbatim for auditability/reproduction). */
export const cleanupRunParams = z
  .object({
    work_item_id: z.string().min(1).optional().describe('작업ID this run is scoped to'),
    scope: z.string().min(1).optional().describe('범위 — path/glob the run was limited to'),
    tracked_filter: cleanupTrackedFilter.describe('tracked filter'),
    categories: z
      .array(z.string().min(1))
      .default([])
      .describe('분류유형 — categories of docs in scope'),
    auto_cleanup: z.boolean().describe('자동정리 — whether cleanup ran without per-doc approval'),
    concurrency: z.number().int().positive().describe('동시성 — worker count'),
    aggressiveness: z
      .number()
      .int()
      .min(1)
      .max(5)
      .describe('적극성 — 1 (conservative) … 5 (aggressive)'),
  })
  .describe('Snapshot of the parameters this classify run was invoked with');

/** Per-doc classification entry. */
export const cleanupEntry = z
  .object({
    name: z.string().min(1).describe('Display name of the doc'),
    original_path: relativePath.describe('Where the doc lived before staging'),
    owning_repo: z
      .string()
      .nullable()
      .describe('Nearest owning sub-repo (findOwningRepo), or null for the workspace root'),
    action: cleanupAction,
    staged_path: relativePath.describe('Where the doc was moved under the run folder'),
    summary: z.string().describe('Short rationale for the disposition'),
    basis: z
      .array(cleanupBasisSignal)
      .min(1)
      .describe('At least one signal — no classification without basis (ac-5)'),
    audit: z
      .object({
        classified_at: isoDateTime,
        aggressiveness: z.number().int().min(1).max(5),
        agent: z.string().min(1).optional().describe('Agent/handle that classified, if any'),
      })
      .describe('Audit trail for this single classification'),
  })
  .describe('One classified doc, moved into its action subfolder');

/** The full classify-run index: run metadata plus per-doc entries. */
export const cleanupIndex = z
  .object({
    schema_version: schemaVersion,
    run_id: z
      .string()
      .regex(
        /^cleanup-\d{8}-\d{6}(-[a-z0-9]+)?$/,
        'run id must be cleanup-<YYYYMMDD-HHMMSS> with an optional collision suffix',
      )
      .describe('Stable identifier for one classify run'),
    created_at: isoDateTime,
    workspace_root: z.string().min(1).describe('Absolute workspace root the run rooted at'),
    params: cleanupRunParams,
    entries: z.array(cleanupEntry).default([]).describe('Append-only list of classified docs'),
  })
  .describe('Index of a single doc-cleanup classify run (append-only friendly)');

export type CleanupAction = z.infer<typeof cleanupAction>;
export type CleanupTrackedFilter = z.infer<typeof cleanupTrackedFilter>;
export type CleanupBasisSignal = z.infer<typeof cleanupBasisSignal>;
export type CleanupRunParams = z.infer<typeof cleanupRunParams>;
export type CleanupEntry = z.infer<typeof cleanupEntry>;
export type CleanupIndex = z.infer<typeof cleanupIndex>;
