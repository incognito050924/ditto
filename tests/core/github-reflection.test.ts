import { describe, expect, test } from 'bun:test';
import { createFakeGhClient } from '~/core/gh-client';
import {
  type ReflectionInput,
  buildResultSummary,
  extractStatusFieldId,
  reflectAutopilotTermination,
  reflectTermination,
} from '~/core/github-reflection';
import type { CompletionContract } from '~/schemas/completion-contract';
import type { DittoConfigGithub } from '~/schemas/ditto-config';
import type { WorkItem } from '~/schemas/work-item';

// impl-reflection node (wi_260628d79, ac-4/ac-5): the GitHub termination reflection
// posts a result-summary comment + a board status update ONLY at a terminal
// (done|abandoned) transition, never on a non-terminal complete. All AC tests
// inject a FAKE GhClient (OBJ-3 seam) and assert on the recorded call list — no
// `gh` subprocess. Pure logic, unit-tested in isolation.

const STATUS_FIELD_LIST = {
  fields: [
    { id: 'PVTF_title', name: 'Title', type: 'ProjectV2Field' },
    {
      id: 'PVTSSF_status',
      name: 'Status',
      type: 'ProjectV2SingleSelectField',
      options: [
        { id: 'opt_done', name: 'Done' },
        { id: 'opt_dropped', name: 'Dropped' },
      ],
    },
  ],
};

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'wi_test001',
    title: 'Add retry to fetch',
    goal: 'fetch retries on 5xx',
    status: 'in_progress',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'fetch retries on 5xx', verdict: 'pass', evidence: [] },
    ],
    github_issue: { repo: 'owner/app', number: 42, project_item_id: 'PVTI_item1' },
    ...overrides,
  } as unknown as WorkItem;
}

function completion(verdict: CompletionContract['final_verdict']): CompletionContract {
  return { final_verdict: verdict } as unknown as CompletionContract;
}

function cfg(overrides: Partial<DittoConfigGithub> = {}): DittoConfigGithub {
  return {
    project: { owner: 'owner', number: 5, node_id: 'PVT_proj1' },
    status_map: { done: 'opt_done', abandoned: 'opt_dropped' },
    auto_reflect: true,
    ...overrides,
  };
}

function fake() {
  return createFakeGhClient({ values: { projectFieldList: STATUS_FIELD_LIST } });
}

