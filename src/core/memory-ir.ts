/**
 * ACG → Memory Graph IR absorber (increment #3, design §10-4 / §10-4a).
 *
 * Pure, deterministic transform that ingests EXISTING ACG analysis outputs
 * (ImpactGraph, boundary DependencyEdges, SemanticScanObservation) and emits
 * Graph IR nodes + edges. The ACG outputs carry no provenance/confidence
 * (§10-4 근거: produceImpactGraph / CodeqlEdgeAnalyzer / scanSignatureChanges),
 * so this stage MUST inject them:
 *   - extraction_run_id (= xrunId), extracted_by, schema_version on every
 *     node/edge provenance;
 *   - calibrated confidence enforced by the memory-graph-ir superRefine
 *     (EXTRACTED=1.0, AMBIGUOUS in [0.1,0.3]).
 *
 * Edge-type discipline (D3 — OBJ-6/7): impact kinds are NOT over-asserted to
 * CALLS/IMPLEMENTS; they are preserved as RELATED_TO + properties.acg_kind on
 * the EDGE (per-relation, lossless: each affected kind = a distinct edge from
 * the change_target Symbol → the affected node). Only boundary imports become
 * IMPORTS.
 *
 * Determinism (ac-3): canonical content (sorted nodes/edges) depends only on
 * the source ACG inputs, never on run metadata. Node/edge ids are canonical
 * (§10-4a) and carry NO run-varying value; xrunId lives only in provenance.
 * Unsupported impact kinds are a LOUD FAIL (no silent drop — D2/OBJ-5).
 */
import type { DependencyEdge } from '~/acg/boundary/boundary';
import type { AcgImpactGraph } from '~/schemas/acg-impact-graph';
import type { AcgSemanticScanObservation } from '~/schemas/acg-semantic-scan-observation';
import type { MemoryEdge, MemoryNode, MemoryProvenance } from '~/schemas/memory-graph-ir';

const SCHEMA_VERSION = '0.1.0' as const;

/** 9 affected-node kinds from acg-impact-graph.ts that map to a Symbol node. */
const SUPPORTED_AFFECTED_KINDS = new Set<string>([
  'direct_caller',
  'transitive_caller',
  'type_contract',
  'generated_client',
  'test',
  'doc',
  'external_surface',
  'ui_surface',
  'user_journey',
]);

const JOURNEY_KINDS = new Set<string>(['ui_surface', 'user_journey']);

/** Thrown when an ACG record carries a kind this absorber does not map (D2). */
export class UnsupportedAcgKindError extends Error {
  constructor(
    public readonly origin: 'impact_affected' | 'impact_unresolved',
    public readonly kind: string,
  ) {
    super(`unsupported ACG ${origin} kind '${kind}'; no silent drop (design §10-4 D2)`);
    this.name = 'UnsupportedAcgKindError';
  }
}

export interface AbsorbAcgInput {
  impact?: AcgImpactGraph;
  boundaryEdges?: DependencyEdge[];
  semantic?: AcgSemanticScanObservation;
}

export interface AbsorbAcgResult {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
}

/**
 * Strip the module extension so paths from impact/semantic match the
 * already-stripped repo-path form boundary emits (§10-4a 일관 적용).
 */
export function normalizePath(path: string): string {
  return path.replace(/\.[cm]?[jt]sx?$/, '').replace(/\.(java|kt|py)$/, '');
}

function symbolNodeId(path: string, symbol: string): string {
  return `symbol:${path}#${symbol}`;
}

/**
 * Parse an impact `change_target` (acg-impact-graph.ts:71) of the form
 * `<path>#<symbol>` or bare `<path>` into a canonical Symbol id + display name.
 */
function changeTargetNode(changeTarget: string): { id: string; name: string } {
  const hashIdx = changeTarget.indexOf('#');
  const rawPath = hashIdx === -1 ? changeTarget : changeTarget.slice(0, hashIdx);
  const symbol = hashIdx === -1 ? changeTarget : changeTarget.slice(hashIdx + 1);
  const path = normalizePath(rawPath);
  return { id: symbolNodeId(path, symbol), name: symbol };
}

export function artifactNodeId(path: string): string {
  return `artifact:${path}`;
}

function provenance(
  extractedBy: MemoryProvenance['extracted_by'],
  xrunId: string,
): MemoryProvenance {
  return {
    extraction_run_id: xrunId,
    extracted_by: extractedBy,
    schema_version: SCHEMA_VERSION,
  };
}

/**
 * Absorb ACG outputs into Graph IR nodes/edges. Pure and deterministic: output
 * is sorted by id and depends only on the inputs (xrunId only flows into
 * provenance, never into a node/edge id).
 */
