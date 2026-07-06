import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { stat } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActiveNodeLeaseStore } from '~/core/active-node-lease';
import { localDir } from '~/core/ditto-paths';

/**
 * WS-HND-T3 (wi_260706kdx): the "write, no-GC" sibling on the lease side. A lease
 * whose owning node died without record-result's removeByNode persists forever and
 * PreToolUse keeps honoring its allow-list. listActive() is now reap-on-read: a
 * lease older than LEAKED_LEASE_MAX_AGE_MS (24h — far beyond any real node runtime)
 * is filtered out and, only when something was actually reaped, the pruned list is
 * written back.
 */

const WI = 'wi_leasereap01';
let repo: string;

function leasePath(): string {
  return join(localDir(repo, 'work-items', WI), 'active-leases.json');
}

function lease(nodeId: string, createdAt: string) {
  return {
    node_id: nodeId,
    work_item_id: WI,
    file_scope: ['src/x.ts'],
    scope_source: 'declared' as const,
    created_at: createdAt,
  };
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-leasereap-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('ActiveNodeLeaseStore reap-on-read (ac-3)', () => {
  const now = Date.now();
  const stale = new Date(now - 25 * 60 * 60 * 1000).toISOString(); // 25h old
  const fresh = new Date(now - 1 * 60 * 60 * 1000).toISOString(); // 1h old

  test('listActive reaps a >24h leaked lease and keeps the recent one', async () => {
    const store = new ActiveNodeLeaseStore(repo);
    await store.set(lease('N-stale', stale));
    await store.set(lease('N-fresh', fresh));

    const active = await store.listActive(WI);

    expect(active.map((l) => l.node_id)).toEqual(['N-fresh']);
  });

  test('the on-disk file is rewritten without the stale lease after reap-on-read', async () => {
    const store = new ActiveNodeLeaseStore(repo);
    await store.set(lease('N-stale', stale));
    await store.set(lease('N-fresh', fresh));

    await store.listActive(WI); // triggers the write-back

    const raw = await Bun.file(leasePath()).json();
    expect(raw.leases.map((l: { node_id: string }) => l.node_id)).toEqual(['N-fresh']);
  });

  test('unparseable created_at is safe-preserved (never reaped on unknown age) — schema fail-open, no partial reap', async () => {
    // The lease schema validates created_at as isoDateTime, so a genuinely
    // unparseable date fails the whole read → listActive returns [] (pre-existing
    // fail-open). The reaper's isLeaked() NaN-guard belts-and-suspenders that a
    // never-determinable age is NEVER treated as leaked; the on-disk file is left
    // intact (the reaper must not partially rewrite a file it couldn't fully read).
    const store = new ActiveNodeLeaseStore(repo);
    await Bun.write(
      leasePath(),
      JSON.stringify({
        schema_version: '0.1.0',
        leases: [
          { node_id: 'N-fresh', work_item_id: WI, file_scope: ['src/x.ts'], created_at: fresh },
          {
            node_id: 'N-weird',
            work_item_id: WI,
            file_scope: ['src/y.ts'],
            created_at: 'not-a-date',
          },
        ],
      }),
    );
    const before = await Bun.file(leasePath()).text();

    const active = await store.listActive(WI);

    expect(active).toEqual([]); // schema fail-open, unchanged behavior
    // reaper never rewrote/truncated the unreadable file
    expect(await Bun.file(leasePath()).text()).toBe(before);
  });

  test('no stale lease → listActive does NOT rewrite the file (common path stays read-only)', async () => {
    const store = new ActiveNodeLeaseStore(repo);
    await store.set(lease('N-a', fresh));
    await store.set(lease('N-b', fresh));
    const before = (await stat(leasePath())).mtimeMs;

    await new Promise((r) => setTimeout(r, 10));
    await store.listActive(WI);

    const after = (await stat(leasePath())).mtimeMs;
    expect(after).toBe(before); // no write happened
  });

  test('unreadable lease file → [] (fail-open regression, ac-4)', async () => {
    expect(await new ActiveNodeLeaseStore(repo).listActive('wi_none')).toEqual([]);
  });
});

describe('ActiveNodeLeaseStore set/removeByNode (regression, ac-4)', () => {
  const fresh = new Date().toISOString();

  test('set then removeByNode round-trips', async () => {
    const store = new ActiveNodeLeaseStore(repo);
    await store.set(lease('N1', fresh));
    expect((await store.listActive(WI)).map((l) => l.node_id)).toEqual(['N1']);
    await store.removeByNode(WI, 'N1');
    expect(await store.listActive(WI)).toEqual([]);
  });

  test('set replaces a lease with the same node_id (keyed by node_id)', async () => {
    const store = new ActiveNodeLeaseStore(repo);
    await store.set(lease('N1', fresh));
    await store.set({ ...lease('N1', fresh), file_scope: ['src/z.ts'] });
    const active = await store.listActive(WI);
    expect(active).toHaveLength(1);
    expect(active[0]?.file_scope).toEqual(['src/z.ts']);
  });
});
