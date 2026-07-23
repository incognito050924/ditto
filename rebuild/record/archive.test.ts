import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { archiveWorkItem } from './archive';
import { LegacyRecordReadOnlyError, listBacklog } from './legacy';
import { createWorkItem, finalizeWorkItem, transitionWorkItem } from './store';

async function freshRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ditto-archive-'));
}

describe('archiveWorkItem — manual, move-not-delete, closed items only', () => {
  test('moves a terminal item to .ditto/archive/<label>/<id>/ intact', async () => {
    const root = await freshRepo();
    await createWorkItem(root, { id: 'wi_a', title: 'a' });
    await finalizeWorkItem(root, 'wi_a', { status: 'done', actor: 'me' });

    await archiveWorkItem(root, 'wi_a', 'cold-2026H1');

    const archived = await readdir(
      join(root, '.ditto', 'archive', 'cold-2026H1', 'wi_a'),
    );
    expect(archived.sort()).toEqual(['events', 'record.json']);
    // 원본 위치에서는 사라졌고, 백로그에도 더는 없다
    expect(await listBacklog(root)).toEqual([]);
  });

  test('refuses a non-terminal item', async () => {
    const root = await freshRepo();
    await createWorkItem(root, { id: 'wi_open', title: 'o' });
    await transitionWorkItem(root, 'wi_open', {
      to: 'in_progress',
      actor: 'me',
    });
    await expect(
      archiveWorkItem(root, 'wi_open', 'cold'),
    ).rejects.toThrow(/terminal/i);
  });

  test('refuses a legacy record — the old src owns heritage', async () => {
    const root = await freshRepo();
    const dir = join(root, '.ditto', 'work-items', 'wi_old');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'record.json'),
      JSON.stringify({ schema_version: '4', id: 'wi_old', status: 'done' }),
      'utf8',
    );
    await expect(archiveWorkItem(root, 'wi_old', 'cold')).rejects.toThrow(
      LegacyRecordReadOnlyError,
    );
  });

  test('refuses when the archive target already exists (no clobber)', async () => {
    const root = await freshRepo();
    await createWorkItem(root, { id: 'wi_b', title: 'b' });
    await finalizeWorkItem(root, 'wi_b', { status: 'abandoned', actor: 'me' });
    await mkdir(join(root, '.ditto', 'archive', 'cold', 'wi_b'), {
      recursive: true,
    });
    await expect(archiveWorkItem(root, 'wi_b', 'cold')).rejects.toThrow(
      /exists/i,
    );
  });
});
