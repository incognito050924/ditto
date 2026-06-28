import { describe, expect, test } from 'bun:test';
import type { GhClient, GhDegradeReason, GhResult, RecordedGhCall } from '~/core/gh-client';
import { claim, unclaim } from '~/core/github-claim';
import type { DittoConfigGithub } from '~/schemas/ditto-config';
import type { WorkItem } from '~/schemas/work-item';

// impl-core node (wi_2606287v9 #5): claim/occupancy logic, remote-authoritative-first
// + best-effort-advisory (NOT a lock). Every test injects a RECORDING fake GhClient
// with per-method failure control and asserts on the recorded call list / order — no
// `gh` subprocess.

const STATUS_FIELD_LIST = {
  fields: [
    {
      id: 'PVTSSF_status',
      name: 'Status',
      type: 'ProjectV2SingleSelectField',
      options: [
        { id: 'opt_inprog', name: 'In Progress' },
        { id: 'opt_blocked', name: 'Blocked' },
      ],
    },
  ],
};

/** Recording fake with per-method failure + canned values (the shared createFakeGhClient
 *  only supports all-or-nothing degrade; read-back variants need per-method control). */
function makeClient(
  opts: {
    values?: Partial<Record<keyof GhClient, unknown>>;
    fail?: Partial<Record<keyof GhClient, GhDegradeReason>>;
  } = {},
): { client: GhClient; calls: RecordedGhCall[] } {
  const calls: RecordedGhCall[] = [];
  const m =
    (method: keyof GhClient) =>
    (...args: unknown[]): GhResult<unknown> => {
      calls.push({ method, args });
      const reason = opts.fail?.[method];
      if (reason) return { ok: false, reason, detail: '' };
      return { ok: true, value: opts.values?.[method] };
    };
  const client = {
    issueView: m('issueView'),
    issueComment: m('issueComment'),
    issueClose: m('issueClose'),
    issueAddAssignee: m('issueAddAssignee'),
    issueRemoveAssignee: m('issueRemoveAssignee'),
    projectItemAdd: m('projectItemAdd'),
    projectItemEdit: m('projectItemEdit'),
    projectFieldList: m('projectFieldList'),
    projectItemList: m('projectItemList'),
    projectView: m('projectView'),
    apiGraphql: m('apiGraphql'),
  } as unknown as GhClient;
  return { client, calls };
}

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'wi_test001',
    title: 'Add retry to fetch',
    status: 'in_progress',
    acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
    github_issue: { repo: 'owner/app', number: 42, project_item_id: 'PVTI_item1' },
    ...overrides,
  } as unknown as WorkItem;
}

function cfg(overrides: Partial<DittoConfigGithub> = {}): DittoConfigGithub {
  return {
    project: { owner: 'owner', number: 5, node_id: 'PVT_proj1' },
    status_map: { done: 'opt_done', abandoned: 'opt_dropped' },
    claim_status_map: { in_progress: 'opt_inprog', blocked: 'opt_blocked' },
    auto_reflect: true,
    ...overrides,
  };
}

const BRANCH = 'ditto/wi_2606287v9';
const COORD = 'ditto/2606287v9'; // sanitizeBranchCoordinate drops only the wi_ prefix
const MARKER = `claim:${COORD}`;

function values(extra: Partial<Record<keyof GhClient, unknown>> = {}) {
  return {
    projectFieldList: STATUS_FIELD_LIST,
    issueView: { assignees: [{ login: 'me' }] },
    ...extra,
  };
}

