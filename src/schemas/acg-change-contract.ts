import { z } from 'zod';
import { acgChangeEnvelope, acgEvidenceKind } from './acg-common';

/**
 * ACG ChangeContract (20-contracts §1) — Design by Contract applied to a change.
 * The variable-time projection of IntentContract; a thin work-item sidecar.
 */

export const acgScopeRef = z
  .object({
    kind: z.enum(['path', 'glob', 'symbol', 'public_surface', 'layer']),
    ref: z.string().min(1),
    note: z.string().optional(),
  })
  .describe('A scope reference (frame condition target)');

export const acgInvariant = z
  .object({
    statement: z.string().min(1),
    promotable: z
      .boolean()
      .describe('True if a codebase-wide property → FitnessFunction promotion candidate'),
  })
  .describe('A property that must still hold after the change');

export const acgAcceptanceCriterion = z
  .object({
    criterion: z.string().min(1),
    evidence_kind: acgEvidenceKind,
  })
  .describe('One acceptance criterion with the evidence kind that closes it');

export const acgChangeContract = z
  .object({
    ...acgChangeEnvelope('acg.change-contract.v1'),
    purpose: z.string().min(1).describe('The result the change pursues (intent, not code)'),
    allowed_scope: z
      .array(acgScopeRef)
      .default([])
      .describe('Frame condition: only paths/symbols here may be modified'),
    forbidden_scope: z
      .array(acgScopeRef)
      .min(1)
      .describe('Must stay untouched. Non-empty — an empty forbid = unbounded change'),
    invariants: z.array(acgInvariant).default([]),
    acceptance: z.array(acgAcceptanceCriterion).min(1),
    decision_ref: z
      .string()
      .nullable()
      .default(null)
      .describe('ADR/decision id. Required when risk_default ≥ medium (stage-2 gate)'),
    risk_default: z.enum(['low', 'medium', 'high']).default('low'),
  })
  .superRefine((value, ctx) => {
    // Stage-2 gate (10-methodology §2 / 20-contracts §1): medium+ risk needs a decision_ref.
    if (value.risk_default !== 'low' && !value.decision_ref) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'risk_default >= medium requires a decision_ref',
        path: ['decision_ref'],
      });
    }
  })
  .describe('ACG ChangeContract — allowed/forbidden frame + invariants + acceptance');

export type AcgChangeContract = z.infer<typeof acgChangeContract>;
export type AcgScopeRef = z.infer<typeof acgScopeRef>;
