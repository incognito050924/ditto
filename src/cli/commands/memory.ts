import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { defineCommand } from 'citty';
import { resolveRepoRootForCreate } from '~/core/fs';
import { generateId } from '~/core/id';
import { bootstrapIngest } from '~/core/memory-bootstrap';
import {
  type ChunkFile,
  assembleSemanticIr,
  chunkSources,
  irFragmentsSchema,
  mergeIrFragments,
} from '~/core/memory-build';
import { memoryStatus, projectMemory } from '~/core/memory-project';
import { scanSources } from '~/core/memory-scan';
import { MemoryEventExistsError, MemoryEventStore, MemoryGraphIrStore } from '~/core/memory-store';
import { type MemoryEvent, memoryEvent, memoryEventType } from '~/schemas/memory-event';
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
      if (format === 'json') {
        writeJson({ events });
      } else if (events.length === 0) {
        writeHuman('No memory events.');
      } else {
        for (const e of events) {
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
        if (format === 'json') {
          writeJson({
            mode: 'semantic-merge',
            ir_version: ir.ir_version,
            nodes: ir.nodes.length,
            edges: ir.edges.length,
          });
        } else {
          writeHuman(`Merged semantic IR ${ir.ir_version}`);
          writeHuman(`  nodes: ${ir.nodes.length}`);
          writeHuman(`  edges: ${ir.edges.length}`);
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
      }
    } catch (err) {
      writeError(`memory status failed: ${err instanceof Error ? err.message : String(err)}`);
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
  },
});