describe('impl-reflection ac-4/ac-5 — terminal GitHub reflection', () => {
  // ac-4 + ac-5 (a): autopilot complete pass+done flip → exactly 1 comment + 1 status update.
  test('(a) autopilot done-flip with auto_reflect ON → 1 comment + 1 status update', () => {
    const { client, calls } = fake();
    const res = reflectAutopilotTermination(
      { client, config: cfg(), configMalformed: false },
      { autoClose: 'flipped', workItem: workItem(), completion: completion('pass') },
    );
    expect(res.commentPosted).toBe(true);
    expect(res.statusUpdated).toBe(true);
    expect(res.issueClosed).toBe(false); // autopilot NEVER closes
    expect(calls.filter((c) => c.method === 'issueComment')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'projectItemEdit')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'issueClose')).toHaveLength(0);
    const edit = calls.find((c) => c.method === 'projectItemEdit');
    expect(edit?.args[0]).toMatchObject({ optionId: 'opt_done', fieldId: 'PVTSSF_status' });
  });

  // ac-4 (b) THE cross-feature regression guard: a non-terminal complete (partial/
  // unverified persists completion.json but does NOT flip) posts NOTHING.
  test('(b) autopilot complete partial/unverified (autoClose=skipped) → 0 gh calls', () => {
    const { client, calls } = fake();
    const res = reflectAutopilotTermination(
      { client, config: cfg(), configMalformed: false },
      { autoClose: 'skipped', workItem: workItem(), completion: completion('partial') },
    );
    expect(res.commentPosted).toBe(false);
    expect(res.statusUpdated).toBe(false);
    expect(calls).toHaveLength(0);
  });

  // ac-4 (c): manual `work done` terminal close posts exactly 1 comment.
  test('(c) work done (trigger=done) → 1 comment, no close', () => {
    const { client, calls } = fake();
    const res = reflectTermination(
      { client, config: cfg() },
      { workItem: workItem(), completion: completion('pass'), trigger: 'done' },
    );
    expect(res.commentPosted).toBe(true);
    expect(calls.filter((c) => c.method === 'issueComment')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'issueClose')).toHaveLength(0);
  });

  // ac-4 (d): the abandon path reflects (trigger=abandoned) → 1 comment + abandoned status.
  test('(d) work abandon (trigger=abandoned) → reflects (1 comment + abandoned status)', () => {
    const { client, calls } = fake();
    const res = reflectTermination(
      { client, config: cfg() },
      { workItem: workItem(), trigger: 'abandoned' },
    );
    expect(res.commentPosted).toBe(true);
    expect(res.statusUpdated).toBe(true);
    expect(calls.filter((c) => c.method === 'issueComment')).toHaveLength(1);
    const edit = calls.find((c) => c.method === 'projectItemEdit');
    expect(edit?.args[0]).toMatchObject({ optionId: 'opt_dropped' });
  });

  // ac-4 (e): auto_reflect OFF and absent → 0 autopilot-path posts (silent default-OFF).
  test('(e) auto_reflect OFF → 0 calls, no notice (silent default-OFF)', () => {
    const { client, calls } = fake();
    const res = reflectAutopilotTermination(
      { client, config: cfg({ auto_reflect: false }), configMalformed: false },
      { autoClose: 'flipped', workItem: workItem(), completion: completion('pass') },
    );
    expect(calls).toHaveLength(0);
    expect(res.notices).toHaveLength(0);
  });

  test('(e2) config ABSENT (undefined) on autopilot path → 0 calls, no notice', () => {
    const { client, calls } = fake();
    const res = reflectAutopilotTermination(
      { client, config: undefined, configMalformed: false },
      { autoClose: 'flipped', workItem: workItem(), completion: completion('pass') },
    );
    expect(calls).toHaveLength(0);
    expect(res.notices).toHaveLength(0);
  });

  // ac-4 (f): MALFORMED config must NOT silently disable an opted-in auto_reflect —
  // a recorded notice fires (distinct from the silent absent default).
  test('(f) malformed config → 0 calls but a RECORDED notice (not silent)', () => {
    const { client, calls } = fake();
    const res = reflectAutopilotTermination(
      { client, config: undefined, configMalformed: true },
      { autoClose: 'flipped', workItem: workItem(), completion: completion('pass') },
    );
    expect(calls).toHaveLength(0);
    expect(res.notices.length).toBeGreaterThan(0);
    expect(res.notices.join(' ')).toContain('malformed');
  });

  // ac-4 (g): no github_issue link → skip + notice, no calls (not an error).
  test('(g) no linked issue → skip + notice, 0 calls', () => {
    const { client, calls } = fake();
    const res = reflectTermination(
      { client, config: cfg() },
      { workItem: workItem({ github_issue: undefined }), trigger: 'done' },
    );
    expect(res.commentPosted).toBe(false);
    expect(calls).toHaveLength(0);
    expect(res.notices.join(' ')).toContain('No linked GitHub issue');
  });

  // ac-5 (h): an unmapped status → board update skipped + notice, but the comment
  // still posts (the two effects are independent).
  test('(h) unmapped status → projectItemEdit NOT called + notice, comment still posts', () => {
    const { client, calls } = fake();
    const res = reflectTermination(
      { client, config: cfg({ status_map: { done: 'opt_done' } }) },
      { workItem: workItem(), trigger: 'abandoned' },
    );
    expect(res.commentPosted).toBe(true); // comment independent of board mapping
    expect(res.statusUpdated).toBe(false);
    expect(calls.filter((c) => c.method === 'projectItemEdit')).toHaveLength(0);
    expect(res.notices.join(' ')).toContain("no status_map entry for 'abandoned'");
  });

  // manual --close-issue closes the issue (the ONLY path that closes).
  test('(close) manual --close-issue → issueClose called once', () => {
    const { client, calls } = fake();
    const res = reflectTermination(
      { client, config: cfg() },
      { workItem: workItem(), trigger: 'done', closeIssue: true },
    );
    expect(res.issueClosed).toBe(true);
    expect(calls.filter((c) => c.method === 'issueClose')).toHaveLength(1);
  });
});

describe('reflection pure helpers', () => {
  test('extractStatusFieldId picks the Status single-select field id', () => {
    expect(extractStatusFieldId(STATUS_FIELD_LIST)).toBe('PVTSSF_status');
    expect(extractStatusFieldId({ fields: [{ id: 'x', name: 'Title' }] })).toBeNull();
  });

  test('buildResultSummary is public-safe: verdict + per-AC line, NO internal wi id', () => {
    const body = buildResultSummary({
      workItem: workItem(),
      completion: completion('pass'),
      trigger: 'done',
    } as ReflectionInput);
    expect(body).not.toContain('wi_test001'); // internal wi id excluded (ac-15)
    expect(body).toContain('final_verdict: `pass`');
    expect(body).toContain('ac-1 [pass]');
  });
});
