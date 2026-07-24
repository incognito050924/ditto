import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MemoryEvent } from '../schemas/memory-event';
import type { MemorySource } from '../schemas/memory-source';
import { realAppendEvent, realWriteSource } from './real-entry';

async function makeRepo(flipped: boolean): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'ditto-memory-real-'));
  await mkdir(join(repoRoot, '.ditto'), { recursive: true });
  if (flipped) {
    await writeFile(
      join(repoRoot, '.ditto', 'recorder.json'),
      JSON.stringify({ recorder: 'rebuild' }),
      'utf8',
    );
  }
  return repoRoot;
}

const event: MemoryEvent = {
  schema_version: '0.1.0',
  event_id: 'memevt_real0001',
  event_type: 'observation',
  actor: { kind: 'agent', role: 'test' },
  text: 'x',
  created_at: '2026-07-24T00:00:00.000Z',
  status: 'pending',
  sources: [],
  confidence_kind: 'EXTRACTED',
  sensitivity: 'internal',
  governs: [],
} as MemoryEvent;

const source: MemorySource = {
  schema_version: '0.1.0',
  source_id: 'src_real0001',
  source_type: 'spec',
  path: '.ditto/knowledge/adr/x.md',
  content_hash: 'a'.repeat(64),
  captured_at: '2026-07-24T00:00:00.000Z',
  revision: 'snapshot:0000',
  sensitivity: 'internal',
} as MemorySource;

describe('memory real-write entry — gated by the ONE committed flip switch', () => {
  test('refuses to append an event while the old src is still the real recorder', async () => {
    const repoRoot = await makeRepo(false);
    await expect(realAppendEvent(repoRoot, event)).rejects.toThrow('flip gate');
    await expect(readdir(join(repoRoot, '.ditto', 'memory', 'events'))).rejects.toThrow();
  });

  test('refuses to write a source while unflipped', async () => {
    const repoRoot = await makeRepo(false);
    await expect(realWriteSource(repoRoot, source)).rejects.toThrow('flip gate');
  });

  test('after the flip, event append and source write go through', async () => {
    const repoRoot = await makeRepo(true);
    await realAppendEvent(repoRoot, event);
    await realWriteSource(repoRoot, source);
    expect(await readdir(join(repoRoot, '.ditto', 'memory', 'events'))).toEqual([
      'memevt_real0001.json',
    ]);
    expect(await readdir(join(repoRoot, '.ditto', 'memory', 'sources'))).toEqual([
      'src_real0001.json',
    ]);
  });
});
