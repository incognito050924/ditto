import { z } from 'zod';
import { acgChangeEnvelope } from './acg-common';

/**
 * ACG SemanticScanObservation (O2/O8, wi_260605aw1 S2) — the NON-GATED output of
 * an automated `ditto semantic observe` run.
 *
 * The autowiring dialectic (reviews/dialectic-1, OBJ-3) ruled that an automated
 * scan must NOT write the blocking `semantic-compatibility.json` (which would
 * force continuation the moment it appears). Instead it records what it observed
 * here — a plain list of changed exported signatures — which the Stop gate never
 * reads. Promotion observation → blocking verdict is an explicit act
 * (`ditto semantic detect`/`verdict`). Multiple changes are fine: this is a list,
 * not the single-`change` blocking artifact (resolves OBJ-5).
 *
 * `fingerprint` (base sha + diff hash) lets a re-run skip the expensive CodeQL
 * scan when nothing changed (OBJ-1).
 */

export const acgSemanticScanObservationChange = z.object({
  file: z.string().min(1),
  symbol: z.string().min(1),
  before: z.string().min(1),
  after: z.string().min(1),
});

export const acgSemanticScanObservation = z
  .object({
    ...acgChangeEnvelope('acg.semantic-scan-observation.v1'),
    base_used: z.string().min(1).describe('Git ref the scan diffed against'),
    language: z.string().min(1),
    source_root: z.string().min(1),
    fingerprint: z
      .string()
      .min(1)
      .describe('sha256(base sha + diff) — re-run skips when unchanged'),
    change_count: z.number().int().min(0),
    changes: z.array(acgSemanticScanObservationChange).default([]),
  })
  .describe('ACG SemanticScanObservation — non-gated record of observed signature changes');

export type AcgSemanticScanObservation = z.infer<typeof acgSemanticScanObservation>;
