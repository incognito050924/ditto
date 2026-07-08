import { z } from 'zod';
import { isoDateTime, schemaVersion, workItemId } from './common';
import { coverageMap } from './coverage';

/**
 * Prism issue-map schema (wi_260707oi1, node oi1-issuemap-engine).
 *
 * The prism issue map REUSES the coverage scope tree (`coverage.ts` / the
 * `coverage-manager.ts` pure functions do the append-only node CRUD, closure, and
 * false-green gate) and adds ONLY the net-new prism concerns on top:
 *   - severity authority (MODEL-2): which nodes are `critical`, code-gated so the
 *     actor who benefits from the launch gate cannot silently control severity;
 *   - a durable one-shot minimal-launch notification stamp (ac-4).
 *
 * It is NOT a third tree engine — the tree itself is a `coverageMap` (§ design
 * decision 1: reuse, never re-implement).
 */

export const prismSeverity = z
  .enum(['critical', 'noncritical'])
  .describe('Prism node severity — critical nodes gate minimal-launch (MODEL-2)');

export type PrismSeverity = z.infer<typeof prismSeverity>;

export const prismSeverityAssignment = z
  .object({
    node_id: z.string().min(1),
    severity: prismSeverity,
    // MODEL-2: a critical→noncritical DEMOTION must record an explicit justification,
    // isomorphic to a non-resolved close's residual_risk. Absent on a plain
    // (up/first) assignment; required only on a demotion (enforced by the gate).
    demotion_reason: z
      .string()
      .optional()
      .describe('Explicit justification recorded on a critical→noncritical demotion (MODEL-2)'),
  })
  .describe('One code-gated per-node severity assignment (MODEL-2)');

export type PrismSeverityAssignment = z.infer<typeof prismSeverityAssignment>;

// ── prism-level per-node evaluation annotation (ac-1 / ac-5 / ac-6) ───────────

/**
 * Argumentation 3-value (Verheij 2005, Argumentation 19:347-371 → Dung in/out/undec).
 * Structural closure ≠ soundness: a node the coverage tree calls `resolved` is only
 * `justified` when it carries a real justifying reason; a node with a surviving
 * rebuttal is `defeated`; a node closed with NEITHER is `unevaluated`. This is a
 * PRISM-LEVEL stamp only — the shared coverage.ts `state` enum (22 consumers) is
 * NOT extended, so `unevaluated` lives here beside the tree, never inside it (A2).
 */
export const prismEvaluation = z
  .enum(['justified', 'defeated', 'unevaluated'])
  .describe(
    'Argumentation 3-value: justified (real justifying reason) · defeated (surviving rebuttal) · unevaluated (a critical resolved-close REJECTED for lacking justification) — prism-level, not the coverage state enum (ac-1)',
  );

export type PrismEvaluation = z.infer<typeof prismEvaluation>;

/**
 * Self-describing status of the opponent seam on a node (OBJ-3 / ADR-0018). When the
 * opponent host (dialectic-opponent, ac-5; Codex opponent, ac-6) is absent the seam
 * degrades to the deterministic shell — but the degrade is STAMPED (`host_absent`),
 * NEVER silent. Mirrors coverage.ts `oracleAdvisoryReason` `tool_absent`.
 */
export const prismOpponentStatus = z
  .enum(['engaged', 'host_absent'])
  .describe(
    'Opponent-seam status: engaged (host ran, critique/dissent recorded) · host_absent (opponent host missing → graceful degrade to the deterministic shell, self-describing not silent, ADR-0018 / OBJ-3)',
  );

export type PrismOpponentStatus = z.infer<typeof prismOpponentStatus>;

/**
 * One prism-level evaluation record for a node — the argumentation state (ac-1), the
 * A2 close-gate inputs closePrismNode reads for a critical `resolved` close, and the
 * opponent-seam output (ac-5 critique/Popper refutation · ac-6 independent dissent).
 * Every field but `node_id` is OPTIONAL — a node may carry only some of these (e.g.
 * an `unevaluated` stamp with no opponent output yet), and an old issue-map.json with
 * no evaluations array at all parses unchanged (additive-optional, backward-compat).
 */
