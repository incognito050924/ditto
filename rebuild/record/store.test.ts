import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { localDir } from '../util/paths';
import {
  createWorkItem,
  loadWorkItem,
  reopenWorkItem,
  transitionWorkItem,
} from './store';

async function freshRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ditto-store-'));
  return root;
}

describe('record store — create/load', () => {
  test('createWorkItem writes a draft record.json under .ditto/work-items/<id>/', async () => {
    const root = await freshRepo();
    await createWorkItem(root, { id: 'wi_new1', title: '새 작업' });
    const loaded = await loadWorkItem(root, 'wi_new1');
    expect(loaded.view.status).toBe('draft');
    expect(loaded.view.title).toBe('새 작업');
    expect(loaded.view.closed_at).toBeNull();
    expect(loaded.events).toHaveLength(0);
  });

  test('createWorkItem refuses an existing id (no silent overwrite)', async () => {
    const root = await freshRepo();
    await createWorkItem(root, { id: 'wi_dup', title: 'a' });
    await expect(
      createWorkItem(root, { id: 'wi_dup', title: 'b' }),
    ).rejects.toThrow(/exists/i);
  });

  test('loadWorkItem on a missing id throws a not-found error', async () => {
    const root = await freshRepo();
    await expect(loadWorkItem(root, 'wi_missing')).rejects.toThrow(
      /not found/i,
    );
  });
});

describe('record store — boundary transitions are recorded immediately as events', () => {
  test('transition appends one event per boundary and the view folds it', async () => {
    const root = await freshRepo();
    await createWorkItem(root, { id: 'wi_t', title: 't' });
    await transitionWorkItem(root, 'wi_t', { to: 'in_progress', actor: 'me' });

    const afterStart = await loadWorkItem(root, 'wi_t');
    expect(afterStart.view.status).toBe('in_progress');
    expect(afterStart.events).toHaveLength(1);

    await transitionWorkItem(root, 'wi_t', { to: 'done', actor: 'me' });
    const afterDone = await loadWorkItem(root, 'wi_t');
    expect(afterDone.view.status).toBe('done');
    expect(afterDone.view.closed_at).not.toBeNull();
    expect(afterDone.events).toHaveLength(2);
    // seq는 단조 증가
    expect(afterDone.events.map((e) => e.seq)).toEqual([1, 2]);
  });

  test('terminal guard: transitioning a done item throws until reopened', async () => {
    const root = await freshRepo();
    await createWorkItem(root, { id: 'wi_g', title: 'g' });
    await transitionWorkItem(root, 'wi_g', { to: 'done', actor: 'me' });

    await expect(
      transitionWorkItem(root, 'wi_g', { to: 'abandoned', actor: 'me' }),
    ).rejects.toThrow(/reopen/i);
    await expect(
      transitionWorkItem(root, 'wi_g', { to: 'in_progress', actor: 'me' }),
    ).rejects.toThrow(/reopen/i);

    await reopenWorkItem(root, 'wi_g', 'me');
    const reopened = await loadWorkItem(root, 'wi_g');
    expect(reopened.view.status).toBe('in_progress');
    expect(reopened.view.closed_at).toBeNull();
  });

  test('reopen refuses a non-terminal item', async () => {
    const root = await freshRepo();
    await createWorkItem(root, { id: 'wi_r', title: 'r' });
    await expect(reopenWorkItem(root, 'wi_r', 'me')).rejects.toThrow(
      /terminal/i,
    );
  });
});

describe('record store — Run tier is disposable', () => {
  test('deleting the personal Run dir loses nothing the Record needs', async () => {
    const root = await freshRepo();
    await createWorkItem(root, { id: 'wi_run', title: 'run' });
    await transitionWorkItem(root, 'wi_run', { to: 'in_progress', actor: 'me' });

    // Run tier(개인·폐기가능)를 만들었다 지워도 Record는 완전하다
    const runDir = localDir(root, 'work-items', 'wi_run');
    await rm(runDir, { recursive: true, force: true });

    const loaded = await loadWorkItem(root, 'wi_run');
    expect(loaded.view.status).toBe('in_progress');
    // Record tier에는 record.json + events/만 있다 (ADR-0005 per-entity)
    const entries = (
      await readdir(join(root, '.ditto', 'work-items', 'wi_run'))
    ).sort();
    expect(entries).toEqual(['events', 'record.json']);
  });
});
