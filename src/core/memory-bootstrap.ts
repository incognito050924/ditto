/**
 * Memory bootstrap ingest (increment "bootstrap", design §10-9 / OBJ-R2-003·004,
 * intent ac-14). Seeds the memory graph from knowledge ALREADY curated in the
 * repo so day-1 is not a cold start (empty graph). It reuses the #2 stores
 * (MemorySourceStore / MemoryEventStore) and adds NO new write model.
 *
 * Three corpora are ingested:
 *   - ADR     `.ditto/knowledge/adr/*.md`  → source(spec) + event(decision, approved)
 *   - glossary `.ditto/knowledge/glossary.json` → source(spec) + event(observation) per term
 *   - archived handoff `.ditto/local/handoff/archive/*.md` → source(note) + event(observation)
 *
 * Idempotency: both ids are content/path-derived (stable). Sources are skipped
 * when already present with the same content_hash. Events are immutable
 * (open 'wx'); a duplicate id raises MemoryEventExistsError, which we treat as a
 * graceful skip (the event already exists) rather than an error.
 *
 * All bootstrap events are written `approved` (and therefore carry
 * `approved_by='bootstrap'` + `decided_at` to satisfy the approval invariant —
 * src/schemas/memory-event.ts superRefine). Bootstrap ingests knowledge that is
 * ALREADY curated (`.ditto/knowledge` + archived handoffs), so it is legitimate
 * to seed it approved — otherwise the reducer drops every pending event and the
 * serving graph holds only ADR decisions (the glossary/handoff would never show).
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { MemoryEvent } from '~/schemas/memory-event';
import type { MemorySource } from '~/schemas/memory-source';
import { dittoDir, localDir } from './ditto-paths';
import { sourceIdForPath } from './memory-scan';
import {
  MemoryEventExistsError,
  MemoryEventStore,
  MemorySourceStore,
  sha256Hex,
} from './memory-store';

/** Stable, content-derived event id: `memevt_<12 hex of sha256(key)>`. */
export function bootstrapEventId(key: string): string {
  return `memevt_${sha256Hex(key).slice(0, 12)}`;
}

/** Best-effort HEAD sha for the repo work tree; null if not git or git missing. */
function gitHeadSha(repoRoot: string): string | null {
  const proc = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) return null;
  const sha = (proc.stdout?.toString() ?? '').trim();
  return /^[a-f0-9]{40}$/.test(sha) ? sha : null;
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter((w) => w.length > 0).length;
}

/** First `# Heading` line of a markdown body, else the first non-empty line. */
function markdownTitle(body: string): string {
  const lines = body.split('\n');
  for (const line of lines) {
    const m = line.match(/^#\s+(.+)$/);
    if (m?.[1]) return m[1].trim();
  }
  for (const line of lines) {
    if (line.trim().length > 0) return line.trim();
  }
  return '';
}

/**
 * Extract the searchable gist of an ADR: title + the "결정"(decision) and
 * "근거"(rationale) sections. This is the part ac-14 needs to be searchable by
 * BODY content, not just the title token (a term in the rationale must be
 * findable even when absent from the title).
 */
function adrGist(body: string): string {
  const title = markdownTitle(body);
  const sections: string[] = [];
  const lines = body.split('\n');
  let capturing = false;
  let captured: string[] = [];
  const flush = () => {
    if (captured.length > 0) sections.push(captured.join('\n').trim());
    captured = [];
  };
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      flush();
      const name = heading[1]?.trim() ?? '';
      capturing = /결정|근거|decision|rationale/i.test(name);
      continue;
    }
    if (capturing) captured.push(line);
  }
  flush();
  const gist = sections.join('\n\n').trim();
  const text = gist.length > 0 ? `${title}\n\n${gist}` : title;
  return text.slice(0, 4000);
}

interface GlossaryEntry {
  term: string;
  definition?: string;
  aliases?: string[];
}

export interface IngestResult {
  sourcesAdded: string[];
  sourcesSkipped: string[];
  eventsAppended: string[];
  eventsSkipped: string[];
}

function emptyResult(): IngestResult {
  return { sourcesAdded: [], sourcesSkipped: [], eventsAppended: [], eventsSkipped: [] };
}

