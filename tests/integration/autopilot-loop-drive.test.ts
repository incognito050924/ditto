import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInitialNodes } from '~/core/autopilot-graph';
import { type NextNodeResult, nextNode, recordResult } from '~/core/autopilot-loop';
import { AutopilotStore } from '~/core/autopilot-store';
import { WorkItemStore } from '~/core/work-item-store';
import { autopilotForcesContinuation } from '~/hooks/stop';
import type { Autopilot } from '~/schemas/autopilot';

/**
 * v0 closure (G9): the autopilot loop, driven only through the step CLI's core
 * functions (`nextNode` → `recordResult`), actually drives a work item to
 * completion — and the Stop hook's continuation predicate
 * (`autopilotForcesContinuation`, the exact persistence gate in stop.ts) tracks
 * the loop: it BLOCKS while work is runnable and YIELDS exactly when there is
 * none. This is the end-to-end evidence that the three wired pieces (step CLI +
 * Stop-hook persistence + skill instructions) compose into a real loop.
 */

let repo: string;
let aps: AutopilotStore;
let wis: WorkItemStore;
let WI: string;
const NOW = new Date('2026-06-01T00:00:00.000Z');

function graph(overrides: Partial<Autopilot> = {}): Autopilot {
  return {
    schema_version: '0.1.0',
    autopilot_id: 'orch_drivetest',
    work_item_id: WI,
    mode: 'autopilot',
    root_goal: 'drive to completion',
    completion_boundary: 'entire_work_item',
    approval_gate: {
      status: 'not_required',
      source: 'small_reversible_policy',
      approved_at: null,
      approved_by: null,
      evidence_refs: [],
    },
    nodes: buildInitialNodes(['ac-1']),
    caps: {
      fix_per_node: 2,
      switch_per_node: 1,
      converge_rounds: 3,
      oracle_failures_to_block: 3,
      loop_rounds: 12,
      no_progress_rounds: 3,
      progress_continuation_cap: 24,
    },
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

/** Play the owner subagent: return a contentful, evidence-bearing pass result. */
async function passNode(nodeId: string): Promise<void> {
  await recordResult(repo, {
    workItemId: WI,
    now: NOW,
    payload: {
      node_id: nodeId,
      result_text: `Completed ${nodeId}: did the work and recorded evidence against ac-1.`,
      outcome: 'pass',
      // A mutating node's pass must carry changed_files (G7 확장, wi_260606h9q);
      // harmless for read-only nodes. Mirrors a real owner that touched files.
      changed_files: ['src/x.ts'],
      evidence_refs: [{ kind: 'note', summary: `${nodeId} done` }],
    },
  });
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-drive-'));
  aps = new AutopilotStore(repo);
  wis = new WorkItemStore(repo);
  const wi = await wis.create(
    {
      title: 'drive test',
      source_request: 'drive the loop end to end',
      goal: 'the loop reaches done',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'loop completes', verdict: 'unverified', evidence: [] },
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

describe('autopilot loop drives a work item to completion (v0 E2E)', () => {
  test('happy path: next-node/record-result loop runs N1→N2→N3 to done', async () => {
    await aps.write(WI, graph());

    const spawned: string[] = [];
    let last: NextNodeResult | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const res = await nextNode(repo, WI);
      last = res;
      if (res.action === 'done') break;
      expect(res.action).toBe('spawn');
      if (res.action !== 'spawn') break;
      spawned.push(res.node_id);

      // mid-flight: the Stop hook must BLOCK (a node is running)
      expect(autopilotForcesContinuation(await aps.get(WI))).toBe(true);

      await passNode(res.node_id);
    }

    expect(last?.action).toBe('done');
    expect(spawned).toEqual(['N1', 'N2', 'N3']);
    const final = await aps.get(WI);
    expect(final.nodes.every((n) => n.status === 'passed')).toBe(true);
    // loop complete: the Stop hook YIELDS (nothing runnable)
    expect(autopilotForcesContinuation(final)).toBe(false);
  });

  test('approval-pending: the loop runs read-only design, then yields before the mutating node', async () => {
    await aps.write(
      WI,
      graph({
        approval_gate: {
          status: 'pending',
          source: null,
          approved_at: null,
          approved_by: null,
          evidence_refs: [],
        },
      }),
    );

    // N1 (design, read-only) runs even with approval pending
    const r1 = await nextNode(repo, WI);
    expect(r1.action).toBe('spawn');
    if (r1.action === 'spawn') {
      expect(r1.node_id).toBe('N1');
      await passNode('N1');
    }

    // N2 (implement, mutating) is gated: present the plan, do not dispatch
    const r2 = await nextNode(repo, WI);
    expect(r2.action).toBe('present_plan');

    // a pending-approval graph YIELDS so the plan can surface (stop.ts line 129)
    expect(autopilotForcesContinuation(await aps.get(WI))).toBe(false);
  });

  test('a fixable failure re-arms the node and the loop still converges', async () => {
    await aps.write(WI, graph());

    // N1: first attempt fails (fixable) → re-armed to pending
    const r1 = await nextNode(repo, WI);
    expect(r1.action).toBe('spawn');
    await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N1',
        result_text: 'A real but fixable local error: the path was wrong; will retry.',
        outcome: 'fail',
        failure_class: 'fixable',
      },
    });
    expect((await aps.get(WI)).nodes.find((n) => n.id === 'N1')?.status).toBe('pending');
    // still runnable → Stop hook blocks
    expect(autopilotForcesContinuation(await aps.get(WI))).toBe(true);

    // drive to completion from the re-armed state
    let last: NextNodeResult | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const res = await nextNode(repo, WI);
      last = res;
      if (res.action === 'done') break;
      if (res.action !== 'spawn') break;
      await passNode(res.node_id);
    }
    expect(last?.action).toBe('done');
    expect((await aps.get(WI)).nodes.every((n) => n.status === 'passed')).toBe(true);
  });
});