export function absorbAcgIntoIr(input: AbsorbAcgInput, xrunId: string): AbsorbAcgResult {
  const nodes = new Map<string, MemoryNode>();
  const edges = new Map<string, MemoryEdge>();

  // --- impact.affected_nodes → Symbol + per-kind RELATED_TO from change_target ---
  // The change_target is the relation source; each affected node is a target.
  // acg_kind/reason live on the EDGE (per-relation), so a symbol affected via
  // multiple kinds yields one distinct edge per kind — lossless (D2/D3).
  if (input.impact && input.impact.affected_nodes.length > 0) {
    const target = changeTargetNode(input.impact.change_target);
    if (!nodes.has(target.id)) {
      nodes.set(target.id, {
        id: target.id,
        node_type: 'Symbol',
        name: target.name,
        properties: {},
        provenance: provenance('impact', xrunId),
      });
    }

    for (const affected of input.impact.affected_nodes) {
      if (!SUPPORTED_AFFECTED_KINDS.has(affected.kind)) {
        throw new UnsupportedAcgKindError('impact_affected', affected.kind);
      }
      const isJourney = JOURNEY_KINDS.has(affected.kind);
      // journey nodes have journey_id (no path); others have path.
      const path = affected.path ? normalizePath(affected.path) : undefined;
      const symbol = affected.symbol ?? affected.journey_id ?? affected.kind;
      const nodeId = isJourney
        ? symbolNodeId(`journey:${affected.journey_id}`, symbol)
        : symbolNodeId(path ?? '', symbol);

      if (!nodes.has(nodeId)) {
        nodes.set(nodeId, {
          id: nodeId,
          node_type: 'Symbol',
          name: symbol,
          properties: {},
          provenance: provenance('impact', xrunId),
        });
      }

      // One edge per (kind, target→affected): canonical id includes the kind so
      // multi-kind affected symbols keep a distinct edge each (no silent drop).
      const edgeId = `related_to:impact:${affected.kind}:${target.id}->${nodeId}`;
      if (!edges.has(edgeId)) {
        const edgeProps: Record<string, unknown> = { acg_kind: affected.kind };
        if (affected.reason !== undefined) edgeProps.reason = affected.reason;
        edges.set(edgeId, {
          id: edgeId,
          from: target.id,
          to: nodeId,
          edge_type: 'RELATED_TO',
          confidence_kind: 'EXTRACTED',
          confidence_score: 1,
          properties: edgeProps,
          provenance: provenance('impact', xrunId),
          weight: 1,
          requires_review: false,
          used_as_evidence: false,
        } as MemoryEdge);
      }
    }
  }

  // --- impact.unresolved → Artifact + RELATED_TO (AMBIGUOUS=0.1, requires_review) ---
  for (const unresolved of input.impact?.unresolved ?? []) {
    const path = normalizePath(unresolved.path);
    const nodeId = artifactNodeId(path);
    // acg_unresolved_kind/reason preserved on the node (edge schema has no
    // properties slot — see impact.affected note above).
    if (!nodes.has(nodeId)) {
      nodes.set(nodeId, {
        id: nodeId,
        node_type: 'Artifact',
        name: path,
        file_type: 'code',
        properties: {
          acg_unresolved_kind: unresolved.kind,
          reason: unresolved.reason,
        },
        provenance: provenance('impact', xrunId),
      });
    }
    const edgeId = `related_to:unresolved:${unresolved.kind}:${nodeId}`;
    if (!edges.has(edgeId)) {
      edges.set(edgeId, {
        id: edgeId,
        from: nodeId,
        to: nodeId,
        edge_type: 'RELATED_TO',
        confidence_kind: 'AMBIGUOUS',
        confidence_score: 0.1,
        provenance: provenance('impact', xrunId),
        weight: 1,
        requires_review: true,
        used_as_evidence: false,
      } as MemoryEdge);
    }
  }

  // --- boundary DependencyEdge → Artifact ×2 + IMPORTS (EXTRACTED=1.0) ---
  for (const dep of input.boundaryEdges ?? []) {
    const from = normalizePath(dep.from);
    const to = normalizePath(dep.to);
    const fromId = artifactNodeId(from);
    const toId = artifactNodeId(to);
    for (const [id, name] of [
      [fromId, from],
      [toId, to],
    ] as const) {
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          node_type: 'Artifact',
          name,
          file_type: 'code',
          properties: {},
          provenance: provenance('codeql', xrunId),
        });
      }
    }
    const edgeId = `imports:${fromId}->${toId}`;
    if (!edges.has(edgeId)) {
      edges.set(edgeId, {
        id: edgeId,
        from: fromId,
        to: toId,
        edge_type: 'IMPORTS',
        confidence_kind: 'EXTRACTED',
        confidence_score: 1,
        provenance: provenance('codeql', xrunId),
        weight: 1,
        requires_review: false,
        used_as_evidence: false,
      } as MemoryEdge);
    }
  }

  // --- semantic.changes → Symbol with before/after (source_revision=base_used) ---
  if (input.semantic) {
    const baseUsed = input.semantic.base_used;
    for (const change of input.semantic.changes) {
      const path = normalizePath(change.file);
      const nodeId = symbolNodeId(path, change.symbol);
      const semanticProps: Record<string, unknown> = {
        before: change.before,
        after: change.after,
      };
      const existing = nodes.get(nodeId);
      if (existing) {
        // merge before/after onto an already-extracted Symbol (e.g. from impact).
        // The semantic observation carries the base revision, so set it on both
        // the node and its provenance (D4/OBJ-9: source_revision 필수 주입).
        // extracted_by reflects origin: an impact-sourced node stays 'impact'.
        existing.properties = { ...existing.properties, ...semanticProps };
        existing.source_revision = baseUsed;
        existing.provenance = existing.provenance
          ? { ...existing.provenance, source_revision: baseUsed }
          : { ...provenance('codeql', xrunId), source_revision: baseUsed };
      } else {
        nodes.set(nodeId, {
          id: nodeId,
          node_type: 'Symbol',
          name: change.symbol,
          source_revision: baseUsed,
          properties: semanticProps,
          provenance: { ...provenance('codeql', xrunId), source_revision: baseUsed },
        });
      }
    }
  }

  const sortById = <T extends { id: string }>(items: T[]): T[] =>
    items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    nodes: sortById([...nodes.values()]),
    edges: sortById([...edges.values()]),
  };
}
