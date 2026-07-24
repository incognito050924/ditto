import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MemoryEvent } from '../schemas/memory-event';
import type { MemorySource } from '../schemas/memory-source';
import {
  MemoryEventExistsError,
  appendEvent,
  loadEvents,
  loadSources,
  writeSource,
} from './store';

async function makeRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ditto-memory-store-'));
}

function evt(over: Partial<MemoryEvent> & { event_id: string }): MemoryEvent {
  return {
    schema_version: '0.1.0',
    event_type: 'observation',
    actor: { kind: 'agent', role: 'test' },
    text: 'x',
    created_at: '2026-07-24T00:00:00.000Z',
    status: 'pending',
    sources: [],
    confidence_kind: 'EXTRACTED',
    sensitivity: 'internal',
    governs: [],
    ...over,
  } as MemoryEvent;
}

function src(over: Partial<MemorySource> & { source_id: string }): MemorySource {
  return {
    schema_version: '0.1.0',
    source_type: 'spec',
    path: '.ditto/knowledge/adr/x.md',
    content_hash: 'a'.repeat(64),
    captured_at: '2026-07-24T00:00:00.000Z',
    revision: 'snapshot:0000',
    sensitivity: 'internal',
    ...over,
  } as MemorySource;
}

describe('memory event store — immutable append-only per-entity files', () => {
  test('appends an event as its own file under .ditto/memory/events and reads it back', async () => {
    const repoRoot = await makeRepo();
    await appendEvent(repoRoot, evt({ event_id: 'memevt_aaaa1111' }));
    const path = join(repoRoot, '.ditto', 'memory', 'events', 'memevt_aaaa1111.json');
    expect(JSON.parse(await readFile(path, 'utf8')).event_id).toBe('memevt_aaaa1111');
    const loaded = await loadEvents(repoRoot);
    expect(loaded.map((e) => e.event_id)).toEqual(['memevt_aaaa1111']);
  });

  test('refuses to overwrite an existing event (immutability, no TOCTOU window)', async () => {
    const repoRoot = await makeRepo();
    await appendEvent(repoRoot, evt({ event_id: 'memevt_dup00000' }));
    await expect(appendEvent(repoRoot, evt({ event_id: 'memevt_dup00000' }))).rejects.toBeInstanceOf(
      MemoryEventExistsError,
    );
  });

  test('a malformed event is rejected before any file is written', async () => {
    const repoRoot = await makeRepo();
    await expect(
      appendEvent(repoRoot, { event_id: 'memevt_bad00000' } as unknown as MemoryEvent),
    ).rejects.toThrow();
  });

  test('loadEvents on a missing store is empty; it skips non-json files', async () => {
    expect(await loadEvents(await makeRepo())).toEqual([]);
  });
});

describe('memory source store — content_hash-keyed rewrite', () => {
  test('writes a source and reads it back', async () => {
    const repoRoot = await makeRepo();
    await writeSource(repoRoot, src({ source_id: 'src_0308233ce2' }));
    const loaded = await loadSources(repoRoot);
    expect(loaded.map((s) => s.source_id)).toEqual(['src_0308233ce2']);
  });

  test('rewrites in place when content_hash changes; overwriting a source is allowed', async () => {
    const repoRoot = await makeRepo();
    await writeSource(repoRoot, src({ source_id: 'src_same0000', content_hash: 'a'.repeat(64) }));
    await writeSource(repoRoot, src({ source_id: 'src_same0000', content_hash: 'b'.repeat(64) }));
    const loaded = await loadSources(repoRoot);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.content_hash).toBe('b'.repeat(64));
  });
});
