/**
 * Warm-start memory push for autopilot dispatch (§5-1 / §10-6 #1, increment #9).
 *
 * The ONE place the autopilot loop consults the memory serving graph before it
 * spawns a researcher/planner node. Everything here is **fail-open and
 * non-invasive**: a throw, an absent/empty/stale graph, or no semantic coverage
 * all yield `undefined`, so the loop builds the exact same packet it would have
 * without memory (the dispatch path is never blocked or broken — §10-6 degrade
 * column, ac-9).
 *
 * Rollback invariant (ac-13 준비, §10-9): this is the SINGLE entry point for the
 * query. The loop never reaches into memory-query/-project directly, so warm-start
 * can later be disabled behind one flag (`DITTO_MEMORY=off`, the master switch —
 * or the granular `DITTO_MEMORY_WARMSTART=0`) without touching the dispatch code. The toolset of the read-only memory query is also
 * the only memory IO the dispatch path performs.
 *
 * Instrumentation (ac-12): every chance to warm-start is one *opportunity*; a
 * graph that is present + fresh + has the queried root is one *attempt*; a query
 * that returns ≥1 related node is a *hit*; an answer actually injected into the
 * packet is *actionable*. The four counters are appended as one JSONL line per
 * spawn under the work item's memory/ dir so a readable report can be produced
 * (threshold-free this round — the condition is "instrumentation exists +
 * produces data").
 */
import { appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AutopilotNode } from '~/schemas/autopilot';
import type { WorkItem } from '~/schemas/work-item';
import { localDir } from './ditto-paths';
import { ensureDir } from './fs';
import { isMemoryEnabled } from './memory-flag';
import { type Freshness, memoryStatus } from './memory-project';
import { type DecisionBrief, queryDecisionBriefs, queryNeighbors } from './memory-query';
import { MemoryProjectionStore, type ServingGraph } from './memory-store';

/** The optional memory context injected into a delegation packet (§10-6 #1). */
export interface MemoryWarmStartContext {
  /** node ids related to the work item within the query depth (ranked, capped). */
  related_nodes?: string[];
  /** Decision-node ids among the related set (a Decision is high-signal context). */
  decisions?: string[];
  /**
   * Decision briefs for the related Decisions — a bare id is not actionable, so
   * the agent gets the governing decision's STRUCTURED gist (rejected-alternatives
   * + invariants + EXTRACTED/INFERRED tag, assembled by the ac-1 brief assembler)
   * to cite or abstain against (memory-librarian §8 inc.2, ac-2). A decision whose
   * body does not resolve degrades to id+summary with empty gist (미발견).
   */
  decision_briefs?: DecisionBrief[];
}

/** One usage-instrumentation record (ac-12), appended as a JSONL line per spawn. */
export interface MemoryUsageRecord {
  ts: string;
  work_item_id: string;
  node_id: string;
  owner: AutopilotNode['owner'];
  /** there was a chance to warm-start (a researcher/planner spawn). */
  opportunity: boolean;
  /** the graph was present + fresh + the queried root existed → a query ran. */
  attempt: boolean;
  /** the query returned ≥1 related node. */
  hit: boolean;
  /** a non-empty memory context was actually injected into the packet. */
  actionable: boolean;
  /** structural freshness of the projection at query time (for the report). */
  freshness?: Freshness;
  /**
   * node_type decomposition of the related set on a hit (ac-10, round-2 review):
   * lets the expansion gate see WHAT the hits are (Decision-skewed vs semantic-
   * layer contribution) instead of a bare hit count.
   */
  hit_node_types?: Record<string, number>;
}

/** Owners that receive a warm-start push (§5-1: cold-restart cost is large here). */
function isWarmStartOwner(owner: AutopilotNode['owner']): boolean {
  return owner === 'researcher' || owner === 'planner';
}

/**
 * Off-switch for the warm-start query (rollback invariant, §10-9 ①/②). The master
 * `DITTO_MEMORY=off` disables it (subsumes the granular flag); the granular
 * `DITTO_MEMORY_WARMSTART=0` still disables just warm-start when the master is on.
 */
function warmStartEnabled(): boolean {
  return isMemoryEnabled() && process.env.DITTO_MEMORY_WARMSTART !== '0';
}

const RELATED_NODE_CAP = 8;

/** Lowercase alphanumeric tokens (≥4 chars) for coarse semantic coverage matching. */
function tokensOf(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 4);
}

/**
 * Pick serving-graph nodes whose id/name shares a token with the work item
 * (coarse semantic coverage). Empty result ⇒ no coverage ⇒ injection suppressed.
 */
function coverageRoots(graph: ServingGraph, workItem: WorkItem): string[] {
  const want = new Set([...tokensOf(workItem.title), ...tokensOf(workItem.goal)]);
  if (want.size === 0) return [];
  const roots: string[] = [];
  for (const n of graph.nodes) {
    const have = new Set([...tokensOf(n.id), ...tokensOf(n.name)]);
    if ([...have].some((t) => want.has(t))) roots.push(n.id);
  }
  return roots.sort();
}

/** Append one usage record under the work item's memory/ dir (best-effort). */
async function recordUsage(repoRoot: string, record: MemoryUsageRecord): Promise<void> {
  const path = usageLogPath(repoRoot, record.work_item_id);
  await ensureDir(dirname(path));
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
}

/** Path to the warm-start usage JSONL for a work item (ac-12 report source). */
export function usageLogPath(repoRoot: string, workItemId: string): string {
  return localDir(repoRoot, 'work-items', workItemId, 'memory', 'warmstart-usage.jsonl');
}

