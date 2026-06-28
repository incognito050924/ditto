import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ClaimWiring,
  autoClaimOnInProgressEdge,
  claimWorkItem,
  reconcileClaimState,
  releaseClaimOnTerminal,
  unclaimWorkItem,
} from '~/cli/commands/work';
import { type RecordedGhCall, createFakeGhClient } from '~/core/gh-client';
import { WorkItemStore } from '~/core/work-item-store';
import type { DittoConfigGithub } from '~/schemas/ditto-config';
import type { WorkItem } from '~/schemas/work-item';

// wi_2606287v9 (#5) n6: claim/unclaim CLI + the in_progress EDGE auto-wire. Every test
// injects a RECORDING fake GhClient (no `gh` subprocess) and a real on-disk
// WorkItemStore (temp dir) so the wiring drives the REAL transition paths
// (claimWorkItem = work-start path; autoClaimOnInProgressEdge = autopilot path).

// `gh project field-list` shape: the Status single-select option the claim board move
// (claim_status_map.in_progress) and terminal status_map point at.
const FIELD_LIST = {
  fields: [
    {
      id: 'PVTSSF_status',
      name: 'Status',
      type: 'ProjectV2SingleSelectField',
      options: [
        { id: 'opt_inprog', name: 'In Progress' },
        { id: 'opt_blocked', name: 'Blocked' },
        { id: 'opt_done', name: 'Done' },
      ],
    },
  ],
};

function cfg(): DittoConfigGithub {
  return {
    project: { owner: 'owner', number: 5, node_id: 'PVT_p' },
    status_map: { done: 'opt_done', abandoned: 'opt_dropped' },
    claim_status_map: { in_progress: 'opt_inprog', blocked: 'opt_blocked' },
    auto_reflect: false,
  };
}

function wiring(
  client: ClaimWiring['client'],
  opts: { config?: DittoConfigGithub; actorLogin?: string } = {},
): ClaimWiring {
  return {
    client,
    config: opts.config ?? cfg(),
    branch: 'ditto/wi_x',
    repoRoot: '/repo',
    ...(opts.actorLogin ? { actorLogin: opts.actorLogin } : {}),
  };
}

async function setupWi(opts: {
  link?: boolean;
  status?: WorkItem['status'];
  claimed_branch?: string;
  markers?: string[];
}): Promise<{ dir: string; store: WorkItemStore; id: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ditto-claim-'));
  const store = new WorkItemStore(dir);
  const created = await store.create({
    title: 't',
    source_request: 'r',
    goal: 'g',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'x is observable', verdict: 'unverified', evidence: [] },
    ],
  });
  await store.update(created.id, (cur) => ({
    ...cur,
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.link === false
      ? {}
      : {
          github_issue: {
            repo: 'owner/app',
            number: 42,
            project_item_id: 'PVTI_1',
            ...(opts.claimed_branch ? { claimed_branch: opts.claimed_branch } : {}),
            ...(opts.markers ? { posted_claim_markers: opts.markers } : {}),
          },
        }),
  }));
  return { dir, store, id: created.id };
}

const count = (calls: RecordedGhCall[], m: string) => calls.filter((c) => c.method === m).length;

describe('ac-1 / ac-2(a) work claim — work-start in_progress transition + claim', () => {
  test('draft WI: promotes to in_progress AND assigns @me exactly once + moves board', async () => {
    const { dir, store, id } = await setupWi({});
    const { client, calls } = createFakeGhClient({
      values: { projectFieldList: FIELD_LIST, issueView: { assignees: [] } },
    });
    const res = await claimWorkItem(store, id, wiring(client));
    expect(res.promotedToInProgress).toBe(true);
    expect((await store.get(id)).status).toBe('in_progress');
    expect(res.fired).toBe(true);
    expect(count(calls, 'issueAddAssignee')).toBe(1);
    expect(count(calls, 'projectItemEdit')).toBe(1); // board → In Progress (ac-5)
    // local sentinel persisted
    const gi = (await store.get(id)).github_issue;
    expect(gi?.claimed_branch).toBeDefined();
    expect(gi?.posted_claim_markers?.length).toBeGreaterThan(0);
    await rm(dir, { recursive: true, force: true });
  });

  test('idempotent: a second claim on the same branch is a zero-gh no-op', async () => {
    const { dir, store, id } = await setupWi({});
    const { client, calls } = createFakeGhClient({
      values: { projectFieldList: FIELD_LIST, issueView: { assignees: [] } },
    });
    await claimWorkItem(store, id, wiring(client));
    const after = calls.length;
    const res2 = await claimWorkItem(store, id, wiring(client));
    expect(res2.fired).toBe(false);
    expect(calls.length).toBe(after); // no new gh calls
    await rm(dir, { recursive: true, force: true });
  });
});

