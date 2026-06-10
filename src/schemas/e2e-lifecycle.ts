import { z } from 'zod';

/**
 * DSL 파생 테스트 수명주기 결정 기록 (wi_260610p9h ac-8 집행 절반).
 *
 * One line per user-confirmed update/delete of a DSL-derived test. As with
 * `e2eFailureVerdict`, `confirmed_by_user` is the literal `true` — an
 * unconfirmed lifecycle action is unrepresentable, not merely discouraged.
 * Ledger: `.ditto/local/work-items/<wi>/e2e-lifecycle.jsonl` when a work item
 * is given, else `.ditto/local/e2e-lifecycle.jsonl` (work-item-independent).
 */

export const e2eLifecycleAction = z
  .enum(['update', 'delete'])
  .describe(
    'update = mark for regeneration (scripter re-runs); delete = remove journey + derived spec',
  );

export type E2eLifecycleAction = z.infer<typeof e2eLifecycleAction>;

export const e2eLifecycleDecision = z
  .object({
    action: e2eLifecycleAction,
    journey_id: z.string().min(1).describe('Journey id (jrn-…)'),
    journey_file: z.string().min(1).describe('Repo-relative .journey.md path'),
    confirmed_by_user: z
      .literal(true)
      .describe('Literal true — a lifecycle action not confirmed by the user cannot be recorded'),
    reason: z.string().min(1).optional().describe('Why the test became update/delete-worthy'),
    deleted_files: z
      .array(z.string())
      .default([])
      .describe('Repo-relative files removed (delete action)'),
    preserved_helpers: z
      .array(z.string())
      .default([])
      .describe('Shared block helpers kept because another journey still references them'),
    decided_at: z.string().min(1).describe('ISO timestamp of the user decision'),
  })
  .describe('One user-confirmed lifecycle decision (e2e-lifecycle.jsonl line)');

export type E2eLifecycleDecision = z.infer<typeof e2eLifecycleDecision>;
