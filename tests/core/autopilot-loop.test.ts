import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInitialNodes } from '~/core/autopilot-graph';
import { nextNode, recordResult } from '~/core/autopilot-loop';
import { AutopilotStore } from '~/core/autopilot-store';
import { WorkItemStore } from '~/core/work-item-store';
import type { Autopilot } from '~/schemas/autopilot';

let repo: string;
let aps: AutopilotStore;
let wis: WorkItemStore;
let WI: string;
const NOW = new Date('2026-06-01T00:00:00.000Z');

function graph(overrides: Partial<Autopilot> = {}): Autopilot {
  return {
    schema_version: '0.1.0',
    autopilot_id: 'orch_looptest',
    work_item_id: WI,
    mode: 'autopilot',
    root_goal: 'goal',
    completion_boundary: 'entire_work_item',
    approval_gate: {
      status: 'not_required',
      source: 'small_reversible_policy',
      approved_at: null,
      approved_by: null,
      evidence_refs: [],
    },
    nodes: buildInitialNodes(['ac-1']),
    caps: { fix_per_node: 2, switch_per_node: 1 },
    continue_policy: {
      continue_after_approval: true,
      continue_after_checkpoint: true,
      continue_after_fixable_failure: true,
      ask_user_only_for_user_owned_decisions: true,
    },
    stop_conditions: [],
    user_interrupt_policy: 'ask_only_for_user_owned_decisions',
    ...overrides,
  };
}

async function seed(g: Autopilot): Promise<void> {
  await aps.write(WI, { ...g, work_item_id: WI });
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-loop-'));
  aps = new AutopilotStore(repo);
  wis = new WorkItemStore(repo);
  const wi = await wis.create(
    {
      title: 'loop test',
      source_request: 'test the loop',
      goal: 'the loop step CLI works',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'loop runs', verdict: 'unverified', evidence: [] },
      ],
    },
    NOW,
  );
  WI = wi.id;
  await wis.update(WI, (w) => ({ ...w, changed_files: ['src/x.ts'] }));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('nextNode (loop step 1-5: select → approval → dispatch → packet)', () => {
  test('dispatches the first ready node and returns a delegation packet', async () => {
    await seed(graph());
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('spawn');
    if (res.action !== 'spawn') throw new Error('expected spawn');
    expect(res.node_id).toBe('N1');
    expect(res.owner).toBe('planner');
    expect(res.packet.task).toBeTruthy();
    expect(res.packet.context.file_scope).toEqual(['src/x.ts']);
    // dispatch persisted: N1 is now running
    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === 'N1')?.status).toBe('running');
  });

  test('is idempotent: a dispatched (running) node is not re-selected', async () => {
    await seed(graph());
    await nextNode(repo, WI); // dispatches N1 -> running
    const res = await nextNode(repo, WI);
    // N1 running, N2 depends on N1 (not passed) => nothing ready
    expect(res.action).toBe('waiting');
  });

  test('present_plan when the next ready node is mutating and approval is pending', async () => {
    const g = graph({
      approval_gate: {
        status: 'pending',
        source: null,
        approved_at: null,
        approved_by: null,
        evidence_refs: [],
      },
      nodes: buildInitialNodes(['ac-1']).map((n) =>
        n.id === 'N1' ? { ...n, status: 'passed' } : n,
      ),
    });
    await seed(g);
    const res = await nextNode(repo, WI);
    // N2 (implement, mutating) is next ready but approval is pending
    expect(res.action).toBe('present_plan');
    // not dispatched
    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === 'N2')?.status).toBe('pending');
  });

  test('read-only node runs even when approval is pending', async () => {
    const g = graph({
      approval_gate: {
        status: 'pending',
        source: null,
        approved_at: null,
        approved_by: null,
        evidence_refs: [],
      },
    });
    await seed(g);
    const res = await nextNode(repo, WI);
    // N1 (design, read-only) may proceed before approval
    expect(res.action).toBe('spawn');
  });

  test('rejected plan rolls back in-flight nodes and stops', async () => {
    const g = graph({
      approval_gate: {
        status: 'rejected',
        source: null,
        approved_at: null,
        approved_by: null,
        evidence_refs: [],
      },
      nodes: buildInitialNodes(['ac-1']).map((n) =>
        n.id === 'N1' ? { ...n, status: 'running' } : n,
      ),
    });
    await seed(g);
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('rollback');
    if (res.action !== 'rollback') throw new Error('expected rollback');
    expect(res.rolled_back_node_ids).toContain('N1');
    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === 'N1')?.status).toBe('pending');
  });

  test('done when all nodes are terminal', async () => {
    const g = graph({
      nodes: buildInitialNodes(['ac-1']).map((n) => ({ ...n, status: 'passed' as const })),
    });
    await seed(g);
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('done');
  });
});

