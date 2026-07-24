import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkItem, loadWorkItem } from '../record/store';
import { getLinkedCoord, linkIssue } from './linkage';

async function freshRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ditto-gh-link-'));
}

describe('issue↔work-item linkage — layer 2 (binds to the record store)', () => {
  test('linkIssue persists the coordinate on the work-item Record', async () => {
    const root = await freshRepo();
    await createWorkItem(root, { id: 'wi_link1', title: 't' });

    const rec = await linkIssue(root, 'wi_link1', { repo: 'octo/app', number: 42 });
    expect(rec.github).toEqual({ repo: 'octo/app', number: 42 });

    const reloaded = await loadWorkItem(root, 'wi_link1');
    expect(reloaded.record.github).toEqual({ repo: 'octo/app', number: 42 });
  });

  test('getLinkedCoord recovers the coordinate from a linked Record', async () => {
    const root = await freshRepo();
    await createWorkItem(root, { id: 'wi_link2', title: 't' });
    const rec = await linkIssue(root, 'wi_link2', { repo: 'octo/app', number: 9 });
    expect(getLinkedCoord(rec)).toEqual({ repo: 'octo/app', number: 9 });
  });

  test('getLinkedCoord returns null on an unlinked Record', async () => {
    const root = await freshRepo();
    await createWorkItem(root, { id: 'wi_link3', title: 't' });
    const { record } = await loadWorkItem(root, 'wi_link3');
    expect(getLinkedCoord(record)).toBeNull();
  });

  test('linkIssue is idempotent — re-linking the same coordinate keeps one value', async () => {
    const root = await freshRepo();
    await createWorkItem(root, { id: 'wi_link4', title: 't' });
    await linkIssue(root, 'wi_link4', { repo: 'octo/app', number: 1 });
    const rec = await linkIssue(root, 'wi_link4', { repo: 'octo/app', number: 1 });
    expect(rec.github).toEqual({ repo: 'octo/app', number: 1 });
  });
});
