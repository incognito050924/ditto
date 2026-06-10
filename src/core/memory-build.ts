/**
 * `ditto memory build --semantic` engine (increment #4) — design §10-5 / §4-2 /
 * §4-6, frozen contract D1 (OBJ-10).
 *
 * ditto does NOT hold the provider (ADR-0001). This module builds the
 * deterministic scaffolding around host-delegated LLM extraction:
 *
 *   - chunkSources():        split scanned sources into chunks (20–25 files) and
 *                            emit one extraction REQUEST PACKET per chunk for the
 *                            `memory-extractor` agent (wired in #8).
 *   - mergeIrFragments():    the load-bearing, pure, DETERMINISTIC reducer that
 *                            folds the IR fragments the host returns into one
 *                            canonical node/edge set (D1 / ac-4).
 *
 * Determinism (ac-4 / §4-2): mergeIrFragments is a pure function of its input
 * fragments only — no clock, no RNG, no input-order dependence. Same fragments
 * (in any order) → bit-identical canonical content (nodes+edges). Run metadata
 * (ir_version, generated_at, extraction_run_id) is layered on by the caller and
 * is deliberately NOT part of the canonical content the golden fixture pins.
 */
import { z } from 'zod';
import {
  type MemoryEdge,
  type MemoryGraphIr,
  type MemoryNode,
  memoryConfidenceKind,
  memoryEdgeType,
  memoryNodeType,
} from '~/schemas/memory-graph-ir';
import { type memorySensitivity, memorySourceId } from '~/schemas/memory-source';

/** Files per extraction chunk (design §4-2 / §10-5: 20–25 files). */
export const CHUNK_FILE_COUNT = 22;

export type MemorySensitivity = z.infer<typeof memorySensitivity>;

/** One source file handed to the extractor (path + content for the chunk packet). */
export interface ChunkFile {
  source_id: string;
  path: string;
  content: string;
  /**
   * Disclosure class. When `'secret'` the file is excluded from chunks so its
   * content never reaches the host extractor LLM (F6 / ac-5). Optional: existing
   * callers that omit it are treated as non-secret (non-invasive).
   */
  sensitivity?: MemorySensitivity;
}

/**
 * One extraction request packet for the `memory-extractor` agent. ditto only
 * builds these; the host runs the LLM and returns IR fragments (delegation —
 * ADR-0001). `chunk_id` is positional/stable so the same scan yields the same
 * packets.
 */
export interface ExtractionChunkRequest {
  chunk_id: string;
  files: ChunkFile[];
}

/**
 * Split scanned sources into deterministic chunks. Input is sorted by source_id
 * so chunk membership is stable across runs (path-derived ids; §10-3 scan).
 */
export function chunkSources(
  sources: ChunkFile[],
  chunkSize: number = CHUNK_FILE_COUNT,
): ExtractionChunkRequest[] {
  const size = Math.max(1, Math.floor(chunkSize));
  // F6/ac-5: drop secret files before chunking so their content is never handed
  // to the host extractor LLM. Filtering first keeps chunk indices over the
  // disclosed set.
  const sorted = [...sources]
    .filter((s) => s.sensitivity !== 'secret')
    .sort((a, b) => (a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : 0));
  const chunks: ExtractionChunkRequest[] = [];
  for (let i = 0; i < sorted.length; i += size) {
    const idx = chunks.length;
    chunks.push({
      chunk_id: `chunk_${String(idx).padStart(4, '0')}`,
      files: sorted.slice(i, i + size),
    });
  }
  return chunks;
}

/** Confidence kinds the extractor may emit (semantic relations are advisory). */
const semanticConfidenceKind = memoryConfidenceKind.exclude(['EXTRACTED']);

const fragmentNodeSchema = z.object({
  /** Optional raw id; for Concept nodes it is re-derived from the label. */
  id: z.string().min(1).optional(),
  node_type: memoryNodeType,
  name: z.string().min(1),
  source_id: memorySourceId,
  properties: z.record(z.unknown()).optional(),
});

const fragmentEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  edge_type: memoryEdgeType,
  confidence_kind: semanticConfidenceKind,
  confidence_score: z.number().min(0).max(1),
  source_id: memorySourceId,
  properties: z.record(z.unknown()).optional(),
});

const irFragmentSchema = z.object({
  nodes: z.array(fragmentNodeSchema).default([]),
  edges: z.array(fragmentEdgeSchema).default([]),
});

/** Validate a list of host-returned IR fragments (used by the CLI `--fragments` input). */
export const irFragmentsSchema = z.array(irFragmentSchema);

