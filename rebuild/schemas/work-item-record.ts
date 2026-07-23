import { z } from 'zod';

import { evidence } from './evidence';
import { verdict } from './verdict';

/**
 * New-generation (rebuild) work item Record schema — the git-shared,
 * per-entity `record.json` under `.ditto/work-items/<id>/`.
 *
 * Deliberately minimal: the nine legacy fields tied to dropped capability
 * areas (runs, worktrees, handoff_path, owner_profile, child_ids,
 * changed_files, started_at_sha, started_untracked_baseline, source_request)
 * do not exist here — `.strict()` rejects them on write. Reading OLD-generation
 * records is a separate, lenient concern (legacy reader), never this schema.
 *
 * The `github` field is a placeholder only (repo/number identity, no behavior
 * fields like project_item_id) — GitHub integration re-enters separately.
 */

export const REBUILD_RECORD_SCHEMA_VERSION = 'rebuild/1';

/** Lifecycle statuses — preserves the lightweight-path set. */
export const workItemStatus = z.enum([
  'draft',
  'in_progress',
  'blocked',
  'partial',
  'unverified',
  'done',
  'abandoned',
]);
export type WorkItemStatus = z.infer<typeof workItemStatus>;

/** done/abandoned are exclusive terminals (first-terminal-wins in reduce). */
export const TERMINAL_STATUSES = ['done', 'abandoned'] as const satisfies
  readonly WorkItemStatus[];

/** Statuses that park work and therefore must carry a re-entry contract. */
export const RE_ENTRY_STATUSES = ['partial', 'unverified', 'blocked'] as const satisfies
  readonly WorkItemStatus[];

export function isTerminalStatus(status: WorkItemStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export const riskSeverity = z.enum(['info', 'low', 'medium', 'high', 'critical']);

/** Declared risk — persisted so it survives as completion-gate input. */
export const declaredRisk = z
  .object({
    statement: z.string().min(1),
    severity: riskSeverity.optional(),
  })
  .strict();
export type DeclaredRisk = z.infer<typeof declaredRisk>;

/** Re-entry contract: how to resume parked work. Never empty. */
export const reEntry = z
  .object({
    command: z.string().min(1).optional(),
    fresh_evidence_needed: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine(
    (r) => !!r.command || (r.fresh_evidence_needed?.length ?? 0) > 0,
    { message: 're_entry must carry a command or fresh_evidence_needed' },
  );
export type ReEntry = z.infer<typeof reEntry>;

export const acceptanceCriterion = z
  .object({
    id: z.string().min(1),
    statement: z.string().min(1),
    verdict,
    evidence: z.array(evidence),
    /** Provenance lock: criteria replaced after first verdict are marked, never erased. */
    superseded: z.boolean().optional(),
  })
  .strict();
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterion>;

export const workItemRecord = z
  .object({
    schema_version: z.literal(REBUILD_RECORD_SCHEMA_VERSION),
    id: z.string().min(1),
    title: z.string().min(1),
    goal: z.string().optional(),
    status: workItemStatus,
    acceptance_criteria: z.array(acceptanceCriterion),
    risks: z.array(declaredRisk),
    re_entry: reEntry.optional(),
    /** Lineage: previous work item(s) this one continues (stem chain edge). */
    follows: z.array(z.string().min(1)).optional(),
    /** Lineage: work item whose run surfaced this one. */
    discovered_by: z.string().min(1).optional(),
    /** Placeholder identity only — no integration behavior in this generation yet. */
    github: z
      .object({
        repo: z.string().min(1).optional(),
        number: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    closed_at: z.string().min(1).nullable(),
  })
  .strict()
  .refine(
    (r) =>
      !(RE_ENTRY_STATUSES as readonly string[]).includes(r.status) ||
      r.re_entry !== undefined,
    {
      message:
        'partial/unverified/blocked records must carry a re_entry contract',
    },
  );
export type WorkItemRecord = z.infer<typeof workItemRecord>;
