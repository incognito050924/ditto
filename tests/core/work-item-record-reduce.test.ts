import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { committedWorkItemDir } from '~/core/ditto-paths';
import { WorkItemEventCorruptError, WorkItemStore, reduceWorkItem } from '~/core/work-item-store';
import { type WorkItem, type WorkItemEvent, workItem, workItemEvent } from '~/schemas/work-item';

// wi_2607069bk WS0-T0 n2 — the hybrid record.json + per-event event-log store core.
// reduceWorkItem is the fold; events order by (seq,actor), NEVER ts; event_id
// dedupes; terminal is first-terminal-wins; reopen clears closed_at via the fold;
// corrupt event files SURFACE (R6, §10.1) rather than silently drop.

let workDir: string;
let store: WorkItemStore;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'ditto-wir-'));
  store = new WorkItemStore(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function sampleInput() {
  return {
    title: 'sample',
    source_request: '사용자 요청 원문',
    goal: '관측 가능한 목표 한 문장',
    acceptance_criteria: [
      { id: 'ac-1', statement: '관찰 가능한 조건', verdict: 'unverified' as const, evidence: [] },
    ],
  };
}

function mkRecord(extra: Record<string, unknown> = {}): WorkItem {
  return workItem.parse({
    schema_version: '0.1.0',
    id: 'wi_reduce0001',
    title: 'a work item',
    source_request: 'do the thing',
    goal: 'the outcome is observable',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'an observable behavior', verdict: 'unverified', evidence: [] },
    ],
    status: 'draft',
    owner_profile: 'workspace-write',
    child_ids: [],
    changed_files: [],
    risks: [],
    runs: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  });
}

function mkEvent(e: Record<string, unknown>): WorkItemEvent {
  return workItemEvent.parse({
    schema_version: '0.1.0',
    work_item_id: 'wi_reduce0001',
    actor: 'workspace-write',
    ts: '2026-01-01T00:00:00.000Z',
    ...e,
  });
}

