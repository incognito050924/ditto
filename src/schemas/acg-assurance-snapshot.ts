import { z } from 'zod';
import { acgProducedBy, uniqueStringSet } from './acg-common';
import { isoDateTime, schemaVersion, workItemId } from './common';

/**
 * ACG AssuranceSnapshot (20-contracts §6.5) — the time-series unit of the
 * Assurance Graph. FitnessFunction is the predicate; this is its evaluation
 * history. Drift (pass-rate slope, violation trend) is derived over these.
 *
 * violation_ids / new_violation_ids are SETS (not counts) keyed by
 * FitnessFunction.baseline.violation_identity so delta_only is auditable (OBJ-32).
 */

export const acgSnapshotResult = z
  .object({
    function_id: z.string().min(1).describe('FitnessFunction.id'),
    outcome: z.enum(['pass', 'fail', 'skip']),
    violations: z.number().int().min(0).optional().describe('Violation count (display/trend)'),
    new_violations: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Count not in baseline.snapshot — delta_only blocking basis'),
    violation_ids: uniqueStringSet(
      'violation_identity set at this point — enables cross-snapshot delta recompute (OBJ-32)',
    ).optional(),
    new_violation_ids: uniqueStringSet(
      'violation_ids not in baseline.snapshot — legacy vs new, audited mechanically',
    ).optional(),
  })
  .describe('One fitness function evaluation result at a point in time');

export const acgAssuranceSnapshot = z
  .object({
    schema_version: schemaVersion,
    kind: z.literal('acg.assurance-snapshot.v1'),
    produced_by: acgProducedBy,
    produced_at: isoDateTime,
    at: isoDateTime.describe('Evaluation time'),
    trigger: z.enum(['per_change', 'periodic']),
    change_ref: workItemId.nullable().default(null).describe('per_change → the work item'),
    results: z.array(acgSnapshotResult).default([]),
  })
  .describe('ACG AssuranceSnapshot — fitness evaluation time-series unit');

export type AcgAssuranceSnapshot = z.infer<typeof acgAssuranceSnapshot>;