export interface UsageReport {
  opportunities: number;
  attempts: number;
  hits: number;
  actionable: number;
  /** summed node_type decomposition across all hit records (ac-10). */
  hit_node_types: Record<string, number>;
  records: MemoryUsageRecord[];
}

/** Read the usage JSONL into a tallied report (ac-12: a readable report). */
export async function readUsageReport(repoRoot: string, workItemId: string): Promise<UsageReport> {
  const path = usageLogPath(repoRoot, workItemId);
  let records: MemoryUsageRecord[] = [];
  if (await Bun.file(path).exists()) {
    const text = await Bun.file(path).text();
    records = text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as MemoryUsageRecord);
  }
  const hitNodeTypes: Record<string, number> = {};
  for (const r of records) {
    for (const [t, n] of Object.entries(r.hit_node_types ?? {})) {
      hitNodeTypes[t] = (hitNodeTypes[t] ?? 0) + n;
    }
  }
  return {
    opportunities: records.filter((r) => r.opportunity).length,
    attempts: records.filter((r) => r.attempt).length,
    hits: records.filter((r) => r.hit).length,
    actionable: records.filter((r) => r.actionable).length,
    hit_node_types: hitNodeTypes,
    records,
  };
}

/**
 * Consult the serving graph for context to warm-start a researcher/planner node.
 *
 * Returns `undefined` (⇒ packet unchanged) for every degrade path: non-warm-start
 * owner, disabled, projection absent, NOT fresh (stale freshness suppressed,
 * §10-6 / ac-9), no semantic coverage, no related node, or any thrown error. Each
 * call appends one instrumentation record (ac-12) — except the cheap non-owner /
 * disabled short-circuits, which are not dispatch opportunities to measure.
 */
export async function warmStartMemoryContext(
  repoRoot: string,
  node: AutopilotNode,
  workItem: WorkItem,
  options: { now?: Date } = {},
): Promise<MemoryWarmStartContext | undefined> {
  if (!isWarmStartOwner(node.owner) || !warmStartEnabled()) return undefined;

  const now = (options.now ?? new Date()).toISOString();
  const base: MemoryUsageRecord = {
    ts: now,
    work_item_id: workItem.id,
    node_id: node.id,
    owner: node.owner,
    opportunity: true,
    attempt: false,
    hit: false,
    actionable: false,
  };

  try {
    // Freshness gate (§10-6, §3 D-G / ac-5): suppress on the trust-defect set
    // {stale, absent, code_drift} — a stale answer or one whose owning-repo HEAD
    // has diverged, used as settled, is worse than no answer (ac-9). But
    // `code_dirty` (working tree edited, not committed) is NOT suppressed: that is
    // the normal mid-development state, so suppressing it would make memory inert
    // the moment a file is touched. We inject and preserve the `code_dirty` label
    // (below) so the consumer knows the working tree was dirty.
    const status = await memoryStatus(repoRoot);
    base.freshness = status.freshness;
    if (status.freshness !== 'fresh' && status.freshness !== 'code_dirty') {
      await recordUsage(repoRoot, base);
      return undefined;
    }
    const graph = await new MemoryProjectionStore(repoRoot).readServing();
    if (!graph || graph.nodes.length === 0) {
      await recordUsage(repoRoot, base);
      return undefined;
    }
    // Semantic coverage gate: no work-item-related node ⇒ no coverage ⇒ suppress.
    const roots = coverageRoots(graph, workItem);
    if (roots.length === 0) {
      await recordUsage(repoRoot, base);
      return undefined;
    }
    base.attempt = true;

    const related = new Set<string>();
    for (const root of roots) {
      related.add(root);
      for (const nb of queryNeighbors(graph, root, 2).neighbors) related.add(nb);
    }
    const relatedNodes = [...related].sort().slice(0, RELATED_NODE_CAP);
    if (relatedNodes.length === 0) {
      await recordUsage(repoRoot, base);
      return undefined;
    }
    base.hit = true;

    // ac-10: decompose the hit by node_type so the gate can tell Decision-skew
    // from semantic-layer contribution.
    const typeOf = new Map(graph.nodes.map((n) => [n.id, n.node_type]));
    const hitTypes: Record<string, number> = {};
    for (const id of relatedNodes) {
      const t = typeOf.get(id) ?? 'unknown';
      hitTypes[t] = (hitTypes[t] ?? 0) + 1;
    }
    base.hit_node_types = hitTypes;

    const decisionIds = new Set(
      graph.nodes.filter((n) => n.node_type === 'Decision').map((n) => n.id),
    );
    const decisions = relatedNodes.filter((id) => decisionIds.has(id));
    // Decision briefs (ac-2): expand each related Decision id to the STRUCTURED
    // brief (rejected-alternatives + invariants + EXTRACTED/INFERRED tag) via the
    // reused ac-1 assembler, so the packet carries the governing decision's gist,
    // not just an id+name. The node name is kept as the readable `summary`.
    const nameOf = new Map(graph.nodes.map((n) => [n.id, n.name]));
    const decisionBriefs = await queryDecisionBriefs(
      repoRoot,
      decisions.map((id) => ({ id, summary: nameOf.get(id) ?? id })),
    );

    base.actionable = true;
    await recordUsage(repoRoot, base);
    return {
      related_nodes: relatedNodes,
      ...(decisions.length > 0 ? { decisions } : {}),
      ...(decisionBriefs.length > 0 ? { decision_briefs: decisionBriefs } : {}),
    };
  } catch {
    // Fail-open: any error in the query path leaves dispatch exactly as it was.
    try {
      await recordUsage(repoRoot, base);
    } catch {
      // even instrumentation must not break dispatch.
    }
    return undefined;
  }
}
