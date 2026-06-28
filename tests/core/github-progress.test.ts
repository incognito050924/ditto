import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AutopilotDecision, AutopilotStore } from '~/core/autopilot-store';
import { createFakeGhClient } from '~/core/gh-client';
import { postUnpostedDecisions } from '~/core/github-progress';
import { WorkItemStore } from '~/core/work-item-store';

// G8 progress posting (wi_260628d79, ac-9/10/11/12). The posting logic is the
// injectable seam: a FAKE GhClient + real stores on a tmp dir, assert on call
// counts + on-disk posted_decision_ids. No `gh` subprocess.

let dir: string;
let wis: WorkItemStore;
let aps: AutopilotStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-ghprog-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
  wis = new WorkItemStore(dir);
  aps = new AutopilotStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function makeLinkedWi(overrides: Partial<{ number: number }> = {}): Promise<string> {
  const created = await wis.create({
    title: 'wi',
    source_request: 'req',
    goal: 'goal',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'x is observable', verdict: 'unverified', evidence: [] },
    ],
  });
  await wis.update(created.id, (cur) => ({
    ...cur,
    github_issue: { repo: 'owner/app', number: overrides.number ?? 42 },
  }));
  return created.id;
}

function escalate(
  reason = 'user must choose A or B',
  ts = '2026-06-28T00:00:00.000Z',
): AutopilotDecision {
  return { ts, node_id: 'N1', failure_class: 'user_decision_needed', decision: 'escalate', reason };
}
function routineRetry(): AutopilotDecision {
  return {
    ts: '2026-06-28T00:00:01.000Z',
    node_id: 'N1',
    decision: 'retry',
    reason: 'fixable retry',
  };
}

