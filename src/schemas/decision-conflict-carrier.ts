import { z } from 'zod';
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
  adr_id: z.string().regex(/^ADR-\d{4}$/, 'adr_id must be ADR-NNNN'),
  kind: z.enum(['forbid', 'require', 'prefer']),
  level: z.enum(['intent', 'method']),
  basis: z
    .string()
    .min(1)
    .describe('Evidence: what the ADR says and how the current work touches it'),
});

export const decisionConflictCarrier = z
  .object({
    schema_version: schemaVersion,
    mode: z.enum(['interactive', 'autopilot']),
    conflicts: z.array(decisionConflict).default([]),
  })
  .describe('Persisted inputs to decisionConflictGate, written by the detecting node');

export type DecisionConflictCarrier = z.infer<typeof decisionConflictCarrier>;
