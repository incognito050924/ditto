import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { utimesSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HandoffStore, buildHandoff } from '~/core/handoff-store';
import { WorkItemStore } from '~/core/work-item-store';
import { handoff as handoffSchema } from '~/schemas/handoff';

let repo: string;
async function workItem() {
  return new WorkItemStore(repo).create({
    title: 'pw',
    source_request: 'add a password strength endpoint',
    goal: 'g',
    acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
  });
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-ho-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('buildHandoff', () => {
  test('assembles a schema-valid handoff from work item state', async () => {
    const wi = await workItem();
    const h = buildHandoff({
      workItem: wi,
      fromContext: 'session X at 60%',
      currentState: 'implement done',
      nextFirstCheck: 'run bun test',
      autopilotId: 'orch_handoff01',
      evidenceRefs: [{ kind: 'command', command: 'bun test', summary: '2 passed' }],
    });
    expect(h.work_item_id).toBe(wi.id);
    expect(h.original_intent).toBe('add a password strength endpoint');
    expect(h.autopilot_id).toBe('orch_handoff01');
    expect(h.evidence_refs).toHaveLength(1);
  });
});

describe('HandoffStore', () => {
  test('write persists an active handoff (.ditto/local/handoff/) and links work item handoff_path', async () => {
    const wi = await workItem();
    const h = buildHandoff({
      workItem: wi,
      fromContext: 'ctx',
      currentState: 'midway',
      nextFirstCheck: 'check X',
    });
    const store = new HandoffStore(repo);
    await store.write(h);
    expect(await store.exists(wi.id)).toBe(true);
    expect((await store.get(wi.id)).current_state).toBe('midway');
    const reloaded = await new WorkItemStore(repo).get(wi.id);
    expect(reloaded.handoff_path).toBe(`.ditto/local/handoff/${wi.id}.md`);
  });

  // wi_260626r3f ac-1: per-work-item scoped pickup so a concurrent worktree
  // session (sharing the main .ditto/local) never steals a sibling's handoff.
  test('getActive returns the active handoff body or null', async () => {
    const wi = await workItem();
    const store = new HandoffStore(repo);
    expect(await store.getActive(wi.id)).toBeNull();
    await store.write(
      buildHandoff({ workItem: wi, fromContext: 'c', currentState: 'mid', nextFirstCheck: 'c' }),
    );
    const got = await store.getActive(wi.id);
    expect(got?.handoff.work_item_id).toBe(wi.id);
    expect(got?.body).toContain('mid');
  });

  test('consumeFor archives only the named work item, leaving siblings active', async () => {
    const a = await workItem();
    const b = await new WorkItemStore(repo).create({
      title: 'pw2',
      source_request: 'r2',
      goal: 'g2',
      acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
    });
    const store = new HandoffStore(repo);
    await store.write(
      buildHandoff({ workItem: a, fromContext: 'c', currentState: 'a-state', nextFirstCheck: 'c' }),
    );
    await store.write(
      buildHandoff({ workItem: b, fromContext: 'c', currentState: 'b-state', nextFirstCheck: 'c' }),
    );
    const consumed = await store.consumeFor(a.id);
    expect(consumed?.handoff.work_item_id).toBe(a.id);
    expect(consumed?.body).toContain('a-state');
    expect(await store.exists(a.id)).toBe(false); // archived
    expect(await store.exists(b.id)).toBe(true); // sibling untouched
    expect(await store.consumeFor(a.id)).toBeNull(); // idempotent: nothing left
  });

  // wi_2606289nt: stale active sweep — an active handoff no session ever picked
  // up, once older than the retention limit, is MOVED into archive (never deleted)
  // so it can never re-inject into an unrelated session's context.
  const DAY = 24 * 60 * 60 * 1000;
  async function writeAged(workItemId: string, currentState: string, createdAt: Date) {
    const items = new WorkItemStore(repo);
    const wi = await items.create({
      title: workItemId,
      source_request: `r-${workItemId}`,
      goal: 'g',
      acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
    });
    const store = new HandoffStore(repo);
    await store.write(
      buildHandoff({
        workItem: wi,
        fromContext: 'c',
        currentState,
        nextFirstCheck: 'c',
        now: createdAt,
      }),
    );
    // WS-HND-T1: the stale sweep is content-blind — it keys staleness on the
    // filesystem mtime, not the parsed created_at. Age the file itself so the
    // written handoff is genuinely old on disk (createdAt alone is not enough).
    utimesSync(join(repo, `.ditto/local/handoff/${wi.id}.md`), createdAt, createdAt);
    return wi;
  }

  test('ac-1: sweepStaleActive moves an age>7d active to archive, keeps a recent (<7d) active', async () => {
    const now = new Date('2026-06-29T00:00:00.000Z');
    const stale = await writeAged('stale', 'old-marker', new Date(now.getTime() - 8 * DAY));
    const recent = await writeAged('recent', 'fresh-marker', new Date(now.getTime() - 1 * DAY));
    const store = new HandoffStore(repo);

    const swept = await store.sweepStaleActive(now);

    expect(swept.map((s) => s.handoff?.work_item_id)).toEqual([stale.id]);
    // move-not-delete: stale gone from active, recent still active
    expect(await store.exists(stale.id)).toBe(false);
    expect(await store.exists(recent.id)).toBe(true);
    // and it lives in archive/ (moved, not deleted)
    const archived = await readdir(join(repo, '.ditto/local/handoff/archive'));
    expect(archived.some((n) => n.startsWith(`${stale.id}__`))).toBe(true);
  });

  test('ac-1 boundary: an active exactly at the limit (not strictly older) stays active', async () => {
    const now = new Date('2026-06-29T00:00:00.000Z');
    const edge = await writeAged('edge', 'edge-marker', new Date(now.getTime() - 7 * DAY));
    const store = new HandoffStore(repo);
    const swept = await store.sweepStaleActive(now);
    expect(swept).toHaveLength(0);
    expect(await store.exists(edge.id)).toBe(true);
  });

  // WS-HND-T1 (wi_2607065tn): content-blind stale sweep. A malformed / non-WI
  // handoff file (parse-fails, no work_item_id, no created_at) must ALSO retire
  // by age — otherwise a hand-authored file (e.g. the real lingering
  // session_260622_risks_processed.md) stays active forever and re-injects into
  // unrelated sessions. Age is decided by the filesystem mtime, not the parsed
  // created_at, so a file that never parses is still sweepable.
  async function writeRawActive(basename: string, body: string, mtime: Date): Promise<string> {
    const dir = join(repo, '.ditto/local/handoff');
    await mkdir(dir, { recursive: true });
    const path = join(dir, basename);
    await writeFile(path, body);
    utimesSync(path, mtime, mtime);
    return path;
  }

  test('ac-1 content-blind: a malformed active file older than 7d (by mtime) is swept to archive', async () => {
    const now = new Date('2026-07-06T00:00:00.000Z');
    // reproduces the real lingering file: hand-authored, no frontmatter → parse-fails
    const path = await writeRawActive(
      'session_260622_risks_processed.md',
      '# risks processed\n\nhand-authored notes, no JSON frontmatter, not a work item.\n',
      new Date(now.getTime() - 8 * DAY),
    );
    const store = new HandoffStore(repo);

    const swept = await store.sweepStaleActive(now);

    // move-not-delete: gone from active/, present under archive/
    expect(await Bun.file(path).exists()).toBe(false);
    const archived = await readdir(join(repo, '.ditto/local/handoff/archive'));
    expect(archived.some((n) => n.startsWith('session_260622_risks_processed__'))).toBe(true);
    // reported as swept even though it never parsed (handoff === null, no work item)
    expect(swept).toHaveLength(1);
    expect(swept[0]?.handoff).toBeNull();
  });

  test('ac-2 content-blind: a malformed active file within 7d (by mtime) is preserved', async () => {
    const now = new Date('2026-07-06T00:00:00.000Z');
    const path = await writeRawActive(
      'session_recent_notes.md',
      'not a handoff: no frontmatter, freshly written\n',
      new Date(now.getTime() - 1 * DAY),
    );
    const store = new HandoffStore(repo);

    const swept = await store.sweepStaleActive(now);

    // recent → safe-preserve (still active, not moved)
    expect(swept).toHaveLength(0);
    expect(await Bun.file(path).exists()).toBe(true);
  });

  // ac-3: context non-injection invariant. After sweep the handoff is in archive/,
  // which listActive() excludes → it can never be injected into any session again.
  test('ac-3: a swept handoff is excluded from listActive (never re-injectable)', async () => {
    const now = new Date('2026-06-29T00:00:00.000Z');
    await writeAged('ghost', 'ghost-marker', new Date(now.getTime() - 30 * DAY));
    const store = new HandoffStore(repo);
    expect(await store.listActive()).toHaveLength(1);
    await store.sweepStaleActive(now);
    expect(await store.listActive()).toHaveLength(0);
  });

  // ac-5: fail-open at store level — a rename failure leaves the file active and
  // does not throw (mirror consume()'s best-effort try/catch).
  test('ac-5: a rename failure leaves the stale file active and does not throw', async () => {
    const now = new Date('2026-06-29T00:00:00.000Z');
    const stale = await writeAged('stuck', 'stuck-marker', new Date(now.getTime() - 30 * DAY));
    const store = new HandoffStore(repo);
    const spy = spyOn(fsp, 'rename').mockRejectedValue(new Error('boom'));
    try {
      const swept = await store.sweepStaleActive(now);
      expect(swept).toHaveLength(0); // nothing successfully swept
    } finally {
      spy.mockRestore();
    }
    expect(await store.exists(stale.id)).toBe(true); // still active, not lost
  });

  test('consume moves active handoffs to archive (picked up once, no accumulation)', async () => {
    const wi = await workItem();
    const store = new HandoffStore(repo);
    await store.write(
      buildHandoff({ workItem: wi, fromContext: 'ctx', currentState: 's', nextFirstCheck: 'c' }),
    );
    const active = await store.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]?.body).toContain('# Handoff');
    const consumed = await store.consume();
    expect(consumed).toHaveLength(1);
    // active is now empty — a second turn picks up nothing.
    expect(await store.listActive()).toHaveLength(0);
    expect(await store.exists(wi.id)).toBe(false);
  });
});

