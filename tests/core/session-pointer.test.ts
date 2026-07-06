import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { utimesSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localDir } from '~/core/ditto-paths';
import { SessionPointerStore } from '~/core/session-pointer';

/**
 * WS-HND-T3 (wi_260706kdx): the "write, no-GC" sibling of the handoff sweep.
 * Session pointers were written but never retired, so a stale pointer kept
 * re-binding a reused session id to a long-dead work item. clear() + a
 * content-blind mtime sweep give the pointer store the same retirement
 * discipline as the handoff store.
 */

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-sp-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

/** Age a pointer file's filesystem mtime so the content-blind sweep sees it as stale. */
function ageFile(path: string, when: Date): void {
  utimesSync(path, when, when);
}

describe('SessionPointerStore get/set (regression, ac-4)', () => {
  test('set then get round-trips the work item id', async () => {
    const store = new SessionPointerStore(repo);
    await store.set('sess-a', 'wi_aaaaaaaa');
    expect(await store.get('sess-a')).toBe('wi_aaaaaaaa');
  });

  test('get returns null when unset', async () => {
    expect(await new SessionPointerStore(repo).get('nope')).toBeNull();
  });
});

describe('SessionPointerStore.clear (ac-2)', () => {
  test('clear deletes the pointer file so get returns null', async () => {
    const store = new SessionPointerStore(repo);
    await store.set('sess-c', 'wi_cccccccc');
    expect(await store.get('sess-c')).toBe('wi_cccccccc');
    await store.clear('sess-c');
    expect(await store.get('sess-c')).toBeNull();
  });

  test('clear on a missing pointer is a fail-open no-op (never throws)', async () => {
    const store = new SessionPointerStore(repo);
    await store.clear('never-existed'); // must not throw
    expect(await store.get('never-existed')).toBeNull();
  });
});

describe('SessionPointerStore.sweepStale (ac-1)', () => {
  const now = new Date('2026-07-06T00:00:00.000Z');
  const stale = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000); // 8 days old
  const recent = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // 1 day old

  test('removes a pointer whose mtime is >7d, keeps a recent one', async () => {
    const store = new SessionPointerStore(repo);
    await store.set('old', 'wi_old00001');
    await store.set('fresh', 'wi_fresh0001');
    ageFile(join(localDir(repo, 'sessions'), 'old.json'), stale);
    ageFile(join(localDir(repo, 'sessions'), 'fresh.json'), recent);

    const swept = await store.sweepStale(now);

    expect(await store.get('old')).toBeNull();
    expect(await store.get('fresh')).toBe('wi_fresh0001');
    expect(swept.length).toBe(1);
  });

  test('content-blind: a malformed pointer file aged >7d is still swept', async () => {
    const store = new SessionPointerStore(repo);
    const dir = localDir(repo, 'sessions');
    await mkdir(dir, { recursive: true });
    const bad = join(dir, 'broken.json');
    await writeFile(bad, 'this is not json', 'utf8');
    ageFile(bad, stale);

    const swept = await store.sweepStale(now);

    expect(swept.length).toBe(1);
    expect(await Bun.file(bad).exists()).toBe(false);
  });

  test('no sessions dir → empty result, never throws', async () => {
    const swept = await new SessionPointerStore(repo).sweepStale(now);
    expect(swept).toEqual([]);
  });
});
