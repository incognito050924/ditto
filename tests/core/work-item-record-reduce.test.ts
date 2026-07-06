import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assembleCompletionFromWorkItem,
  buildCompletion,
  mirrorAcceptanceVerdicts,
} from '~/core/completion-store';
import { committedWorkItemDir, localDir } from '~/core/ditto-paths';
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

// wi_2607069bk WS0-T0 n3 — dual-tier backward compatibility (design §5, §6, §2.2,
// §3.3). A "legacy" WI has ONLY .ditto/local/work-items/<id>/work-item.json — no
// committed record.json / events/. Directly materialize one on disk.
function legacyLiteral(id: string, extra: Record<string, unknown> = {}) {
  return {
    schema_version: '0.1.0',
    id,
    title: 'legacy title',
    source_request: 'the legacy request',
    goal: 'the legacy observable outcome',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'first observable behavior', verdict: 'unverified', evidence: [] },
      { id: 'ac-2', statement: 'second observable behavior', verdict: 'unverified', evidence: [] },
    ],
    status: 'in_progress',
    owner_profile: 'workspace-write',
    child_ids: [],
    changed_files: [],
    risks: [],
    runs: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

async function writeLegacy(id: string, extra: Record<string, unknown> = {}): Promise<void> {
  const dir = localDir(workDir, 'work-items', id);
  await mkdir(dir, { recursive: true });
  const parsed = workItem.parse(legacyLiteral(id, extra));
  await writeFile(join(dir, 'work-item.json'), `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

describe('n3 forced lazy-migrate on first write of a legacy WI (§6, Finding B-F2)', () => {
  test('first update() synthesizes a COMPLETE record.json (+created event) then applies the patch', async () => {
    const id = 'wi_legacy001';
    await writeLegacy(id, { follows: 'wi_pred00001' });
    // no committed Record yet
    expect(await Bun.file(join(committedWorkItemDir(workDir, id), 'record.json')).exists()).toBe(
      false,
    );

    // first write: grade ac-1 pass (a verdict patch, no status change)
    await store.update(id, (cur) => ({
      ...cur,
      acceptance_criteria: cur.acceptance_criteria.map((c) =>
        c.id === 'ac-1' ? { ...c, verdict: 'pass' as const } : c,
      ),
    }));

    // a COMPLETE record.json now exists — every authored field survived (title,
    // goal, ALL acceptance criteria, lineage), so a later workItem.parse cannot
    // throw on a missing required field.
    const recordPath = join(committedWorkItemDir(workDir, id), 'record.json');
    expect(await Bun.file(recordPath).exists()).toBe(true);
    const record = workItem.parse(JSON.parse(await Bun.file(recordPath).text()));
    expect(record.title).toBe('legacy title');
    expect(record.goal).toBe('the legacy observable outcome');
    expect(record.acceptance_criteria.map((c) => c.id)).toEqual(['ac-1', 'ac-2']);
    expect(record.follows).toBe('wi_pred00001');

    // events/: a `created` status event (capturing the legacy status) is present so
    // the fold reproduces the pre-migration status; the verdict patch is a 2nd event.
    const eventsDir = join(committedWorkItemDir(workDir, id), 'events');
    const events = (await readdir(eventsDir)).filter((n) => n.endsWith('.json'));
    expect(events.length).toBeGreaterThanOrEqual(2);

    // the patch applied on top: ac-1 pass, status still in_progress, lineage intact
    const got = await store.get(id);
    expect(got.status).toBe('in_progress');
    expect(got.acceptance_criteria.find((c) => c.id === 'ac-1')?.verdict).toBe('pass');
    expect(got.title).toBe('legacy title');
    expect(got.follows).toBe('wi_pred00001');
  });
});

describe('n3 dual-base exists/list (§5, §6 Finding B-F3)', () => {
  test('exists() sees a committed-only AND a legacy-only WI', async () => {
    // committed-only: create then delete the personal mirror
    const committed = await store.create(sampleInput());
    await rm(localDir(workDir, 'work-items', committed.id), { recursive: true, force: true });
    // legacy-only: only work-item.json, no committed record
    await writeLegacy('wi_legacy002');

    expect(await store.exists(committed.id)).toBe(true);
    expect(await store.exists('wi_legacy002')).toBe(true);
    expect(await store.exists('wi_nonexistent9')).toBe(false);
  });

  test('list() aggregates both cohorts and dedups a WI present in both bases (committed wins)', async () => {
    // present in BOTH bases (create writes committed + mirror)
    const both = await store.create({ ...sampleInput(), title: 'in-both' });
    // committed-only
    const committedOnly = await store.create({ ...sampleInput(), title: 'committed-only' });
    await rm(localDir(workDir, 'work-items', committedOnly.id), { recursive: true, force: true });
    // legacy-only
    await writeLegacy('wi_legacy003');

    const ids = (await store.list()).map((s) => s.id).sort();
    expect(ids).toEqual([both.id, committedOnly.id, 'wi_legacy003'].sort());
    // dedup: the WI in both bases appears exactly once
    expect(ids.filter((i) => i === both.id).length).toBe(1);
  });
});

describe('n3 archive dual-base + Record durability (§3.3 D2)', () => {
  test('archive finds a legacy-only terminal WI via the dual base and moves it out of list()', async () => {
    await writeLegacy('wi_legacy004', { status: 'done', closed_at: '2026-02-01T00:00:00.000Z' });
    const moved = await store.archive('2026-Q1');
    expect(moved).toContain('wi_legacy004');
    // left the active list
    expect((await store.list()).map((s) => s.id)).not.toContain('wi_legacy004');
    // move-not-delete: personal dir relocated under archive/<label>
    const archived = join(
      workDir,
      '.ditto',
      'local',
      'archive',
      '2026-Q1',
      'wi_legacy004',
      'work-item.json',
    );
    expect(await Bun.file(archived).exists()).toBe(true);
  });

  test('archive keeps the committed Record restorable (git-tracked move, not delete)', async () => {
    const a = await store.create({ ...sampleInput(), title: 'to-archive' });
    await store.close(a.id, 'done');
    await store.archive('2026-Q3');
    // committed Record left the ACTIVE committed base ...
    expect(await Bun.file(join(committedWorkItemDir(workDir, a.id), 'record.json')).exists()).toBe(
      false,
    );
    // ... but is preserved (restorable) under the committed archive namespace
    const preserved = join(workDir, '.ditto', 'work-items-archive', '2026-Q3', a.id, 'record.json');
    expect(await Bun.file(preserved).exists()).toBe(true);
  });
});

describe('n3 reconcile enumerates/counts/surfaces unparseable events (§2.2, R6)', () => {
  test('reconcile re-derives head from events for a healthy WI (0 unparseable)', async () => {
    const created = await store.create(sampleInput());
    await store.close(created.id, 'done');
    const report = await store.reconcile(created.id);
    expect(report.head_status).toBe('done');
    expect(report.head_closed_at).toBeDefined();
    expect(report.unparseable_events).toEqual([]);
    expect(report.event_count).toBeGreaterThanOrEqual(2);
  });

  test('reconcile SURFACES (enumerates+counts) corrupt event files without throwing', async () => {
    const created = await store.create(sampleInput());
    await store.close(created.id, 'done');
    const eventsDir = join(committedWorkItemDir(workDir, created.id), 'events');
    const files = (await readdir(eventsDir)).filter((n) => n.endsWith('.json'));
    // corrupt exactly one event file
    const corruptName = files.sort()[0] ?? '';
    await writeFile(join(eventsDir, corruptName), '{ not json', 'utf8');
    // surface-don't-mutate: reconcile does NOT throw; it reports the corrupt path
    const report = await store.reconcile(created.id);
    expect(report.unparseable_events.length).toBe(1);
    expect(report.unparseable_events[0]).toContain(corruptName);
  });
});

// wi_2607069bk WS0-T0 n6 (§4-C5, ac-7) — github idempotency lives in COMMITTED
// events, not on record.json. A decision posted via the event API survives a Run-tier
// (local mirror) delete, a re-post is deduped, and record.json keeps ONLY the immutable
// coordinates even after a subsequent authored write.
describe('C5 github idempotency = committed events (ac-7)', () => {
  async function readCommittedRecord(id: string): Promise<WorkItem> {
    const raw = await readFile(join(committedWorkItemDir(workDir, id), 'record.json'), 'utf8');
    return workItem.parse(JSON.parse(raw));
  }

  test('Run-delete-then-repost = 0 duplicate; Record keeps only immutable coords', async () => {
    const created = await store.create(sampleInput());
    // Link the issue (immutable coords) via an authored update.
    await store.update(created.id, (cur) => ({
      ...cur,
      github_issue: { repo: 'owner/app', number: 7 },
    }));

    // Post a decision as a COMMITTED github_post event (not a record.json mutation).
    await store.recordGithubPost(created.id, { posted_decision_id: 'dec-1' });

    // A LATER authored write (title change) must NOT bake the folded idempotency set
    // back onto record.json — the Record keeps only immutable coords.
    await store.update(created.id, (cur) => ({ ...cur, title: 'renamed' }));
    const recAfterUpdate = await readCommittedRecord(created.id);
    expect(recAfterUpdate.github_issue).toEqual({ repo: 'owner/app', number: 7 });
    expect(recAfterUpdate.github_issue?.posted_decision_ids).toBeUndefined();

    // get() folds the committed event → the posted id is visible.
    const folded1 = await store.get(created.id);
    expect(folded1.github_issue?.posted_decision_ids).toEqual(['dec-1']);

    // DELETE the Run tier (personal mirror dir). The committed Record + events survive.
    await rm(localDir(workDir, 'work-items', created.id), { recursive: true, force: true });

    // The dedup state SURVIVES the Run delete — folded from the committed event.
    const afterDelete = await store.get(created.id);
    expect(afterDelete.github_issue?.posted_decision_ids).toEqual(['dec-1']);

    // A RE-POST of the same decision is deduped: folded set size stays 1 (no duplicate).
    await store.recordGithubPost(created.id, { posted_decision_id: 'dec-1' });
    const afterRepost = await store.get(created.id);
    expect(afterRepost.github_issue?.posted_decision_ids).toEqual(['dec-1']);
  });

  test('claim then claim_release folds branch/marker and clears on release', async () => {
    const created = await store.create(sampleInput());
    await store.update(created.id, (cur) => ({
      ...cur,
      github_issue: { repo: 'owner/app', number: 9 },
    }));
    await store.recordClaim(created.id, {
      claimed_branch: 'feature/x',
      posted_claim_marker: 'claim:feature/x',
    });
    const claimed = await store.get(created.id);
    expect(claimed.github_issue?.claimed_branch).toBe('feature/x');
    expect(claimed.github_issue?.posted_claim_markers).toEqual(['claim:feature/x']);

    await store.releaseClaim(created.id, {
      claimed_branch: 'feature/x',
      posted_claim_marker: 'claim:feature/x',
    });
    const released = await store.get(created.id);
    expect(released.github_issue?.claimed_branch).toBeUndefined();
    expect(released.github_issue?.posted_claim_markers).toBeUndefined();
    // Record.json still carries only the immutable coords.
    const rec = await readCommittedRecord(created.id);
    expect(rec.github_issue).toEqual({ repo: 'owner/app', number: 9 });
  });
});

// wi_2607069bk WS0-T0 n7 (ac-2) — the CAPSTONE durability proof for the whole
// Record/Run split: deleting the disposable Run dir `.ditto/local/work-items/<id>/`
// loses NOTHING. status, every AC verdict+evidence, and the github idempotency set
// are ALL re-derived from the committed Record (record.json + events/), and
// completion.json regenerates losslessly from the reduced WI via
// assembleCompletionFromWorkItem. Ties together n2 (status/verdict events + reduce),
// n4 (committed base), n6 (github events). The mirror (autopilot.ts:465 / work.ts:1984)
// persists verdicts via the EVENT-emitting update() path, so a re-mirror of the same
// verdicts is diff-gated to 0 duplicate events.
describe('ac-2 capstone: Record survives Run deletion (status+verdict+github lossless)', () => {
  function twoAcInput() {
    return {
      title: 'capstone',
      source_request: '사용자 요청 원문',
      goal: '관측 가능한 목표 한 문장',
      acceptance_criteria: [
        {
          id: 'ac-1',
          statement: '첫 번째 관찰 가능한 조건',
          verdict: 'unverified' as const,
          evidence: [],
        },
        {
          id: 'ac-2',
          statement: '두 번째 관찰 가능한 조건',
          verdict: 'unverified' as const,
          evidence: [],
        },
      ],
    };
  }

  const countEventFiles = async (id: string): Promise<number> =>
    (await readdir(join(committedWorkItemDir(workDir, id), 'events'))).filter((n) =>
      n.endsWith('.json'),
    ).length;

  test('after deleting the Run dir, get() reproduces status+verdict+github from the committed Record; completion regenerates; re-mirror adds 0 duplicate verdict events', async () => {
    // 1. create + link a github issue (immutable coords, authored on record.json)
    const created = await store.create(twoAcInput());
    await store.update(created.id, (cur) => ({
      ...cur,
      status: 'in_progress' as const,
      github_issue: { repo: 'owner/app', number: 42 },
    }));

    // 2. mirror the completion's derived per-AC verdicts+evidence back onto the WI —
    //    THIS is the autopilot.ts:465 / work.ts:1984 call-site path: update(cur =>
    //    mirrorAcceptanceVerdicts(cur, completion)) → emits one verdict event per AC.
    const inProgress = await store.get(created.id);
    const completion = buildCompletion({
      workItem: inProgress,
      declaredBy: 'implementer',
      summary: '모든 기준 검증됨',
      verdicts: [
        {
          criterion_id: 'ac-1',
          verdict: 'pass',
          evidence: [{ kind: 'command', command: 'bun test ac-1', summary: 'green' }],
        },
        {
          criterion_id: 'ac-2',
          verdict: 'pass',
          evidence: [{ kind: 'command', command: 'bun test ac-2', summary: 'green' }],
        },
      ],
    });
    expect(completion.final_verdict).toBe('pass');
    await store.update(created.id, (cur) => mirrorAcceptanceVerdicts(cur, completion));

    // 3. record a github decision post as a COMMITTED github event (n6 API)
    await store.recordGithubPost(created.id, { posted_decision_id: 'dec-1' });

    // 4. drive to a terminal status (done + closed_at) — a status event
    await store.close(created.id, 'done');

    // sanity BEFORE deletion: the folded view carries everything
    const beforeDelete = await store.get(created.id);
    expect(beforeDelete.status).toBe('done');
    expect(beforeDelete.acceptance_criteria.map((c) => c.verdict)).toEqual(['pass', 'pass']);
    expect(beforeDelete.github_issue?.posted_decision_ids).toEqual(['dec-1']);
    const eventsBeforeDelete = await countEventFiles(created.id);

    // 5. DELETE the disposable Run dir. The committed Record (.ditto/work-items/<id>/)
    //    is a SIBLING namespace and survives; only the personal mirror + completion.json
    //    (which lives under the Run dir) are destroyed.
    const runDir = localDir(workDir, 'work-items', created.id);
    expect(await Bun.file(join(runDir, 'work-item.json')).exists()).toBe(true);
    await rm(runDir, { recursive: true, force: true });
    expect(await Bun.file(join(runDir, 'work-item.json')).exists()).toBe(false);

    // 6. get() STILL reproduces EVERYTHING from the committed Record alone:
    const survivor = await store.get(created.id);
    //    (a) terminal status + closed_at
    expect(survivor.status).toBe('done');
    expect(survivor.closed_at).toBeDefined();
    //    (b) every AC verdict + its evidence
    const ac1 = survivor.acceptance_criteria.find((c) => c.id === 'ac-1');
    const ac2 = survivor.acceptance_criteria.find((c) => c.id === 'ac-2');
    expect(ac1?.verdict).toBe('pass');
    expect(ac1?.evidence).toEqual([
      { kind: 'command', command: 'bun test ac-1', summary: 'green' },
    ]);
    expect(ac2?.verdict).toBe('pass');
    expect(ac2?.evidence).toEqual([
      { kind: 'command', command: 'bun test ac-2', summary: 'green' },
    ]);
    //    (c) the github idempotency set
    expect(survivor.github_issue?.repo).toBe('owner/app');
    expect(survivor.github_issue?.number).toBe(42);
    expect(survivor.github_issue?.posted_decision_ids).toEqual(['dec-1']);

    // 7. completion.json (destroyed with the Run dir) REGENERATES losslessly from the
    //    reduced WI — assembleCompletionFromWorkItem is the forward projection.
    const regen = assembleCompletionFromWorkItem(survivor, {
      declaredBy: 'implementer',
      summary: '모든 기준 검증됨',
    });
    expect(regen.final_verdict).toBe('pass');
    expect(regen.acceptance.map((a) => ({ id: a.criterion_id, v: a.verdict }))).toEqual([
      { id: 'ac-1', v: 'pass' },
      { id: 'ac-2', v: 'pass' },
    ]);
    expect(regen.acceptance.find((a) => a.criterion_id === 'ac-1')?.evidence).toEqual([
      { kind: 'command', command: 'bun test ac-1', summary: 'green' },
    ]);

    // 8. a RE-MIRROR of the SAME verdicts adds 0 duplicate verdict events (diff-gated
    //    emission in emitTransitionEvents: before.verdict===after && evidence equal).
    await store.update(created.id, (cur) => mirrorAcceptanceVerdicts(cur, completion));
    const eventsAfterReMirror = await countEventFiles(created.id);
    expect(eventsAfterReMirror).toBe(eventsBeforeDelete);
    // and the folded view is unchanged
    const afterReMirror = await store.get(created.id);
    expect(afterReMirror.acceptance_criteria.map((c) => c.verdict)).toEqual(['pass', 'pass']);
    expect(afterReMirror.status).toBe('done');
    expect(afterReMirror.github_issue?.posted_decision_ids).toEqual(['dec-1']);
  });
});
