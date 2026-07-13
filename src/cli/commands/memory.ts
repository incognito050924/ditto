import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { defineCommand } from 'citty';
import { dittoDir } from '~/core/ditto-paths';
import { EvidenceStore } from '~/core/evidence-store';
import { resolveRepoRootForCreate } from '~/core/fs';
import { listChangedFiles } from '~/core/git';
import { generateId } from '~/core/id';
import { bootstrapIngest } from '~/core/memory-bootstrap';
import {
  type ChunkFile,
  assembleSemanticIr,
  chunkSources,
  findDanglingEdges,
  irFragmentsSchema,
  mergeIrFragments,
} from '~/core/memory-build';
import { measureHallucination } from '~/core/memory-measure';
import {
  MemoryEventAlreadyDecidedError,
  MemoryEventNotPendingError,
  MemorySelfApprovalError,
  approveEvent,
  memoryStatus,
  projectMemory,
  proposeEvent,
} from '~/core/memory-project';
import {
  type BodyQueryResult,
  MemoryNodeNotFoundError,
  MemoryProjectionAbsentError,
  explainNode,
  queryBodies,
  queryNeighbors,
  querySymbolBrief,
  readFreshness,
  readPullUsage,
  recordPullQuery,
  runAudit,
  shortestPath,
} from '~/core/memory-query';
import { scanSources } from '~/core/memory-scan';
import {
  MemoryEventExistsError,
  MemoryEventStore,
  MemoryGraphIrStore,
  MemoryProjectionStore,
  MemorySourceStore,
} from '~/core/memory-store';
import { readUsageReport } from '~/core/memory-warmstart';
import { workItemId as workItemIdSchema } from '~/schemas/common';
import type { EvidenceRecord } from '~/schemas/evidence-record';
import {
  type MemoryEvent,
  memoryEvent,
  memoryEventId,
  memoryEventType,
} from '~/schemas/memory-event';
import { memoryConfidenceKind } from '~/schemas/memory-graph-ir';
import { memorySensitivity, memorySourceId } from '~/schemas/memory-source';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/** Print the freshness envelope (§4-4) attached to every query/path/explain answer. */
function writeFreshnessHuman(f: {
  projection_id: string;
  generated_at: string;
  freshness: string;
  dirty_sources: string[];
  drifted_repos: string[];
  drifted_sources: string[];
}): void {
  writeHuman(
    `  [freshness: ${f.freshness} · projection: ${f.projection_id || '(absent)'} · generated: ${
      f.generated_at || '(absent)'
    } · dirty_sources: ${f.dirty_sources.length} · drifted_repos: ${
      f.drifted_repos.length
    } · drifted_sources: ${f.drifted_sources.length}]`,
  );
  // Make the axis-2 label actionable, not inert (design §3 D-H, ac-11): tell the
  // consumer to verify only the drifted sources directly (from code) and trust
  // the rest. The full consumer contract lives in skills/memory-graph/SKILL.md.
  if ((f.freshness === 'code_drift' || f.freshness === 'code_dirty') && f.drifted_sources.length) {
    writeHuman('  drift: verify the drifted_sources directly (from code); trust the rest.');
  }
}

/**
 * Dirty working-tree gate for scan/build (ac-9, design §3 D-E). A dirty CODE tree
 * means what is hashed may diverge from what gets committed, so the manifest
 * baseline could be stale. The tracked SoT under `.ditto/` is rewritten by
 * scan/project itself and is NOT code drift, so it is excluded from this check
 * (mirrors isRepoDirty in memory-project.ts:498-501; ac-6 false-positive rule).
 * Default is non-interactive-safe: warn (stderr) and proceed. `--require-clean`
 * turns it into a hard precondition: exit non-zero and do NOT proceed. Never
 * creates a commit or stash — diagnostic only. Returns true when the caller must
 * stop (already exited).
 */
function dirtyTreeGate(repoRoot: string, requireClean: boolean): boolean {
  const dirty = listChangedFiles(repoRoot).some((p) => !p.startsWith('.ditto/'));
  if (!dirty) return false;
  if (requireClean) {
    writeError(`working tree is dirty under ${repoRoot}; --require-clean refuses to proceed`);
    process.exit(USAGE_ERROR_EXIT);
    return true;
  }
  writeError(
    `warning: working tree is dirty under ${repoRoot}; the memory baseline may not match committed code (pass --require-clean to enforce, or commit first)`,
  );
  return false;
}

