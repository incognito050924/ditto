import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkIssue, parseIssueCoord, pullIssue, resolveProjectItemId } from '~/cli/commands/work';
import { createFakeGhClient } from '~/core/gh-client';
import { WorkItemStore } from '~/core/work-item-store';
import type { DittoConfigGithub } from '~/schemas/ditto-config';

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

// wi_260628p46 — populate github_issue.project_item_id from the configured Project
// board so completion reflection (ac-5) can reach projectItemEdit instead of the
// "no project_item_id → skip" dead branch. Population is BEST-EFFORT (ADR-0018):
// no config / gh degraded / issue not on the board → field stays absent, no throw.
const cfg = (overrides: Partial<DittoConfigGithub> = {}): DittoConfigGithub => ({
  project: { owner: 'owner', number: 2 },
  status_map: { done: 'opt-done' },
  auto_reflect: false,
  ...overrides,
});

// A board item-list payload where issue #1 is item PVTI_x (REAL gh project item-list
// shape): `repository` is at the ITEM TOP LEVEL as a URL string; `content` carries
// only number/title/type. Default repo owner/app so the coord these tests pull/link
// (owner/app#1) matches the card after the repo-aware fix.
const boardWith = (
  issueNumber: number,
  itemId: string,
  repository = 'https://github.com/owner/app',
) => ({
  items: [
    {
      id: itemId,
      repository,
      content: { type: 'Issue', number: issueNumber, title: `Issue ${issueNumber}` },
      status: 'Backlog',
    },
  ],
});

function fakeClientWithBoard(title: string, board: unknown) {
  return createFakeGhClient({
    values: { issueView: { number: 1, title, body: 'b', state: 'open' }, projectItemList: board },
  }).client;
}

describe('wi_260628p46 project_item_id population', () => {
  test('resolveProjectItemId returns the board item id when the issue is on the board', () => {
    const client = createFakeGhClient({
      values: { projectItemList: boardWith(1, 'PVTI_x') },
    }).client;
    expect(resolveProjectItemId({ client, config: cfg() }, 1, 'owner/app')).toBe('PVTI_x');
  });

  test('resolveProjectItemId returns null when no project config', () => {
    const client = createFakeGhClient({
      values: { projectItemList: boardWith(1, 'PVTI_x') },
    }).client;
    expect(resolveProjectItemId({ client, config: undefined }, 1, 'owner/app')).toBeNull();
  });

  test('resolveProjectItemId returns null when the issue is not on the board', () => {
    const client = createFakeGhClient({
      values: { projectItemList: boardWith(99, 'PVTI_x') },
    }).client;
    expect(resolveProjectItemId({ client, config: cfg() }, 1, 'owner/app')).toBeNull();
  });

  test('resolveProjectItemId returns null when gh degrades (best-effort, no throw)', () => {
    const client = createFakeGhClient({
      degrade: { ok: false, reason: 'unauthenticated', detail: 'x' },
    }).client;
    expect(resolveProjectItemId({ client, config: cfg() }, 1, 'owner/app')).toBeNull();
  });

  // ac-1: pull with a configured project populates project_item_id from the board.
  test('ac-1: pull populates github_issue.project_item_id from the configured board', async () => {
    const coord = coordOf('owner/app#1');
    const r = await pullIssue(
      {
        client: fakeClientWithBoard('Add retry', boardWith(1, 'PVTI_x')),
        store,
        sessionRepo: 'owner/app',
        config: cfg(),
      },
      coord,
    );
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') throw new Error('expected created');
    const item = await store.get(r.id);
    expect(item.github_issue).toEqual({ repo: 'owner/app', number: 1, project_item_id: 'PVTI_x' });
  });

  // ac-2: pull WITHOUT config keeps the existing contract — no project_item_id, no throw.
  test('ac-2: pull without project config leaves project_item_id absent (graceful)', async () => {
    const coord = coordOf('owner/app#1');
    const r = await pullIssue(
      { client: fakeClient('Add retry', 'b'), store, sessionRepo: 'owner/app' },
      coord,
    );
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') throw new Error('expected created');
    expect((await store.get(r.id)).github_issue).toEqual({ repo: 'owner/app', number: 1 });
  });

  // ac-1: link with config+client populates project_item_id on the actual link write.
  test('ac-1: link populates github_issue.project_item_id from the configured board', async () => {
    const wi = await store.create({
      title: 'wi',
      source_request: 'req',
      goal: 'goal',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'x is observable', verdict: 'unverified', evidence: [] },
      ],
    });
    const coord = coordOf('owner/app#1');
    const client = createFakeGhClient({
      values: { projectItemList: boardWith(1, 'PVTI_y') },
    }).client;
    const linked = await linkIssue(store, wi.id, coord, { client, config: cfg() });
    expect(linked.kind).toBe('linked');
    expect((await store.get(wi.id)).github_issue).toEqual({
      repo: 'owner/app',
      number: 1,
      project_item_id: 'PVTI_y',
    });
  });
});

