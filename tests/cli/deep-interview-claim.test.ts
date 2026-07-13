import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ClaimWiring, autoClaimOnInProgressEdge } from '~/cli/commands/work';
import { type RecordedGhCall, createFakeGhClient } from '~/core/gh-client';
import {
  type FinalizePayload,
  finalizeInterview,
  recordTurn,
  startInterview,
} from '~/core/interview-driver';
import { WorkItemStore } from '~/core/work-item-store';
import type { DittoConfigGithub } from '~/schemas/ditto-config';

// wi_2606287v9 (#5) ac-2 / n8-review F1: the CANONICAL autopilot path runs through
// deep-interview finalize → finalizeInterview → core bootstrapAutopilot. That chokepoint
// must promote draft→in_progress so the finalize CLI wrapper can fire the SAME claim edge
// the `ditto autopilot bootstrap` CLI path fires — both entry points symmetric. These tests
// drive the REAL finalize, then the n6 claim helper (autoClaimOnInProgressEdge) with a
// RECORDING fake GhClient (no `gh` subprocess), exactly as finalizeCmd does.

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

const PAYLOAD: FinalizePayload = {
  goal: 'returns integer score 0..100 for a password',
  in_scope: ['POST /password-strength'],
  out_of_scope: [],
  acceptance_criteria: [
    {
      id: 'ac-1',
      statement: 'returns integer 0..100',
      verdict: 'unverified' as const,
      evidence: [],
      evidence_required: ['test'],
    },
  ],
  unknowns: [],
  follow_up_candidates: [],
  question_policy: 'ask_only_if_user_only_can_answer' as const,
  risk: { non_local: false, irreversible: false, unaudited: false },
  user_confirmation: { confirmed: true, statement: '네, 이 의도가 맞습니다' },
};

async function driveToReady(repo: string, wiId: string): Promise<void> {
  await startInterview(repo, { workItemId: wiId });
  await recordTurn(repo, {
    workItemId: wiId,
    payload: {
      dimension: { id: 'd-shape', critical: true, state: 'resolved', ambiguity: 0.05, notes: '' },
      question: {
        text: 'shape?',
        why_matters: 'response',
        user_explanation: '응답 값의 형태를 무엇으로 정할지 사용자 언어로 확인하는 질문입니다.',
        recommended_answer: '추천: 0..100 정수 — 점수 표현으로 가장 단순하고 명확합니다.',
        info_gain_estimate: 'high',
      },
      answer: { text: 'integer 0..100', kind: 'user' },
      readiness_score: 0.85,
    },
  });
}

async function makeWi(link: boolean): Promise<{ repo: string; store: WorkItemStore; id: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'ditto-difin-'));
  const store = new WorkItemStore(repo);
  const wi = await store.create({
    title: 'pw',
    source_request: 'add a /password-strength endpoint',
    goal: 'returns a score',
    acceptance_criteria: [{ id: 'ac-1', statement: 'TBD', verdict: 'unverified', evidence: [] }],
  });
  if (link) {
    await store.update(wi.id, (cur) => ({
      ...cur,
      github_issue: { repo: 'owner/app', number: 42, project_item_id: 'PVTI_1' },
    }));
  }
  return { repo, store, id: wi.id };
}

describe('ac-2 canonical path: deep-interview finalize promotes + fires claim', () => {
  test('linked WI: finalize promotes draft→in_progress AND claim fires once', async () => {
    const { repo, store, id } = await makeWi(true);
    await driveToReady(repo, id);
    const before = await store.get(id);
    expect(before.status).toBe('draft');

    const result = await finalizeInterview(repo, { workItemId: id, payload: PAYLOAD });
    expect(result.status).toBe('finalized');

    // canonical chokepoint promotion (the n8-review F1 gap fix)
    const after = await store.get(id);
    expect(after.status).toBe('in_progress');

    // the finalize CLI wrapper fires the SAME claim edge as `ditto autopilot bootstrap`
    const { client, calls } = createFakeGhClient({
      values: { projectFieldList: FIELD_LIST, issueView: { assignees: [] } },
    });
    const claim = await autoClaimOnInProgressEdge(store, id, before.status, after, wiring(client));
    expect(claim.fired).toBe(true);
    expect(count(calls, 'issueAddAssignee')).toBe(1);
    await rm(repo, { recursive: true, force: true });
  });

  test('linked WI: idempotent — a re-finalize (already in_progress) does not re-fire', async () => {
    const { repo, store, id } = await makeWi(true);
    await driveToReady(repo, id);
    await finalizeInterview(repo, { workItemId: id, payload: PAYLOAD });
    const promoted = await store.get(id);

    // first claim persists the branch-grain sentinel
    const first = createFakeGhClient({
      values: { projectFieldList: FIELD_LIST, issueView: { assignees: [] } },
    });
    await autoClaimOnInProgressEdge(store, id, 'draft', promoted, wiring(first.client));
    expect(count(first.calls, 'issueAddAssignee')).toBe(1);

    // re-finalize: WI already in_progress → the prev=in_progress edge does NOT re-fire
    await finalizeInterview(repo, { workItemId: id, payload: PAYLOAD });
    const reAfter = await store.get(id);
    expect(reAfter.status).toBe('in_progress');
    const second = createFakeGhClient({
      values: { projectFieldList: FIELD_LIST, issueView: { assignees: [] } },
    });
    const claim2 = await autoClaimOnInProgressEdge(
      store,
      id,
      reAfter.status,
      reAfter,
      wiring(second.client),
    );
    expect(claim2.fired).toBe(false);
    expect(second.calls.length).toBe(0);
    await rm(repo, { recursive: true, force: true });
  });

  test('unlinked WI: finalize promotes but fires NO gh (no github_issue link)', async () => {
    const { repo, store, id } = await makeWi(false);
    await driveToReady(repo, id);
    const before = await store.get(id);

    await finalizeInterview(repo, { workItemId: id, payload: PAYLOAD });
    const after = await store.get(id);
    expect(after.status).toBe('in_progress');

    // finalizeCmd guards on github_issue before building wiring; the helper also no-ops on no link
    const { client, calls } = createFakeGhClient();
    const claim = await autoClaimOnInProgressEdge(store, id, before.status, after, wiring(client));
    expect(claim.fired).toBe(false);
    expect(count(calls, 'issueAddAssignee')).toBe(0);
    await rm(repo, { recursive: true, force: true });
  });
});