function merge(into: IngestResult, from: IngestResult): void {
  into.sourcesAdded.push(...from.sourcesAdded);
  into.sourcesSkipped.push(...from.sourcesSkipped);
  into.eventsAppended.push(...from.eventsAppended);
  into.eventsSkipped.push(...from.eventsSkipped);
}

/**
 * Write a source idempotently. Skips (no write) when an entry with the same id
 * AND content_hash already exists, so re-runs do not churn captured_at.
 */
async function writeSourceIdempotent(
  store: MemorySourceStore,
  source: MemorySource,
  result: IngestResult,
): Promise<void> {
  if (await store.exists(source.source_id)) {
    const prior = await store.get(source.source_id);
    if (prior.content_hash === source.content_hash) {
      result.sourcesSkipped.push(source.source_id);
      return;
    }
  }
  await store.write(source);
  result.sourcesAdded.push(source.source_id);
}

/** Append an event, treating an already-existing immutable id as a graceful skip. */
async function appendEventGraceful(
  store: MemoryEventStore,
  event: MemoryEvent,
  result: IngestResult,
): Promise<void> {
  try {
    await store.append(event);
    result.eventsAppended.push(event.event_id);
  } catch (err) {
    if (err instanceof MemoryEventExistsError) {
      result.eventsSkipped.push(event.event_id);
      return;
    }
    throw err;
  }
}

async function listMarkdown(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((n) => n.endsWith('.md'))
    .sort()
    .map((n) => join(dir, n));
}

/**
 * Ingest curated knowledge + archived handoffs into the memory SoT.
 * `repoRoot` is the rooting root and SoT location. `now` is injectable for tests.
 */
export async function bootstrapIngest(
  repoRoot: string,
  options: { now?: Date } = {},
): Promise<IngestResult> {
  const now = (options.now ?? new Date()).toISOString();
  const head = gitHeadSha(repoRoot);
  const revision = head ?? `bootstrap:${now}`;
  const sourceStore = new MemorySourceStore(repoRoot);
  const eventStore = new MemoryEventStore(repoRoot);
  const result = emptyResult();

  merge(result, await ingestAdrs(repoRoot, sourceStore, eventStore, now, revision, head));
  merge(result, await ingestGlossary(repoRoot, sourceStore, eventStore, now, revision, head));
  merge(result, await ingestHandoffs(repoRoot, sourceStore, eventStore, now, revision, head));
  return result;
}

async function ingestAdrs(
  repoRoot: string,
  sourceStore: MemorySourceStore,
  eventStore: MemoryEventStore,
  now: string,
  revision: string,
  head: string | null,
): Promise<IngestResult> {
  const result = emptyResult();
  const dir = join(dittoDir(repoRoot), 'knowledge', 'adr');
  for (const abs of await listMarkdown(dir)) {
    const body = await readFile(abs, 'utf8');
    const rel = relative(repoRoot, abs);
    const sourceId = sourceIdForPath(rel);
    const source: MemorySource = {
      schema_version: '0.1.0',
      source_id: sourceId,
      source_type: 'spec',
      path: rel,
      content_hash: sha256Hex(body),
      captured_at: now,
      revision,
      sensitivity: 'internal',
      word_count: wordCount(body),
      ...(head ? { git_commit: head } : {}),
    };
    await writeSourceIdempotent(sourceStore, source, result);

    const text = adrGist(body) || markdownTitle(body) || rel;
    const event: MemoryEvent = {
      schema_version: '0.1.0',
      event_id: bootstrapEventId(`adr:${sourceId}`),
      event_type: 'decision',
      actor: { kind: 'agent', role: 'bootstrap' },
      text,
      created_at: now,
      status: 'approved',
      sources: [sourceId],
      confidence_kind: 'EXTRACTED',
      sensitivity: 'internal',
      approved_by: 'bootstrap',
      decided_at: now,
    };
    await appendEventGraceful(eventStore, event, result);
  }
  return result;
}