describe('ac-10 no-link skip', () => {
  test('claim with no linked issue → skip + notice, zero gh calls', async () => {
    const { dir, store, id } = await setupWi({ link: false });
    const { client, calls } = createFakeGhClient();
    const res = await claimWorkItem(store, id, wiring(client));
    expect(res.fired).toBe(false);
    expect(res.notices.join(' ')).toContain('No linked GitHub issue');
    expect(count(calls, 'issueAddAssignee')).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('ac-2 in_progress edge auto-wire (both paths)', () => {
  test('(b) autopilot path: draft→in_progress edge fires claim', async () => {
    const { dir, store, id } = await setupWi({});
    const next = await store.update(id, (cur) => ({ ...cur, status: 'in_progress' as const }));
    const { client, calls } = createFakeGhClient({
      values: { projectFieldList: FIELD_LIST, issueView: { assignees: [] } },
    });
    const res = await autoClaimOnInProgressEdge(store, id, 'draft', next, wiring(client));
    expect(res.fired).toBe(true);
    expect(count(calls, 'issueAddAssignee')).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });

  test('(c) already in_progress: a second update does NOT re-fire (zero gh calls)', async () => {
    const { dir, store, id } = await setupWi({ status: 'in_progress' });
    const next = await store.update(id, (cur) => ({ ...cur, title: 'renamed' }));
    const { client, calls } = createFakeGhClient({ values: { projectFieldList: FIELD_LIST } });
    const res = await autoClaimOnInProgressEdge(store, id, 'in_progress', next, wiring(client));
    expect(res.fired).toBe(false);
    expect(calls.length).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });

  test('(d) reopen (terminal→in_progress) does NOT re-fire claim (sentinel)', async () => {
    const { dir, store, id } = await setupWi({});
    const promoted = await store.update(id, (cur) => ({ ...cur, status: 'in_progress' as const }));
    const { client, calls } = createFakeGhClient({
      values: { projectFieldList: FIELD_LIST, issueView: { assignees: [] } },
    });
    await autoClaimOnInProgressEdge(store, id, 'draft', promoted, wiring(client));
    expect(count(calls, 'issueAddAssignee')).toBe(1); // claimed once on start
    await store.close(id, 'done');
    const reopened = await store.reopen(id);
    expect(reopened.status).toBe('in_progress');
    const res = await autoClaimOnInProgressEdge(store, id, 'done', reopened, wiring(client));
    expect(res.fired).toBe(false);
    expect(count(calls, 'issueAddAssignee')).toBe(1); // NO re-fire on reopen
    await rm(dir, { recursive: true, force: true });
  });
});

describe('ac-7 work unclaim — @me release + marker clear', () => {
  test('drops @me, posts the release comment, clears the local sentinel', async () => {
    const { dir, store, id } = await setupWi({
      status: 'in_progress',
      claimed_branch: 'ditto/wi_x',
      markers: ['claim:ditto/wi_x'],
    });
    const { client, calls } = createFakeGhClient();
    const res = await unclaimWorkItem(store, id, wiring(client), { reason: 'handing off' });
    expect(res.released).toBe(true);
    expect(count(calls, 'issueRemoveAssignee')).toBe(1);
    expect(count(calls, 'issueComment')).toBe(1);
    const gi = (await store.get(id)).github_issue;
    expect(gi?.claimed_branch).toBeUndefined();
    expect(gi?.posted_claim_markers).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  test('no-link unclaim → skip + notice, no gh write', async () => {
    const { dir, store, id } = await setupWi({ link: false, status: 'in_progress' });
    const { client, calls } = createFakeGhClient();
    const res = await unclaimWorkItem(store, id, wiring(client));
    expect(res.released).toBe(false);
    expect(res.notices.join(' ')).toContain('No linked GitHub issue');
    expect(count(calls, 'issueRemoveAssignee')).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('ac-6 reconcile — re-read remote assignee first, refuse to clobber foreign', () => {
  test('foreign assignee present → refuses, does NOT write @me', async () => {
    const { dir, store, id } = await setupWi({ status: 'in_progress' });
    const { client, calls } = createFakeGhClient({
      values: { issueView: { assignees: [{ login: 'someone-else' }] } },
    });
    const res = await reconcileClaimState(store, id, wiring(client, { actorLogin: 'me' }));
    expect(res.reconciled).toBe(false);
    expect(res.warnings.join(' ').toLowerCase()).toContain('foreign');
    expect(count(calls, 'issueAddAssignee')).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });

  test('no foreign assignee → claims (post-hoc claim-omission recovery)', async () => {
    const { dir, store, id } = await setupWi({ status: 'in_progress' });
    const { client, calls } = createFakeGhClient({
      values: { issueView: { assignees: [{ login: 'me' }] }, projectFieldList: FIELD_LIST },
    });
    const res = await reconcileClaimState(store, id, wiring(client, { actorLogin: 'me' }));
    expect(res.reconciled).toBe(true);
    expect(count(calls, 'issueAddAssignee')).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });

  test('terminal WI → reconcile is a no-op (left to termination reflection)', async () => {
    const { dir, store, id } = await setupWi({});
    await store.close(id, 'done');
    const { client, calls } = createFakeGhClient();
    const res = await reconcileClaimState(store, id, wiring(client, { actorLogin: 'me' }));
    expect(res.reconciled).toBe(false);
    expect(calls.length).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('ac-5 terminal @me release — unconditional, comment-free, marker-gated', () => {
  test('claimed WI on close: drops @me + clears marker, posts NO comment', async () => {
    const { dir, store, id } = await setupWi({
      status: 'in_progress',
      claimed_branch: 'ditto/wi_x',
      markers: ['claim:ditto/wi_x'],
    });
    const { client, calls } = createFakeGhClient();
    const res = await releaseClaimOnTerminal(store, id, wiring(client));
    expect(res.released).toBe(true);
    expect(count(calls, 'issueRemoveAssignee')).toBe(1);
    expect(count(calls, 'issueComment')).toBe(0); // 1-comment contract: no extra comment
    const gi = (await store.get(id)).github_issue;
    expect(gi?.claimed_branch).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  test('un-claimed (no sentinel) WI: no-op, zero gh calls', async () => {
    const { dir, store, id } = await setupWi({ status: 'in_progress' });
    const { client, calls } = createFakeGhClient();
    const res = await releaseClaimOnTerminal(store, id, wiring(client));
    expect(res.released).toBe(false);
    expect(calls.length).toBe(0); // never touches an issue we did not claim
    await rm(dir, { recursive: true, force: true });
  });
});
