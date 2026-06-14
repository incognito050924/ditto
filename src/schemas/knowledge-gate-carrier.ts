import { z } from 'zod';
import { schemaVersion } from './common';

/**
 * KnowledgeGateCarrier — the persisted inputs to `knowledgeUpdateGate`
 * (`src/core/gates.ts`). The three triggers and the four delta counts are decided
 * by the knowledge node (skill/agent) at recording time but were never persisted,
 * so the Stop hook had no way to enforce the gate at run time (only the manual
 * `ditto knowledge gate` CLI saw them). This carrier is that artifact: the
 * knowledge node writes it into the work-item dir, Stop reads it like every other
 * ledger (absent → inert, malformed → fail-closed).
 *
 * The shape mirrors `KnowledgeTriggers` + `KnowledgeRecordDelta` exactly so the
 * gate consumes it without translation. The gate (not this schema) owns the
 * trigger↔content consistency rule (over/under-recording); this schema only
 * carries what the node declared it saw and recorded.
 */
export const knowledgeGateCarrier = z
  .object({
    schema_version: schemaVersion,
    triggers: z
      .object({
        adr_worthy_decision: z.boolean(),
        new_agreed_term: z.boolean(),
        repeated_pattern: z.boolean(),
      })
      .describe('The three knowledge triggers the node declared for this work item'),
    delta: z
      .object({
        decisions: z.number().int().nonnegative(),
        glossary_terms: z.number().int().nonnegative(),
        patterns: z.number().int().nonnegative(),
        learnings: z.number().int().nonnegative(),
      })
      .describe('Per-update counts the node declared it recorded'),
  })
  .describe('Persisted inputs to knowledgeUpdateGate, written by the knowledge node');

export type KnowledgeGateCarrier = z.infer<typeof knowledgeGateCarrier>;