export type SemanticConfidenceKind = z.infer<typeof semanticConfidenceKind>;
export type FragmentNode = z.infer<typeof fragmentNodeSchema>;
export type FragmentEdge = z.infer<typeof fragmentEdgeSchema>;

/**
 * One IR fragment returned by the host extractor for a chunk. Nodes/edges are
 * partial (the reducer fills derived/required fields); the extractor MUST tag a
 * confidence_kind ∈ {INFERRED, AMBIGUOUS} and a source_id (provenance — §10-5).
 */
export type IrFragment = z.infer<typeof irFragmentSchema>;

/**
 * The function the host injects to actually run extraction for one chunk. ditto
 * never calls a provider directly (ADR-0001); tests pass a synthetic resolver.
 */
export type ExtractFn = (chunk: ExtractionChunkRequest) => Promise<IrFragment>;

/**
 * Concept-id normalization (frozen D1.a): lowercase, normalize all whitespace
 * AND punctuation runs to a single space, trim. Stable concept id =
 * `concept:<normalized-label>`.
 */
export function normalizeConceptLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function conceptId(label: string): string {
  return `concept:${normalizeConceptLabel(label)}`;
}

/**
 * Resolve a node's canonical id. Concept nodes are keyed by their normalized
 * label (so re-extraction noise in the raw label folds to one node — §4-2(2));
 * any other node keeps its provided id (or, defensively, falls back to a
 * type+name id only if none was given).
 */
function canonicalNodeId(node: FragmentNode): string {
  if (node.node_type === 'Concept') return conceptId(node.name);
  if (node.id && node.id.length > 0) return node.id;
  return `${node.node_type.toLowerCase()}:${normalizeConceptLabel(node.name)}`;
}

/** Conservatism rank for confidence-kind conflict resolution (higher = more conservative). */
const KIND_RANK: Record<SemanticConfidenceKind, number> = { INFERRED: 0, AMBIGUOUS: 1 };

const SEMANTIC_RUN_ID = 'xrun_semantic' as const;
const SCHEMA_VERSION = '0.1.0' as const;