describe('github-claim claim() — remote-first + occupancy', () => {
  // ac-1: a fresh claim sets the assignee + moves the board + posts a branch comment +
  // returns the local marker. The branch comment carries NO wi_ leak.
  test('ac-1 fresh claim: assignee + board(in_progress) + branch comment + local marker', () => {
    const { client, calls } = makeClient({ values: values() });
    const res = claim(
      { client, config: cfg() },
      { workItem: workItem(), branch: BRANCH, actorLogin: 'me' },
    );

    expect(res.assigneeAdded).toBe(true);
    expect(res.boardUpdated).toBe(true);
    expect(res.commentPosted).toBe(true);
    expect(res.localClaim).toEqual({ claimed_branch: COORD, posted_claim_markers: [MARKER] });

    expect(calls.filter((c) => c.method === 'issueAddAssignee')).toHaveLength(1);
    const edit = calls.find((c) => c.method === 'projectItemEdit');
    expect(edit?.args[0]).toMatchObject({ optionId: 'opt_inprog', fieldId: 'PVTSSF_status' });
    const comment = calls.find((c) => c.method === 'issueComment');
    const body = String(comment?.args[2]);
    expect(body).toContain('ditto/2606287v9');
    expect(body).not.toContain('wi_'); // no wi_ leak on the public branch comment
  });

  // remote-first call ORDER: the @me assignee write precedes the read-back, board, and
  // the (returned) local marker. The local marker is computed only AFTER the gh writes.
  test('remote-first: issueAddAssignee is the FIRST gh call, before read-back/board/comment', () => {
    const { client, calls } = makeClient({ values: values() });
    claim({ client, config: cfg() }, { workItem: workItem(), branch: BRANCH, actorLogin: 'me' });
    expect(calls[0]?.method).toBe('issueAddAssignee');
    const assignIdx = calls.findIndex((c) => c.method === 'issueAddAssignee');
    const viewIdx = calls.findIndex((c) => c.method === 'issueView');
    const commentIdx = calls.findIndex((c) => c.method === 'issueComment');
    expect(assignIdx).toBeLessThan(viewIdx);
    expect(assignIdx).toBeLessThan(commentIdx);
  });

  // ac-8 + remote-first invariant: the assignee write degrades ⇒ NO local claim, NO
  // board move, NO comment, no throw. (A 2nd machine never sees local-owned-but-board-free.)
  test('remote-first invariant: assignee write degraded ⇒ NO local claim, only the assignee call', () => {
    const { client, calls } = makeClient({
      values: values(),
      fail: { issueAddAssignee: 'rate_limited' },
    });
    const res = claim(
      { client, config: cfg() },
      { workItem: workItem(), branch: BRANCH, actorLogin: 'me' },
    );
    expect(res.assigneeAdded).toBe(false);
    expect(res.localClaim).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('issueAddAssignee');
    expect(res.notices.join(' ')).toContain('NO local claim');
  });

  // ac-2: an idempotent re-claim on the steady state (local marker present) is a
  // zero-gh-call no-op — the gh write happens once per claim edge.
  test('ac-2 idempotent re-claim on steady state ⇒ noop, 0 gh calls', () => {
    const { client, calls } = makeClient({ values: values() });
    const wi = workItem({
      github_issue: {
        repo: 'owner/app',
        number: 42,
        project_item_id: 'PVTI_item1',
        claimed_branch: COORD,
        posted_claim_markers: [MARKER],
      },
    } as Partial<WorkItem>);
    const res = claim(
      { client, config: cfg() },
      { workItem: wi, branch: BRANCH, actorLogin: 'me' },
    );
    expect(res.noop).toBe(true);
    expect(calls).toHaveLength(0);
    expect(res.localClaim).toBeUndefined();
  });

  // ac-3 read-back variant A: a DEGRADED read ⇒ "occupancy UNKNOWN" (distinct from a
  // clean read) — advisory warn only, the claim still lands locally (assignee write ok).
  test('ac-3 degraded read-back ⇒ occupancy UNKNOWN warning, claim still lands', () => {
    const { client } = makeClient({ values: values(), fail: { issueView: 'timeout' } });
    const res = claim(
      { client, config: cfg() },
      { workItem: workItem(), branch: BRANCH, actorLogin: 'me' },
    );
    expect(res.occupancy).toBe('unknown');
    expect(res.localClaim).toBeDefined();
    expect(res.warnings.join(' ')).toContain('UNKNOWN');
    expect(res.warnings.join(' ')).not.toContain('Duplicate-claim');
  });

  // ac-3 variant B: a FOREIGN assignee ⇒ a duplicate-claim warning (distinct from UNKNOWN).
  test('ac-3 foreign assignee ⇒ duplicate-claim warning (advisory, not a block)', () => {
    const { client } = makeClient({
      values: values({ issueView: { assignees: [{ login: 'me' }, { login: 'alice' }] } }),
    });
    const res = claim(
      { client, config: cfg() },
      { workItem: workItem(), branch: BRANCH, actorLogin: 'me' },
    );
    expect(res.occupancy).toBe('foreign');
    expect(res.warnings.join(' ')).toContain('Duplicate-claim');
    expect(res.warnings.join(' ')).toContain('alice'); // surfaced only in the transient warning
    expect(res.localClaim).toBeDefined(); // advisory, never blocks the claim
  });

  // ac-3 variant C: same actor but a DIFFERENT branch already recorded ⇒ a resume hint.
  test('ac-3 same @me, different branch ⇒ resume hint', () => {
    const { client } = makeClient({ values: values() });
    const wi = workItem({
      github_issue: {
        repo: 'owner/app',
        number: 42,
        project_item_id: 'PVTI_item1',
        claimed_branch: 'ditto/other',
        posted_claim_markers: ['claim:ditto/other'],
      },
    } as Partial<WorkItem>);
    const res = claim(
      { client, config: cfg() },
      { workItem: wi, branch: BRANCH, actorLogin: 'me' },
    );
    expect(res.warnings.join(' ')).toContain('Resume hint');
    expect(res.warnings.join(' ')).toContain('ditto/other');
  });

  // ac-3 variant D: a CONFIRMED partial (read ok but @me absent) ⇒ NO local claim
  // (distinct from a degraded UNKNOWN read).
  test('confirmed partial: read ok but @me absent ⇒ NO local claim', () => {
    const { client } = makeClient({ values: values({ issueView: { assignees: [] } }) });
    const res = claim(
      { client, config: cfg() },
      { workItem: workItem(), branch: BRANCH, actorLogin: 'me' },
    );
    expect(res.assigneeAdded).toBe(true);
    expect(res.localClaim).toBeUndefined();
    expect(res.warnings.join(' ')).toContain('NOT reflected');
  });

  // ac-5 terminal-overwrite guard: a non-terminal claim must NEVER overwrite a terminal
  // board status ⇒ projectItemEdit not called when the WI is terminal.
  test('ac-5 board guard: terminal WI status ⇒ claim board move skipped (no projectItemEdit)', () => {
    const { client, calls } = makeClient({ values: values() });
    const res = claim(
      { client, config: cfg() },
      {
        workItem: workItem({ status: 'done' } as Partial<WorkItem>),
        branch: BRANCH,
        actorLogin: 'me',
      },
    );
    expect(res.boardUpdated).toBe(false);
    expect(calls.filter((c) => c.method === 'projectItemEdit')).toHaveLength(0);
    expect(res.notices.join(' ')).toContain('terminal');
  });

  // ac-10: no github_issue link ⇒ skip + notice, 0 gh calls, no throw.
  test('ac-10 no linked issue ⇒ skip + notice, 0 gh calls', () => {
    const { client, calls } = makeClient({ values: values() });
    const res = claim(
      { client, config: cfg() },
      { workItem: workItem({ github_issue: undefined }), branch: BRANCH, actorLogin: 'me' },
    );
    expect(res.assigneeAdded).toBe(false);
    expect(calls).toHaveLength(0);
    expect(res.notices.join(' ')).toContain('No linked GitHub issue');
  });

  // ac-8: every gh path degrades without throwing — gh fully down ⇒ assignee notice, no local claim.
  test('ac-8 gh fully down ⇒ degrades without throw, no local claim', () => {
    const { client } = makeClient({
      fail: {
        issueAddAssignee: 'absent',
        issueView: 'absent',
        issueComment: 'absent',
        projectFieldList: 'absent',
        projectItemEdit: 'absent',
      },
    });
    const res = claim(
      { client, config: cfg() },
      { workItem: workItem(), branch: BRANCH, actorLogin: 'me' },
    );
    expect(res.assigneeAdded).toBe(false);
    expect(res.localClaim).toBeUndefined();
    expect(res.notices.length).toBeGreaterThan(0);
  });
});

