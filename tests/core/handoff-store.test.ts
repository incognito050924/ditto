import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
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