describe('recordResult (loop step 6: G7 guard → classify → decide → persist)', () => {
  async function dispatchN1(g = graph()): Promise<void> {
    await seed(g);
    await nextNode(repo, WI); // N1 -> running
  }

  test('contentful pass transitions the node to passed with evidence', async () => {
    await dispatchN1();
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N1',
        result_text: 'Wrote the plan: 3 steps mapping to ac-1, see plan.md.',
        outcome: 'pass',
        evidence_refs: [{ kind: 'file', path: 'plan.md', summary: 'plan' }],
      },
    });
    expect(res.status).toBe('passed');
    expect(res.outcome).toBe('pass');
    expect(res.guard_contentful).toBe(true);
    const after = await aps.get(WI);
    const n1 = after.nodes.find((n) => n.id === 'N1');
    expect(n1?.status).toBe('passed');
    expect(n1?.evidence_refs).toHaveLength(1);
  });

  test('G7: an ack-only result claimed as pass is overridden to fixable (never passes)', async () => {
    await dispatchN1();
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: { node_id: 'N1', result_text: 'done', outcome: 'pass' },
    });
    // claimed pass, but ack-only => not contentful => forced fail/fixable
    expect(res.guard_contentful).toBe(false);
    expect(res.outcome).toBe('fail');
    expect(res.decision).toBe('retry');
    expect(res.status).toBe('pending'); // re-armed
    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === 'N1')?.status).toBe('pending');
    expect(after.nodes.find((n) => n.id === 'N1')?.attempts.fix).toBe(1);
    const decisions = await aps.readDecisions(WI);
    expect(decisions.at(-1)?.failure_class).toBe('fixable');
  });

  test('G7: an empty result is non-contentful', async () => {
    await dispatchN1();
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: { node_id: 'N1', result_text: '   ', outcome: 'pass' },
    });
    expect(res.guard_contentful).toBe(false);
    expect(res.outcome).toBe('fail');
  });

  test('wrong_approach fail re-arms via switch and increments switch attempts', async () => {
    await dispatchN1();
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N1',
        result_text: 'The whole approach is wrong; the schema does not support this.',
        outcome: 'fail',
        failure_class: 'wrong_approach',
        reason: 'dead end',
      },
    });
    expect(res.decision).toBe('switch_approach');
    expect(res.status).toBe('pending');
    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === 'N1')?.attempts.switch).toBe(1);
  });

  test('fixable fail at the cap escalates and closes the node as failed', async () => {
    // caps.fix_per_node = 2: with 2 fixes already consumed, the next fixable fail caps out
    const g = graph({
      nodes: buildInitialNodes(['ac-1']).map((n) =>
        n.id === 'N1' ? { ...n, status: 'running', attempts: { fix: 2, switch: 0 } } : n,
      ),
    });
    await seed(g);
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N1',
        result_text: 'still failing with the same local error after the fix attempt',
        outcome: 'fail',
        failure_class: 'fixable',
      },
    });
    expect(res.decision).toBe('escalate');
    expect(res.cap_exceeded).toBe(true);
    expect(res.status).toBe('failed');
  });

  test('blocked_external fail escalates and blocks the node (not terminal failure)', async () => {
    await dispatchN1();
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N1',
        result_text: 'cannot proceed: the staging API credential is missing',
        outcome: 'fail',
        failure_class: 'blocked_external',
      },
    });
    expect(res.decision).toBe('escalate');
    expect(res.cap_exceeded).toBe(false);
    expect(res.status).toBe('blocked');
  });

  test('throws when the node is not running (call next-node first)', async () => {
    await seed(graph()); // N1 still pending, never dispatched
    let err: unknown;
    try {
      await recordResult(repo, {
        workItemId: WI,
        now: NOW,
        payload: { node_id: 'N1', result_text: 'x', outcome: 'pass' },
      });
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.message).toContain('not running');
  });
});
