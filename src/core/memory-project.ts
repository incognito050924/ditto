/**
 * IR → projection (increment #5, design §4-3 / §10-4b).
 *
 * One-way generation from `graph-ir.json` (structure IR #3 + semantic IR #4)
 * plus the reducer's approved decision events, into:
 *   - a serving graph (`graph.json`): query-ready adjacency (#6 query reads it),
 *   - a wiki (markdown under projections/wiki/): for humans,
 *   - a projection manifest recording the reduced approved-set hash (freshness).
 *
 * Projections are never edited in place — if wrong, fix the source/extractor
 * and regenerate (§4-3). This module is the regeneration step.
 *
 * Event nodes (§10-4b step 2): an approved `event_type='decision'` becomes a
 * `Decision` node (grounding sources → `RATIONALE_FOR` edges); every other
 * approved type becomes an `Episode` node (grounding sources → `MENTIONS`
 * edges). Each grounding source is also emitted as a `Source` node so the edge
 * resolves to a real, queryable node. EXTRACTED (approved fact, score 1.0).
 */
import { type MemoryEvent, memoryEvent } from '~/schemas/memory-event';
import type { MemoryEdge, MemoryGraphIr, MemoryNode } from '~/schemas/memory-graph-ir';
import type {
  MemoryProjectionManifest,
  MemorySourceRevision,
} from '~/schemas/memory-projection-manifest';
import type { MemorySource } from '~/schemas/memory-source';
import { generateId } from './id';
import { reduceEvents } from './memory-reduce';
import {
  MemoryEventStore,
  MemoryGraphIrStore,
  MemoryProjectionStore,
  MemorySourceStore,
  type ServingGraph,
  sha256Hex,
} from './memory-store';

const SCHEMA_VERSION = '0.1.0' as const;
const SEMANTIC_RUN_ID = 'xrun_decisions' as const;

/** Stable, content-derived projection id: `proj_<12 hex of sha256(key)>`. */
function projectionIdFor(key: string): string {
  return `proj_${sha256Hex(key).slice(0, 12)}`;
}

function eventNodeId(eventId: string): string {
  return `decision:${eventId}`;
}

/**
 * Fold approved events into graph nodes + edges from their grounding sources.
 * Pure & deterministic — sorted by id.
 *
 * - `decision` events → a `Decision` node; its sources become `RATIONALE_FOR`
 *   edges (source → decision).
 * - every other approved type (observation/analysis/preference/review_outcome/
 *   correction) → an `Episode` node; its sources become `MENTIONS` edges
 *   (source → event).
 * - each grounding source is ALSO emitted as a `Source` node (deduped by id) so
 *   the edge's `from` resolves to a real node instead of dangling — without it
 *   the source is unqueryable (query/explain only see graph.nodes).
 *
 * Sensitivity gate (F6 / ac-5): a `sensitivity='secret'` event is NOT projected
 * (no node, no edges). Independently, any grounding source whose id is in
 * `secretSourceIds` is not emitted as a `Source` node and its edge is omitted —
 * the (non-secret) event node is kept, just without that one edge. Event
 * sensitivity gates the event; source sensitivity gates the source/edge.
 */
export function projectEventNodes(
  approved: MemoryEvent[],
  secretSourceIds: ReadonlySet<string> = new Set(),
): {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
} {
  const nodes: MemoryNode[] = [];
  const edges: MemoryEdge[] = [];
  const sourceNodeIds = new Set<string>();
  for (const e of approved) {
    if (e.sensitivity === 'secret') continue;
    const isDecision = e.event_type === 'decision';
    const nodeId = eventNodeId(e.event_id);
    nodes.push({
      id: nodeId,
      node_type: isDecision ? 'Decision' : 'Episode',
      name: e.text.slice(0, 120),
      properties: {
        event_id: e.event_id,
        event_type: e.event_type,
        decided_at: e.decided_at ?? '',
      },
      provenance: {
        extraction_run_id: SEMANTIC_RUN_ID,
        extracted_by: 'human',
        schema_version: SCHEMA_VERSION,
        ...(e.sources[0] ? { source_id: e.sources[0] } : {}),
      },
    });
    const edgeType = isDecision ? 'RATIONALE_FOR' : 'MENTIONS';
    for (const sourceId of e.sources) {
      if (secretSourceIds.has(sourceId)) continue;
      const sourceNodeId = `source:${sourceId}`;
      if (!sourceNodeIds.has(sourceNodeId)) {
        sourceNodeIds.add(sourceNodeId);
        nodes.push({
          id: sourceNodeId,
          node_type: 'Source',
          name: sourceId,
          properties: {},
          provenance: {
            source_id: sourceId,
            extraction_run_id: SEMANTIC_RUN_ID,
            extracted_by: 'human',
            schema_version: SCHEMA_VERSION,
          },
        });
      }
      const edgeId = `${edgeType.toLowerCase()}:${sourceId}->${nodeId}`;
      edges.push({
        id: edgeId,
        from: sourceNodeId,
        to: nodeId,
        edge_type: edgeType,
        confidence_kind: 'EXTRACTED',
        confidence_score: 1,
        properties: {},
        provenance: {
          source_id: sourceId,
          extraction_run_id: SEMANTIC_RUN_ID,
          extracted_by: 'human',
          schema_version: SCHEMA_VERSION,
        },
        weight: 1,
        requires_review: false,
        used_as_evidence: false,
      });
    }
  }
  const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { nodes: nodes.sort(byId), edges: edges.sort(byId) };
}