const memoryScan = defineCommand({
  meta: {
    name: 'scan',
    description: 'Hash code/document sources into the memory manifest and report changes',
  },
  args: {
    'source-root': {
      type: 'string',
      description: 'Directory to scan (absolute or repo-relative). Defaults to the repo root.',
      required: false,
    },
    'require-clean': {
      type: 'boolean',
      description: 'Hard-fail (non-zero exit) when the working tree is dirty instead of warning.',
      default: false,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    if (dirtyTreeGate(repoRoot, args['require-clean'])) return;
    try {
      const result = await scanSources(repoRoot, {
        ...(args['source-root'] ? { sourceRoot: args['source-root'] } : {}),
      });
      if (format === 'json') {
        writeJson({
          repo_root: repoRoot,
          scanned: result.scanned.length,
          added: result.added,
          changed: result.changed,
          unchanged: result.unchanged,
        });
      } else {
        writeHuman(`Scanned ${result.scanned.length} source(s) under ${repoRoot}`);
        writeHuman(`  added:     ${result.added.length}`);
        writeHuman(`  changed:   ${result.changed.length}`);
        writeHuman(`  unchanged: ${result.unchanged.length}`);
        for (const id of [...result.added, ...result.changed]) {
          const s = result.scanned.find((x) => x.source.source_id === id);
          writeHuman(`  ${s?.status === 'added' ? '+' : '~'} ${id}\t${s?.source.path ?? ''}`);
        }
      }
    } catch (err) {
      writeError(`memory scan failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const eventsAppend = defineCommand({
  meta: {
    name: 'append',
    description: 'Append one immutable memory event (append-only SoT)',
  },
  args: {
    type: {
      type: 'string',
      description: `Event type: ${memoryEventType.options.join('|')}`,
      required: true,
    },
    text: { type: 'string', description: 'Event body text', required: true },
    source: {
      type: 'string',
      description: 'Source id grounding this event (repeatable as comma-separated)',
      required: false,
    },
    actor: {
      type: 'string',
      description: 'Actor kind: user|agent (default agent)',
      default: 'agent',
    },
    role: { type: 'string', description: 'Agent role when actor=agent', required: false },
    confidence: {
      type: 'string',
      description: `Confidence kind: ${memoryConfidenceKind.options.join('|')} (default EXTRACTED)`,
      default: 'EXTRACTED',
    },
    sensitivity: {
      type: 'string',
      description: `Sensitivity: ${memorySensitivity.options.join('|')} (default internal)`,
      default: 'internal',
    },
    supersedes: {
      type: 'string',
      description: 'Event id this event supersedes (approval/correction chain)',
      required: false,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const actorKind = args.actor;
    if (actorKind !== 'user' && actorKind !== 'agent') {
      writeError(`--actor must be user|agent; got "${actorKind}"`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const sources = (args.source ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const s of sources) {
      if (!memorySourceId.safeParse(s).success) {
        writeError(`invalid --source id "${s}"`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
    }
    const repoRoot = await resolveRepoRootForCreate();
    const store = new MemoryEventStore(repoRoot);
    try {
      const eventId = await generateId('memevt', (candidate) =>
        Bun.file(`${repoRoot}/.ditto/memory/events/${candidate}.json`).exists(),
      );
      const draft = {
        schema_version: '0.1.0' as const,
        event_id: eventId,
        event_type: args.type,
        actor: { kind: actorKind, ...(args.role ? { role: args.role } : {}) },
        text: args.text,
        created_at: new Date().toISOString(),
        status: 'pending' as const,
        sources,
        confidence_kind: args.confidence,
        sensitivity: args.sensitivity,
        ...(args.supersedes ? { supersedes: args.supersedes } : {}),
      };
      const parsed = memoryEvent.safeParse(draft);
      if (!parsed.success) {
        writeError(`invalid event: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const written = await store.append(parsed.data);
      if (format === 'json') {
        writeJson(written);
      } else {
        writeHuman(`Appended event ${written.event_id}`);
        writeHuman(`  type:   ${written.event_type}`);
        writeHuman(`  status: ${written.status}`);
      }
    } catch (err) {
      if (err instanceof MemoryEventExistsError) {
        writeError(err.message);
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      writeError(
        `memory events append failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const eventsList = defineCommand({
  meta: {
    name: 'list',
    description: 'List memory events sorted by created_at ascending',
  },
  args: {
    limit: {
      type: 'string',
      description: 'Max number of (most recent) events to show',
      required: false,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    let limit: number | undefined;
    if (args.limit !== undefined) {
      const n = Number(args.limit);
      if (!Number.isInteger(n) || n < 0) {
        writeError(`--limit must be a non-negative integer; got "${args.limit}"`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      limit = n;
    }
    const repoRoot = await resolveRepoRootForCreate();
    const store = new MemoryEventStore(repoRoot);
    try {
      let events: MemoryEvent[] = await store.list();
      if (limit !== undefined) events = events.slice(Math.max(0, events.length - limit));
      // Consistency with the R1 visibility rule: no CLI read surface prints a
      // secret BODY. Metadata/id stay visible so curation (approve) still works.
      const disclosed = events.map((e) =>
        e.sensitivity === 'secret' ? { ...e, text: '[redacted: sensitivity=secret]' } : e,
      );
      if (format === 'json') {
        writeJson({ events: disclosed });
      } else if (disclosed.length === 0) {
        writeHuman('No memory events.');
      } else {
        for (const e of disclosed) {
          writeHuman(`${e.event_id}\t${e.created_at}\t${e.status}\t${e.event_type}\t${e.text}`);
        }
      }
    } catch (err) {
      writeError(`memory events list failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const eventsCommand = defineCommand({
  meta: { name: 'events', description: 'Append-only memory events (append, list)' },
  subCommands: { append: eventsAppend, list: eventsList },
});

const memoryBootstrap = defineCommand({
  meta: {
    name: 'bootstrap',
    description:
      'Ingest curated knowledge (ADR, glossary) and archived handoffs into the memory graph so day-1 is not a cold start (idempotent)',
  },
  args: {
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const r = await bootstrapIngest(repoRoot);
      if (format === 'json') {
        writeJson({
          sources_added: r.sourcesAdded,
          sources_skipped: r.sourcesSkipped,
          events_appended: r.eventsAppended,
          events_skipped: r.eventsSkipped,
        });
      } else {
        writeHuman(`Bootstrap ingest into ${repoRoot}`);
        writeHuman(`  sources:  +${r.sourcesAdded.length} (skipped ${r.sourcesSkipped.length})`);
        writeHuman(`  events:   +${r.eventsAppended.length} (skipped ${r.eventsSkipped.length})`);
      }
    } catch (err) {
      writeError(`memory bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const memoryBuild = defineCommand({
  meta: {
    name: 'build',
    description:
      'Build the memory Graph IR. Default is structure-only (cheap, §4-6). With --semantic it delegates LLM extraction to the host (ADR-0001): emit chunk request packets, or merge host-returned --fragments deterministically and write the IR.',
  },
  args: {
    semantic: {
      type: 'boolean',
      description: 'Enable the (expensive) semantic extraction path. Default off (structure only).',
      default: false,
    },
    fragments: {
      type: 'string',
      description:
        'Path to a JSON array of host-returned IR fragments ({nodes,edges}). When set with --semantic, merge them deterministically and write the IR.',
      required: false,
    },
    'source-root': {
      type: 'string',
      description:
        'Directory to scan for chunking (absolute or repo-relative). Defaults to repo root.',
      required: false,
    },
    'require-clean': {
      type: 'boolean',
      description: 'Hard-fail (non-zero exit) when the working tree is dirty instead of warning.',
      default: false,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    if (dirtyTreeGate(repoRoot, args['require-clean'])) return;

    // Default (no --semantic): structure-only cost grade (§4-6). Semantic
    // extraction is opt-in because it is expensive + non-deterministic (LLM).
    if (!args.semantic) {
      if (format === 'json') {
        writeJson({ mode: 'structure-only', semantic: false });
      } else {
        writeHuman('Structure-only build (cost grade §4-6). Pass --semantic for LLM extraction.');
      }
      return;
    }

    try {
      // --fragments: merge host-returned fragments deterministically + persist.
      if (args.fragments) {
        const path = isAbsolute(args.fragments) ? args.fragments : join(repoRoot, args.fragments);
        const raw = await readFile(path, 'utf8');
        const parsed = irFragmentsSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) {
          writeError(
            `invalid fragments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          );
          process.exit(USAGE_ERROR_EXIT);
          return;
        }
        const merged = mergeIrFragments(parsed.data);
        const stamp = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
        const ir = assembleSemanticIr(merged, {
          ir_version: `ir_${stamp}`,
          generated_at: new Date().toISOString(),
          extraction_run_id: `xrun_${stamp}`,
        });
        await new MemoryGraphIrStore(repoRoot).write(ir);
        const dangling = findDanglingEdges(ir.nodes, ir.edges);
        if (format === 'json') {
          writeJson({
            mode: 'semantic-merge',
            ir_version: ir.ir_version,
            nodes: ir.nodes.length,
            edges: ir.edges.length,
            dangling_edges: dangling.length,
          });
        } else {
          writeHuman(`Merged semantic IR ${ir.ir_version}`);
          writeHuman(`  nodes: ${ir.nodes.length}`);
          writeHuman(`  edges: ${ir.edges.length}`);
          writeHuman(`  dangling edges: ${dangling.length}`);
        }
        return;
      }

      // No fragments yet: scan + emit chunk request packets for the host to
      // fan out to the memory-extractor agent (delegation — ditto holds no provider).
      const scan = await scanSources(repoRoot, {
        ...(args['source-root'] ? { sourceRoot: args['source-root'] } : {}),
      });
      const files: ChunkFile[] = [];
      for (const s of scan.scanned) {
        const path = s.source.path;
        // chunking needs a file-backed source path; skip path-less sources.
        if (!path) continue;
        const abs = isAbsolute(path) ? path : join(repoRoot, path);
        files.push({
          source_id: s.source.source_id,
          path,
          content: await readFile(abs, 'utf8'),
          // R7: carry the source record's disclosure class so chunkSources'
          // secret filter is effective on the runtime path, not only in tests.
          sensitivity: s.source.sensitivity,
        });
      }
      const chunks = chunkSources(files);
      if (format === 'json') {
        writeJson({ mode: 'semantic-chunks', chunk_count: chunks.length, chunks });
      } else {
        writeHuman(`Semantic build: ${chunks.length} chunk(s) ready for memory-extractor.`);
        for (const c of chunks) {
          writeHuman(`  ${c.chunk_id}\t${c.files.length} file(s)`);
        }
        writeHuman(
          'Run extraction in the host, then: ditto memory build --semantic --fragments <out.json>',
        );
      }
    } catch (err) {
      writeError(`memory build failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const memoryProject = defineCommand({
  meta: {
    name: 'project',
    description:
      'Project the current Graph IR + approved events one-way into the serving graph, wiki, and manifest (§4-3). Projections are regenerated, never hand-edited.',
  },
  args: {
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const r = await projectMemory(repoRoot);
      if (format === 'json') {
        writeJson({
          projection_id: r.manifest.projection_id,
          set_hash: r.set_hash,
          nodes: r.node_count,
          edges: r.edge_count,
        });
      } else {
        writeHuman(`Projected ${r.manifest.projection_id}`);
        writeHuman(`  nodes: ${r.node_count}`);
        writeHuman(`  edges: ${r.edge_count}`);
        writeHuman(`  set_hash: ${r.set_hash.slice(0, 16)}`);
      }
    } catch (err) {
      writeError(`memory project failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const memoryStatusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Report projection freshness (fresh/stale/absent) and dirty sources (§4-4)',
  },
  args: {
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const s = await memoryStatus(repoRoot);
      if (format === 'json') {
        writeJson(s);
      } else {
        writeHuman(`Memory projection: ${s.freshness}`);
        if (s.projection_id) writeHuman(`  projection: ${s.projection_id}`);
        writeHuman(`  dirty sources: ${s.dirty_sources.length}`);
        for (const id of s.dirty_sources) writeHuman(`    ~ ${id}`);
        // R9 (AX): surface the approval backlog instead of letting it queue silently.
        writeHuman(`  pending approvals: ${s.pending_count}`);
        if (s.pending_count > 0) {
          writeHuman('    (decide with `ditto memory approve <eventId> --by <you> --actor user`)');
        }
      }
    } catch (err) {
      writeError(`memory status failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * Load the serving graph (read-only) for query/path/explain. Exits with a usage
 * error when nothing has been projected yet.
 */
async function loadServingOrExit(repoRoot: string) {
  const graph = await new MemoryProjectionStore(repoRoot).readServing();
  if (!graph) {
    writeError('no serving graph projected yet; run `ditto memory project` first');
    process.exit(USAGE_ERROR_EXIT);
  }
  return graph;
}

/**
 * BODY-search fallback for `query` (ac-2 / F2): when the node is absent from the
 * serving graph (or `--text` is given), search ingested event bodies instead of
 * graph adjacency, so a term living only in a rationale/finding is still found.
 * Records the pull (ac-8) with the match count as neighbor_count.
 */
async function runBodyQuery(
  repoRoot: string,
  node: string,
  depth: number,
  format: ReturnType<typeof parseOutputFormat>,
  // R9: distinguish the implicit node-not-found fallback from explicit --text in
  // machine output — exit 0 + empty matches is otherwise ambiguous with "known
  // node, no neighbors" for callers that used the old exit-65 signal.
  fallback: boolean,
): Promise<void> {
  const result: BodyQueryResult = await queryBodies(repoRoot, node);
  await recordPullQuery(repoRoot, {
    ts: new Date().toISOString(),
    node,
    depth,
    neighbor_count: result.matches.length,
    freshness: result.freshness,
  }).catch(() => {});
  if (format === 'json') {
    writeJson({ ...result, mode: 'body-search', fallback });
    return;
  }
  writeHuman(
    `Body matches for "${result.query}" (${fallback ? 'node not in graph — text fallback' : '--text'}):`,
  );
  for (const m of result.matches) writeHuman(`  - ${m.event_id}\t${m.source_id}`);
  if (result.matches.length === 0) writeHuman('  (none)');
  writeFreshnessHuman(result);
}

const memoryQuery = defineCommand({
  meta: {
    name: 'query',
    description:
      'Traverse the serving graph from a node (undirected BFS, default depth 2). Read-only; answer carries projection_id/generated_at/freshness/dirty_sources (§4-4).',
  },
  args: {
    node: { type: 'positional', description: 'Node id to start from', required: true },
    depth: { type: 'string', description: 'Traversal depth (default 2)', default: '2' },
    text: {
      type: 'boolean',
      description: 'Search event bodies (rationale/finding) instead of graph traversal (ac-2 / F2)',
      default: false,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const depth = Number(args.depth);
    if (!Number.isInteger(depth) || depth < 0) {
      writeError(`--depth must be a non-negative integer; got "${args.depth}"`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    try {
      // Explicit text mode: search event bodies, not the graph (ac-2 / F2).
      if (args.text) {
        await runBodyQuery(repoRoot, args.node, depth, format, false);
        return;
      }
      // A `symbol:<path>#<name>` id returns the decision-lineage brief (ac-1):
      // governing ADR(s) + rejected alternatives + invariants + per-item
      // EXTRACTED/INFERRED tag with cite/fallback/미발견 coverage — not generic
      // BFS neighbors.
      if (args.node.startsWith('symbol:') && args.node.includes('#')) {
        const brief = await querySymbolBrief(repoRoot, args.node);
        await recordPullQuery(repoRoot, {
          ts: new Date().toISOString(),
          node: args.node,
          depth,
          neighbor_count: brief.governing_adrs.length,
          freshness: brief.freshness,
        }).catch(() => {});
        if (format === 'json') {
          writeJson(brief);
        } else {
          writeHuman(`Decision-lineage brief for ${brief.symbol} (coverage: ${brief.coverage}):`);
          if (brief.items.length === 0) {
            writeHuman('  (no governing decision found — 미발견)');
          }
          for (const it of brief.items) {
            writeHuman(`  - ${it.adr_id}\t[${it.tag} · ${it.coverage}]`);
          }
          if (brief.rejected_alternatives.length > 0) {
            writeHuman(`  rejected alternatives (${brief.rejected_alternatives.length}):`);
            for (const a of brief.rejected_alternatives) writeHuman(`    × ${a}`);
          }
          if (brief.invariants.length > 0) {
            writeHuman(`  invariants (${brief.invariants.length}):`);
            for (const i of brief.invariants) writeHuman(`    ! ${i}`);
          }
          writeFreshnessHuman(brief);
        }
        return;
      }
      const graph = await loadServingOrExit(repoRoot);
      const result = queryNeighbors(graph, args.node, depth);
      const freshness = await readFreshness(repoRoot);
      // Instrument the pull (ac-8): the conditional pull habit must be observable
      // as an ACTUAL query utterance, not just prompt text. Best-effort — telemetry
      // never breaks the answer.
      await recordPullQuery(repoRoot, {
        ts: new Date().toISOString(),
        node: args.node,
        depth,
        neighbor_count: result.neighbors.length,
        freshness: freshness.freshness,
      }).catch(() => {});
      if (format === 'json') {
        writeJson({ ...result, ...freshness });
      } else {
        writeHuman(`Neighbors of ${result.root} within depth ${result.depth}:`);
        for (const id of result.neighbors) writeHuman(`  - ${id}`);
        if (result.neighbors.length === 0) writeHuman('  (none)');
        writeFreshnessHuman(freshness);
      }
    } catch (err) {
      // Node absent from the serving graph → fall back to BODY search (ac-2 / F2)
      // instead of failing, so the body-search recall is reachable at runtime.
      if (err instanceof MemoryNodeNotFoundError) {
        await runBodyQuery(repoRoot, args.node, depth, format, true);
        return;
      }
      writeError(`memory query failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const memoryPath = defineCommand({
  meta: {
    name: 'path',
    description:
      'Shortest path between two nodes (undirected BFS). Read-only; answer carries freshness (§4-4).',
  },
  args: {
    from: { type: 'positional', description: 'Start node id', required: true },
    to: { type: 'positional', description: 'Target node id', required: true },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const graph = await loadServingOrExit(repoRoot);
      const result = shortestPath(graph, args.from, args.to);
      const freshness = await readFreshness(repoRoot);
      if (format === 'json') {
        writeJson({ ...result, ...freshness });
      } else if (result.path) {
        writeHuman(`Path ${result.from} → ${result.to}:`);
        writeHuman(`  ${result.path.join(' → ')}`);
        writeFreshnessHuman(freshness);
      } else {
        writeHuman(`No path between ${result.from} and ${result.to}.`);
        writeFreshnessHuman(freshness);
      }
    } catch (err) {
      if (err instanceof MemoryNodeNotFoundError) {
        writeError(err.message);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      writeError(`memory path failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const memoryExplain = defineCommand({
  meta: {
    name: 'explain',
    description:
      'Describe one node: its label + adjacent edges. Read-only; answer carries freshness (§4-4).',
  },
  args: {
    node: { type: 'positional', description: 'Node id to explain', required: true },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const graph = await loadServingOrExit(repoRoot);
      const result = explainNode(graph, args.node);
      const freshness = await readFreshness(repoRoot);
      if (format === 'json') {
        writeJson({ ...result, ...freshness });
      } else {
        writeHuman(`${result.node.name} (${result.node.node_type})`);
        writeHuman(`  id: ${result.node.id}`);
        writeHuman(`  edges: ${result.edges.length}`);
        for (const e of result.edges) {
          writeHuman(`    ${e.direction === 'out' ? '→' : '←'} ${e.edge_type} ${e.to}`);
        }
        writeFreshnessHuman(freshness);
      }
    } catch (err) {
      if (err instanceof MemoryNodeNotFoundError) {
        writeError(err.message);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      writeError(`memory explain failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const memoryAudit = defineCommand({
  meta: {
    name: 'audit',
    description:
      'Count orphan/stale/duplicate/contradiction over the serving graph and append the result to the git-tracked append-only history (§4-6). Manual only — no auto-trigger.',
  },
  args: {
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const { entry, history_length } = await runAudit(repoRoot);
      if (format === 'json') {
        writeJson({ ...entry, history_length });
      } else {
        writeHuman(
          `Audit ${entry.projection_id} (${entry.freshness}) — history #${history_length}`,
        );
        writeHuman(`  nodes: ${entry.node_count}  edges: ${entry.edge_count}`);
        writeHuman(`  orphan:        ${entry.counts.orphan}`);
        writeHuman(`  stale sources: ${entry.counts.stale}`);
        writeHuman(`  duplicate:     ${entry.counts.duplicate}`);
        writeHuman(`  contradiction: ${entry.counts.contradiction}`);
      }
    } catch (err) {
      if (err instanceof MemoryProjectionAbsentError) {
        writeError(err.message);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      writeError(`memory audit failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const memoryPropose = defineCommand({
  meta: {
    name: 'propose',
    description:
      'Propose a pending memory event (write model, §4-5). Agents cannot write the graph directly; only propose→approve→re-projection. Creates a pending event (no approved_by).',
  },
  args: {
    type: {
      type: 'string',
      description: `Event type: ${memoryEventType.options.join('|')}`,
      required: true,
    },
    text: { type: 'string', description: 'Event body text', required: true },
    source: {
      type: 'string',
      description: 'Source id grounding this event (comma-separated)',
      required: false,
    },
    actor: {
      type: 'string',
      description: 'Actor kind: user|agent (default agent)',
      default: 'agent',
    },
    role: { type: 'string', description: 'Agent role when actor=agent', required: false },
    confidence: {
      type: 'string',
      description: `Confidence kind: ${memoryConfidenceKind.options.join('|')} (default EXTRACTED)`,
      default: 'EXTRACTED',
    },
    sensitivity: {
      type: 'string',
      description: `Sensitivity: ${memorySensitivity.options.join('|')} (default internal)`,
      default: 'internal',
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const actorKind = args.actor;
    if (actorKind !== 'user' && actorKind !== 'agent') {
      writeError(`--actor must be user|agent; got "${actorKind}"`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const sources = (args.source ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const s of sources) {
      if (!memorySourceId.safeParse(s).success) {
        writeError(`invalid --source id "${s}"`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
    }
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const written = await proposeEvent(repoRoot, {
        event_type: args.type as MemoryEvent['event_type'],
        text: args.text,
        sources,
        confidence_kind: args.confidence as MemoryEvent['confidence_kind'],
        sensitivity: args.sensitivity as MemoryEvent['sensitivity'],
        actor: { kind: actorKind, ...(args.role ? { role: args.role } : {}) },
      });
      if (format === 'json') {
        writeJson(written);
      } else {
        writeHuman(`Proposed event ${written.event_id}`);
        writeHuman(`  type:   ${written.event_type}`);
        writeHuman(`  status: ${written.status}`);
      }
    } catch (err) {
      if (err instanceof MemoryEventExistsError) {
        writeError(err.message);
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      // Schema rejection (e.g. bad type/source) is a usage error.
      if (/invalid|expected|required/i.test(msg)) {
        writeError(`memory propose failed: ${msg}`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      writeError(`memory propose failed: ${msg}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const memoryApprove = defineCommand({
  meta: {
    name: 'approve',
    description:
      'Approve (or --reject) a pending event (§10-2 F2). Original file is never mutated; a new immutable event with supersedes is appended, then the projection is regenerated.',
  },
  args: {
    eventId: { type: 'positional', description: 'Pending event id to approve', required: true },
    by: { type: 'string', description: 'Approver identity (required)', required: true },
    actor: {
      type: 'string',
      description: 'Approver kind: user|agent (default agent). Agents cannot self-approve.',
      default: 'agent',
    },
    reject: {
      type: 'boolean',
      description: 'Record a rejected decision instead of approved',
      default: false,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    if (!args.by || args.by.trim().length === 0) {
      writeError('--by <approver> is required');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    // F7: validate the event id against the schema (parity with append/propose
    // --source) before it is composed into a file path.
    if (!memoryEventId.safeParse(args.eventId).success) {
      writeError(`invalid event id "${args.eventId}"`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const approverKind = args.actor;
    if (approverKind !== 'user' && approverKind !== 'agent') {
      writeError(`--actor must be user|agent; got "${approverKind}"`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const { decision, projection } = await approveEvent(repoRoot, args.eventId, {
        by: args.by,
        approverKind,
        reject: args.reject,
      });
      if (format === 'json') {
        writeJson({
          decision,
          projection_id: projection.manifest.projection_id,
          set_hash: projection.set_hash,
          nodes: projection.node_count,
          edges: projection.edge_count,
        });
      } else {
        writeHuman(`${args.reject ? 'Rejected' : 'Approved'} ${args.eventId}`);
        writeHuman(`  decision event: ${decision.event_id} (supersedes ${decision.supersedes})`);
        writeHuman(`  status: ${decision.status} · by ${decision.approved_by}`);
        writeHuman(
          `  re-projected: ${projection.manifest.projection_id} (${projection.node_count} nodes)`,
        );
      }
    } catch (err) {
      if (
        err instanceof MemoryEventNotPendingError ||
        err instanceof MemoryEventAlreadyDecidedError ||
        err instanceof MemorySelfApprovalError
      ) {
        writeError(err.message);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (/ENOENT|no such file|not found/i.test(msg)) {
        writeError(`memory approve failed: event ${args.eventId} not found`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      writeError(`memory approve failed: ${msg}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * Where the evidence came from, rendered for the event text. The EvidenceRecord
 * has no stable id and is not a memory source, so the provenance cannot live in
 * the event's `sources` array (those must be `src_…` ids) — it is carried in the
 * text instead (memory-librarian §8 inc.3 design note, ac-3 predicate adjusted).
 */
function evidenceLocus(record: EvidenceRecord): string {
  const ref = record.ref;
  switch (ref.kind) {
    case 'command':
      return ref.command
        ? `command \`${ref.command}\`${record.exit_code !== null ? ` (exit ${record.exit_code})` : ''}`
        : 'command';
    case 'file':
    case 'artifact':
      if (ref.path) {
        return ref.lines ? `${ref.path}:${ref.lines.start}-${ref.lines.end}` : ref.path;
      }
      return ref.kind;
    case 'url':
      return ref.url ?? 'url';
    default:
      return ref.kind;
  }
}

/** Build the INFERRED observation body from an evidence record. */
function findingText(record: EvidenceRecord): string {
  const body = record.ref.summary ?? record.key_lines.join('\n');
  const sha = record.ref.sha256 ? ` sha256:${record.ref.sha256.slice(0, 12)}` : '';
  const text = `${body}\n\nevidence: ${evidenceLocus(record)}${sha}`.trim();
  // memoryEvent.text caps at 4000; truncate defensively (rare, long key_lines).
  return text.length > 4000 ? text.slice(0, 4000) : text;
}

const memoryProposeFinding = defineCommand({
  meta: {
    name: 'propose-finding',
    description:
      'Convert a captured evidence record into a pending INFERRED observation event (§8 inc.3, ac-3). Evidence-bound capture only: the agent self-report is grounded in an evidence record and never stored as fact. Selector: --work-item <id> --index <n> (EvidenceRecord has no stable id; see design note).',
  },
  args: {
    'work-item': {
      type: 'string',
      description: 'Work item id whose evidence-index.json holds the record',
      required: true,
    },
    index: {
      type: 'string',
      description: 'Zero-based index of the record in evidence-index.json',
      required: true,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const wi = args['work-item'];
    if (!workItemIdSchema.safeParse(wi).success) {
      writeError(`invalid --work-item id "${wi}"`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const index = Number(args.index);
    if (!Number.isInteger(index) || index < 0) {
      writeError(`--index must be a non-negative integer; got "${args.index}"`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const ledger = await new EvidenceStore(repoRoot).readIndex(wi);
      if (ledger.records.length === 0) {
        writeError(`no evidence records for work item ${wi}`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      if (index >= ledger.records.length) {
        writeError(`--index ${index} out of range (${ledger.records.length} record(s))`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const record = ledger.records[index];
      if (record === undefined) {
        throw new Error(`invariant: --index ${index} within bounds (checked above)`);
      }
      // confidence_kind=INFERRED: an agent-captured finding is a guess grounded
      // in evidence, never a fact (ac-3·ac-4). The laundering guard in
      // proposeEvent would downgrade EXTRACTED anyway; we set it explicitly.
      const written = await proposeEvent(repoRoot, {
        event_type: 'observation',
        text: findingText(record),
        sources: [],
        confidence_kind: 'INFERRED',
        actor: { kind: 'agent' },
      });
      if (format === 'json') {
        writeJson(written);
      } else {
        writeHuman(`Proposed finding ${written.event_id} from ${wi} evidence #${index}`);
        writeHuman(`  type:       ${written.event_type}`);
        writeHuman(`  confidence: ${written.confidence_kind}`);
        writeHuman(`  status:     ${written.status}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/invalid|expected|required/i.test(msg)) {
        writeError(`memory propose-finding failed: ${msg}`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      writeError(`memory propose-finding failed: ${msg}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const memoryCapture = defineCommand({
  meta: {
    name: 'capture',
    description:
      'Capture a data-dependent-case observation: a pending, INFERRED observation event grounded in ≥1 code-path source (wi_260621r2m, ac-1). Reuses the propose path; the agent self-report is never stored as fact (laundering downgrade) and must cite at least one source_type=code source.',
  },
  args: {
    text: { type: 'string', description: 'Observed data-dependent behavior', required: true },
    source: {
      type: 'string',
      description:
        'Code-path source id(s) grounding the observation (comma-separated, ≥1 required)',
      required: false,
    },
    role: { type: 'string', description: 'Agent role', required: false },
    // confidence is accepted for symmetry with `propose`; an agent EXTRACTED
    // claim is downgraded to INFERRED by proposeEvent's laundering guard (ac-1).
    confidence: {
      type: 'string',
      description: `Confidence kind: ${memoryConfidenceKind.options.join('|')} (default INFERRED)`,
      default: 'INFERRED',
    },
    sensitivity: {
      type: 'string',
      description: `Sensitivity: ${memorySensitivity.options.join('|')} (default internal)`,
      default: 'internal',
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const sources = (args.source ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const s of sources) {
      if (!memorySourceId.safeParse(s).success) {
        writeError(`invalid --source id "${s}"`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
    }
    const repoRoot = await resolveRepoRootForCreate();
    // Code-source floor (ac-1, finding-B): a data-dependent case is an observation
    // ABOUT code, so it must be grounded in ≥1 source that resolves to a
    // source_type='code' MemorySource. Enforced here at the CLI layer only — the
    // generic proposeEvent contract is left unchanged.
    const sourceStore = new MemorySourceStore(repoRoot);
    let hasCodeSource = false;
    for (const id of sources) {
      try {
        if ((await sourceStore.get(id)).source_type === 'code') {
          hasCodeSource = true;
          break;
        }
      } catch {
        // unresolvable source id — does not count toward the code floor
      }
    }
    if (!hasCodeSource) {
      writeError(
        'capture requires at least one --source resolving to a source_type=code MemorySource',
      );
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    try {
      const written = await proposeEvent(repoRoot, {
        event_type: 'observation',
        text: args.text,
        sources,
        confidence_kind: args.confidence as MemoryEvent['confidence_kind'],
        sensitivity: args.sensitivity as MemoryEvent['sensitivity'],
        actor: { kind: 'agent', ...(args.role ? { role: args.role } : {}) },
      });
      if (format === 'json') {
        writeJson(written);
      } else {
        writeHuman(`Captured observation ${written.event_id}`);
        writeHuman(`  type:       ${written.event_type}`);
        writeHuman(`  confidence: ${written.confidence_kind}`);
        writeHuman(`  status:     ${written.status}`);
      }
    } catch (err) {
      if (err instanceof MemoryEventExistsError) {
        writeError(err.message);
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (/invalid|expected|required/i.test(msg)) {
        writeError(`memory capture failed: ${msg}`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      writeError(`memory capture failed: ${msg}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const memoryMeasure = defineCommand({
  meta: {
    name: 'measure',
    description:
      'Compute the hallucination-reduction baseline (§8 inc.5, ac-5): re-proposal rate against catalogued rejected alternatives + invariant inventory + ADR parse coverage. measure-before-expand gate data source (ADR-0013 D4). Pass --against <file,...> to check candidate plan texts for re-proposals.',
  },
  args: {
    against: {
      type: 'string',
      description: 'Comma-separated candidate text file(s) to scan for re-proposals',
      required: false,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    const adrDir = join(dittoDir(repoRoot), 'knowledge', 'adr');
    let names: string[];
    try {
      names = (await readdir(adrDir)).filter((n) => n.endsWith('.md')).sort();
    } catch {
      writeError(`no ADR directory at ${adrDir}`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    if (names.length === 0) {
      writeError(`no ADRs found under ${adrDir}`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    try {
      const adrs = await Promise.all(
        names.map(async (n) => ({ id: n, body: await readFile(join(adrDir, n), 'utf8') })),
      );
      const candidateFiles = (args.against ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const candidates = await Promise.all(
        candidateFiles.map((f) => readFile(isAbsolute(f) ? f : join(repoRoot, f), 'utf8')),
      );
      const report = measureHallucination(adrs, candidates);
      if (format === 'json') {
        writeJson(report);
      } else {
        writeHuman('Hallucination-reduction baseline (ac-5):');
        writeHuman(
          `  ADRs: ${report.adrs_total} (with 대안 section: ${report.adrs_with_rejected_section})`,
        );
        if (report.adrs_without_rejected_section.length > 0) {
          writeHuman(`  no 대안 section: ${report.adrs_without_rejected_section.join(', ')}`);
        }
        writeHuman(`  rejected alternatives catalogued: ${report.rejected_alternatives_total}`);
        writeHuman(`  invariants (low-precision scan): ${report.invariants_total}`);
        writeHuman(`  candidates scanned: ${report.candidates_total}`);
        writeHuman(
          `  re-proposals detected: ${report.reproposals_detected} (rate ${report.reproposal_rate.toFixed(3)})`,
        );
        writeHuman('  invariant violation rate: not computed (prose-scattered — see doc)');
      }
    } catch (err) {
      writeError(`memory measure failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const memoryUsage = defineCommand({
  meta: {
    name: 'usage',
    description:
      'Report memory usage instrumentation (ac-12): warm-start metrics (opportunity/attempt/hit/actionable) for a work item, plus the global pull-query count. Read-only.',
  },
  args: {
    'work-item': {
      type: 'string',
      description: 'Work item id whose warm-start usage to tally (omit to report pull usage only)',
      required: false,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const warmstart = args['work-item']
        ? await readUsageReport(repoRoot, args['work-item'])
        : undefined;
      const pull = await readPullUsage(repoRoot);
      if (format === 'json') {
        writeJson({
          ...(args['work-item'] ? { work_item_id: args['work-item'] } : {}),
          warmstart: warmstart
            ? {
                opportunities: warmstart.opportunities,
                attempts: warmstart.attempts,
                hits: warmstart.hits,
                actionable: warmstart.actionable,
                hit_node_types: warmstart.hit_node_types,
              }
            : null,
          pull: { queries: pull.length },
        });
      } else {
        if (warmstart) {
          writeHuman(`Warm-start usage for ${args['work-item']}:`);
          writeHuman(`  opportunities: ${warmstart.opportunities}`);
          writeHuman(`  attempts:      ${warmstart.attempts}`);
          writeHuman(`  hits:          ${warmstart.hits}`);
          writeHuman(`  actionable:    ${warmstart.actionable}`);
          const types = Object.entries(warmstart.hit_node_types)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([t, n]) => `${t}=${n}`)
            .join(' ');
          if (types.length > 0) writeHuman(`  hit node types: ${types}`);
        } else {
          writeHuman('Warm-start usage: (pass --work-item <id> to tally)');
        }
        writeHuman(`Pull-query usage: ${pull.length} query(ies)`);
      }
    } catch (err) {
      writeError(`memory usage failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

export const memoryCommand = defineCommand({
  meta: {
    name: 'memory',
    description: 'Memory subsystem — scan sources and record append-only events',
  },
  subCommands: {
    scan: memoryScan,
    events: eventsCommand,
    bootstrap: memoryBootstrap,
    build: memoryBuild,
    project: memoryProject,
    status: memoryStatusCommand,
    query: memoryQuery,
    path: memoryPath,
    explain: memoryExplain,
    audit: memoryAudit,
    usage: memoryUsage,
    propose: memoryPropose,
    'propose-finding': memoryProposeFinding,
    capture: memoryCapture,
    measure: memoryMeasure,
    approve: memoryApprove,
  },
});
