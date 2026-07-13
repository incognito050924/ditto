import { z } from 'zod';
import { isoDateTime, schemaVersion, workItemId } from './common';

/**
 * ACG (Agentic Change Governance) shared schema pieces — the DITTO *binding* of
 * the ACG spec layer (20-contracts §0).
 *
 * Binding decisions (v0-implementation-plan.md §3):
 *  - D1 envelope is DITTO-native: schema_version + work_item_id + a `kind`
 *    discriminator (`acg.<name>.v1`) + provenance. There is NO separate
 *    `acg.*` wire envelope; the spec's `schema`/`work_item`/`produced_by`
 *    notation maps onto these DITTO field names (20-contracts §0.1/§0.2).
 */

/** Spec evidence_kind (20-contracts §1). Binds to DITTO evidenceRef.kind (§0.2). */
export const acgEvidenceKind = z
  .enum(['test', 'build', 'log', 'diff', 'screen', 'manual', 'e2e'])
  .describe('ACG acceptance/evidence kind; binds to DITTO evidenceRef.kind per 20-contracts §0.2');

export const acgProducedBy = z.enum(['agent', 'user']).describe('Who produced this ACG artifact');

/**
 * Envelope field map for a CHANGE-TIME artifact (tied to one work item).
 * Spread into a z.object: `z.object({ ...acgChangeEnvelope('acg.x.v1'), ... })`.
 */
export function acgChangeEnvelope(kind: string) {
  return {
    schema_version: schemaVersion,
    kind: z.literal(kind),
    work_item_id: workItemId,
    produced_by: acgProducedBy,
    produced_at: isoDateTime,
  };
}

/**
 * Envelope field map for a CATALOG artifact (per-repo, not tied to a work item):
 * ArchitectureSpec, JourneySpec. No work_item_id.
 */
export function acgCatalogEnvelope(kind: string) {
  return {
    schema_version: schemaVersion,
    kind: z.literal(kind),
    produced_by: acgProducedBy,
    produced_at: isoDateTime,
  };
}

/** Array of identity strings with enforced uniqueness (set semantics). */
export const uniqueStringSet = (describe: string) =>
  z
    .array(z.string().min(1))
    .refine((a) => new Set(a).size === a.length, { message: 'entries must be unique (set)' })
    .describe(describe);