async function ingestGlossary(
  repoRoot: string,
  sourceStore: MemorySourceStore,
  eventStore: MemoryEventStore,
  now: string,
  revision: string,
  head: string | null,
): Promise<IngestResult> {
  const result = emptyResult();
  const abs = join(dittoDir(repoRoot), 'knowledge', 'glossary.json');
  let raw: string;
  try {
    raw = await readFile(abs, 'utf8');
  } catch {
    return result;
  }
  let parsed: { entries?: GlossaryEntry[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return result; // malformed glossary is not a bootstrap failure
  }
  const rel = relative(repoRoot, abs);
  const sourceId = sourceIdForPath(rel);
  const source: MemorySource = {
    schema_version: '0.1.0',
    source_id: sourceId,
    source_type: 'spec',
    path: rel,
    content_hash: sha256Hex(raw),
    captured_at: now,
    revision,
    sensitivity: 'internal',
    word_count: wordCount(raw),
    ...(head ? { git_commit: head } : {}),
  };
  await writeSourceIdempotent(sourceStore, source, result);

  for (const entry of parsed.entries ?? []) {
    if (!entry?.term) continue;
    const definition = entry.definition ?? '';
    const aliases = (entry.aliases ?? []).join(', ');
    const text = [`${entry.term}: ${definition}`, aliases ? `aliases: ${aliases}` : '']
      .filter((s) => s.length > 0)
      .join('\n')
      .slice(0, 4000);
    const event: MemoryEvent = {
      schema_version: '0.1.0',
      event_id: bootstrapEventId(`glossary:${sourceId}:${entry.term}`),
      event_type: 'observation',
      actor: { kind: 'agent', role: 'bootstrap' },
      text,
      created_at: now,
      status: 'approved',
      sources: [sourceId],
      confidence_kind: 'EXTRACTED',
      sensitivity: 'internal',
      approved_by: 'bootstrap',
      decided_at: now,
    };
    await appendEventGraceful(eventStore, event, result);
  }
  return result;
}

/** Pull the intent/finding gist out of a handoff body (front-matter JSON + sections). */
function handoffGist(body: string): string {
  const parts: string[] = [];
  // Front-matter JSON (between the leading `---` fences) carries intent/state.
  const fence = body.match(/^---\n([\s\S]*?)\n---/);
  if (fence?.[1]) {
    try {
      const meta = JSON.parse(fence[1].trim()) as Record<string, unknown>;
      for (const key of ['original_intent', 'current_state', 'next_first_check']) {
        const v = meta[key];
        if (typeof v === 'string' && v.length > 0) parts.push(`${key}: ${v}`);
      }
      const decisions = meta.decisions_made;
      if (Array.isArray(decisions) && decisions.length > 0) {
        parts.push(`decisions: ${decisions.map((d) => String(d)).join('; ')}`);
      }
      const failed = meta.failed_or_unverified;
      if (Array.isArray(failed) && failed.length > 0) {
        parts.push(`failed_or_unverified: ${failed.map((d) => String(d)).join('; ')}`);
      }
    } catch {
      // ignore malformed front matter; fall back to body sections below
    }
  }
  if (parts.length === 0) {
    // No usable front matter: take the markdown title + first paragraphs.
    const title = markdownTitle(body);
    if (title) parts.push(title);
  }
  return parts.join('\n').slice(0, 4000);
}

async function ingestHandoffs(
  repoRoot: string,
  sourceStore: MemorySourceStore,
  eventStore: MemoryEventStore,
  now: string,
  revision: string,
  head: string | null,
): Promise<IngestResult> {
  const result = emptyResult();
  const dir = localDir(repoRoot, 'handoff', 'archive');
  for (const abs of await listMarkdown(dir)) {
    const body = await readFile(abs, 'utf8');
    const rel = relative(repoRoot, abs);
    const sourceId = sourceIdForPath(rel);
    const source: MemorySource = {
      schema_version: '0.1.0',
      source_id: sourceId,
      source_type: 'note',
      path: rel,
      content_hash: sha256Hex(body),
      captured_at: now,
      revision,
      sensitivity: 'internal',
      word_count: wordCount(body),
      ...(head ? { git_commit: head } : {}),
    };
    await writeSourceIdempotent(sourceStore, source, result);

    const text = handoffGist(body) || markdownTitle(body) || rel;
    const event: MemoryEvent = {
      schema_version: '0.1.0',
      event_id: bootstrapEventId(`handoff:${sourceId}`),
      event_type: 'observation',
      actor: { kind: 'agent', role: 'bootstrap' },
      text,
      created_at: now,
      status: 'approved',
      sources: [sourceId],
      confidence_kind: 'EXTRACTED',
      sensitivity: 'internal',
      approved_by: 'bootstrap',
      decided_at: now,
    };
    await appendEventGraceful(eventStore, event, result);
  }
  return result;
}