describe('github-claim unclaim() — @me-only release + audit comment', () => {
  // ac-7: unclaim removes @me ONLY (issueRemoveAssignee with @me) + posts a release comment.
  test('ac-7 unclaim removes @me ONLY + posts a durable release comment', () => {
    const { client, calls } = makeClient({ values: values() });
    const res = unclaim({ client, config: cfg() }, { workItem: workItem(), reason: 'handed off' });
    expect(res.assigneeRemoved).toBe(true);
    expect(res.commentPosted).toBe(true);
    const rm = calls.find((c) => c.method === 'issueRemoveAssignee');
    expect(rm?.args[2]).toBe('@me'); // @me-only — never clears other assignees
    const comment = calls.find((c) => c.method === 'issueComment');
    expect(String(comment?.args[2])).toContain('released');
  });

  // blocked → Blocked board column via claim_status_map.
  test('unclaim with boardStatusKey=blocked ⇒ board moved to Blocked', () => {
    const { client, calls } = makeClient({ values: values() });
    const res = unclaim(
      { client, config: cfg() },
      { workItem: workItem(), boardStatusKey: 'blocked' },
    );
    expect(res.boardUpdated).toBe(true);
    const edit = calls.find((c) => c.method === 'projectItemEdit');
    expect(edit?.args[0]).toMatchObject({ optionId: 'opt_blocked' });
  });

  // ac-10 + ac-8: no link ⇒ skip + notice; gh degraded ⇒ notice, no throw.
  test('ac-10 unclaim no linked issue ⇒ skip + notice, 0 gh calls', () => {
    const { client, calls } = makeClient();
    const res = unclaim(
      { client, config: cfg() },
      { workItem: workItem({ github_issue: undefined }) },
    );
    expect(res.assigneeRemoved).toBe(false);
    expect(calls).toHaveLength(0);
    expect(res.notices.join(' ')).toContain('No linked GitHub issue');
  });
});