describe('reduceWorkItem — pure fold (wi_2607069bk §2.1)', () => {
  test('orders events by (seq,actor), NOT ts (clock-skew safe)', () => {
    // seq order says the LATE-ts fail (seq 2) is the last verdict; ts order would
    // pick the EARLY-ts pass (seq 1). The reducer must follow seq, so ac-1 = fail.
    const record = mkRecord();
    const events = [
      mkEvent({ seq: 0, event_id: 'e-created', kind: 'status', payload: { to: 'draft' } }),
      mkEvent({
        seq: 1,
        event_id: 'e-pass',
        ts: '2026-12-31T23:59:59.000Z', // LATE ts, but earlier seq
        kind: 'verdict',
        payload: { criterion_id: 'ac-1', verdict: 'pass', evidence: [] },
      }),
      mkEvent({
        seq: 2,
        event_id: 'e-fail',
        ts: '2026-01-02T00:00:00.000Z', // EARLY ts, but later seq
        kind: 'verdict',
        payload: { criterion_id: 'ac-1', verdict: 'fail', evidence: [] },
      }),
    ];
    const reduced = reduceWorkItem(record, events);
    expect(reduced.acceptance_criteria[0]?.verdict).toBe('fail');
  });

  test('terminal is FIRST-terminal-wins under two competing terminal events (R1)', () => {
    const record = mkRecord();
    // done@(5,A) and abandoned@(5,B): equal seq, A<B → done wins; closed_at from done.
    const events = [
      mkEvent({ seq: 0, event_id: 'e0', kind: 'status', payload: { to: 'draft' } }),
      mkEvent({
        seq: 5,
        actor: 'writer-A',
        event_id: 'e-done',
        kind: 'status',
        payload: { to: 'done', closed_at: '2026-05-01T00:00:00.000Z' },
      }),
      mkEvent({
        seq: 5,
        actor: 'writer-B',
        event_id: 'e-aband',
        kind: 'status',
        payload: { to: 'abandoned', closed_at: '2026-05-02T00:00:00.000Z' },
      }),
    ];
    const reduced = reduceWorkItem(record, events);
    expect(reduced.status).toBe('done');
    expect(reduced.closed_at).toBe('2026-05-01T00:00:00.000Z');
  });

  test('first-terminal-wins picks the LOWEST (seq,actor) terminal (reversed actors)', () => {
    const record = mkRecord();
    const events = [
      mkEvent({ seq: 0, event_id: 'e0', kind: 'status', payload: { to: 'draft' } }),
      mkEvent({
        seq: 5,
        actor: 'writer-A',
        event_id: 'e-aband',
        kind: 'status',
        payload: { to: 'abandoned', closed_at: '2026-05-02T00:00:00.000Z' },
      }),
      mkEvent({
        seq: 5,
        actor: 'writer-B',
        event_id: 'e-done',
        kind: 'status',
        payload: { to: 'done', closed_at: '2026-05-01T00:00:00.000Z' },
      }),
    ];
    // lowest (seq,actor) terminal = (5, writer-A) = abandoned
    expect(reduceWorkItem(record, events).status).toBe('abandoned');
  });

  test('dedupes by event_id (a repeated event folds once)', () => {
    const record = mkRecord();
    const pass = mkEvent({
      seq: 1,
      event_id: 'e-dup',
      kind: 'verdict',
      payload: { criterion_id: 'ac-1', verdict: 'pass', evidence: [] },
    });
    const created = mkEvent({ seq: 0, event_id: 'e0', kind: 'status', payload: { to: 'draft' } });
    const once = reduceWorkItem(record, [created, pass]);
    const twice = reduceWorkItem(record, [created, pass, pass]); // same event_id twice
    expect(twice).toEqual(once);
    expect(twice.acceptance_criteria[0]?.verdict).toBe('pass');
  });

  test('reopen CLEARS closed_at via the fold (not a merge that resurrects it)', () => {
    const record = mkRecord();
    const events = [
      mkEvent({ seq: 0, event_id: 'e0', kind: 'status', payload: { to: 'draft' } }),
      mkEvent({ seq: 1, event_id: 'e1', kind: 'status', payload: { to: 'in_progress' } }),
      mkEvent({
        seq: 2,
        event_id: 'e-done',
        kind: 'status',
        payload: { to: 'done', closed_at: '2026-06-01T00:00:00.000Z' },
      }),
      // reopen: a later non-terminal status event whose closed_at is null CLEARS it
      mkEvent({
        seq: 3,
        event_id: 'e-reopen',
        kind: 'status',
        payload: { to: 'in_progress', closed_at: null },
      }),
    ];
    const reduced = reduceWorkItem(record, events);
    expect(reduced.status).toBe('in_progress');
    expect(reduced.closed_at).toBeUndefined();
  });

  test('folds github idempotency markers as a set-union; claim_release removes', () => {
    const record = mkRecord({
      github_issue: { repo: 'o/r', number: 7 },
    });
    const events = [
      mkEvent({ seq: 0, event_id: 'e0', kind: 'status', payload: { to: 'draft' } }),
      mkEvent({
        seq: 1,
        event_id: 'e-post1',
        kind: 'github_post',
        payload: { posted_decision_id: 'dec-1' },
      }),
      mkEvent({
        seq: 2,
        event_id: 'e-post2',
        kind: 'github_post',
        payload: { posted_decision_id: 'dec-2' },
      }),
      mkEvent({
        seq: 3,
        event_id: 'e-claim',
        kind: 'claim',
        payload: { claimed_branch: 'ditto/wi', posted_claim_marker: 'claim:ditto/wi' },
      }),
      mkEvent({
        seq: 4,
        event_id: 'e-rel',
        kind: 'claim_release',
        payload: { claimed_branch: 'ditto/wi', posted_claim_marker: 'claim:ditto/wi' },
      }),
    ];
    const reduced = reduceWorkItem(record, events);
    expect(reduced.github_issue?.posted_decision_ids?.sort()).toEqual(['dec-1', 'dec-2']);
    // claim then claim_release → marker removed, branch cleared
    expect(reduced.github_issue?.posted_claim_markers ?? []).toEqual([]);
    expect(reduced.github_issue?.claimed_branch).toBeUndefined();
  });
});

