import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActiveNodeLeaseStore } from '~/core/active-node-lease';
import { buildInitialNodes } from '~/core/autopilot-graph';
import { nextNode } from '~/core/autopilot-loop';
import { AutopilotStore } from '~/core/autopilot-store';
import { WorkItemStore } from '~/core/work-item-store';
import type { Autopilot } from '~/schemas/autopilot';

/**
 * 이슈2 (wi_260610iex): scopeOf()의 fallback(workItem.changed_files)은 동시성
 * 휴리스틱이지 노드의 의도된 작업 범위가 아니다. lease가 스코프의 출처를
 * 들고 다녀야(declared|derived) 훅이 선언된 스코프만 집행할 수 있다.
 */

let repo: string;
let aps: AutopilotStore;
let WI: string;
const NOW = new Date('2026-06-01T00:00:00.000Z');

function graph(overrides: Partial<Autopilot> = {}): Autopilot {
  return {
    schema_version: '0.1.0',
    autopilot_id: 'orch_leaseprov',
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
    caps: { fix_per_node: 2, switch_per_node: 1, converge_rounds: 3 },
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

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-leaseprov-'));
  aps = new AutopilotStore(repo);
  const wi = await new WorkItemStore(repo).create(
    {
      title: 'lease provenance test',
      source_request: 'test lease scope provenance',
      goal: 'leases carry scope_source so only declared scopes are enforced',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'lease carries provenance', verdict: 'unverified', evidence: [] },
      ],
    },
    NOW,
  );
  WI = wi.id;
  await new WorkItemStore(repo).update(WI, (w) => ({ ...w, changed_files: ['src/x.ts'] }));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('nextNode lease scope provenance', () => {
  test('a node WITHOUT declared file_scope gets a derived-scope lease (fallback heuristic)', async () => {
    await aps.write(WI, graph());
    const res = await nextNode(repo, WI); // dispatches N1 (no file_scope declared)
    expect(res.action).toBe('spawn');
    const leases = await new ActiveNodeLeaseStore(repo).listActive(WI);
    expect(leases).toHaveLength(1);
    expect(leases[0]?.scope_source).toBe('derived');
  });

  test('a node WITH declared file_scope gets a declared-scope lease', async () => {
    const g = graph();
    const nodes = g.nodes.map((n) =>
      n.id === 'N1' ? { ...n, file_scope: ['src/core/planned.ts'] } : n,
    );
    await aps.write(WI, { ...g, nodes });
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('spawn');
    const leases = await new ActiveNodeLeaseStore(repo).listActive(WI);
    expect(leases[0]?.scope_source).toBe('declared');
    expect(leases[0]?.file_scope).toEqual(['src/core/planned.ts']);
  });

  test('a lease persisted without scope_source parses as declared (back-compat default)', async () => {
    const store = new ActiveNodeLeaseStore(repo);
    await store.set({
      node_id: 'N9',
      work_item_id: WI,
      file_scope: ['src/core/'],
      // fresh: listActive reaps leases >24h old (WS-HND-T3); this test asserts
      // scope_source back-compat parsing, so the lease must read as still-live.
      created_at: new Date().toISOString(),
    } as never);
    const leases = await store.listActive(WI);
    expect(leases[0]?.scope_source).toBe('declared');
  });
});