describe('G8 progress posting', () => {
  // ac-9: sync rollup posts unposted-only in exactly 1 comment; routine excluded.
  test('ac-9: posts unposted decisive in exactly 1 comment, routine excluded', async () => {
    const wi = await makeLinkedWi();
    await aps.appendDecision(wi, routineRetry()); // routine — must NOT post
    await aps.appendDecision(wi, escalate('decision A'));
    await aps.appendDecision(wi, {
      ts: '2026-06-28T00:00:02.000Z',
      node_id: 'N2',
      decision: 'batch_escalate',
      reason: 'out-of-scope batch',
    });
    const { client, calls } = createFakeGhClient();
    const res = await postUnpostedDecisions({ client, store: wis, aps }, wi);
    expect(res.kind).toBe('posted');
    // exactly ONE gh call for the whole rollup
    expect(calls.filter((c) => c.method === 'issueComment')).toHaveLength(1);
    // both decisive decisions are in the single body; the routine retry is not
    const body = String(calls[0]?.args[2]);
    expect(body).toContain('decision A');
    expect(body).toContain('out-of-scope batch');
    expect(body).not.toContain('fixable retry');
    expect(res.kind === 'posted' && res.posted_ids).toHaveLength(2);
  });

  // ac-9: 0 new -> no-op, 0 gh calls.
  test('ac-9: 0 new unposted decisive -> no gh call (no-op)', async () => {
    const wi = await makeLinkedWi();
    await aps.appendDecision(wi, routineRetry()); // only routine -> nothing decisive
    const { client, calls } = createFakeGhClient();
    const res = await postUnpostedDecisions({ client, store: wis, aps }, wi);
    expect(res.kind).toBe('no_new');
    expect(calls).toHaveLength(0);
  });

  // ac-10: same id revisit -> no double-post (idempotent).
  test('ac-10: revisiting the same decision does not re-post (idempotent)', async () => {
    const wi = await makeLinkedWi();
    await aps.appendDecision(wi, escalate());
    const first = createFakeGhClient();
    expect((await postUnpostedDecisions({ client: first.client, store: wis, aps }, wi)).kind).toBe(
      'posted',
    );
    expect(first.calls.filter((c) => c.method === 'issueComment')).toHaveLength(1);
    // marked on disk
    const marked = await wis.get(wi);
    expect(marked.github_issue?.posted_decision_ids ?? []).toHaveLength(1);
    // second run: same log, nothing new -> no second comment
    const second = createFakeGhClient();
    const res2 = await postUnpostedDecisions({ client: second.client, store: wis, aps }, wi);
    expect(res2.kind).toBe('no_new');
    expect(second.calls).toHaveLength(0);
  });

  // ac-10: TWO distinct same-content decisions BOTH post (the per-occurrence id discriminates).
  test('ac-10: two distinct same-content decisions both post (id discriminates)', async () => {
    const wi = await makeLinkedWi();
    // first occurrence
    await aps.appendDecision(wi, escalate('same reason', '2026-06-28T00:00:00.000Z'));
    const a = createFakeGhClient();
    expect((await postUnpostedDecisions({ client: a.client, store: wis, aps }, wi)).kind).toBe(
      'posted',
    );
    expect(a.calls.filter((c) => c.method === 'issueComment')).toHaveLength(1);
    // second occurrence — byte-identical content (same ts/reason), distinct occurrence
    await aps.appendDecision(wi, escalate('same reason', '2026-06-28T00:00:00.000Z'));
    const b = createFakeGhClient();
    const res = await postUnpostedDecisions({ client: b.client, store: wis, aps }, wi);
    expect(res.kind).toBe('posted'); // NOT silently dropped
    expect(b.calls.filter((c) => c.method === 'issueComment')).toHaveLength(1);
    // both occurrences are now marked (2 distinct ids)
    const marked = await wis.get(wi);
    expect(marked.github_issue?.posted_decision_ids ?? []).toHaveLength(2);
  });

  // ac-10: decisive predicate fires on the REAL fields (disposition=blocked too).
  test('ac-10: a loop_terminated/blocked decision posts (disposition predicate)', async () => {
    const wi = await makeLinkedWi();
    await aps.appendDecision(wi, {
      ts: '2026-06-28T00:00:00.000Z',
      node_id: wi,
      decision: 'loop_terminated',
      disposition: 'blocked',
      reason: 'closed without convergence',
    });
    await aps.appendDecision(wi, {
      ts: '2026-06-28T00:00:01.000Z',
      node_id: wi,
      decision: 'loop_terminated',
      disposition: 'converged',
      reason: 'converged ok',
    }); // routine verdict
    const { client, calls } = createFakeGhClient();
    const res = await postUnpostedDecisions({ client, store: wis, aps }, wi);
    expect(res.kind).toBe('posted');
    expect(calls.filter((c) => c.method === 'issueComment')).toHaveLength(1);
    const body = String(calls[0]?.args[2]);
    expect(body).toContain('closed without convergence');
    expect(body).not.toContain('converged ok');
  });

  // ac-11: no link -> skip + notice, no gh call, nothing marked.
  test('ac-11: no github_issue link -> skip + notice (no gh call)', async () => {
    const created = await wis.create({
      title: 'wi',
      source_request: 'req',
      goal: 'goal',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'x is observable', verdict: 'unverified', evidence: [] },
      ],
    });
    await aps.appendDecision(created.id, escalate());
    const { client, calls } = createFakeGhClient();
    const res = await postUnpostedDecisions({ client, store: wis, aps }, created.id);
    expect(res.kind).toBe('skipped');
    expect(res.kind === 'skipped' && res.notice).toContain('no linked GitHub issue');
    expect(calls).toHaveLength(0);
  });

  // ac-11: a post degradation HOLDS the marking (so a later sync rolls it up).
  test('ac-11: post degradation holds marking — not double-posted, retriable', async () => {
    const wi = await makeLinkedWi();
    await aps.appendDecision(wi, escalate());
    const down = createFakeGhClient({
      degrade: { ok: false, reason: 'timeout', detail: 'gh hung' },
    });
    const res = await postUnpostedDecisions({ client: down.client, store: wis, aps }, wi);
    expect(res.kind).toBe('degraded');
    // NOT marked -> a later (healthy) sync still finds it unposted and posts it
    const afterFail = await wis.get(wi);
    expect(afterFail.github_issue?.posted_decision_ids ?? []).toHaveLength(0);
    const up = createFakeGhClient();
    const res2 = await postUnpostedDecisions({ client: up.client, store: wis, aps }, wi);
    expect(res2.kind).toBe('posted');
    expect(up.calls.filter((c) => c.method === 'issueComment')).toHaveLength(1);
  });

  // ac-12: child target resolution -> own sub-issue link FIRST.
  test('ac-12: child with its OWN issue link posts to its own issue (no prefix)', async () => {
    const child = await makeLinkedWi({ number: 7 });
    await aps.appendDecision(child, escalate('child decision'));
    const { client, calls } = createFakeGhClient();
    const res = await postUnpostedDecisions({ client, store: wis, aps }, child);
    expect(res.kind).toBe('posted');
    expect(calls[0]?.args[1]).toBe(7); // own issue number
    const body = String(calls[0]?.args[2]);
    expect(body).not.toContain(`[${child}]`); // no parent prefix when own link wins
  });

  // ac-12: child with NO own link -> posts to PARENT's issue with a [<child>] prefix.
  test("ac-12: child with no own link posts to parent's issue with a [child] prefix", async () => {
    const parent = await makeLinkedWi({ number: 100 });
    const childWi = await wis.create({
      title: 'child',
      source_request: 'req',
      goal: 'goal',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'x is observable', verdict: 'unverified', evidence: [] },
      ],
    });
    await wis.update(childWi.id, (cur) => ({ ...cur, parent_id: parent }));
    await aps.appendDecision(childWi.id, escalate('child needs decision'));
    const { client, calls } = createFakeGhClient();
    const res = await postUnpostedDecisions({ client, store: wis, aps }, childWi.id);
    expect(res.kind).toBe('posted');
    expect(calls[0]?.args[1]).toBe(100); // parent's issue number
    const body = String(calls[0]?.args[2]);
    expect(body).toContain(`[${childWi.id}]`); // child prefix
    // idempotency tracked on the PARENT's link (where the issue lives)
    const markedParent = await wis.get(parent);
    expect(markedParent.github_issue?.posted_decision_ids ?? []).toHaveLength(1);
  });

  // ac-12: child with no own link AND no parent link -> skip.
  test('ac-12: child with no own and no parent link -> skip', async () => {
    const parentWi = await wis.create({
      title: 'parent',
      source_request: 'req',
      goal: 'goal',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'x is observable', verdict: 'unverified', evidence: [] },
      ],
    });
    const childWi = await wis.create({
      title: 'child',
      source_request: 'req',
      goal: 'goal',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'x is observable', verdict: 'unverified', evidence: [] },
      ],
    });
    await wis.update(childWi.id, (cur) => ({ ...cur, parent_id: parentWi.id }));
    await aps.appendDecision(childWi.id, escalate());
    const { client, calls } = createFakeGhClient();
    const res = await postUnpostedDecisions({ client, store: wis, aps }, childWi.id);
    expect(res.kind).toBe('skipped');
    expect(calls).toHaveLength(0);
  });
});
