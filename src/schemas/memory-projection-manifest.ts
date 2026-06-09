import { z } from 'zod';
import { isoDateTime, schemaVersion, sha256 } from './common';
import { memoryEventId } from './memory-event';
import { graphIrVersion } from './memory-graph-ir';
import { memorySourceId } from './memory-source';

export const memoryProjectionId = z
  .string()
  .regex(
    /^proj_[a-z0-9_-]{4,}$/,
    'projection id must start with proj_ followed by 4+ lowercase alphanumerics, underscore, or hyphen',
  )
  .describe('Stable identifier for one projection generation');

export const memorySourceRevision = z
  .object({
    source_id: memorySourceId,
    path: z.string().min(1).optional(),
    hash: sha256,
    revision: z.string().min(1),
    git_commit: z
      .string()
      .regex(/^[a-f0-9]{40}$/, 'git commit must be 40 lowercase hex characters')
      .optional(),
  })
  .describe('Which source version this projection reflects');

export const memoryProjectionManifest = z
  .object({
    schema_version: schemaVersion,
    projection_id: memoryProjectionId,
    generated_at: isoDateTime,
    graph_ir_version: graphIrVersion,
    wiki_version: z.string().min(1).optional(),
    serving_version: z.string().min(1).optional(),
    extractor_versions: z
      .record(z.string().min(1))
      .default({})
      .describe('extractor name -> version, e.g. { ast: ast-v1, semantic: semantic-v1 }'),
    source_revisions: z.array(memorySourceRevision).default([]),
    memory_event_until: memoryEventId
      .optional()
      .describe('latest event id reflected in this projection'),
    dirty_sources: z
      .array(memorySourceId)
      .default([])
      .describe('sources whose current hash differs from this projection'),
  })
  .describe(
    'Lineage contract: what inputs a projection was built from, so freshness is cheap to judge (report §3.4)',
  );

export type MemorySourceRevision = z.infer<typeof memorySourceRevision>;
export type MemoryProjectionManifest = z.infer<typeof memoryProjectionManifest>;