export const prismNodeEvaluation = z
  .object({
    node_id: z.string().min(1),
    evaluation: prismEvaluation
      .optional()
      .describe('Argumentation 3-value stamp for this node (ac-1)'),
    // A2 close-gate inputs: closePrismNode requires BOTH on a critical `resolved`
    // close; either missing → the close is rejected and the node is stamped
    // `unevaluated`. Recorded here (prism-level), isomorphic to the residual_risk
    // gate on an unknown-close — symmetry with the existing MODEL-1 gate (ac-1).
    justifying_reason: z
      .string()
      .optional()
      .describe(
        'The actual reason justifying a critical resolved-close (A2 close-gate input, ac-1)',
      ),
    refutation_attempted: z
      .boolean()
      .optional()
      .describe(
        'Whether a strongest-rebuttal (Popper refutation) was attempted before closing — the field-presence gate closePrismNode reads (A2, ac-1)',
      ),
    // Opponent-seam output recorded on the node (the model half of A2/anchor re-facing).
    opponent_critique: z
      .string()
      .optional()
      .describe(
        'Dialectic-opponent critique + Popper refutation recorded on a flagged critical node (ac-5)',
      ),
    opponent_dissent: z
      .string()
      .optional()
      .describe(
        'Codex independent 2nd-perspective dissent re-derived from original intent at anchor re-facing (ac-6)',
      ),
    opponent_status: prismOpponentStatus
      .optional()
      .describe(
        'Self-describing opponent-seam status; host_absent when the host degrades (OBJ-3 / ADR-0018)',
      ),
  })
  .describe(
    'One prism-level per-node evaluation annotation — argumentation state + opponent seam (ac-1/ac-5/ac-6)',
  );

export type PrismNodeEvaluation = z.infer<typeof prismNodeEvaluation>;

export const prismIssueMap = z
  .object({
    schema_version: schemaVersion,
    work_item_id: workItemId,
    // The reused coverage tree — node CRUD / close / select run through the
    // coverage-manager pure functions on THIS field (design decision 1).
    tree: coverageMap,
    severities: z
      .array(prismSeverityAssignment)
      .default([])
      .describe('Per-node severity authority state (MODEL-2)'),
    // ac-1/ac-5/ac-6: prism-level per-node evaluation annotation, sibling to
    // `severities`. Additive-optional (default []) so an old issue-map.json parses
    // unchanged: argumentation 3-value (unevaluated), the A2 close-gate inputs, and
    // the opponent seam's critique/dissent + self-describing degrade status.
    evaluations: z
      .array(prismNodeEvaluation)
      .default([])
      .describe(
        'Per-node prism-level argumentation + opponent-seam evaluation state (ac-1/ac-5/ac-6)',
      ),
    // ac-4: durable one-shot minimal-launch notification. Set when critical scope is
    // all resolved and non-critical scope survives; CLEARED (retracted) when the map
    // regresses (a new/reopened critical node), so re-reaching re-notifies.
    notified_at: isoDateTime
      .optional()
      .describe('When minimal-launch was announced (one-shot; retracted on regression, ac-4)'),
  })
  .describe('Prism issue map — coverage tree + severity authority + launch notification (oi1)');

export type PrismIssueMap = z.infer<typeof prismIssueMap>;

/**
 * Decision-grade prism record (Record tier, durable). The Run-tier issue map is a
 * discardable draft; these are the decision-grade events that must survive a Run
 * wipe (approval / unknown-close / skip / early-exit / launch notification).
 */
export const prismDecisionKind = z
  .enum(['severity_demotion', 'unknown_close', 'skip', 'early_exit', 'notified', 'challenge_admit'])
  .describe('Kind of decision-grade prism record kept in the durable Record tier');

export const prismDecision = z
  .object({
    schema_version: schemaVersion,
    work_item_id: workItemId,
    kind: prismDecisionKind,
    node_id: z.string().min(1).optional(),
    reason: z.string().min(1).describe('Why this decision was made (never silent)'),
    residual_risk: z.string().optional().describe('Surviving risk, when the decision leaves one'),
    recorded_at: isoDateTime,
  })
  .describe('One append-only decision-grade prism record (Record tier)');

export type PrismDecisionKind = z.infer<typeof prismDecisionKind>;
export type PrismDecision = z.infer<typeof prismDecision>;