// wi_260714usn — repo-aware Project board card resolution. A Projects v2 board can
// hold cards from MULTIPLE repos, so an issue `number` ALONE is ambiguous: two repos
// can each have an issue #20. The REAL `gh project item-list --format json` shape
// carries the owning repo at the ITEM TOP LEVEL as a URL string
// (item.repository = "https://github.com/owner/name"); `content` holds only
// number/title/type. resolveProjectItemId must match on (repo, number) — normalizing
// the item's URL repository → owner/name (parseRemoteUrlToRepo) — NOT on number alone.
// The signature under test is repo-aware: resolveProjectItemId(deps, issueNumber, repo).
// These are RED against the current number-only code (which ignores the repo arg).
const boardItem = (id: string, number: number, repository: unknown, status = 'Backlog') => ({
  id,
  repository,
  content: { type: 'Issue', number, title: `Issue ${number}` },
  status,
});

const boardOf = (...items: unknown[]) => ({ items, totalCount: items.length });

const clientWithBoard = (board: unknown) =>
  createFakeGhClient({ values: { projectItemList: board } }).client;

describe('wi_260714usn resolveProjectItemId repo-aware (multi-repo collision)', () => {
  // ac-1: a 2-repo COLLISION — the same issue number 20 exists on two different repos.
  // The coord names ONE repo; resolveProjectItemId must return THAT repo's card, not
  // the first-listed one. Number-only code returns the first (ditto) card → RED for the
  // right reason (picks the wrong card because it never looks at the repo).
  test('ac-1: collision same number, different repo → resolves the coord repo card, not the first', () => {
    const client = clientWithBoard(
      boardOf(
        boardItem('PVTI_ditto', 20, 'https://github.com/incognito050924/ditto'),
        boardItem('PVTI_palim', 20, 'https://github.com/incognito050924/palimpsest'),
      ),
    );
    expect(resolveProjectItemId({ client, config: cfg() }, 20, 'incognito050924/palimpsest')).toBe(
      'PVTI_palim',
    );
  });

  // ac-2: the item's repository is the URL form; matching a coord given as owner/name
  // REQUIRES normalizing URL→owner/name, not a raw string compare. A wrong-repo decoy is
  // listed FIRST, so number-only returns the decoy → RED; passing needs URL normalization.
  test('ac-2: repository URL form is normalized (owner/name) to pick the right card past a decoy', () => {
    const client = clientWithBoard(
      boardOf(
        boardItem('PVTI_decoy', 20, 'https://github.com/incognito050924/palimpsest'),
        boardItem('PVTI_ditto', 20, 'https://github.com/incognito050924/ditto'),
      ),
    );
    expect(resolveProjectItemId({ client, config: cfg() }, 20, 'incognito050924/ditto')).toBe(
      'PVTI_ditto',
    );
  });

  // ac-3: the number matches but the repo is UNUSABLE — absent / non-string / a string
  // that parseRemoteUrlToRepo maps to null (empty, bare host, already-normalized
  // owner/name). The card can NOT be identified by repo, so resolve must SKIP (return
  // null) — NOT throw, and NOT fall back to a number-only match. Number-only code
  // returns the id for every case → RED for the right reason (no skip, no fallback guard).
  test('ac-3: matching number but absent/non-string/unparseable repository → null (skip, no number-only fallback)', () => {
    const call = (repository: unknown) =>
      resolveProjectItemId(
        { client: clientWithBoard(boardOf(boardItem('PVTI_x', 20, repository))), config: cfg() },
        20,
        'incognito050924/ditto',
      );
    expect(call(undefined)).toBeNull(); // (a) absent
    expect(call(123)).toBeNull(); // (b) non-string: number
    expect(call({ url: 'x' })).toBeNull(); // (b) non-string: object
    expect(call('')).toBeNull(); // (c) empty → parseRemoteUrlToRepo null
    expect(call('https://github.com/')).toBeNull(); // (c) bare host → parseRemoteUrlToRepo null
    expect(call('incognito050924/ditto')).toBeNull(); // (c) already-normalized owner/name → parseRemoteUrlToRepo null
  });

  // ac-4 (non-regression guard): a single-repo board (no collision) still resolves the
  // correct card. Green both before and after the fix — it pins the happy path against
  // regression while ac-1/ac-2/ac-3 drive the new repo-aware behavior.
  test('ac-4: single-repo (no collision) → correct card still resolves', () => {
    const client = clientWithBoard(
      boardOf(boardItem('PVTI_only', 7, 'https://github.com/incognito050924/ditto')),
    );
    expect(resolveProjectItemId({ client, config: cfg() }, 7, 'incognito050924/ditto')).toBe(
      'PVTI_only',
    );
  });
});
