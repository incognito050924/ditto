import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInitialNodes, supersededByPromotion } from '~/core/autopilot-graph';
import { nextNode, recordResult } from '~/core/autopilot-loop';
import { AutopilotStore } from '~/core/autopilot-store';
import { WorkItemStore } from '~/core/work-item-store';
import type { Autopilot, AutopilotNode } from '~/schemas/autopilot';

/**
 * 이슈3 (wi_260610iex): planner가 generated_nodes로 그래프를 확장하면 시드 후속
 * 노드(N2 implement / N3 verify)와 책임이 중복된다. 승격 시 — (i) 생성 노드에
 * 전이 의존하고 (ii) acceptance_refs가 승격 합집합에 전부 덮이며 (iii) 생존
 * 노드가 의존하지 않는 — pending 노드를 supersede(제거)한다.
 */

let repo: string;
let aps: AutopilotStore;
let WI: string;
const NOW = new Date('2026-06-01T00:00:00.000Z');

function graph(overrides: Partial<Autopilot> = {}): Autopilot {
  return {
    schema_version: '0.1.0',
    autopilot_id: 'orch_supersede',
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
    nodes: buildInitialNodes(['ac-1', 'ac-2']),
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

const proposal = (
  id: string,
  kind: 'implement' | 'verify',
  depends_on: string[],
  acceptance_refs: string[],
) => ({ id, kind, purpose: `p-${id}`, depends_on, acceptance_refs });

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-supersede-'));
  aps = new AutopilotStore(repo);
  const wi = await new WorkItemStore(repo).create(
    {
      title: 'supersede test',
      source_request: 'test seed supersession',
      goal: 'planner expansion supersedes covered pending seed successors',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'covered one', verdict: 'unverified', evidence: [] },
        { id: 'ac-2', statement: 'covered two', verdict: 'unverified', evidence: [] },
      ],
    },
    NOW,
  );
  WI = wi.id;
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('supersededByPromotion (pure)', () => {
  const mk = (
    id: string,
    status: AutopilotNode['status'],
    depends_on: string[],
    acceptance_refs: string[],
  ): AutopilotNode => ({
    id,
    kind: 'implement',
    owner: 'implementer',
    purpose: `p-${id}`,
    status,
    depends_on,
    acceptance_refs,
    evidence_refs: [],
    ac_verdicts: [],
    attempts: { fix: 0, switch: 0 },
  });

  test('covered pending successors of the generator are superseded (seed N2/N3 case)', () => {
    const seed = buildInitialNodes(['ac-1', 'ac-2']); // N1 design → N2 implement → N3 verify
    const promoted = [mk('G1', 'pending', [], ['ac-1']), mk('G2', 'pending', ['G1'], ['ac-2'])];
    const ids = supersededByPromotion([...seed, ...promoted], 'N1', promoted);
    expect(ids.sort()).toEqual(['N2', 'N3']);
  });

  test('partial coverage keeps the seeds (no silent scope shrink)', () => {
    const seed = buildInitialNodes(['ac-1', 'ac-2']);
    const promoted = [mk('G1', 'pending', [], ['ac-1'])]; // ac-2 uncovered
    expect(supersededByPromotion([...seed, ...promoted], 'N1', promoted)).toEqual([]);
  });

  test('a seed a promoted survivor depends on is kept — and the conservative closure keeps its chain', () => {
    const seed = buildInitialNodes(['ac-1', 'ac-2']);
    const promoted = [
      mk('G1', 'pending', ['N2'], ['ac-1']), // planner wove seed N2 into its subgraph
      mk('G2', 'pending', ['G1'], ['ac-2']),
    ];
    // N2 kept (survivor G1 depends on it) → N3's dependency N2 is outside the
    // removal set, so N3 is kept too (ancestor-closure: never remove a node whose
    // non-generator dependency survives). Conservative duplication beats a hole.
    expect(supersededByPromotion([...seed, ...promoted], 'N1', promoted)).toEqual([]);
  });

  test('a running seed is never superseded, and its pending dependents stay with it', () => {
    const seed = buildInitialNodes(['ac-1', 'ac-2']);
    const running = seed.map((n) => (n.id === 'N2' ? { ...n, status: 'running' as const } : n));
    const promoted = [mk('G1', 'pending', [], ['ac-1']), mk('G2', 'pending', [], ['ac-2'])];
    // N2 running → not a candidate; N3 depends on surviving N2 → ancestor-closure keeps it.
    expect(supersededByPromotion([...running, ...promoted], 'N1', promoted)).toEqual([]);
  });

  test('a pending successor with empty acceptance_refs is never superseded', () => {
    const seed = buildInitialNodes(['ac-1', 'ac-2']);
    const cleanup = mk('C1', 'pending', ['N1'], []);
    const promoted = [mk('G1', 'pending', [], ['ac-1']), mk('G2', 'pending', [], ['ac-2'])];
    const ids = supersededByPromotion([...seed, cleanup, ...promoted], 'N1', promoted);
    expect(ids.sort()).toEqual(['N2', 'N3']); // C1 stays
  });
});

describe('recordResult promotion integrates supersession', () => {
  test('design pass with full-coverage generated_nodes removes covered pending seeds and reports them', async () => {
    await aps.write(WI, graph());
    await nextNode(repo, WI); // dispatch N1
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N1',
        result_text: 'plan: G1 implements ac-1, G2 verifies both; seed successors are covered',
        outcome: 'pass',
        generated_nodes: [
          proposal('G1', 'implement', ['N1'], ['ac-1', 'ac-2']),
          proposal('G2', 'verify', ['G1'], ['ac-1', 'ac-2']),
        ],
      },
    });
    expect(res.promoted_node_ids).toEqual(['G1', 'G2']);
    expect(res.superseded_node_ids?.sort()).toEqual(['N2', 'N3']);
    const g = await aps.get(WI);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['G1', 'G2', 'N1']);
  });

  test('partial coverage promotes without removing seeds', async () => {
    await aps.write(WI, graph());
    await nextNode(repo, WI);
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N1',
        result_text: 'plan: G1 covers only ac-1; seed implement/verify still own ac-2',
        outcome: 'pass',
        generated_nodes: [proposal('G1', 'implement', ['N1'], ['ac-1'])],
      },
    });
    expect(res.promoted_node_ids).toEqual(['G1']);
    expect(res.superseded_node_ids ?? []).toEqual([]);
    const g = await aps.get(WI);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['G1', 'N1', 'N2', 'N3']);
  });
});
