import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HandoffStore, buildHandoff } from '~/core/handoff-store';
import { WorkItemStore } from '~/core/work-item-store';

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
