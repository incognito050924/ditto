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
  test('write persists handoff.json and links work item handoff_path', async () => {
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
    expect(reloaded.handoff_path).toBe(`.ditto/work-items/${wi.id}/handoff.json`);
  });
});
