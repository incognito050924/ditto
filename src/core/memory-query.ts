/**
 * Serving-graph queries + audit (increment #6, design §10-3 / §4-4 / §4-6).
 *
 * READ-ONLY over the serving graph (`graph.json`, design §4-3): query/path/
 * explain never mutate it. Each answer carries a freshness envelope
 * (`projection_id`·`generated_at`·`freshness`·`dirty_sources`, §4-4 / ac-6) read
 * from the projection manifest + `memoryStatus`, so a caller cannot use a stale
 * result as if it were settled.
 *
 * `audit` (§4-6) counts orphan / stale-source / duplicate / contradiction over
 * the serving graph and appends each run to a git-tracked append-only history
 * (`dittoDir/memory/audit-log.jsonl`, SoT tier) — a one-shot report would lose
 * "what was orphan at that point" (not recomputable from a regenerable IR). It
 * never triggers curator/anything else (audit→curator auto is out of scope, §5-4).
 */
import { appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { dittoDir, localDir } from './ditto-paths';
import { ensureDir } from './fs';
import { type Freshness, memoryStatus } from './memory-project';
import { reduceEvents } from './memory-reduce';
import { MemoryEventStore, MemoryProjectionStore, type ServingGraph } from './memory-store';

/** Freshness envelope attached to every query/path/explain answer (§4-4). */
export interface FreshnessEnvelope {
  projection_id: string;
  generated_at: string;
  freshness: Freshness;
  dirty_sources: string[];
  /** axis-2 (code ↔ SoT): owning repos whose HEAD/working tree diverged from baseline. */
  drifted_repos: string[];
  /** axis-2: sources owned by a drifted/dirty repo (or a non-git source whose hash moved). */
  drifted_sources: string[];
}

export class MemoryProjectionAbsentError extends Error {
  constructor() {
    super('no serving graph projected yet; run `ditto memory project` first');
    this.name = 'MemoryProjectionAbsentError';
  }
}

export class MemoryNodeNotFoundError extends Error {
  constructor(public readonly nodeId: string) {
    super(`node "${nodeId}" not found in the serving graph`);
    this.name = 'MemoryNodeNotFoundError';
  }
}

/** Read the freshness envelope from the manifest + current status (no graph mutation). */
export async function readFreshness(repoRoot: string): Promise<FreshnessEnvelope> {
  const status = await memoryStatus(repoRoot);
  return {
    projection_id: status.projection_id ?? '',
    generated_at: status.generated_at ?? '',
    freshness: status.freshness,
    dirty_sources: status.dirty_sources,
    drifted_repos: status.drifted_repos,
    drifted_sources: status.drifted_sources,
  };
}

/**
 * Pull-query instrumentation (increment #8, ac-8). The conditional pull habit in
 * the owner prompts must be observable as ACTUAL query utterances, not just
 * prompt text — so every `ditto memory query` records one JSONL line here. This
 * is runtime telemetry (a regenerable derivative), so it lives under `localDir`
 * (Tier ③, gitignored), separate from the SoT under `dittoDir`.
 */
export interface PullQueryRecord {
  ts: string;
  /** the node id the caller queried for cross-entity context. */
  node: string;
  /** traversal depth requested. */
  depth: number;
  /** count of related nodes the query returned (0 ⇒ the caller falls back to explore). */
  neighbor_count: number;
  /** projection freshness at query time (incl. axis-2 code_drift/code_dirty; a non-fresh answer must not be used as settled). */
  freshness: Freshness;
}

/** Path to the pull-query usage JSONL (ac-8 instrumentation source). */
export function pullUsageLogPath(repoRoot: string): string {
  return localDir(repoRoot, 'memory', 'pull-usage.jsonl');
}

/** Append one pull-query record (best-effort: telemetry must not break the query). */
export async function recordPullQuery(repoRoot: string, record: PullQueryRecord): Promise<void> {
  const path = pullUsageLogPath(repoRoot);
  await ensureDir(dirname(path));
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
}

/** Read the pull-query usage JSONL into its records (ac-8: instrumentation produces data). */
export async function readPullUsage(repoRoot: string): Promise<PullQueryRecord[]> {
  const path = pullUsageLogPath(repoRoot);
  if (!(await Bun.file(path).exists())) return [];
  const text = await Bun.file(path).text();
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as PullQueryRecord);
}

