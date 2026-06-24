import { z } from 'zod';
import { schemaVersion } from './common';

/**
 * RetroMetricSnapshot — one point-in-time row of a work item's retro measurement,
 * appended to a cross-WI append-only ledger when a retro node passes (ADR-0024
 * Decision 4 trend preservation). The retro `outcome_floor`/`process_health`
 * metrics are ephemeral — a past work item's coverage cannot be reconstructed
 * later — so the trend the ADR's retract condition needs ("does the floor measure
 * weak-planner variance reduction?") only exists if each WI's measurement is
 * captured AT retro time. This schema is that captured row.
 *
 * `metrics` mirrors `RetroMetrics` (src/core/retro-measure.ts) exactly: each group
 * present only when grounded, `no_measurable_signal` when neither was. The store
 * keeps the ledger consistent with the anti-SLOP shape (an absent slot means
 * "ungrounded", never a fabricated zero) — it copies, it does not invent.
 */
export const retroMetricSnapshot = z.object({
  schema_version: schemaVersion,
  work_item_id: z.string().min(1),
  /** ISO timestamp INJECTED by the caller (deterministic — never read from the clock here). */
  recorded_at: z.string().min(1),
  metrics: z.object({
    outcome_floor: z
      .object({
        coverage: z.number().optional(),
        unit_only_closures: z.number().int().nonnegative().optional(),
        escape_recurrence: z.number().int().nonnegative().optional(),
      })
      .optional(),
    process_health: z.object({ post_cost: z.number().int().nonnegative() }).optional(),
    no_measurable_signal: z.literal(true).optional(),
  }),
});

export type RetroMetricSnapshot = z.infer<typeof retroMetricSnapshot>;
