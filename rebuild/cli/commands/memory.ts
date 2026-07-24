import { randomBytes } from 'node:crypto';

import { defineCommand } from 'citty';

import { autoMemoryContext } from '../../memory/auto-context';
import { projectMemory } from '../../memory/projection';
import { queryMemory } from '../../memory/query';
import { realAppendEvent } from '../../memory/real-entry';
import { loadEvents } from '../../memory/store';
import { LegacyRecorderActiveError } from '../../record/flip-gate';
import {
  type MemoryEvent,
  memoryConfidenceKind,
  memoryEvent,
  memorySensitivity,
  memoryEventType,
} from '../../schemas/memory-event';
import { MemoryEventExistsError } from '../../memory/store';
import { findRepoRoot } from '../../util/fs';
import { RUNTIME_ERROR_EXIT, USAGE_ERROR_EXIT, parseOutputFormat, writeError, writeHuman, writeJson } from '../util';

/**
 * `ditto memory` (rebuild host surface) — a thin front over the REBUILT memory
 * engine only. It exposes exactly the capabilities the rebuild backs today:
 *  - events append : realAppendEvent (flip-gated real write)
 *  - events list   : loadEvents
 *  - query         : queryMemory (visible-head body search)
 *  - project       : projectMemory (pure serving projection)
 *
 * The old src had ~16 verbs (scan/build/bootstrap/status/path/explain/audit/
 * usage/propose/approve/…); those are OMITTED here because no rebuilt engine
 * function backs them yet. This surface grows one engine-backed verb at a time.
 */

/** A secret body never leaves the SoT through a read surface; metadata stays visible. */
function redactSecret(e: MemoryEvent): MemoryEvent {
  return e.sensitivity === 'secret' ? { ...e, text: '[redacted: sensitivity=secret]' } : e;
}

const eventsAppend = defineCommand({
  meta: {
    name: 'append',
    description: 'Append one immutable memory event (append-only SoT). Flip-gated real write.',
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
      description: 'Source id(s) grounding this event (comma-separated)',
      required: false,
    },
    actor: { type: 'string', description: 'Actor kind: user|agent (default agent)', default: 'agent' },
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
    }
    const actorKind = args.actor;
    if (actorKind !== 'user' && actorKind !== 'agent') {
      writeError(`--actor must be user|agent; got "${actorKind}"`);
      process.exit(USAGE_ERROR_EXIT);
    }
    const sources = (args.source ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const draft = {
      schema_version: '0.1.0',
      event_id: `memevt_${Date.now().toString(36)}${randomBytes(5).toString('hex')}`,
      event_type: args.type,
      actor: { kind: actorKind, ...(args.role ? { role: args.role } : {}) },
      text: args.text,
      created_at: new Date().toISOString(),
      status: 'pending',
      sources,
      confidence_kind: args.confidence,
      sensitivity: args.sensitivity,
      ...(args.supersedes ? { supersedes: args.supersedes } : {}),
    };
    const parsed = memoryEvent.safeParse(draft);
    if (!parsed.success) {
      writeError(`invalid event: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      process.exit(USAGE_ERROR_EXIT);
    }
    const repoRoot = await findRepoRoot();
    try {
      await realAppendEvent(repoRoot, parsed.data);
      if (format === 'json') {
        writeJson(parsed.data);
      } else {
        writeHuman(`Appended event ${parsed.data.event_id}`);
        writeHuman(`  type:   ${parsed.data.event_type}`);
        writeHuman(`  status: ${parsed.data.status}`);
      }
    } catch (err) {
      if (err instanceof LegacyRecorderActiveError || err instanceof MemoryEventExistsError) {
        writeError(err.message);
        process.exit(RUNTIME_ERROR_EXIT);
      }
      writeError(`memory events append failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const eventsList = defineCommand({
  meta: { name: 'list', description: 'List stored memory events sorted by created_at ascending' },
  args: {
    limit: { type: 'string', description: 'Max number of (most recent) events to show', required: false },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
    }
    let limit: number | undefined;
    if (args.limit !== undefined) {
      const n = Number(args.limit);
      if (!Number.isInteger(n) || n < 0) {
        writeError(`--limit must be a non-negative integer; got "${args.limit}"`);
        process.exit(USAGE_ERROR_EXIT);
      }
      limit = n;
    }
    const repoRoot = await findRepoRoot();
    try {
      let events = await loadEvents(repoRoot);
      events = [...events].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
      if (limit !== undefined) events = events.slice(Math.max(0, events.length - limit));
      const disclosed = events.map(redactSecret);
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

const memoryQuery = defineCommand({
  meta: {
    name: 'query',
    description:
      'Search visible (approved, non-secret) memory event bodies for text. Read-only. Pass --auto to route through the DITTO_MEMORY master switch (fail-open: no output when off).',
  },
  args: {
    text: { type: 'positional', description: 'Query text', required: true },
    auto: {
      type: 'boolean',
      description: 'Route through the automatic memory-context switch (DITTO_MEMORY)',
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
    }
    const repoRoot = await findRepoRoot();
    try {
      const events = await loadEvents(repoRoot);
      const hits = args.auto
        ? (autoMemoryContext(events, { text: args.text }) ?? [])
        : queryMemory(events, { text: args.text });
      if (format === 'json') {
        writeJson({ query: args.text, matches: hits });
      } else if (hits.length === 0) {
        writeHuman(`No matches for "${args.text}".`);
      } else {
        writeHuman(`Matches for "${args.text}":`);
        for (const e of hits) writeHuman(`  - ${e.event_id}\t${e.event_type}\t${e.text}`);
      }
    } catch (err) {
      writeError(`memory query failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const memoryProject = defineCommand({
  meta: {
    name: 'project',
    description:
      'Compute the serving projection from the event log (visible approved heads). Read-only; a pure function of the visible head set.',
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
    }
    const repoRoot = await findRepoRoot();
    try {
      const events = await loadEvents(repoRoot);
      const projection = projectMemory(events);
      if (format === 'json') {
        writeJson(projection);
      } else {
        writeHuman(`Projection ${projection.projection_id}`);
        writeHuman(`  generated_at: ${projection.generated_at}`);
        writeHuman(`  set_hash:     ${projection.set_hash.slice(0, 16)}`);
        writeHuman(`  nodes:        ${projection.nodes.length}`);
        for (const n of projection.nodes) writeHuman(`    - ${n.event_id}\t${n.event_type}\t${n.text}`);
      }
    } catch (err) {
      writeError(`memory project failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

export const memoryCommand = defineCommand({
  meta: {
    name: 'memory',
    description: 'Memory subsystem (rebuild) — append-only events, body query, and serving projection',
  },
  subCommands: {
    events: eventsCommand,
    query: memoryQuery,
    project: memoryProject,
  },
});
