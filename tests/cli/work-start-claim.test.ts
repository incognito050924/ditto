import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ClaimWiring, maybeClaimOnStart } from '~/cli/commands/work';
import { type RecordedGhCall, createFakeGhClient } from '~/core/gh-client';
import { WorkItemStore } from '~/core/work-item-store';
import type { DittoConfigGithub } from '~/schemas/ditto-config';

// wi_260710otc: `ditto work start --issue` (백로그 착수) must fire the claim — assign @me,
// promote draft→in_progress, move the board — so a start on one machine is visible to
// others through GitHub (the only shared channel; local work-items/config are per-machine,
// ADR-0012). The gate is `maybeClaimOnStart` (claim flag ON + a linked github_issue), which
// delegates to the already-tested claimWorkItem. Every test injects a RECORDING fake
// GhClient (no `gh` subprocess) + a real on-disk WorkItemStore.

const FIELD_LIST = {
  fields: [
    {
      id: 'PVTSSF_status',
      name: 'Status',
      type: 'ProjectV2SingleSelectField',
      options: [{ id: 'opt_inprog', name: 'In Progress' }],
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

function wiring(client: ClaimWiring['client']): ClaimWiring {
  return { client, config: cfg(), branch: 'ditto/wi_x', repoRoot: '/repo' };
}

const count = (calls: RecordedGhCall[], m: string) => calls.filter((c) => c.method === m).length;

async function setupWi(link: boolean): Promise<{ dir: string; store: WorkItemStore; id: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ditto-start-claim-'));
  const store = new WorkItemStore(dir);
  const created = await store.create({
    title: 't',
    source_request: 'r',
    goal: 'g',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'x is observable', verdict: 'unverified', evidence: [] },
    ],
  });
  if (link) {
    await store.update(created.id, (cur) => ({
      ...cur,
      github_issue: { repo: 'owner/app', number: 42, project_item_id: 'PVTI_1' },
    }));
  }
  return { dir, store, id: created.id };
}

describe('ac-1 work start --issue claim=true: promotes + assigns @me', () => {
  test('linked WI: status→in_progress AND issueAddAssignee(@me) called once', async () => {
    const { dir, store, id } = await setupWi(true);
    const { client, calls } = createFakeGhClient({
      values: { projectFieldList: FIELD_LIST, issueView: { assignees: [] } },
    });
    const res = await maybeClaimOnStart(store, id, { claim: true }, wiring(client));
    expect(res).not.toBeNull();
    expect(res?.fired).toBe(true);
    expect(res?.promotedToInProgress).toBe(true);
    expect((await store.get(id)).status).toBe('in_progress');
    expect(count(calls, 'issueAddAssignee')).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('ac-2 work start --issue --no-claim: no claim, stays draft', () => {
  test('linked WI + claim=false: returns null, status draft, zero gh calls', async () => {
    const { dir, store, id } = await setupWi(true);
    const { client, calls } = createFakeGhClient({
      values: { projectFieldList: FIELD_LIST, issueView: { assignees: [] } },
    });
    const res = await maybeClaimOnStart(store, id, { claim: false }, wiring(client));
    expect(res).toBeNull();
    expect((await store.get(id)).status).toBe('draft');
    expect(count(calls, 'issueAddAssignee')).toBe(0);
    expect(calls.length).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('ac-3 re-start an already-linked issue also claims', () => {
  test('a linked WI (existing pull) claims: issueAddAssignee + in_progress', async () => {
    const { dir, store, id } = await setupWi(true);
    const { client, calls } = createFakeGhClient({
      values: { projectFieldList: FIELD_LIST, issueView: { assignees: [] } },
    });
    const res = await maybeClaimOnStart(store, id, { claim: true }, wiring(client));
    expect(res?.fired).toBe(true);
    expect((await store.get(id)).status).toBe('in_progress');
    expect(count(calls, 'issueAddAssignee')).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('ac-4 pure work start (no issue) unchanged', () => {
  test('unlinked WI + claim=true: returns null, status draft, zero gh calls', async () => {
    const { dir, store, id } = await setupWi(false);
    const { client, calls } = createFakeGhClient();
    const res = await maybeClaimOnStart(store, id, { claim: true }, wiring(client));
    expect(res).toBeNull();
    expect((await store.get(id)).status).toBe('draft');
    expect(calls.length).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });
});
