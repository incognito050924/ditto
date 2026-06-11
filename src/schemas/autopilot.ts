import { z } from 'zod';
import {
  autopilotId,
  evidenceRef,
  isoDateTime,
  relativePath,
  schemaVersion,
  verdict,
  workItemId,
} from './common';

export const nodeKind = z
  .enum([
    'research',
    'design',
    'implement',
    'review',
    'verify',
    'fix',
    // `e2e` (one-off journey run, owner playwright-e2e): since the proposal
    // model (wi_260610p9h) the planner no longer adds these itself — the kind
    // stays for manually-authored graphs and the skills/e2e runtime.
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
    // `e2e-author` is wired to the `main-session` owner, not a subagent: journey
    // authoring needs a user dialogue, which only the session-rooted main agent
    // can hold (wi_260610p9h). The driver runs the ditto:e2e-author skill inline.
    'e2e-author',
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
    // Not a subagent either: the main session itself. Owns `e2e-author` nodes —
    // scenario authoring requires a user dialogue (session rooting), so the
    // driver executes the skill inline in the main session, never spawns.
    'main-session',
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
    // Per-AC verdicts a judging node (verifier/e2e) emits for the criteria it
    // addresses. A node carries a single status, but a verification node can pass
    // *as a node* (it ran, produced evidence) while judging a specific criterion
    // partial/fail/unverified. Recording the per-AC judgment here keeps the
    // completion bridge (deriveAcVerdicts) from letting the node-level pass absorb
    // a per-AC non-pass (false-green at the completion gate; claim ≠ proof, §6.8).
    // Optional + default [] — a legacy graph and any non-judging node parse
    // unchanged. criterion_ids outside `acceptance_refs` are ignored downstream.
    ac_verdicts: z
      .array(z.object({ criterion_id: z.string().min(1), verdict, notes: z.string().optional() }))
      .default([]),
    attempts: z
      .object({ fix: z.number().int().nonnegative(), switch: z.number().int().nonnegative() })
      .default({ fix: 0, switch: 0 }),
    // Optional planner suggestion of a specialized variant name. Late binding:
    // it only orders/ensures that variant in the dispatch candidates; the driver
    // still makes the final selection. Survives promotion from nodeProposal.
    agent_hint: z.string().optional(),
    // Optional per-node file scope: the repo-relative files this node may touch.
    // Drives the file-overlap gate so two mutating nodes with overlapping scope
    // never run concurrently (within a wave and across next-node calls). Optional
    // + additive: a node without it falls back to the work item's changed_files.
    file_scope: z.array(relativePath).optional(),
  })
  .describe('One node in the autopilot graph');

export const nodeProposal = z
  .object({
    id: z.string().min(1),
    kind: nodeKind,
    purpose: z.string().min(1),
    depends_on: z.array(z.string()).default([]),
    acceptance_refs: z.array(z.string()).default([]),
    // Optional: a planner MAY suggest a specialized variant for this node. The
    // hint is late-bound — it only orders the dispatch candidates; the driver
    // still selects. Copied onto the promoted node by proposalsToNodes.
    agent_hint: z.string().optional(),
    // Optional per-node file scope a planner MAY declare so the promoted node
    // serializes against overlapping mutating nodes. Copied onto the node by
    // proposalsToNodes when present, like agent_hint.
    file_scope: z.array(relativePath).optional(),
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
