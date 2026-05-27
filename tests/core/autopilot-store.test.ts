import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInitialNodes } from '~/core/autopilot-graph';
import { AutopilotStore } from '~/core/autopilot-store';
import type { Autopilot } from '~/schemas/autopilot';

let repo: string;
let store: AutopilotStore;
const WI = 'wi_storetest';

function graph(): Autopilot {
  return {
    schema_version: '0.1.0',
    autopilot_id: 'orch_storetest',
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
  };
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-aps-'));
  store = new AutopilotStore(repo);
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('AutopilotStore', () => {
  test('write then get round-trips a schema-valid graph', async () => {
    await store.write(WI, graph());
    const read = await store.get(WI);
    expect(read.nodes).toHaveLength(3);
    expect(read.autopilot_id).toBe('orch_storetest');
  });

  test('updateNode mutates exactly one node and persists', async () => {
    await store.write(WI, graph());
    await store.updateNode(WI, 'N1', (n) => ({ ...n, status: 'passed' }));
    const read = await store.get(WI);
    expect(read.nodes.find((n) => n.id === 'N1')?.status).toBe('passed');
    expect(read.nodes.find((n) => n.id === 'N2')?.status).toBe('pending');
  });

  test('updateNode throws on unknown node', async () => {
    await store.write(WI, graph());
    let err: unknown;
    try {
      await store.updateNode(WI, 'N9', (n) => n);
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.message).toContain('not found');
  });

  test('updateNode forbids changing the node id', async () => {
    await store.write(WI, graph());
    let err: unknown;
    try {
      await store.updateNode(WI, 'N1', (n) => ({ ...n, id: 'X' }));
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.message).toContain('changed node id');
  });

  test('decisions log is append-only', async () => {
    await store.write(WI, graph());
    await store.appendDecision(WI, {
      ts: '2026-05-26T00:00:00.000Z',
      node_id: 'N2',
      failure_class: 'fixable',
      decision: 'retry',
      reason: 'transient',
      attempts: { fix: 1, switch: 0 },
    });
    await store.appendDecision(WI, {
      ts: '2026-05-26T00:01:00.000Z',
      node_id: 'N2',
      failure_class: 'wrong_approach',
      decision: 'switch_approach',
      reason: 'dead end',
      attempts: { fix: 1, switch: 1 },
    });
    const decisions = await store.readDecisions(WI);
    expect(decisions).toHaveLength(2);
    expect(decisions[1]?.decision).toBe('switch_approach');
  });
});