/** Undirected neighbor lookup: outgoing adjacency + incoming (edges pointing at id). */
function neighborsOf(
  graph: ServingGraph,
  id: string,
): Array<{ to: string; edge_type: string; direction: 'out' | 'in' }> {
  const out: Array<{ to: string; edge_type: string; direction: 'out' | 'in' }> = [];
  for (const e of graph.adjacency[id] ?? []) {
    out.push({ to: e.to, edge_type: e.edge_type, direction: 'out' });
  }
  for (const [from, edges] of Object.entries(graph.adjacency)) {
    for (const e of edges) {
      if (e.to === id) out.push({ to: from, edge_type: e.edge_type, direction: 'in' });
    }
  }
  return out;
}

export interface QueryResult {
  root: string;
  depth: number;
  /** node ids reachable within `depth` undirected hops (excludes root), sorted. */
  neighbors: string[];
}

/**
 * BFS undirected traversal from `node` up to `depth` hops (default 2). Pure over
 * the serving graph — read-only.
 */
export function queryNeighbors(graph: ServingGraph, node: string, depth: number): QueryResult {
  const present = new Set(graph.nodes.map((n) => n.id));
  if (!present.has(node)) throw new MemoryNodeNotFoundError(node);

  const seen = new Set<string>([node]);
  let frontier: string[] = [node];
  for (let hop = 0; hop < depth; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of neighborsOf(graph, id)) {
        if (!seen.has(nb.to)) {
          seen.add(nb.to);
          next.push(nb.to);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  seen.delete(node);
  return { root: node, depth, neighbors: [...seen].sort() };
}

/**
 * Significant tokens (len ≥ 3) of a string — the SAME tokenizer the title-token
 * duplicateSearch (src/hooks/user-prompt-submit.ts) uses, so the recall
 * comparison in the ac-14 test is apples-to-apples.
 */
export function bodyTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9가-힣]+/)
      .filter((t) => t.length >= 3),
  );
}

export interface BodyMatch {
  source_id: string;
  event_id: string;
}

/**
 * BODY search over ingested events: an event matches when `query` appears as a
 * substring of its text OR shares a significant token with it. This is broader
 * recall than title-token overlap because it sees the rationale/finding body,
 * not just the document title (ac-14). Pure helper over already-loaded events.
 */
export function searchEventBodies(
  query: string,
  events: ReadonlyArray<{ event_id: string; text: string; sources: string[] }>,
): BodyMatch[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const qTokens = bodyTokens(query);
  const out: BodyMatch[] = [];
  for (const e of events) {
    const body = e.text.toLowerCase();
    let hit = body.includes(q);
    if (!hit) {
      const bTokens = bodyTokens(e.text);
      for (const t of qTokens) {
        if (bTokens.has(t)) {
          hit = true;
          break;
        }
      }
    }
    if (hit) out.push({ source_id: e.sources[0] ?? '', event_id: e.event_id });
  }
  return out;
}

export interface BodyQueryResult extends FreshnessEnvelope {
  query: string;
  /** events whose BODY matches `query` (substring or shared significant token). */
  matches: BodyMatch[];
}

/**
 * BODY-search fallback (ac-2 / F2): when a query string is not a node id present
 * in the serving graph, search the ingested EVENT bodies (rationale/finding text)
 * instead of the graph adjacency. This gives wider recall than node-id/title
 * traversal — a term living only in a decision's rationale is still findable.
 * Reads the append-only events SoT (read-only) and attaches the same freshness
 * envelope as graph queries. Reuses `searchEventBodies` (bootstrap).
 */
export async function queryBodies(repoRoot: string, query: string): Promise<BodyQueryResult> {
  const events = await new MemoryEventStore(repoRoot).list();
  // §4-5 visibility (round-2 review R1): body search obeys the SAME rule as the
  // serving graph — approved chain heads only (reduceEvents), never
  // sensitivity=secret. Without this, pending/rejected/secret bodies would leak
  // through the body-search tier that projection/build already filter.
  const visible = reduceEvents(events).approvedHeads.filter((e) => e.sensitivity !== 'secret');
  const matches = searchEventBodies(query, visible);
  const freshness = await readFreshness(repoRoot);
  return { query, matches, ...freshness };
}

export interface PathResult {
  from: string;
  to: string;
  /** shortest path node ids inclusive of endpoints, or null if disconnected. */
  path: string[] | null;
}

/** BFS shortest path between two nodes (undirected). Pure / read-only. */
export function shortestPath(graph: ServingGraph, from: string, to: string): PathResult {
  const present = new Set(graph.nodes.map((n) => n.id));
  if (!present.has(from)) throw new MemoryNodeNotFoundError(from);
  if (!present.has(to)) throw new MemoryNodeNotFoundError(to);
  if (from === to) return { from, to, path: [from] };

  const prev = new Map<string, string>();
  const visited = new Set<string>([from]);
  const queue: string[] = [from];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    for (const nb of neighborsOf(graph, cur)) {
      if (visited.has(nb.to)) continue;
      visited.add(nb.to);
      prev.set(nb.to, cur);
      if (nb.to === to) {
        const path: string[] = [to];
        let step = to;
        while (step !== from) {
          step = prev.get(step) as string;
          path.push(step);
        }
        return { from, to, path: path.reverse() };
      }
      queue.push(nb.to);
    }
  }
  return { from, to, path: null };
}

