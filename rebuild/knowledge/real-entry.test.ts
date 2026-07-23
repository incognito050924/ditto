import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { realCreateAdrSkeleton, realSyncKnowledgeProjection } from './real-entry';

async function makeRepo(flipped: boolean): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'ditto-knowledge-real-'));
  await mkdir(join(repoRoot, '.ditto', 'knowledge', 'adr'), { recursive: true });
  if (flipped) {
    await writeFile(
      join(repoRoot, '.ditto', 'recorder.json'),
      JSON.stringify({ recorder: 'rebuild' }),
      'utf8',
    );
  }
  return repoRoot;
}

describe('knowledge real-write entry — gated by the ONE committed flip switch', () => {
  test('refuses to author an ADR while the old src is still the real recorder', async () => {
    const repoRoot = await makeRepo(false);
    await expect(
      realCreateAdrSkeleton({ repoRoot, slug: 'x', now: new Date('2026-07-24T00:00:00Z') }),
    ).rejects.toThrow('flip gate');
    // Nothing was written.
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(join(repoRoot, '.ditto', 'knowledge', 'adr'))).toEqual([]);
  });

  test('refuses to project into CLAUDE.md while unflipped, leaving the file untouched', async () => {
    const repoRoot = await makeRepo(false);
    await expect(realSyncKnowledgeProjection(repoRoot)).rejects.toThrow('flip gate');
    await expect(readFile(join(repoRoot, 'CLAUDE.md'), 'utf8')).rejects.toThrow();
  });

  test('after the flip, authoring and projection go through', async () => {
    const repoRoot = await makeRepo(true);
    const adr = await realCreateAdrSkeleton({
      repoRoot,
      slug: 'flipped',
      now: new Date('2026-07-24T00:00:00Z'),
    });
    expect(adr.id).toBe('ADR-20260724-flipped');
    const sync = await realSyncKnowledgeProjection(repoRoot);
    expect(sync.action).toBe('created');
    expect(await readFile(join(repoRoot, 'CLAUDE.md'), 'utf8')).toContain(
      'ADR-20260724-flipped',
    );
  });
});
