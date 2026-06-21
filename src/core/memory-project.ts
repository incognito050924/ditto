import { resolve } from 'node:path';
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
import { gitRevParse, listChangedFiles } from './git';
import { generateId } from './id';
import { artifactNodeId, normalizePath } from './memory-ir';
import { reduceEvents } from './memory-reduce';
import { findOwningRepo } from './memory-scan';
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
 *
 * Code-grounding (wi_260621vy9, option A): `codeSourcePaths` maps a code
 * source id → its path; a non-decision event grounded on such a source also gets
 * an Artifact node (name=path) + Episode→Artifact MENTIONS edge, deduped through
 * the same Artifact set the decision governs bridge uses. Secret sources are
 * skipped (the source loop `continue`s on them before this branch).
 */
export function projectEventNodes(
  approved: MemoryEvent[],
  secretSourceIds: ReadonlySet<string> = new Set(),
  codeSourcePaths: ReadonlyMap<string, string> = new Map(),
): {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
} {
  const nodes: MemoryNode[] = [];
  const edges: MemoryEdge[] = [];
  const sourceNodeIds = new Set<string>();
  const artifactNodeIds = new Set<string>();
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
      // Code-source grounding bridge (wi_260621vy9, option A): a non-decision
      // event (observation/analysis) grounded on a `source_type='code'` source →
      // an Artifact node (id reuses the ACG path normalization so it merges with
      // governs/code-island Artifacts) + an Episode→Artifact MENTIONS edge, so a
      // code-grounded captured discovery is reachable in warm-start (it shares
      // the path's tokens). Secret sources are already skipped above (the loop
      // `continue`s before here). Decision events keep the governs bridge below.
      if (!isDecision) {
        const codePath = codeSourcePaths.get(sourceId);
        if (codePath !== undefined) {
          const artId = artifactNodeId(normalizePath(codePath));
          if (!artifactNodeIds.has(artId)) {
            artifactNodeIds.add(artId);
            nodes.push({
              id: artId,
              node_type: 'Artifact',
              name: codePath,
              properties: {},
              provenance: {
                extraction_run_id: SEMANTIC_RUN_ID,
                extracted_by: 'human',
                schema_version: SCHEMA_VERSION,
                source_id: sourceId,
              },
            });
          }
          edges.push({
            id: `mentions:${artId}->${nodeId}`,
            from: nodeId,
            to: artId,
            edge_type: 'MENTIONS',
            confidence_kind: 'EXTRACTED',
            confidence_score: 1,
            properties: {},
            provenance: {
              extraction_run_id: SEMANTIC_RUN_ID,
              extracted_by: 'human',
              schema_version: SCHEMA_VERSION,
              source_id: sourceId,
            },
            weight: 1,
            requires_review: false,
            used_as_evidence: false,
          });
        }
      }
    }
    // Code↔decision bridge (memory-librarian §8 inc.1): a decision's `governs`
    // paths (from an ADR `관련:` header) → Artifact nodes + Artifact→Decision
    // RATIONALE_FOR edges, so a code file resolves to the ADR that governs it.
    // Artifact ids reuse the ACG path normalization so they merge with the
    // code-island Artifact/Symbol nodes emitted from impact/codeql IR.
    if (isDecision) {
      for (const rawPath of e.governs) {
        const artId = artifactNodeId(normalizePath(rawPath));
        const groundingSource = e.sources[0];
        if (!artifactNodeIds.has(artId)) {
          artifactNodeIds.add(artId);
          nodes.push({
            id: artId,
            node_type: 'Artifact',
            name: artId.slice('artifact:'.length),
            properties: {},
            provenance: {
              extraction_run_id: SEMANTIC_RUN_ID,
              extracted_by: 'human',
              schema_version: SCHEMA_VERSION,
              ...(groundingSource ? { source_id: groundingSource } : {}),
            },
          });
        }
        edges.push({
          id: `rationale_for:${artId}->${nodeId}`,
          from: artId,
          to: nodeId,
          edge_type: 'RATIONALE_FOR',
          confidence_kind: 'EXTRACTED',
          confidence_score: 1,
          properties: {},
          provenance: {
            extraction_run_id: SEMANTIC_RUN_ID,
            extracted_by: 'human',
            schema_version: SCHEMA_VERSION,
            ...(groundingSource ? { source_id: groundingSource } : {}),
          },
          weight: 1,
          requires_review: false,
          used_as_evidence: false,
        });
      }
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
  // wi_260621vy9 (option A): map each code source to its path so a non-decision
  // event grounded on code emits an Artifact node — the core wiring that makes
  // code-grounded captured discoveries reachable in warm-start (without it the
  // capture-side branch silently no-ops). Secret gating stays via secretSourceIds.
  const codeSourcePaths = new Map<string, string>();
  for (const s of sources) {
    if (s.source_type === 'code' && s.path) codeSourcePaths.set(s.source_id, s.path);
  }
  const eventGraph = projectEventNodes(approvedHeads, secretSourceIds, codeSourcePaths);

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
  const actor = input.actor ?? { kind: 'agent' };
  // Laundering guard (memory-librarian §8 inc.4, ac-4): an agent's self-report
  // must not be stored as EXTRACTED (fact). Deterministic facts (ACG/codeql,
  // ADR bootstrap) are appended directly, never through propose — so an agent
  // claiming EXTRACTED here is laundering a guess. Downgrade to INFERRED; the
  // returned event surfaces the downgraded kind. A user may assert EXTRACTED.
  const requestedKind = input.confidence_kind ?? 'EXTRACTED';
  const confidenceKind =
    actor.kind === 'agent' && requestedKind === 'EXTRACTED' ? 'INFERRED' : requestedKind;
  const draft = memoryEvent.parse({
    schema_version: '0.1.0' as const,
    event_id: eventId,
    event_type: input.event_type,
    actor,
    text: input.text,
    created_at: now,
    status: 'pending' as const,
    sources: input.sources ?? [],
    confidence_kind: confidenceKind,
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

/**
 * `code_drift`/`code_dirty` are axis-2 (code ↔ SoT) signals separate from the
 * axis-1 `stale` (SoT ↔ projection) signal: `code_drift` = an owning repo's HEAD
 * no longer matches the commit the projection was built from (the memory reflects
 * a different commit's code), `code_dirty` = an owning repo's working tree
 * diverges from its baseline (file edited / stashed). `absent` = never projected.
 */
export type Freshness = 'fresh' | 'stale' | 'absent' | 'code_drift' | 'code_dirty';

export interface StatusResult {
  freshness: Freshness;
  /** sources whose current content_hash differs from the projection's record. */
  dirty_sources: string[];
  /** owning repos whose current HEAD/working tree diverged from the baseline. */
  drifted_repos: string[];
  /** sources owned by a drifted/dirty repo (or a non-git source whose hash moved). */
  drifted_sources: string[];
  /**
   * Undecided pending proposals (pending heads no decision event supersedes).
   * Surfaced so the approval backlog is visible instead of queueing silently
   * (round-2 review R9, AX).
   */
  pending_count: number;
  current_set_hash: string;
  recorded_set_hash?: string;
  projection_id?: string;
  generated_at?: string;
}

/** Pending events that no other event supersedes (no decision recorded yet). */
function countUndecidedPending(events: MemoryEvent[]): number {
  const superseded = new Set<string>();
  for (const e of events) {
    if (e.supersedes) superseded.add(e.supersedes);
  }
  return events.filter((e) => e.status === 'pending' && !superseded.has(e.event_id)).length;
}

/** Best-effort current HEAD sha for `repo`; null when not a git work tree. */
function headOf(repo: string): string | null {
  try {
    const sha = gitRevParse(repo, 'HEAD');
    return /^[a-f0-9]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Whether `repo`'s working tree is dirty (design §3 D-B). At the rooting root the
 * tracked SoT lives under `.ditto/`, which is rewritten by scan/project and so is
 * NOT code drift — exclude it (git.ts:44 precedent). Sub-repos carry no SoT, so no
 * exclusion. Constant git calls: one porcelain per repo.
 */
function isRepoDirty(repo: string, isRoot: boolean): boolean {
  const changed = listChangedFiles(repo);
  const relevant = isRoot ? changed.filter((p) => !p.startsWith('.ditto/')) : changed;
  return relevant.length > 0;
}

interface Axis2Result {
  /** code_drift (HEAD moved) takes priority over code_dirty (working tree); null = no axis-2 signal. */
  freshness: 'code_drift' | 'code_dirty' | null;
  drifted_repos: string[];
  drifted_sources: string[];
}

/**
 * Axis-2 (code ↔ SoT) detection (design §3 D-B / D-G). Groups manifest source
 * revisions by their OWNING repo (findOwningRepo, mirroring scan attribution),
 * then per repo (head + porcelain cached — repo-once, file-count-independent):
 *  - stored git_commit ≠ current HEAD → `code_drift` for that repo's sources,
 *  - working tree dirty → `code_dirty` for that repo's sources.
 * Non-git sources (revision=`snapshot:<hash>`, no git_commit) are compared only
 * by bounded content_hash against the manifest — no full rehash, no rescan.
 */
async function detectAxis2(
  repoRoot: string,
  revisions: readonly MemorySourceRevision[],
  currentHash: ReadonlyMap<string, string>,
): Promise<Axis2Result> {
  const root = resolve(repoRoot);
  // Group source revisions by owning repo (absolute dir), repo-once attribution.
  const owningRepoOf = new Map<string, string | null>();
  const sourcesByRepo = new Map<string, MemorySourceRevision[]>();
  const nonGit: MemorySourceRevision[] = [];
  for (const r of revisions) {
    if (!r.git_commit) {
      nonGit.push(r);
      continue;
    }
    const owner = r.path ? ((await findOwningRepo(resolve(root, r.path), root)) ?? root) : root;
    const key = resolve(owner);
    owningRepoOf.set(r.source_id, key);
    const bucket = sourcesByRepo.get(key) ?? [];
    bucket.push(r);
    sourcesByRepo.set(key, bucket);
  }

  const driftedRepos = new Set<string>();
  const driftedSources = new Set<string>();
  let sawDrift = false;
  let sawDirty = false;
  for (const [repo, revs] of sourcesByRepo) {
    const isRoot = repo === root;
    const head = headOf(repo);
    const drift = head !== null && revs.some((r) => r.git_commit !== head);
    const dirty = isRepoDirty(repo, isRoot);
    if (!drift && !dirty) continue;
    if (drift) sawDrift = true;
    if (dirty) sawDirty = true;
    driftedRepos.add(repo);
    for (const r of revs) driftedSources.add(r.source_id);
  }

  // Non-git sources (no HEAD): bounded content_hash compare only — no full rehash,
  // no rescan (ac-8). A hash move IS already the axis-1 `stale`/dirty signal, so it
  // does NOT raise a code_dirty git-working-tree verdict; we only surface the moved
  // source in `drifted_sources` for visibility. (Permanent-drift hard semantics: ②.)
  for (const r of nonGit) {
    const now = currentHash.get(r.source_id);
    if (now !== undefined && now !== r.hash) driftedSources.add(r.source_id);
  }

  const driftedRepoPaths = [...driftedRepos]
    .map((abs) => (abs === root ? '.' : relativeFromRoot(root, abs)))
    .sort();
  return {
    // code_drift outranks code_dirty (HEAD mismatch = trust defect > working edit).
    freshness: sawDrift ? 'code_drift' : sawDirty ? 'code_dirty' : null,
    drifted_repos: driftedRepoPaths,
    drifted_sources: [...driftedSources].sort(),
  };
}

/** Rooting-root-relative path to an owning repo dir (mirrors scan's `repo` field). */
function relativeFromRoot(root: string, abs: string): string {
  const rel = abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs;
  return rel || '.';
}

/**
 * Report freshness (design §4-4 / §10-4b step 3 + §3 axis-2): axis 1 — the
 * projection is `stale` when the CURRENT reduced approved-set hash differs from
 * the manifest's (`serving_version`) OR a source's content_hash moved. axis 2 —
 * `code_drift`/`code_dirty` when an owning repo's HEAD/working tree diverged from
 * the recorded baseline. `absent` = never projected. Priority: code_drift first
 * (HEAD diverged — the worst trust defect), then stale (axis-1), then code_dirty
 * (working tree edited — normal dev state), then fresh.
 */
export async function memoryStatus(repoRoot: string): Promise<StatusResult> {
  const events: MemoryEvent[] = await new MemoryEventStore(repoRoot).list();
  const { setHash: currentSetHash } = reduceEvents(events);

  const pendingCount = countUndecidedPending(events);
  const manifest = await new MemoryProjectionStore(repoRoot).readManifest();
  if (!manifest) {
    return {
      freshness: 'absent',
      dirty_sources: [],
      drifted_repos: [],
      drifted_sources: [],
      pending_count: pendingCount,
      current_set_hash: currentSetHash,
    };
  }

  const sources: MemorySource[] = await new MemorySourceStore(repoRoot).list();
  const recordedHash = new Map<string, string>();
  for (const r of manifest.source_revisions) recordedHash.set(r.source_id, r.hash);
  const currentHash = new Map<string, string>();
  for (const s of sources) currentHash.set(s.source_id, s.content_hash);

  const dirty: string[] = [];
  for (const s of sources) {
    const recorded = recordedHash.get(s.source_id);
    if (recorded === undefined || recorded !== s.content_hash) dirty.push(s.source_id);
  }
  dirty.sort();

  const axis2 = await detectAxis2(repoRoot, manifest.source_revisions, currentHash);

  const eventSetStale = manifest.serving_version !== currentSetHash;
  const axis1Stale = eventSetStale || dirty.length > 0;
  // Priority (intentional): code_drift > stale > code_dirty > fresh. code_drift
  // (HEAD diverged) is the worst trust defect and stays absolute-highest. But
  // axis-1 `stale` MUST outrank `code_dirty`: the dev tree is almost always dirty,
  // so if code_dirty won, a stale projection would read code_dirty and the
  // warm-start gate (which injects code_dirty) would serve it as settled (ac-5).
  // Pure code_dirty (axis-1 fresh + dirty tree) still wins over fresh so the gate
  // injects mid-development. All signals surface via the separate fields.
  const freshness: Freshness =
    axis2.freshness === 'code_drift'
      ? 'code_drift'
      : axis1Stale
        ? 'stale'
        : axis2.freshness === 'code_dirty'
          ? 'code_dirty'
          : 'fresh';

  return {
    freshness,
    dirty_sources: dirty,
    drifted_repos: axis2.drifted_repos,
    drifted_sources: axis2.drifted_sources,
    pending_count: pendingCount,
    current_set_hash: currentSetHash,
    ...(manifest.serving_version !== undefined
      ? { recorded_set_hash: manifest.serving_version }
      : {}),
    projection_id: manifest.projection_id,
    generated_at: manifest.generated_at,
  };
}
