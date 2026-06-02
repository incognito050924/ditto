import { z } from 'zod';
import { evidenceRef, relativePath, schemaVersion, severity, verdict, workItemId } from './common';

// Honesty labels (§6.9). Single source; reused by interview-state.
export const honestyKind = z
  .enum(['finding', 'hypothesis', 'taste'])
  .describe('What the item is; backing-less claims are hypothesis, not finding');

export const confidenceLevel = z
  .enum(['high', 'medium', 'low'])
  .describe('Confidence in a claim; backing-less claims must be low');

export const ledgerStatus = z
  .enum(['acted', 'deferred', 'dismissed'])
  .describe('What was done with the item; deferred/dismissed require a reason');

// How a closure was reached (ledger-primary, §W1-2). Single source; reused by
// interview-state. mutual_agreement = the gate genuinely passed; ledger_only =
// the deterministic floor/cap forced closure without the gate passing;
// safe_default = closed by deferring to a conservative stance.
export const closureMode = z
  .enum(['mutual_agreement', 'ledger_only', 'safe_default'])
  .describe('How the closure was reached, not why (that is exit.reason)');

export const convergenceVersion = z
  .object({
    version: z.number().int().positive(),
    score: z.number(),
    evidence_refs: z.array(evidenceRef).default([]),
  })
  .describe('One scored version of the refined artifact');

export const decisionLedgerEntry = z
  .object({
    id: z.string().min(1),
    round: z.number().int().nonnegative(),
    objection: z.string().min(1),
    kind: honestyKind,
    criterion_id: z.string().min(1).nullable().default(null),
    severity: severity,
    admissible: z.boolean(),
    status: ledgerStatus,
    confidence: confidenceLevel,
    backed_by: z.array(evidenceRef).default([]),
    reason: z.string().min(1).describe('Why acted/dismissed; required for symmetry (§3.2)'),
    supersedes: z.string().min(1).nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'finding' && value.backed_by.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'kind=finding requires non-empty backed_by',
        path: ['backed_by'],
      });
    }
    // Derivable consistency: an admissible objection must carry a high/critical
    // severity (mirrors stop.ts ADMISSIBLE_SEVERITIES). Only bites when the
    // self-declared admissible flag is true.
    if (value.admissible === true && value.severity !== 'high' && value.severity !== 'critical') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'admissible=true requires severity high or critical (ADMISSIBLE_SEVERITIES)',
        path: ['admissible'],
      });
    }
  })
  .describe('Append-only decision ledger entry with honesty labels (§4.1, §6.1)');

export const convergence = z
  .object({
    schema_version: schemaVersion,
    work_item_id: workItemId,
    target_ref: z.string().min(1).describe('Node id, review id, or AC-set this refinement targets'),
    round_cap: z.number().int().positive(),
    rounds_run: z.number().int().nonnegative(),
    versions: z.array(convergenceVersion).min(1),
    selected_version: z.number().int().positive(),
    decision_ledger: z.array(decisionLedgerEntry).default([]),
    open_admissible_count: z.number().int().nonnegative(),
    gate: z.object({
      completion_gate: verdict,
      convergence_gate: z.enum(['no_open_admissible', 'open_admissible']),
      converged: z.boolean(),
    }),
    exit: z.object({
      reason: z.enum(['converged', 'cap_reached', 'blocked']),
      closure_mode: closureMode,
      verdict_delegated_to_completion: z.boolean().default(true),
      next_handoff_path: relativePath.nullable().default(null),
    }),
  })
  .describe('Convergence sidecar; records refinement closure, does not set verdict (§6.9)');

export type Convergence = z.infer<typeof convergence>;
export type DecisionLedgerEntry = z.infer<typeof decisionLedgerEntry>;
export type ClosureMode = z.infer<typeof closureMode>;