export interface ExplainResult {
  node: { id: string; node_type: string; name: string };
  /** outgoing + incoming edges with the adjacent node id. */
  edges: Array<{ to: string; edge_type: string; direction: 'out' | 'in' }>;
}

/** Describe one node: its label + adjacent (out/in) edges. Pure / read-only. */
export function explainNode(graph: ServingGraph, node: string): ExplainResult {
  const found = graph.nodes.find((n) => n.id === node);
  if (!found) throw new MemoryNodeNotFoundError(node);
  const edges = neighborsOf(graph, node).sort((a, b) =>
    a.to < b.to ? -1 : a.to > b.to ? 1 : a.edge_type < b.edge_type ? -1 : 1,
  );
  return { node: { id: found.id, node_type: found.node_type, name: found.name }, edges };
}

export interface AuditCounts {
  /** nodes with no incoming and no outgoing edge. */
  orphan: number;
  /** sources whose current hash differs from the projection (stale, from status). */
  stale: number;
  /** edges that repeat the same (from,to,edge_type). */
  duplicate: number;
  /** CONTRADICTS edges in the serving graph. */
  contradiction: number;
}

export interface AuditEntry {
  audited_at: string;
  projection_id: string;
  freshness: Freshness;
  node_count: number;
  edge_count: number;
  counts: AuditCounts;
}

/** Compute audit counts over the serving graph + status. Pure. */
export function auditCounts(graph: ServingGraph, dirtySources: string[]): AuditCounts {
  const referenced = new Set<string>();
  const seenEdges = new Set<string>();
  let duplicate = 0;
  let contradiction = 0;
  for (const [from, edges] of Object.entries(graph.adjacency)) {
    for (const e of edges) {
      referenced.add(from);
      referenced.add(e.to);
      const key = `${from} ${e.to} ${e.edge_type}`;
      if (seenEdges.has(key)) duplicate++;
      else seenEdges.add(key);
      if (e.edge_type === 'CONTRADICTS') contradiction++;
    }
  }
  let orphan = 0;
  for (const n of graph.nodes) {
    if (!referenced.has(n.id)) orphan++;
  }
  return { orphan, stale: dirtySources.length, duplicate, contradiction };
}

/**
 * Append-only audit history (SoT tier, git-tracked under dittoDir/memory/).
 * Mirrors the events store's append-only discipline; one JSONL line per run, so
 * drift is read as a time series rather than a single snapshot (§4-6).
 */
export class MemoryAuditLogStore {
  constructor(public readonly repoRoot: string) {}

  private path(): string {
    return join(dittoDir(this.repoRoot), 'memory', 'audit-log.jsonl');
  }

  /** Append one entry as a JSONL line (never rewrites prior lines). */
  async append(entry: AuditEntry): Promise<void> {
    const p = this.path();
    await ensureDir(dirname(p));
    await appendFile(p, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** Read the full history in append order. */
  async list(): Promise<AuditEntry[]> {
    const p = this.path();
    if (!(await Bun.file(p).exists())) return [];
    const text = await Bun.file(p).text();
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AuditEntry);
  }
}

export interface AuditResult {
  entry: AuditEntry;
  /** number of entries in the history after this append (>= 1). */
  history_length: number;
}

/**
 * Run an audit: read the serving graph (read-only) + status, compute counts,
 * and append the result to the append-only history. Manual command only — no
 * automatic trigger and no curator hand-off (§4-6 / §5-4 gate).
 */
export async function runAudit(
  repoRoot: string,
  options: { now?: Date } = {},
): Promise<AuditResult> {
  const graph = await new MemoryProjectionStore(repoRoot).readServing();
  if (!graph) throw new MemoryProjectionAbsentError();
  const fresh = await readFreshness(repoRoot);

  let edgeCount = 0;
  for (const edges of Object.values(graph.adjacency)) edgeCount += edges.length;

  const entry: AuditEntry = {
    audited_at: (options.now ?? new Date()).toISOString(),
    projection_id: fresh.projection_id,
    freshness: fresh.freshness,
    node_count: graph.nodes.length,
    edge_count: edgeCount,
    counts: auditCounts(graph, fresh.dirty_sources),
  };

  const store = new MemoryAuditLogStore(repoRoot);
  await store.append(entry);
  const history = await store.list();
  return { entry, history_length: history.length };
}
