import { defineCommand } from 'citty';
import { resolveRepoRootForCreate } from '~/core/fs';
import { generateId } from '~/core/id';
import { bootstrapIngest } from '~/core/memory-bootstrap';
import { scanSources } from '~/core/memory-scan';
import { MemoryEventExistsError, MemoryEventStore } from '~/core/memory-store';
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

export const memoryCommand = defineCommand({
  meta: {
    name: 'memory',
    description: 'Memory subsystem — scan sources and record append-only events',
  },
  subCommands: {
    scan: memoryScan,
    events: eventsCommand,
    bootstrap: memoryBootstrap,
  },
});