function sortById<T extends { id: string }>(items: T[]): T[] {
  return items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Deterministic merge reducer (D1 / ac-4). Pure: depends only on `fragments`.
 *
 * Policy (frozen contract):
 *  - node id: Concept → `concept:<normalized-label>`; others keep their id.
 *    Duplicate ids fold to ONE node; properties are merged (union; on a key
 *    clash the value from the lexicographically-smaller (id, name) node wins,
 *    so order of arrival never matters).
 *  - edge id: derived as `<from>|<edge_type>|<to>` (after node-id remap), so the
 *    dedup key is exactly (from, to, edge_type).
 *  - edge confidence conflict: the MORE CONSERVATIVE kind wins (AMBIGUOUS >
 *    INFERRED); within the same kind the MAX score wins.
 *  - confidence band: extractor confidence_kind must be INFERRED | AMBIGUOUS and
 *    its score must sit in the schema band; out-of-band is a LOUD FAIL (no
 *    silent clamp) so §4-2 calibration discipline is enforced at merge time.
 *  - output sorted by id (nodes and edges).
 */
export function mergeIrFragments(fragments: IrFragment[]): {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
} {
  const provenance = (sourceId: string) => ({
    source_id: sourceId,
    extraction_run_id: SEMANTIC_RUN_ID,
    extracted_by: 'llm' as const,
    schema_version: SCHEMA_VERSION,
  });

  // --- nodes: fold by canonical id, order-independent property merge ---
  // remap raw concept ids (or name-derived ids) to canonical ids for edges.
  const idRemap = new Map<string, string>();
  const nodeAcc = new Map<string, MemoryNode>();

  // First pass collects every fragment node keyed by canonical id so we can
  // fold deterministically regardless of arrival order.
  const grouped = new Map<string, FragmentNode[]>();
  for (const frag of fragments) {
    for (const fn of frag.nodes) {
      const cid = canonicalNodeId(fn);
      if (fn.id && fn.id !== cid) idRemap.set(fn.id, cid);
      const bucket = grouped.get(cid);
      if (bucket) bucket.push(fn);
      else grouped.set(cid, [fn]);
    }
  }

  for (const [cid, group] of grouped) {
    // canonical winner = smallest by (id, name); its scalar fields win ties.
    const ordered = [...group].sort((a, b) => {
      const ka = `${a.id ?? ''}\u0000${a.name}`;
      const kb = `${b.id ?? ''}\u0000${b.name}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const winner = ordered[0] as FragmentNode;
    // merge properties: later (lexicographically larger) nodes fill only keys
    // the winner lacks; keys are then emitted in sorted order so the serialized
    // result is independent of input/arrival order (canonical determinism).
    const collected: Record<string, unknown> = {};
    for (const fn of ordered) {
      for (const [k, v] of Object.entries(fn.properties ?? {})) {
        if (!(k in collected)) collected[k] = v;
      }
    }
    const props: Record<string, unknown> = {};
    for (const k of Object.keys(collected).sort()) props[k] = collected[k];
    nodeAcc.set(cid, {
      id: cid,
      node_type: winner.node_type,
      name: winner.name,
      properties: props,
      provenance: provenance(winner.source_id),
    });
  }

  // --- edges: dedup by (from,to,edge_type) after node-id remap ---
  // Endpoint canonicalization: an explicit node remap wins; otherwise a raw
  // `concept:<label>` endpoint is normalized to its canonical concept id so an
  // edge that references a concept by raw label still folds to one node.
  const remapEndpoint = (raw: string): string => {
    const mapped = idRemap.get(raw);
    if (mapped) return mapped;
    if (raw.startsWith('concept:')) return conceptId(raw.slice('concept:'.length));
    return raw;
  };

  const edgeAcc = new Map<string, FragmentEdge & { remappedFrom: string; remappedTo: string }>();
  for (const frag of fragments) {
    for (const fe of frag.edges) {
      const from = remapEndpoint(fe.from);
      const to = remapEndpoint(fe.to);
      const key = `${from}|${fe.edge_type}|${to}`;
      const incoming = { ...fe, remappedFrom: from, remappedTo: to };
      const existing = edgeAcc.get(key);
      if (!existing) {
        edgeAcc.set(key, incoming);
        continue;
      }
      // confidence conflict: more conservative kind wins, then max score, then
      // smaller source_id — all deterministic, order-independent.
      const winner = pickConfidence(existing, incoming);
      edgeAcc.set(key, winner);
    }
  }

  const edges: MemoryEdge[] = [];
  for (const [key, fe] of edgeAcc) {
    edges.push({
      id: `edge:${key}`,
      from: fe.remappedFrom,
      to: fe.remappedTo,
      edge_type: fe.edge_type,
      confidence_kind: fe.confidence_kind,
      confidence_score: fe.confidence_score,
      properties: fe.properties ?? {},
      provenance: provenance(fe.source_id),
      weight: 1,
      requires_review: fe.confidence_kind === 'AMBIGUOUS',
      used_as_evidence: false,
    });
  }

  return { nodes: sortById([...nodeAcc.values()]), edges: sortById(edges) };
}

function pickConfidence<T extends FragmentEdge>(a: T, b: T): T {
  const ra = KIND_RANK[a.confidence_kind];
  const rb = KIND_RANK[b.confidence_kind];
  if (ra !== rb) return ra > rb ? a : b;
  if (a.confidence_score !== b.confidence_score) {
    return a.confidence_score > b.confidence_score ? a : b;
  }
  return a.source_id <= b.source_id ? a : b;
}

/**
 * Assemble a full MemoryGraphIr snapshot from merged nodes/edges + run metadata.
 * The schema superRefine here enforces the calibrated confidence bands (§4-2),
 * so an out-of-band fragment score is a loud parse failure, not a silent clamp.
 */
export function assembleSemanticIr(
  merged: { nodes: MemoryNode[]; edges: MemoryEdge[] },
  run: { ir_version: string; generated_at: string; extraction_run_id: string },
): MemoryGraphIr {
  return {
    schema_version: SCHEMA_VERSION,
    ir_version: run.ir_version,
    generated_at: run.generated_at,
    extraction_run_id: run.extraction_run_id,
    nodes: merged.nodes,
    edges: merged.edges,
    hyperedges: [],
  };
}

/**
 * Build the semantic graph by delegating extraction per chunk to the injected
 * `extract` fn, then merging deterministically. The reducer (not the LLM) owns
 * canonical content, so re-running with the same fragments is reproducible.
 */
export async function buildSemanticGraph(
  chunks: ExtractionChunkRequest[],
  extract: ExtractFn,
): Promise<{ nodes: MemoryNode[]; edges: MemoryEdge[] }> {
  const fragments: IrFragment[] = [];
  for (const chunk of chunks) {
    fragments.push(await extract(chunk));
  }
  return mergeIrFragments(fragments);
}