// ac-6 (wi_260627jhh): critical_decisions + irreversible_risks as SEPARATE
// structural fields, additive (old-format handoff still parses).
describe('handoff critical_decisions / irreversible_risks (ac-6)', () => {
  test('backward-compat: an old-shape handoff (neither new field) still parses, no drop, new fields default []', () => {
    // A serialized OLD handoff — predates the two new fields entirely.
    const old = {
      schema_version: '0.1.0',
      work_item_id: 'wi_oldshape0',
      from_context: 'old session',
      original_intent: 'do the thing',
      current_state: 'midway',
      decisions_made: ['kept this decision'],
      changed_files: ['src/a.ts'],
      evidence_refs: [],
      failed_or_unverified: [],
      open_threads: [],
      next_first_check: 'run tests',
      forbidden_scope_creep: [],
      created_at: '2026-06-27T00:00:00.000Z',
    };
    const parsed = handoffSchema.parse(old);
    // No silent drop of existing fields.
    expect(parsed.decisions_made).toEqual(['kept this decision']);
    expect(parsed.changed_files).toEqual(['src/a.ts']);
    // New fields default to [].
    expect(parsed.critical_decisions).toEqual([]);
    expect(parsed.irreversible_risks).toEqual([]);
  });

  test('new fields round-trip as DISTINCT fields (not folded into decisions_made)', async () => {
    const wi = await workItem();
    const h = buildHandoff({
      workItem: wi,
      fromContext: 'c',
      currentState: 's',
      nextFirstCheck: 'c',
      decisionsMade: ['ordinary decision'],
      criticalDecisions: [{ decision: 'chose option B', rationale: 'A is irreversible' }],
      irreversibleRisks: [{ risk: 'dropped column', why_irreversible: 'data is unrecoverable' }],
    });
    const store = new HandoffStore(repo);
    await store.write(h);
    const reloaded = await store.get(wi.id);
    // distinct field, survives serialize → parse round-trip
    expect(reloaded.critical_decisions).toEqual([
      { decision: 'chose option B', rationale: 'A is irreversible' },
    ]);
    expect(reloaded.irreversible_risks).toEqual([
      { risk: 'dropped column', why_irreversible: 'data is unrecoverable' },
    ]);
    // not folded into decisions_made
    expect(reloaded.decisions_made).toEqual(['ordinary decision']);
    expect(JSON.stringify(reloaded.decisions_made)).not.toContain('chose option B');
  });

  test('decisions_made is unchanged (no rename regression)', async () => {
    const wi = await workItem();
    const h = buildHandoff({
      workItem: wi,
      fromContext: 'c',
      currentState: 's',
      nextFirstCheck: 'c',
      decisionsMade: ['still here'],
    });
    expect(h.decisions_made).toEqual(['still here']);
  });

  test('tier rule: an irreversible-risk substance is preserved inline (not pointer-only)', async () => {
    const wi = await workItem();
    const substance = 'production data deleted; no backup exists for the affected rows';
    const h = buildHandoff({
      workItem: wi,
      fromContext: 'c',
      currentState: 's',
      nextFirstCheck: 'c',
      irreversibleRisks: [{ risk: 'destructive migration', why_irreversible: substance }],
    });
    // substance is carried in-band, not replaced by a re-fetch pointer
    expect(h.irreversible_risks[0]?.why_irreversible).toBe(substance);
  });
});
