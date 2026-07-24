import { open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { memoryEvent, type MemoryEvent } from '../schemas/memory-event';
import { memorySource, type MemorySource } from '../schemas/memory-source';
import { atomicWriteText, ensureDir } from '../util/fs';
import { dittoDir } from '../util/paths';

/**
 * Per-entity 2-tier SoT store for memory. Both events and sources live as
 * one-JSON-file-per-entity under `.ditto/memory/` (git-tracked, no server, no
 * single JSONL) so per-entity files merge without conflict.
 *
 * Events are IMMUTABLE (append-only): a new file is created with the `wx` flag
 * so an existing id fails closed — there is no mutation and no TOCTOU window.
 * A status change is a new superseding event, never an edit (see reduce.ts).
 * Sources are content_hash-keyed and MAY be rewritten in place when the
 * captured content changes.
 */

export class MemoryEventExistsError extends Error {
  constructor(eventId: string) {
    super(`memory event ${eventId} already exists — events are immutable (append-only)`);
    this.name = 'MemoryEventExistsError';
  }
}

function eventsDir(repoRoot: string): string {
  return join(dittoDir(repoRoot), 'memory', 'events');
}

function sourcesDir(repoRoot: string): string {
  return join(dittoDir(repoRoot), 'memory', 'sources');
}

/** Append an event as its own immutable file. Validates before writing; `wx` fails on an existing id. */
export async function appendEvent(repoRoot: string, event: MemoryEvent): Promise<void> {
  const parsed = memoryEvent.parse(event);
  const dir = eventsDir(repoRoot);
  await ensureDir(dir);
  const path = join(dir, `${parsed.event_id}.json`);
  let handle;
  try {
    handle = await open(path, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new MemoryEventExistsError(parsed.event_id);
    }
    throw err;
  }
  try {
    await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}

async function loadDir<T>(dir: string, parse: (raw: unknown) => T): Promise<T[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const name of names) {
    const raw: unknown = JSON.parse(await readFile(join(dir, name), 'utf8'));
    out.push(parse(raw));
  }
  return out;
}

/** Load every stored event (validated). Missing store → empty. */
export async function loadEvents(repoRoot: string): Promise<MemoryEvent[]> {
  return loadDir(eventsDir(repoRoot), (raw) => memoryEvent.parse(raw));
}

/** Write a source, rewriting in place if it already exists (content_hash-keyed). */
export async function writeSource(repoRoot: string, source: MemorySource): Promise<void> {
  const parsed = memorySource.parse(source);
  const dir = sourcesDir(repoRoot);
  await ensureDir(dir);
  await atomicWriteText(join(dir, `${parsed.source_id}.json`), `${JSON.stringify(parsed, null, 2)}\n`);
}

/** Load every stored source (validated). Missing store → empty. */
export async function loadSources(repoRoot: string): Promise<MemorySource[]> {
  return loadDir(sourcesDir(repoRoot), (raw) => memorySource.parse(raw));
}
