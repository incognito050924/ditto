import { z } from 'zod';
import { isoDateTime, schemaVersion, sha256 } from './common';
import { memorySourceId } from './memory-source';

export const memoryConfidenceKind = z
  .enum(['EXTRACTED', 'INFERRED', 'AMBIGUOUS'])
  .describe(
    'Provenance class of a relation: EXTRACTED (explicit in source), INFERRED (deduced), AMBIGUOUS (uncertain — review only)',
  );

export const memoryExtractedBy = z
  .enum(['tree-sitter', 'codeql', 'impact', 'llm', 'node2vec', 'human', 'other'])
  .describe('What produced this node/edge');

export const extractionRunId = z
  .string()
  .regex(
    /^xrun_[a-z0-9_-]{4,}$/,
    'extraction run id must start with xrun_ followed by 4+ lowercase alphanumerics, underscore, or hyphen',
  )
  .describe('Stable identifier for one extraction run');

export const graphIrVersion = z
  .string()
  .regex(
    /^ir_[a-z0-9_-]{4,}$/,
    'graph IR version must start with ir_ followed by 4+ lowercase alphanumerics, underscore, or hyphen',
  )
  .describe('Stable identifier for one Graph IR snapshot');

export const memoryNodeType = z
  .enum([
    'Source',
    'Artifact',
    'Symbol',
    'DocumentSection',
    'Entity',
    'Concept',
    'Claim',
    'Decision',
    'Episode',
    'MemoryEvent',
    'GraphReport',
  ])
  .describe('Node label (report §3.3 / §8)');

export const memoryEdgeType = z
  .enum([
    'CALLS',
    'IMPORTS',
    'EXTENDS',
    'IMPLEMENTS',
    'MENTIONS',
    'ASSERTS',
    'SUPPORTS',
    'CONTRADICTS',
    'SIMILAR_TO',
    'RELATED_TO',
    'RATIONALE_FOR',
    'ALIAS_OF',
    'SUPERSEDES',
  ])
  .describe('Edge relation type');

export const memoryHyperedgeRelation = z
  .enum(['PARTICIPATE_IN', 'IMPLEMENT', 'FORM'])
  .describe('N-ary relation type for a hyperedge');

export const memoryProvenance = z
  .object({
    source_id: memorySourceId.optional(),
    source_revision: z.string().min(1).optional(),
    source_hash: sha256.optional(),
    source_span: z.string().optional().describe('line range, page, timestamp, etc.'),
    extraction_run_id: extractionRunId,
    extracted_by: memoryExtractedBy,
    schema_version: schemaVersion,
  })
  .describe('Where a node/edge came from — required so the graph stays regenerable (report §5.2)');

export const memoryNode = z
  .object({
    id: z
      .string()
      .min(1)
      .describe('Canonical id, e.g. artifact:<path> or symbol:<path>#<qualified_name>'),
    node_type: memoryNodeType,
    name: z.string().min(1),
    file_type: z.enum(['code', 'document', 'paper', 'image']).optional(),
    source_id: memorySourceId.optional(),
    source_revision: z.string().min(1).optional(),
    source_span: z.string().optional(),
    properties: z.record(z.unknown()).default({}),
    provenance: memoryProvenance.optional(),
  })
  .describe('One graph node');

const enforceConfidenceBands = (
  kind: z.infer<typeof memoryConfidenceKind>,
  score: number,
  ctx: z.RefinementCtx,
): void => {
  // graphify confidence discipline (companion §2.3): no 0.5-default, calibrated bands.
  if (kind === 'EXTRACTED' && score !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'EXTRACTED relations must have confidence_score = 1.0',
      path: ['confidence_score'],
    });
  }
  if (kind === 'AMBIGUOUS' && (score < 0.1 || score > 0.3)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'AMBIGUOUS relations must have confidence_score in [0.1, 0.3]',
      path: ['confidence_score'],
    });
  }
  if (kind === 'INFERRED' && (score < 0.4 || score > 0.95)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'INFERRED relations must have confidence_score in [0.4, 0.95]',
      path: ['confidence_score'],
    });
  }
};

export const memoryEdge = z
  .object({
    id: z.string().min(1),
    from: z.string().min(1).describe('source node id'),
    to: z.string().min(1).describe('target node id'),
    edge_type: memoryEdgeType,
    confidence_kind: memoryConfidenceKind,
    confidence_score: z.number().min(0).max(1),
    properties: z.record(z.unknown()).default({}),
    provenance: memoryProvenance,
    weight: z.number().positive().default(1),
    valid_from: isoDateTime.optional(),
    valid_to: isoDateTime.optional(),
    expires_at: isoDateTime.optional().describe('TTL for inferred candidates (report §6.5)'),
    requires_review: z.boolean().default(false),
    used_as_evidence: z.boolean().default(false),
  })
  .superRefine((edge, ctx) =>
    enforceConfidenceBands(edge.confidence_kind, edge.confidence_score, ctx),
  )
  .describe('One directed graph edge with provenance and calibrated confidence');

export const memoryHyperedge = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    nodes: z.array(z.string().min(1)).min(3).describe('3+ node ids participating together'),
    relation: memoryHyperedgeRelation,
    confidence_kind: memoryConfidenceKind,
    confidence_score: z.number().min(0).max(1),
    provenance: memoryProvenance,
  })
  .superRefine((h, ctx) => enforceConfidenceBands(h.confidence_kind, h.confidence_score, ctx))
  .describe('N-ary relation among 3+ nodes (companion §4-1)');

export const memoryGraphIr = z
  .object({
    schema_version: schemaVersion,
    ir_version: graphIrVersion,
    generated_at: isoDateTime,
    extraction_run_id: extractionRunId,
    nodes: z.array(memoryNode).default([]),
    edges: z.array(memoryEdge).default([]),
    hyperedges: z.array(memoryHyperedge).default([]),
  })
  .describe(
    'Compiled intermediate representation between extractors and projections — regenerable, never SoT (report §3.3)',
  );

export type MemoryProvenance = z.infer<typeof memoryProvenance>;
export type MemoryNode = z.infer<typeof memoryNode>;
export type MemoryEdge = z.infer<typeof memoryEdge>;
export type MemoryHyperedge = z.infer<typeof memoryHyperedge>;
export type MemoryGraphIr = z.infer<typeof memoryGraphIr>;
