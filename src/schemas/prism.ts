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
