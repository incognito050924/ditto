import { z } from 'zod';
import { ADR_ID_FULL_RE } from './adr-id';
import { schemaVersion } from './common';

/**
 * DecisionConflictCarrier — the persisted inputs to `decisionConflictGate`
 * (`src/core/gates.ts`, ADR-0020). An agent that detected ADR conflicts while
 * processing a node declares them here (work-item dir); the Stop hook reads it like
 * every other ledger (absent → inert, malformed → fail-closed) and runs the gate so
 * an intent conflict under autopilot blocks the run (D3 fail-closed), while EVERY
 * detected conflict — even an auto-aligned method conflict — is disclosed at the
 * boundary (D2 transparency: silent autonomous compliance is forbidden).
 *
 * The conflict shape mirrors `DecisionConflict` exactly so the gate consumes it
 * without translation. WHETHER a conflict exists and its (kind, level) is the LLM
 * layer's judgement (ADR-0001/0020 D4); this schema only carries the declaration.
 */
export const decisionConflict = z.object({
  adr_id: z
    .string()
    .regex(
      ADR_ID_FULL_RE,
      'adr_id must be legacy ADR-NNNN or new ADR-YYYYMMDD-slug (slug = lowercase alphanumeric words, hyphen-separated)',
    ),
  kind: z.enum(['forbid', 'require', 'prefer']),
  level: z.enum(['intent', 'method']),
  basis: z
    .string()
    .min(1)
    .describe('Evidence: what the ADR says and how the current work touches it'),
  // Optional per-conflict RESOLUTION record (wi_2607222uc): the detecting side
  // asserts the conflicting ADR was superseded after a re-collation with the user.
  // A claim alone demotes NOTHING — the gate verifies the ADR's status line at the
  // HEAD commit (positive evidence only; every failure branch stays blocking,
  // fail-closed — see `splitResolvedConflicts` in src/core/gates.ts). Additive +
  // optional: a legacy carrier without it parses and blocks exactly as before
  // (schema_version stays 0.1.0 — the literal is shared across every artifact).
  resolution: z
    .object({
      superseded_by: z
        .string()
        .regex(
          ADR_ID_FULL_RE,
          'superseded_by must be legacy ADR-NNNN or new ADR-YYYYMMDD-slug (slug = lowercase alphanumeric words, hyphen-separated)',
        )
        .describe('The successor ADR the conflicting decision was superseded by'),
      basis: z
        .string()
        .min(1)
        .describe('Re-collation evidence: why/how the conflict was resolved with the user'),
    })
    .optional()
    .describe(
      'Claimed resolution of this conflict; demotes the block only after HEAD verification',
    ),
});

export const decisionConflictCarrier = z
  .object({
    schema_version: schemaVersion,
    mode: z.enum(['interactive', 'autopilot']),
    conflicts: z.array(decisionConflict).default([]),
  })
  .describe('Persisted inputs to decisionConflictGate, written by the detecting node');

export type DecisionConflictCarrier = z.infer<typeof decisionConflictCarrier>;
