import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkIssue, parseIssueCoord, pullIssue } from '~/cli/commands/work';
import { createFakeGhClient } from '~/core/gh-client';
import { WorkItemStore } from '~/core/work-item-store';

const coordOf = (s: string) => {
  const c = parseIssueCoord(s);
  if (!c) throw new Error(`bad coord: ${s}`);
  return c;
};

// M3 (wi_260628d79) — GitHub issue pull (G1) + link (G2) + cross-repo guard (ac-13).
// AC tests inject a FAKE GhClient (OBJ-3 seam) + a real WorkItemStore on a tmp dir;
// no `gh` subprocess. Assertions are on the result + on-disk store state.

let dir: string;
let store: WorkItemStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-ghlink-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
  store = new WorkItemStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeClient(title: string, body: string) {
  return createFakeGhClient({ values: { issueView: { number: 1, title, body, state: 'open' } } })
    .client;
}

describe('M3 GitHub issue pull/link', () => {
  // ac-1: pull creates a WI seeded from the issue + saves the coord; idempotent.
  test('ac-1: pull creates a WI seeded from the issue title/body and saves github_issue', async () => {
    const coord = coordOf('owner/app#1');
    // session repo differs only in CASE — the canonicalized guard must treat this as
    // SAME repo and allow execution (ac-13 BINDING: a non-canonical parse must not
    // falsely block a same-repo pull).
    const r = await pullIssue(
      { client: fakeClient('Add retry', 'Body text'), store, sessionRepo: 'Owner/App' },
      coord,
    );
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') throw new Error('expected created');
    const item = await store.get(r.id);
    expect(item.github_issue).toEqual({ repo: 'owner/app', number: 1 });
    expect(item.source_request).toContain('Add retry');
    expect(item.source_request).toContain('Body text');
  });

  test('ac-1: pulling the same issue twice returns the existing id (no duplicate)', async () => {
    const coord = coordOf('owner/app#1');
    const deps = () => ({ client: fakeClient('T', 'B'), store, sessionRepo: 'owner/app' });
    const first = await pullIssue(deps(), coord);
    expect(first.kind).toBe('created');
    const second = await pullIssue(deps(), coord);
    expect(second.kind).toBe('existing');
    if (first.kind === 'created' && second.kind === 'existing') {
      expect(second.id).toBe(first.id);
    }
    // No duplicate work item was created.
    expect(await store.list()).toHaveLength(1);
  });

  // ac-2: link an existing WI to a coord; same coord twice -> same state (idempotent).
  test('ac-2: link is idempotent — same coord twice does not change state', async () => {
    const created = await store.create({
      title: 'wi',
      source_request: 'req',
      goal: 'goal',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'x is observable', verdict: 'unverified', evidence: [] },
      ],
    });
    const coord = coordOf('owner/app#7');
    const first = await linkIssue(store, created.id, coord);
    expect(first.kind).toBe('linked');
    const afterFirst = await store.get(created.id);
    const second = await linkIssue(store, created.id, coord);
    expect(second.kind).toBe('linked');
    if (second.kind === 'linked') expect(second.alreadyLinked).toBe(true);
    const afterSecond = await store.get(created.id);
    // Idempotent: the link is unchanged AND the second call did not rewrite the WI.
    expect(afterSecond.github_issue).toEqual({ repo: 'owner/app', number: 7 });
    expect(afterSecond.updated_at).toBe(afterFirst.updated_at);
  });

  // ac-13: a cross-repo coord fails CLOSED on execution (no WI created), while
  // link/display stay allowed.
  test('ac-13: cross-repo pull is fail-closed on execution; link stays allowed', async () => {
    const coord = coordOf('other/app#5');
    const r = await pullIssue(
      { client: fakeClient('Foreign issue', 'b'), store, sessionRepo: 'owner/app' },
      coord,
    );
    expect(r.kind).toBe('cross_repo');
    if (r.kind === 'cross_repo') {
      expect(r.title).toBe('Foreign issue'); // display allowed (issue fetched)
    }
    // Execution blocked: no work item was created for the foreign repo.
    expect(await store.list()).toHaveLength(0);

    // Link/display still allowed for a cross-repo coord on an EXISTING WI (backlog).
    const wi = await store.create({
      title: 'wi',
      source_request: 'req',
      goal: 'goal',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'x is observable', verdict: 'unverified', evidence: [] },
      ],
    });
    const linked = await linkIssue(store, wi.id, coord);
    expect(linked.kind).toBe('linked');
    expect((await store.get(wi.id)).github_issue).toEqual({ repo: 'other/app', number: 5 });
  });
});
