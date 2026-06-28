import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkIssue, mirrorHierarchy, parseIssueCoord } from '~/cli/commands/work';
import type { GhClient, GhDegradation, GhResult } from '~/core/gh-client';
import { WorkItemStore } from '~/core/work-item-store';

const coordOf = (s: string) => {
  const c = parseIssueCoord(s);
  if (!c) throw new Error(`bad coord: ${s}`);
  return c;
};

// M4 (wi_260628d79) — mirror a GitHub issue's sub-issue / task-list hierarchy into
// the work items' parent_id/child_ids (ac-3). AC tests inject a FAKE GhClient
// (OBJ-3 seam) + a real WorkItemStore on a tmp dir; no `gh` subprocess. Resolution
// order: graphql addSubIssue read FIRST → task-list `- [ ] #n` parse FALLBACK →
// both-fail manual degrade (never throws, ADR-0018). ditto creates NO issues.

let dir: string;
let store: WorkItemStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-ghhier-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
  store = new WorkItemStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const STUB_DEGRADE: GhDegradation = { ok: false, reason: 'unknown_command', detail: 'stub' };

/** A minimal GhClient whose two relevant reads (apiGraphql / issueView) are
 *  per-test canned; every other method degrades. */
function hierFake(opts: { graphql?: GhResult<unknown>; issueView?: GhResult<unknown> }): GhClient {
  return {
    issueView: () => opts.issueView ?? STUB_DEGRADE,
    issueComment: () => ({ ok: true, value: undefined }),
    issueClose: () => ({ ok: true, value: undefined }),
    projectItemAdd: () => STUB_DEGRADE,
    projectItemEdit: () => ({ ok: true, value: undefined }),
    projectFieldList: () => STUB_DEGRADE,
    projectItemList: () => STUB_DEGRADE,
    apiGraphql: () => opts.graphql ?? STUB_DEGRADE,
  } as GhClient;
}

async function makeLinkedWi(titleSuffix: string, issueNumber: number): Promise<string> {
  const created = await store.create({
    title: `wi-${titleSuffix}`,
    source_request: 'req',
    goal: 'goal',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'x is observable', verdict: 'unverified', evidence: [] },
    ],
  });
  await linkIssue(store, created.id, coordOf(`owner/app#${issueNumber}`));
  return created.id;
}

describe('M4 GitHub hierarchy mirror', () => {
  // (a) graphql returns sub-issues -> children mirrored into parent_id/child_ids.
  test('ac-3: graphql addSubIssue read maps sub-issues to parent_id/child_ids', async () => {
    const parentId = await makeLinkedWi('parent', 1);
    const childA = await makeLinkedWi('child-a', 2);
    const childB = await makeLinkedWi('child-b', 3);
    const graphql: GhResult<unknown> = {
      ok: true,
      value: {
        data: { repository: { issue: { subIssues: { nodes: [{ number: 2 }, { number: 3 }] } } } },
      },
    };
    const r = await mirrorHierarchy({ client: hierFake({ graphql }), store }, parentId);
    expect(r.kind).toBe('mirrored');
    if (r.kind !== 'mirrored') throw new Error('expected mirrored');
    expect(r.source).toBe('graphql');
    expect(r.child_work_ids.sort()).toEqual([childA, childB].sort());
    const parent = await store.get(parentId);
    expect(parent.child_ids.sort()).toEqual([childA, childB].sort());
    expect((await store.get(childA)).parent_id).toBe(parentId);
    expect((await store.get(childB)).parent_id).toBe(parentId);
  });

  // (b) graphql errors -> fall back to parsing the issue BODY task-list `- [ ] #n`.
  test('ac-3: graphql failure falls back to task-list parse', async () => {
    const parentId = await makeLinkedWi('parent', 1);
    const childA = await makeLinkedWi('child-a', 2);
    const childB = await makeLinkedWi('child-b', 3);
    const body = 'Plan\n\n- [ ] #2 first\n- [x] #3 second\n';
    const r = await mirrorHierarchy(
      {
        client: hierFake({
          graphql: STUB_DEGRADE,
          issueView: { ok: true, value: { number: 1, title: 'parent', body, state: 'open' } },
        }),
        store,
      },
      parentId,
    );
    expect(r.kind).toBe('mirrored');
    if (r.kind !== 'mirrored') throw new Error('expected mirrored');
    expect(r.source).toBe('task_list');
    expect(r.child_work_ids.sort()).toEqual([childA, childB].sort());
    expect((await store.get(parentId)).child_ids.sort()).toEqual([childA, childB].sort());
    expect((await store.get(childA)).parent_id).toBe(parentId);
  });

  // (c) BOTH fail -> degrade to manual input (skip+notice), never throw, no issue/WI made.
  test('ac-3: graphql + task-list both fail -> manual degrade (no throw, no issue created)', async () => {
    const parentId = await makeLinkedWi('parent', 1);
    const before = (await store.list()).length;
    const r = await mirrorHierarchy(
      { client: hierFake({ graphql: STUB_DEGRADE, issueView: STUB_DEGRADE }), store },
      parentId,
    );
    expect(r.kind).toBe('degraded');
    if (r.kind === 'degraded') expect(r.reason).toBe('unknown_command');
    // ditto created no issues and no work items on the degrade path.
    expect((await store.list()).length).toBe(before);
    expect((await store.get(parentId)).child_ids).toEqual([]);
  });
});
