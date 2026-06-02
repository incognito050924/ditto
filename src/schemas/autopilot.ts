import { z } from 'zod';
import { autopilotId, evidenceRef, isoDateTime, schemaVersion, workItemId } from './common';

export const nodeKind = z
  .enum([
    'research',
    'design',
    'implement',
    'review',
    'verify',
    'fix',
    'e2e',
    'docs',
    'knowledge',
    // [VERIFY] lifecycle kinds, wired to dedicated owners (contract §2.2).
    'security',
    'refactor',
    'retro',
    // `cleanup` is wired to the `driver` owner, not an LLM owner: it is
    // deterministic git/worktree work, so the engine runs it as a driver step
    // behind an explicit irreversible-git approval gate (contract §2.2).
    'cleanup',
  ])
  .describe('Kind of work a node represents');

export const nodeOwner = z
  .enum([
    'researcher',
    'planner',
    'implementer',
    'reviewer',
    'verifier',
    'architect',
    'playwright-e2e',
    'knowledge-curator',
    // [VERIFY] lifecycle owners (contract §2.2): a dedicated deep security pass,
    // a Tidy-First restructurer (mutating), and a retrospective writer.
    'security-reviewer',
    'refactorer',
    'retrospective',
    // Not an LLM subagent: the deterministic engine itself. Owns `cleanup` nodes
    // (git/worktree teardown) that the driver runs in-process, never spawns.
    'driver',
  ])
  .describe('Subagent role that owns the node');

export const nodeStatus = z
  .enum(['pending', 'running', 'passed', 'failed', 'blocked'])
  .describe('Execution state of a node');

export const approvalStatus = z
  .enum(['pending', 'approved', 'not_required', 'rejected'])
  .describe('Plan approval gate state for mutating work');

export const approvalSource = z
  .enum(['user', 'approved_spec', 'issue', 'prd', 'small_reversible_policy'])
  .describe('Where the approval (or its waiver) comes from');

export const autopilotMode = z.enum(['autopilot']).describe('Driver mode; only autopilot in v0');

export const completionBoundary = z
  .enum(['entire_work_item'])
  .describe('Scope the autopilot must complete; never narrowed mid-run');

export const stopCondition = z
  .enum([
    'all_acceptance_criteria_passed_or_explicitly_closed',
    'blocked_by_user_owned_decision',
    'blocked_by_external_system',
    'safety_boundary_hit',
  ])
  .describe('Condition that yields control back to the user/plan');

export const autopilotNode = z
  .object({
    id: z.string().min(1),
    kind: nodeKind,
    owner: nodeOwner,
    purpose: z.string().min(1),
    status: nodeStatus,
    depends_on: z.array(z.string()).default([]),
    acceptance_refs: z.array(z.string()).default([]),
    evidence_refs: z.array(evidenceRef).default([]),
    attempts: z
      .object({ fix: z.number().int().nonnegative(), switch: z.number().int().nonnegative() })
      .default({ fix: 0, switch: 0 }),
  })
  .describe('One node in the autopilot graph');

export const nodeProposal = z
  .object({
    id: z.string().min(1),
    kind: nodeKind,
    purpose: z.string().min(1),
    depends_on: z.array(z.string()).default([]),
    acceptance_refs: z.array(z.string()).default([]),
  })
  .describe(
    'Intent-level node a planner emits (A-3). The mechanical fields (owner/status/' +
      'attempts/evidence) are derived on promotion via proposalsToNodes; the integrity ' +
      'gate (validateNodeAddition) then guards the splice.',
  );

export const autopilot = z
  .object({
    schema_version: schemaVersion,
    autopilot_id: autopilotId,
    work_item_id: workItemId,
    mode: autopilotMode.default('autopilot'),
    root_goal: z.string().min(1).describe('Whole requested goal; never split, only nodes are'),
    completion_boundary: completionBoundary.default('entire_work_item'),
    approval_gate: z.object({
      status: approvalStatus,
      source: approvalSource.nullable().default(null),
      approved_at: isoDateTime.nullable().default(null),
      approved_by: z.string().min(1).nullable().default(null),
      evidence_refs: z.array(evidenceRef).default([]),
    }),
    nodes: z.array(autopilotNode).default([]),
    caps: z.object({
      fix_per_node: z.number().int().nonnegative(),
      switch_per_node: z.number().int().nonnegative(),
      // Forward re-expansion budget (§4.3): max forward fix↔review rounds before
      // the node-*between* convergence loop escalates. `.default` so a legacy
      // graph written before this field parses without regression.
      converge_rounds: z.number().int().positive().default(3),
    }),
    continue_policy: z.object({
      continue_after_approval: z.boolean().default(true),
      continue_after_checkpoint: z.boolean().default(true),
      continue_after_fixable_failure: z.boolean().default(true),
      ask_user_only_for_user_owned_decisions: z.boolean().default(true),
    }),
    stop_conditions: z.array(stopCondition).default([]),
    user_interrupt_policy: z
      .enum(['ask_only_for_user_owned_decisions'])
      .default('ask_only_for_user_owned_decisions'),
  })
  .describe('Autopilot graph state; mutated only through AutopilotStore (§6.5)');

export type Autopilot = z.infer<typeof autopilot>;
export type AutopilotNode = z.infer<typeof autopilotNode>;
export type NodeProposal = z.infer<typeof nodeProposal>;
