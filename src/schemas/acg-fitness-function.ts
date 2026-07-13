import { z } from 'zod';
import { acgProducedBy } from './acg-common';
import { isoDateTime, schemaVersion, workItemId } from './common';

/**
 * ACG FitnessFunction — the genuinely new core. A property the
 * codebase must keep over time, as an executable predicate evaluated per-change
 * + periodically. AssuranceSnapshot is the time series of these evaluations.
 *
 * NOTE: schema defined in v0 (WU-1); the *runner/scheduler* that executes it is
 * out of v0 scope.
 */

export const acgFitnessKind = z.enum([
  'architectural',
  'dependency',
  'semantic',
  'coverage',
  'consistency',
  'performance',
  'duplication',
  'complexity',
  'user_journey',
]);

export const acgReproducibility = z
  .object({
    model_version: z.string().min(1).describe('Pinned judge model id (e.g. claude-opus-4-8)'),
    prompt_hash: z.string().optional(),
    votes: z.number().int().min(1).optional(),
    tie_break: z.enum(['fail_closed', 'fail_open', 'escalate']).optional(),
    input_fixing: z.string().optional(),
  })
  .describe('llm_judged reproducibility fixing (OBJ-07)');

export const acgExecution = z
  .object({
    environment: z.string().optional(),
    requires_clean_build: z
      .boolean()
      .optional()
      .describe(
        'executed spec succeeds with exit 0; non-zero exit is a build/command failure, not a clean result (fail-closed)',
      ),
    timeout_s: z.number().int().positive().optional(),
    retries: z.number().int().min(0).optional(),
    flake_policy: z.enum(['quarantine', 'fail', 'retry']).optional(),
    selection: z.enum(['per_change', 'risk_tiered', 'sampled', 'periodic']).optional(),
    budget: z.string().optional(),
  })
  .describe('mode=executed policy: flaky/cost handling (OBJ-18)');

export const acgFitnessBaseline = z
  .object({
    metric: z.string().optional(),
    scope: z.string().optional(),
    threshold: z.number().optional(),
    comparator: z.enum(['lte', 'gte', 'eq']).optional(),
    violation_identity: z
      .string()
      .optional()
      .describe('Key that identifies the same violation across snapshots'),
    snapshot: z
      .string()
      .optional()
      .describe('Identifier set/count at introduction — existing debt'),
    delta_only: z.boolean().optional(),
    window: z.string().optional(),
  })
  .describe('Existing-debt baseline for incremental enforcement (OBJ-03/21)');

export const acgFitnessFunction = z
  .object({
    schema_version: schemaVersion,
    kind: z.literal('acg.fitness-function.v1'),
    produced_by: acgProducedBy,
    produced_at: isoDateTime,
    id: z.string().min(1).describe('Stable slug, e.g. ff-backend-sb-version-single'),
    statement: z.string().min(1).describe('Property to keep (human-readable)'),
    fitness_kind: acgFitnessKind,
    evaluator: z.object({
      mode: z.enum(['deterministic', 'llm_judged', 'executed']),
      spec: z.string().min(1).describe('deterministic: command/query; llm_judged: judge prompt'),
      reproducibility: acgReproducibility.optional(),
      execution: acgExecution.optional(),
    }),
    baseline: acgFitnessBaseline.optional(),
    cadence: z.object({
      per_change: z.boolean().default(false),
      periodic: z.enum(['none', 'daily', 'weekly', 'on_release']).default('none'),
    }),
    on_violation: z.enum(['block', 'warn', 'track']),
    source_change: workItemId.optional().describe('work item/ChangeContract that promoted this'),
  })
  .superRefine((value, ctx) => {
    if (value.evaluator.mode === 'llm_judged' && !value.evaluator.reproducibility) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'llm_judged evaluator requires reproducibility',
        path: ['evaluator', 'reproducibility'],
      });
    }
  })
  .describe('ACG FitnessFunction — continuous fitness predicate');

export type AcgFitnessFunction = z.infer<typeof acgFitnessFunction>;