describe('WorkItemStore committed record + events (wi_2607069bk §1.1)', () => {
  test('create writes record.json + a created status event, and NO evidence/ dir (A2)', async () => {
    const created = await store.create(sampleInput());
    // committed base: record.json exists
    const recordPath = join(committedWorkItemDir(workDir, created.id), 'record.json');
    expect(await Bun.file(recordPath).exists()).toBe(true);
    // committed base: exactly one created status event
    const eventsDir = join(committedWorkItemDir(workDir, created.id), 'events');
    const eventFiles = (await readdir(eventsDir)).filter((n) => n.endsWith('.json'));
    expect(eventFiles.length).toBe(1);
    const ev = workItemEvent.parse(
      JSON.parse(await Bun.file(join(eventsDir, eventFiles[0] ?? '')).text()),
    );
    expect(ev.kind).toBe('status');
    if (ev.kind === 'status') expect(ev.payload.to).toBe('draft');
    // §3.2 A2: eager evidence/ scaffolding is removed — it must NOT exist at create
    const evidenceDir = join(workDir, '.ditto', 'local', 'work-items', created.id, 'evidence');
    let evidenceExists = true;
    try {
      await stat(evidenceDir);
    } catch {
      evidenceExists = false;
    }
    expect(evidenceExists).toBe(false);
  });

  test('get() folds record + events (round-trips create/update/close)', async () => {
    const created = await store.create(sampleInput());
    expect((await store.get(created.id)).status).toBe('draft');
    // update an authored field
    await store.update(created.id, (cur) => ({ ...cur, title: 'renamed' }));
    expect((await store.get(created.id)).title).toBe('renamed');
    // close → terminal via the event log
    await store.close(created.id, 'done');
    const done = await store.get(created.id);
    expect(done.status).toBe('done');
    expect(done.closed_at).toBeDefined();
  });

  test('reopen clears closed_at end-to-end through the event store', async () => {
    const created = await store.create(sampleInput());
    await store.close(created.id, 'done');
    const reopened = await store.reopen(created.id);
    expect(reopened.status).toBe('in_progress');
    expect(reopened.closed_at).toBeUndefined();
    expect((await store.get(created.id)).closed_at).toBeUndefined();
  });

  test('append is idempotent: re-emitting the same verdict does not add a 2nd event', async () => {
    const created = await store.create(sampleInput());
    const setPass = (cur: WorkItem): WorkItem => ({
      ...cur,
      acceptance_criteria: cur.acceptance_criteria.map((c) =>
        c.id === 'ac-1' ? { ...c, verdict: 'pass' as const } : c,
      ),
    });
    await store.update(created.id, setPass);
    const eventsDir = join(committedWorkItemDir(workDir, created.id), 'events');
    const afterFirst = (await readdir(eventsDir)).filter((n) => n.endsWith('.json')).length;
    // re-apply the SAME verdict (same content) → same event_id → no new file
    await store.update(created.id, setPass);
    const afterSecond = (await readdir(eventsDir)).filter((n) => n.endsWith('.json')).length;
    expect(afterSecond).toBe(afterFirst);
    expect((await store.get(created.id)).acceptance_criteria[0]?.verdict).toBe('pass');
  });

  test('commit-last: a done transition is ONE atomic append with verdicts already present', async () => {
    const created = await store.create(sampleInput());
    // verdicts committed FIRST (during the run), as separate verdict events
    await store.update(created.id, (cur) => ({
      ...cur,
      acceptance_criteria: cur.acceptance_criteria.map((c) =>
        c.id === 'ac-1' ? { ...c, verdict: 'pass' as const } : c,
      ),
    }));
    const eventsDir = join(committedWorkItemDir(workDir, created.id), 'events');
    const beforeClose = (await readdir(eventsDir)).filter((n) => n.endsWith('.json')).length;
    // close → done: exactly ONE new event (the terminal status), not N+1
    await store.close(created.id, 'done');
    const afterClose = (await readdir(eventsDir)).filter((n) => n.endsWith('.json')).length;
    expect(afterClose).toBe(beforeClose + 1);
    const done = await store.get(created.id);
    expect(done.status).toBe('done');
    expect(done.acceptance_criteria[0]?.verdict).toBe('pass');
  });

  test('R6: a corrupt event file SURFACES (throws) rather than reviving a stale status', async () => {
    const created = await store.create(sampleInput());
    await store.close(created.id, 'done');
    // baseline: get() reads the terminal
    expect((await store.get(created.id)).status).toBe('done');
    // corrupt the terminal event file: a silently-dropped terminal would revive
    // the pre-terminal (draft) status — that is the regression R6 forbids.
    const eventsDir = join(committedWorkItemDir(workDir, created.id), 'events');
    const files = (await readdir(eventsDir)).filter((n) => n.endsWith('.json'));
    // corrupt EVERY event file so the fold cannot fall back to a partial view
    for (const f of files) {
      await writeFile(join(eventsDir, f), '{ this is not valid json', 'utf8');
    }
    await expect(store.get(created.id)).rejects.toThrow(WorkItemEventCorruptError);
  });
});