/** Build the query-ready serving graph (adjacency) from IR nodes/edges. */
export function buildServingGraph(
  nodes: MemoryNode[],
  edges: MemoryEdge[],
  meta: { projection_id: string; generated_at: string },
): ServingGraph {
  const adjacency: ServingGraph['adjacency'] = {};
  for (const e of edges) {
    const bucket = adjacency[e.from] ?? [];
    bucket.push({ to: e.to, edge_type: e.edge_type });
    adjacency[e.from] = bucket;
  }
  for (const id of Object.keys(adjacency)) {
    adjacency[id]?.sort((a, b) =>
      a.to < b.to ? -1 : a.to > b.to ? 1 : a.edge_type < b.edge_type ? -1 : 1,
    );
  }
  return {
    projection_id: meta.projection_id,
    generated_at: meta.generated_at,
    nodes: [...nodes]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((n) => ({ id: n.id, node_type: n.node_type, name: n.name })),
    adjacency,
  };
}

/** Render a human-facing wiki markdown over the projected nodes/edges. */
export function renderWiki(
  nodes: MemoryNode[],
  edges: MemoryEdge[],
  meta: { projection_id: string; generated_at: string },
): string {
  const lines: string[] = [];
  lines.push('# Memory Graph (generated — do not edit)');
  lines.push('');
  lines.push(`> projection: ${meta.projection_id} · generated: ${meta.generated_at}`);
  lines.push('> One-way projection from graph-ir.json. Fix the source/extractor and regenerate.');
  lines.push('');
  lines.push(`## Nodes (${nodes.length})`);
  lines.push('');
  const outgoing = new Map<string, MemoryEdge[]>();
  for (const e of edges) {
    const bucket = outgoing.get(e.from);
    if (bucket) bucket.push(e);
    else outgoing.set(e.from, [e]);
  }
  for (const n of [...nodes].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    lines.push(`### ${n.name}`);
    lines.push(`- id: \`${n.id}\``);
    lines.push(`- type: ${n.node_type}`);
    const out = outgoing.get(n.id) ?? [];
    if (out.length > 0) {
      lines.push('- edges:');
      for (const e of [...out].sort((a, b) => (a.to < b.to ? -1 : 1))) {
        lines.push(`  - ${e.edge_type} → \`${e.to}\` (${e.confidence_kind})`);
      }
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export interface ProjectionResult {
  manifest: MemoryProjectionManifest;
  serving: ServingGraph;
  /** event_id set hash that bounds freshness (reduced approved-set). */
  set_hash: string;
  node_count: number;
  edge_count: number;
}

/**
 * Project the current IR + approved events into serving graph + wiki + manifest.
 * Reads the regenerable IR (may be absent → empty structure) and the SoT
 * events, runs the reducer, and persists derived artifacts. Pure functions do
 * the shaping; this orchestrator does IO.
 */
export async function projectMemory(
  repoRoot: string,
  options: { now?: Date } = {},
): Promise<ProjectionResult> {
  const now = (options.now ?? new Date()).toISOString();

  const ir: MemoryGraphIr | null = await new MemoryGraphIrStore(repoRoot).read();
  const events: MemoryEvent[] = await new MemoryEventStore(repoRoot).list();
  const sources: MemorySource[] = await new MemorySourceStore(repoRoot).list();

  const { approvedHeads, setHash } = reduceEvents(events);
  // F6/ac-5: secret sources are not projected as nodes and their edges are
  // omitted (source-sensitivity gate; event-sensitivity gate lives inside).
  const secretSourceIds = new Set(
    sources.filter((s) => s.sensitivity === 'secret').map((s) => s.source_id),
  );
  const eventGraph = projectEventNodes(approvedHeads, secretSourceIds);

  const nodes: MemoryNode[] = [...(ir?.nodes ?? []), ...eventGraph.nodes];
  const edges: MemoryEdge[] = [...(ir?.edges ?? []), ...eventGraph.edges];

  const projectionId = projectionIdFor(`${ir?.ir_version ?? 'noir'}:${setHash}`);
  const serving = buildServingGraph(nodes, edges, {
    projection_id: projectionId,
    generated_at: now,
  });
  const wiki = renderWiki(nodes, edges, { projection_id: projectionId, generated_at: now });

  const sourceRevisions: MemorySourceRevision[] = [...sources]
    .sort((a, b) => (a.source_id < b.source_id ? -1 : 1))
    .map((s) => ({
      source_id: s.source_id,
      ...(s.path ? { path: s.path } : {}),
      hash: s.content_hash,
      revision: s.revision,
      ...(s.git_commit ? { git_commit: s.git_commit } : {}),
    }));

  const manifest: MemoryProjectionManifest = {
    schema_version: SCHEMA_VERSION,
    projection_id: projectionId,
    generated_at: now,
    graph_ir_version: ir?.ir_version ?? 'ir_empty',
    serving_version: setHash,
    extractor_versions: {},
    source_revisions: sourceRevisions,
    ...(approvedHeads.length > 0
      ? { memory_event_until: approvedHeads[approvedHeads.length - 1]?.event_id }
      : {}),
    dirty_sources: [],
  };

  const store = new MemoryProjectionStore(repoRoot);
  await store.writeServing(serving);
  await store.writeWiki('index.md', wiki);
  await store.writeManifest(manifest);

  return {
    manifest,
    serving,
    set_hash: setHash,
    node_count: nodes.length,
    edge_count: edges.length,
  };
}

/**
 * Write model — proposal/approval gate (design §4-5 / §10-2 F2).
 *
 * Agents never write the serving graph or IR directly: there is no
 * graph/IR write API exposed for them. The ONLY path that influences a
 * projection is (1) `proposeEvent` → a pending MemoryEvent, then (2)
 * `approveEvent` → a NEW immutable approved event that supersedes the
 * original, then re-projection. The approval invariant is enforced by the
 * `memoryEvent` schema (approved ⇒ approved_by + decided_at; pending ⇒ no
 * approved_by); reduceEvents only feeds approved heads into projection.
 */

export class MemoryEventNotPendingError extends Error {
  constructor(
    public readonly eventId: string,
    public readonly status: string,
  ) {
    super(
      `event ${eventId} is not pending (status=${status}); only pending events can be approved`,
    );
    this.name = 'MemoryEventNotPendingError';
  }
}

/**
 * Raised when an event has already been decided — some other event already
 * supersedes it (§10-2 single-chain-head invariant). Because events are
 * immutable, the original file stays `pending` forever, so a status check
 * alone cannot detect this; we must look for an existing superseding event.
 * Without this guard a double-approve forks the chain into two approved heads.
 */
export class MemoryEventAlreadyDecidedError extends Error {
  constructor(
    public readonly eventId: string,
    public readonly decidedBy: string,
  ) {
    super(
      `event ${eventId} is already decided by ${decidedBy}; it cannot be approved or rejected again`,
    );
    this.name = 'MemoryEventAlreadyDecidedError';
  }
}

/**
 * Raised when an agent tries to approve an event it (an agent) proposed — the
 * propose→approve gate would otherwise be a no-op: an INFERRED guess could be
 * self-approved into an approved fact (§4-5 "흔들린 추측이 사실로 굳지 않게").
 * Enforced on actor *kind* (the actor carries no identifier), which is the
 * simplest safe rule: an agent-proposed event requires a human approver.
 */
export class MemorySelfApprovalError extends Error {
  constructor(public readonly eventId: string) {
    super(`event ${eventId} was proposed by an agent; it requires approval by a user`);
    this.name = 'MemorySelfApprovalError';
  }
}

export interface ProposeInput {
  event_type: MemoryEvent['event_type'];
  text: string;
  sources?: string[];
  confidence_kind?: MemoryEvent['confidence_kind'];
  sensitivity?: MemoryEvent['sensitivity'];
  actor?: MemoryEvent['actor'];
}

/**
 * Create one pending MemoryEvent (status='pending', no approved_by — approval
 * invariant). Records it immutably via MemoryEventStore.append. This is the
 * only entry point that introduces new knowledge into the write model.
 */
export async function proposeEvent(
  repoRoot: string,
  input: ProposeInput,
  options: { now?: Date } = {},
): Promise<MemoryEvent> {
  const now = (options.now ?? new Date()).toISOString();
  const store = new MemoryEventStore(repoRoot);
  const eventId = await generateId('memevt', (candidate) =>
    store.get(candidate).then(
      () => true,
      () => false,
    ),
  );
  const draft = memoryEvent.parse({
    schema_version: '0.1.0' as const,
    event_id: eventId,
    event_type: input.event_type,
    actor: input.actor ?? { kind: 'agent' },
    text: input.text,
    created_at: now,
    status: 'pending' as const,
    sources: input.sources ?? [],
    confidence_kind: input.confidence_kind ?? 'EXTRACTED',
    sensitivity: input.sensitivity ?? 'internal',
  });
  return store.append(draft);
}

/**
 * Approve a pending event (§10-2 F2). The original file is NEVER mutated;
 * instead a NEW immutable event is appended with status='approved',
 * approved_by, decided_at, and supersedes=<originalId>. After appending,
 * the projection is regenerated so reduceEvents reflects the new approved
 * head (the supersession chain's new head). `decision` becomes 'rejected'
 * when reject=true (same supersedes mechanism).
 */
export async function approveEvent(
  repoRoot: string,
  eventId: string,
  options: { by: string; approverKind?: 'user' | 'agent'; reject?: boolean; now?: Date },
): Promise<{ decision: MemoryEvent; projection: ProjectionResult }> {
  const store = new MemoryEventStore(repoRoot);
  const original = await store.get(eventId); // throws if absent
  if (original.status !== 'pending') {
    throw new MemoryEventNotPendingError(eventId, original.status);
  }
  // §10-2 single-chain-head invariant: the original file is immutable so its
  // status is always 'pending', even after a decision. A decision is recorded
  // as a NEW event whose `supersedes` points back here. If such an event
  // already exists, this id is already decided — approving again would fork the
  // chain into two approved heads (reduceEvents would emit both). Reject it.
  const existing = await store.list();
  const priorDecision = existing.find((e) => e.supersedes === eventId);
  if (priorDecision) {
    throw new MemoryEventAlreadyDecidedError(eventId, priorDecision.event_id);
  }
  // §4-5 propose/approve gate: an agent must not self-approve its own guess.
  // Compare on actor *kind* (the actor has no identifier) — an agent-proposed
  // event can only be decided by a user. approverKind defaults to 'agent'.
  const approverKind = options.approverKind ?? 'agent';
  if (original.actor.kind === 'agent' && approverKind === 'agent') {
    throw new MemorySelfApprovalError(eventId);
  }
  const now = (options.now ?? new Date()).toISOString();
  const decisionId = await generateId('memevt', (candidate) =>
    store.get(candidate).then(
      () => true,
      () => false,
    ),
  );
  const decision = memoryEvent.parse({
    ...original,
    event_id: decisionId,
    created_at: now,
    status: options.reject ? ('rejected' as const) : ('approved' as const),
    approved_by: options.by,
    decided_at: now,
    supersedes: original.event_id,
  });
  const written = await store.append(decision);
  const projection = await projectMemory(repoRoot, options.now ? { now: options.now } : {});
  return { decision: written, projection };
}

export type Freshness = 'fresh' | 'stale' | 'absent';

export interface StatusResult {
  freshness: Freshness;
  /** sources whose current content_hash differs from the projection's record. */
  dirty_sources: string[];
  current_set_hash: string;
  recorded_set_hash?: string;
  projection_id?: string;
  generated_at?: string;
}

/**
 * Report freshness (design §4-4 / §10-4b step 3): the projection is stale when
 * the CURRENT reduced approved-set hash differs from the one the manifest
 * recorded (`serving_version`), OR when any source's current content_hash
 * differs from the revision the projection recorded. `absent` = never projected.
 */
export async function memoryStatus(repoRoot: string): Promise<StatusResult> {
  const events: MemoryEvent[] = await new MemoryEventStore(repoRoot).list();
  const { setHash: currentSetHash } = reduceEvents(events);

  const manifest = await new MemoryProjectionStore(repoRoot).readManifest();
  if (!manifest) {
    return { freshness: 'absent', dirty_sources: [], current_set_hash: currentSetHash };
  }

  const sources: MemorySource[] = await new MemorySourceStore(repoRoot).list();
  const recordedHash = new Map<string, string>();
  for (const r of manifest.source_revisions) recordedHash.set(r.source_id, r.hash);

  const dirty: string[] = [];
  for (const s of sources) {
    const recorded = recordedHash.get(s.source_id);
    if (recorded === undefined || recorded !== s.content_hash) dirty.push(s.source_id);
  }
  dirty.sort();

  const eventSetStale = manifest.serving_version !== currentSetHash;
  const freshness: Freshness = eventSetStale || dirty.length > 0 ? 'stale' : 'fresh';

  return {
    freshness,
    dirty_sources: dirty,
    current_set_hash: currentSetHash,
    ...(manifest.serving_version !== undefined
      ? { recorded_set_hash: manifest.serving_version }
      : {}),
    projection_id: manifest.projection_id,
    generated_at: manifest.generated_at,
  };
}
