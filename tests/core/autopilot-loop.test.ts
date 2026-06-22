import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActiveNodeLeaseStore } from '~/core/active-node-lease';
import { buildInitialNodes } from '~/core/autopilot-graph';
import { nextNode, recordResult } from '~/core/autopilot-loop';
import { AutopilotStore } from '~/core/autopilot-store';
import { CoverageStore } from '~/core/coverage-store';
import { localDir } from '~/core/ditto-paths';
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
    // Variant routing (ac-3/ac-4): the spawn packet exposes variant_candidates;
    // with no .ditto/agents/ present the catalog is empty so it is [].
    expect(res.packet.variant_candidates).toEqual([]);
    // dispatch persisted: N1 is now running
    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === 'N1')?.status).toBe('running');
  });

  test('spawn packet exposes matching variant_candidates from .ditto/agents (ac-3)', async () => {
    // The seed node must DECLARE its own file_scope for a scoped variant to route:
    // a scoped variant narrows by glob only on a declared scope (wi_260622kb4). A
    // node falling back to the mixed work-item changed_files drops scoped variants.
    const g = graph();
    g.nodes = g.nodes.map((n) => (n.id === 'N1' ? { ...n, file_scope: ['src/plan.ts'] } : n));
    await seed(g);
    const dir = join(repo, '.ditto', 'agents');
    await mkdir(dir, { recursive: true });
    await Bun.write(
      join(dir, 'planner-variant.md'),
      `---
name: deep-planner
role: planner
description: deep planning specialist
match: [src/**]
---
`,
    );
    await Bun.write(
      join(dir, 'impl-variant.md'),
      `---
name: impl-specialist
role: implementer
description: impl
match: [src/**]
---
`,
    );
    const res = await nextNode(repo, WI);
    if (res.action !== 'spawn') throw new Error('expected spawn');
    // N1 is the planner node; only the planner-role variant matches the owner.
    expect(res.owner).toBe('planner');
    expect(res.packet.variant_candidates).toEqual([
      { name: 'deep-planner', description: 'deep planning specialist' },
    ]);
  });

  // wi_260622kb4 defense: a node that does NOT declare its own file_scope falls
  // back to the mixed work-item changed_files; a scoped variant must NOT route off
  // that untrusted scope (the live mis-routing this fix closes).
  test('undeclared file_scope (changed_files fallback) drops scoped variant candidates', async () => {
    await seed(graph()); // seed nodes carry no file_scope → derived from changed_files
    const dir = join(repo, '.ditto', 'agents');
    await mkdir(dir, { recursive: true });
    await Bun.write(
      join(dir, 'planner-variant.md'),
      `---
name: deep-planner
role: planner
description: deep planning specialist
match: [src/**]
---
`,
    );
    const res = await nextNode(repo, WI);
    if (res.action !== 'spawn') throw new Error('expected spawn');
    expect(res.owner).toBe('planner');
    // scoped variant dropped — no role-generalist present, so candidates is empty.
    expect(res.packet.variant_candidates).toEqual([]);
  });

  // Warm-start non-invasiveness (§10-6 #1, ac-9): with NO memory projection, the
  // loop's fail-open query returns undefined, so a planner spawn packet carries no
  // `memory` context and dispatch behaves exactly as before.
  test('no memory projection ⇒ planner packet has no memory context (dispatch unchanged)', async () => {
    await seed(graph());
    const res = await nextNode(repo, WI);
    if (res.action !== 'spawn') throw new Error('expected spawn');
    expect(res.owner).toBe('planner');
    expect(res.packet.context.memory).toBeUndefined();
    expect('memory' in res.packet.context).toBe(false);
    // node still dispatched to running — the absent query never blocked dispatch.
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

describe('nextNode terminal surfacing (작은 고정: §6.8 done disposition + A-2 escalate blocked)', () => {
  // Fix 2 (§6.8): graph `done` is NOT acceptance closing — completion judges with
  // evidence (graph 상태 ≠ 완료 판정). `done` surfaces the disposition so the driver
  // knows completion is owed and whether it can pass; it never auto-closes an AC.
  test('all passed → done with all_passed=true and a completion-owed reason', async () => {
    await seed(
      graph({
        nodes: buildInitialNodes(['ac-1']).map((n) => ({ ...n, status: 'passed' as const })),
      }),
    );
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('done');
    if (res.action !== 'done') throw new Error('expected done');
    expect(res.all_passed).toBe(true);
    expect(res.reason.toLowerCase()).toContain('completion');
  });

  test('terminal with a failed node → done with all_passed=false', async () => {
    await seed(
      graph({
        nodes: buildInitialNodes(['ac-1']).map((n) => ({
          ...n,
          status: n.id === 'N3' ? ('failed' as const) : ('passed' as const),
        })),
      }),
    );
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('done');
    if (res.action !== 'done') throw new Error('expected done');
    expect(res.all_passed).toBe(false);
  });

  // Fix 1 (A-2 surfacing): a blocked node with nothing runnable is an escalated,
  // user-owned decision — not a transient `waiting`. Surface it as `blocked` with
  // the node ids and the decision-log reason that escalated it.
  test('a blocked node with nothing runnable → action=blocked surfacing the decision (not waiting)', async () => {
    const blockedReview = {
      id: 'N3',
      kind: 'review' as const,
      owner: 'reviewer' as const,
      purpose: 'review the change',
      status: 'blocked' as const,
      depends_on: [] as string[],
      acceptance_refs: ['ac-1'],
      evidence_refs: [],
      attempts: { fix: 0, switch: 0 },
    };
    await seed(graph({ nodes: [blockedReview] }));
    await aps.appendDecision(WI, {
      ts: NOW.toISOString(),
      node_id: 'N3',
      failure_class: 'user_decision_needed',
      decision: 'escalate',
      reason: 'forward re-expansion budget reached with findings still open',
      attempts: { fix: 0, switch: 0 },
    });
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('blocked');
    if (res.action !== 'blocked') throw new Error('expected blocked');
    expect(res.blocked_node_ids).toEqual(['N3']);
    expect(res.reason).toContain('N3');
    expect(res.reason.toLowerCase()).toContain('budget'); // surfaced the decision reason
  });

  test('a running node still surfaces as waiting, not blocked (transient, in progress)', async () => {
    await seed(
      graph({
        nodes: buildInitialNodes(['ac-1']).map((n) =>
          n.id === 'N1' ? { ...n, status: 'running' as const } : n,
        ),
      }),
    );
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('waiting');
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

  test('a pass carrying per-AC verdicts persists them on the node (verifier judgment survives)', async () => {
    await dispatchN1();
    await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N1',
        result_text: 'Verified ac-1: holds for the success path but the error path is unmet.',
        outcome: 'pass',
        evidence_refs: [{ kind: 'file', path: 'verify.log', summary: 'run' }],
        ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'partial', notes: 'error path unmet' }],
      },
    });
    const after = await aps.get(WI);
    const n1 = after.nodes.find((n) => n.id === 'N1');
    expect(n1?.status).toBe('passed'); // the node passed as a node
    expect(n1?.ac_verdicts).toEqual([
      { criterion_id: 'ac-1', verdict: 'partial', notes: 'error path unmet' },
    ]);
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

describe('recordResult changed_files union (#1: owner reports → work-item accumulation)', () => {
  async function dispatchN1(): Promise<void> {
    await seed(graph());
    await nextNode(repo, WI); // N1 -> running
  }

  test('a contentful pass with changed_files unions them into the work item (deduped, existing first)', async () => {
    // beforeEach pins changed_files = ['src/x.ts']; the node reports x.ts (dup) + y.ts.
    await dispatchN1();
    await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N1',
        result_text: 'Edited src/y.ts to add the union helper; src/x.ts already touched.',
        outcome: 'pass',
        evidence_refs: [{ kind: 'file', path: 'src/y.ts', summary: 'edit' }],
        changed_files: ['src/y.ts', 'src/x.ts'],
      },
    });
    const wi = await wis.get(WI);
    expect(wi.changed_files).toEqual(['src/x.ts', 'src/y.ts']);
  });

  test('a pass without changed_files leaves the work item changed_files unchanged', async () => {
    await dispatchN1();
    await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: { node_id: 'N1', result_text: 'Wrote the plan mapping to ac-1.', outcome: 'pass' },
    });
    const wi = await wis.get(WI);
    expect(wi.changed_files).toEqual(['src/x.ts']);
  });

  test('changed_files on a non-pass (fixable fail) does NOT touch the work item (union is pass-only)', async () => {
    await dispatchN1();
    await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N1',
        result_text: 'partial edit then hit a local error; retrying the fix next round',
        outcome: 'fail',
        failure_class: 'fixable',
        changed_files: ['src/half-done.ts'],
      },
    });
    const wi = await wis.get(WI);
    expect(wi.changed_files).toEqual(['src/x.ts']);
  });
});

describe('recordResult node promotion (A-3: planner 콘텐츠 승격 — addNodes의 첫 live 호출자)', () => {
  const designOnly = (): Autopilot =>
    graph({
      nodes: [
        {
          id: 'N1',
          kind: 'design',
          owner: 'planner',
          purpose: 'plan the change',
          status: 'pending',
          depends_on: [],
          acceptance_refs: ['ac-1'],
          evidence_refs: [],
          attempts: { fix: 0, switch: 0 },
        },
      ],
    });

  const proposal = (id: string, kind: 'implement' | 'review', depends_on: string[]) => ({
    id,
    kind,
    purpose: `p-${id}`,
    depends_on,
    acceptance_refs: ['ac-1'],
  });

  test('contentful design pass splices generated_nodes via addNodes (1→3) and returns promoted ids', async () => {
    await seed(designOnly());
    await nextNode(repo, WI); // dispatch N1 (pending → running)
    const res = await recordResult(repo, {
      workItemId: WI,
      payload: {
        node_id: 'N1',
        result_text:
          'plan: the change needs an implement node then a review node; generated the subgraph',
        outcome: 'pass',
        generated_nodes: [proposal('G1', 'implement', ['N1']), proposal('G2', 'review', ['G1'])],
      },
      now: NOW,
    });
    expect(res.promoted_node_ids).toEqual(['G1', 'G2']);
    const g = await aps.get(WI);
    expect(g.nodes.map((n) => n.id)).toEqual(['N1', 'G1', 'G2']);
    expect(g.nodes.find((n) => n.id === 'G1')?.owner).toBe('implementer'); // kindToOwner filled
    expect(g.nodes.find((n) => n.id === 'G1')?.status).toBe('pending');
  });

  test('promoted node becomes the next dispatched node (engine runs beyond the 1-node seed)', async () => {
    await seed(designOnly());
    await nextNode(repo, WI);
    await recordResult(repo, {
      workItemId: WI,
      payload: {
        node_id: 'N1',
        result_text: 'plan: one implement node suffices; generated it',
        outcome: 'pass',
        generated_nodes: [proposal('G1', 'implement', ['N1'])],
      },
      now: NOW,
    });
    const next = await nextNode(repo, WI);
    expect(next.action).toBe('spawn');
    if (next.action === 'spawn') expect(next.node_id).toBe('G1');
  });

  test('no generated_nodes leaves the graph unchanged (default 3-node path invariant)', async () => {
    await seed(graph()); // default 3-node chain
    await nextNode(repo, WI);
    const res = await recordResult(repo, {
      workItemId: WI,
      payload: {
        node_id: 'N1',
        result_text: 'planned the change against the acceptance criteria; no extra nodes needed',
        outcome: 'pass',
      },
      now: NOW,
    });
    expect(res.promoted_node_ids).toEqual([]);
    expect((await aps.get(WI)).nodes).toHaveLength(3);
  });

  test('invalid promotion (duplicate id) is rejected by addNodes (existing nodes stay stable)', async () => {
    await seed(designOnly());
    await nextNode(repo, WI);
    let err: unknown;
    try {
      await recordResult(repo, {
        workItemId: WI,
        payload: {
          node_id: 'N1',
          result_text: 'plan with a colliding node id',
          outcome: 'pass',
          generated_nodes: [proposal('N1', 'implement', [])],
        },
        now: NOW,
      });
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.message).toContain('duplicate node id');
  });

  test('non-contentful pass promotes nothing (G7 floor overrides claimed pass)', async () => {
    await seed(designOnly());
    await nextNode(repo, WI);
    const res = await recordResult(repo, {
      workItemId: WI,
      payload: {
        node_id: 'N1',
        result_text: 'done',
        outcome: 'pass',
        generated_nodes: [proposal('G1', 'implement', ['N1'])],
      },
      now: NOW,
    });
    expect(res.guard_contentful).toBe(false);
    expect(res.promoted_node_ids).toEqual([]);
    expect((await aps.get(WI)).nodes).toHaveLength(1);
  });
});

describe('recordResult plan-stage coverage wiring (premortem-coverage §7.2/§12: design→review brief)', () => {
  const designOnly = (): Autopilot =>
    graph({
      approval_gate: {
        status: 'not_required',
        source: 'small_reversible_policy',
        approved_at: null,
        approved_by: null,
        evidence_refs: [],
      },
      nodes: [
        {
          id: 'N1',
          kind: 'design',
          owner: 'planner',
          purpose: 'plan the change',
          status: 'pending',
          depends_on: [],
          acceptance_refs: ['ac-1'],
          evidence_refs: [],
          attempts: { fix: 0, switch: 0 },
        },
      ],
    });

  const proposal = (id: string, kind: 'implement' | 'review', depends_on: string[]) => ({
    id,
    kind,
    purpose: `p-${id}`,
    depends_on,
    acceptance_refs: ['ac-1'],
  });

  // ac-3 precondition: a design pass carrying plan_brief is only valid after a
  // real coverage sweep wrote coverage.json. Seed it so the wiring assertions run.
  const seedCoverage = async (): Promise<void> => {
    await new CoverageStore(repo).writeMap(WI, {
      schema_version: '0.1.0',
      work_item_id: WI,
      root_id: 'cov-root',
      nodes: [
        {
          id: 'cov-root',
          parent_id: null,
          label: 'intent',
          origin: 'seed',
          depth_weight: 0,
          state: 'resolved',
          children: [],
        },
      ],
    });
  };

  test('contentful design pass with plan_brief populates approval_gate brief + change_surface (standard → pending)', async () => {
    await seed(designOnly());
    await seedCoverage();
    await nextNode(repo, WI); // dispatch N1 → running
    await recordResult(repo, {
      workItemId: WI,
      payload: {
        node_id: 'N1',
        result_text:
          'plan: ran the pre-mortem coverage sweep; the change touches the parser interface',
        outcome: 'pass',
        generated_nodes: [proposal('G1', 'implement', ['N1']), proposal('G2', 'review', ['G1'])],
        plan_brief: {
          change_surface: ['src/parser.ts', 'src/lexer.ts'],
          interface_changes: ['parse(): add an options arg'],
          dod: ['parser accepts the new option'],
          test_scenarios: ['parse with the option set returns the new shape'],
          tier_inputs: {
            changedFileCount: 2,
            interfaceChanged: true,
            risk: { non_local: false, irreversible: false, unaudited: false },
            large: false,
          },
        },
      },
      now: NOW,
    });
    const g = await aps.get(WI);
    // brief regime turned ON: change_surface present, brief populated.
    expect(g.approval_gate.change_surface).toEqual(['src/parser.ts', 'src/lexer.ts']);
    expect(g.approval_gate.plan_brief?.interface_changes).toEqual(['parse(): add an options arg']);
    expect(g.approval_gate.plan_brief?.dod).toEqual(['parser accepts the new option']);
    expect(g.approval_gate.plan_brief?.test_scenarios).toEqual([
      'parse with the option set returns the new shape',
    ]);
    // standard tier (interface changed) → user approval required → pending.
    expect(g.approval_gate.status).toBe('pending');
    // seed-style supersession path still grows the graph from the planner output.
    expect(g.nodes.map((n) => n.id)).toEqual(['N1', 'G1', 'G2']);
  });

  test('light tier (few files, no interface, no risk) auto-waives the brief (not_required)', async () => {
    await seed(designOnly());
    await seedCoverage();
    await nextNode(repo, WI);
    await recordResult(repo, {
      workItemId: WI,
      payload: {
        node_id: 'N1',
        result_text: 'plan: small reversible change; coverage sweep found no interface impact',
        outcome: 'pass',
        generated_nodes: [proposal('G1', 'implement', ['N1'])],
        plan_brief: {
          change_surface: ['src/x.ts'],
          interface_changes: [],
          dod: ['x still works'],
          test_scenarios: ['unit test for x'],
          tier_inputs: {
            changedFileCount: 1,
            interfaceChanged: false,
            risk: { non_local: false, irreversible: false, unaudited: false },
            large: false,
          },
        },
      },
      now: NOW,
    });
    const g = await aps.get(WI);
    expect(g.approval_gate.change_surface).toEqual(['src/x.ts']);
    expect(g.approval_gate.plan_brief).toBeDefined();
    expect(g.approval_gate.status).toBe('not_required');
  });

  test('design pass WITHOUT plan_brief leaves approval_gate untouched (backward compat)', async () => {
    await seed(designOnly());
    await nextNode(repo, WI);
    await recordResult(repo, {
      workItemId: WI,
      payload: {
        node_id: 'N1',
        result_text: 'planned the change; no brief regime for this legacy path',
        outcome: 'pass',
        generated_nodes: [proposal('G1', 'implement', ['N1'])],
      },
      now: NOW,
    });
    const g = await aps.get(WI);
    expect(g.approval_gate.change_surface).toBeUndefined();
    expect(g.approval_gate.plan_brief).toBeUndefined();
    expect(g.approval_gate.status).toBe('not_required');
  });

  // ADR-0020 D3 producer (wi_260616eu8): recordResult persists the planner's
  // declared decision conflicts as the carrier, BEFORE the plan-gate consults it,
  // so an intent conflict front-loads the approval gate in the SAME call even when
  // the tier alone would auto-waive (light → not_required).
  const carrierPath = () => localDir(repo, 'work-items', WI, 'decision-conflict.json');

  test('contentful design pass with intent-level decision_conflicts writes carrier + forces approval pending', async () => {
    await seed(designOnly());
    await seedCoverage();
    await nextNode(repo, WI);
    await recordResult(repo, {
      workItemId: WI,
      payload: {
        node_id: 'N1',
        result_text:
          'plan: ran the coverage sweep; this request contradicts a recorded decision (ADR-0011)',
        outcome: 'pass',
        generated_nodes: [proposal('G1', 'implement', ['N1'])],
        plan_brief: {
          // light tier (1 file, no interface, no risk) → producePlanGate alone
          // would give not_required; the intent conflict must override to pending.
          change_surface: ['src/x.ts'],
          interface_changes: [],
          dod: ['x still works'],
          test_scenarios: ['unit test for x'],
          tier_inputs: {
            changedFileCount: 1,
            interfaceChanged: false,
            risk: { non_local: false, irreversible: false, unaudited: false },
            large: false,
          },
        },
        decision_conflicts: [
          {
            adr_id: 'ADR-0011',
            kind: 'forbid',
            level: 'intent',
            basis: 'ADR-0011 forbids cross-repo subagent delegation; this work item requires it',
          },
        ],
      },
      now: NOW,
    });
    // (a) the carrier was written BY recordResult (not a fixture) with the conflict.
    const carrier = JSON.parse(await readFile(carrierPath(), 'utf8'));
    expect(carrier.schema_version).toBe('0.1.0');
    expect(carrier.mode).toBe('autopilot');
    expect(carrier.conflicts).toEqual([
      {
        adr_id: 'ADR-0011',
        kind: 'forbid',
        level: 'intent',
        basis: 'ADR-0011 forbids cross-repo subagent delegation; this work item requires it',
      },
    ]);
    // (b) the SAME call front-loaded the approval gate to pending despite light tier.
    const g = await aps.get(WI);
    expect(g.approval_gate.status).toBe('pending');
  });

  test('contentful design pass with absent decision_conflicts writes no carrier (backward compat)', async () => {
    await seed(designOnly());
    await seedCoverage();
    await nextNode(repo, WI);
    await recordResult(repo, {
      workItemId: WI,
      payload: {
        node_id: 'N1',
        result_text: 'plan: small reversible change; no ADR conflicts detected',
        outcome: 'pass',
        generated_nodes: [proposal('G1', 'implement', ['N1'])],
        plan_brief: {
          change_surface: ['src/x.ts'],
          interface_changes: [],
          dod: ['x still works'],
          test_scenarios: ['unit test for x'],
          tier_inputs: {
            changedFileCount: 1,
            interfaceChanged: false,
            risk: { non_local: false, irreversible: false, unaudited: false },
            large: false,
          },
        },
      },
      now: NOW,
    });
    // No carrier file created.
    await expect(readFile(carrierPath(), 'utf8')).rejects.toThrow();
    // approval_gate behaves exactly as the legacy light-tier path: not_required.
    const g = await aps.get(WI);
    expect(g.approval_gate.status).toBe('not_required');
  });
});

describe('recordResult forward re-expansion (A-2: review findings → fix+review splice · §2.4/§4.3)', () => {
  const reviewGraph = (reviewId: string, converge = 3): Autopilot =>
    graph({
      nodes: [
        {
          id: reviewId,
          kind: 'review',
          owner: 'reviewer',
          purpose: 'review the change against the acceptance criteria',
          status: 'running',
          depends_on: [],
          acceptance_refs: ['ac-1'],
          evidence_refs: [],
          attempts: { fix: 0, switch: 0 },
        },
      ],
      caps: { fix_per_node: 2, switch_per_node: 1, converge_rounds: converge },
    });

  const findingsResult =
    'reviewed the diff against ac-1; found 2 issues that must be fixed before this can close';

  test('review with findings (within budget) splices a fix+review round via addNodes', async () => {
    await seed(reviewGraph('R0'));
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: { node_id: 'R0', result_text: findingsResult, outcome: 'pass', has_findings: true },
    });
    // the review node did its job (contentful findings) → it passes; the loop keeps
    // going through the spliced forward round, not a back-edge to R0.
    expect(res.status).toBe('passed');
    expect(res.promoted_node_ids).toEqual(['R0.fix.r0', 'R0.rev.r0']);
    const g = await aps.get(WI);
    expect(g.nodes.map((n) => n.id)).toEqual(['R0', 'R0.fix.r0', 'R0.rev.r0']);
    const fix = g.nodes.find((n) => n.id === 'R0.fix.r0');
    expect(fix?.kind).toBe('fix');
    expect(fix?.owner).toBe('implementer');
    expect(fix?.depends_on).toEqual(['R0']); // forward edge only
    const rev = g.nodes.find((n) => n.id === 'R0.rev.r0');
    expect(rev?.kind).toBe('review');
    expect(rev?.depends_on).toEqual(['R0.fix.r0']);
  });

  test('the spliced fix node is the next dispatchable node (loop continues forward)', async () => {
    await seed(reviewGraph('R0'));
    await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: { node_id: 'R0', result_text: findingsResult, outcome: 'pass', has_findings: true },
    });
    const next = await nextNode(repo, WI);
    expect(next.action).toBe('spawn');
    if (next.action === 'spawn') expect(next.node_id).toBe('R0.fix.r0');
  });

  test('review with no findings closes the loop (plain pass, no splice)', async () => {
    await seed(reviewGraph('R0'));
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'R0',
        result_text: 'reviewed against ac-1; zero findings, the change is correct',
        outcome: 'pass',
        has_findings: false,
      },
    });
    expect(res.status).toBe('passed');
    expect(res.promoted_node_ids).toEqual([]);
    expect((await aps.get(WI)).nodes).toHaveLength(1);
  });

  test('review with findings at the convergence budget escalates (blocked, never passes)', async () => {
    // 'R0.rev.r0' carries one forward-review marker → round 1; converge_rounds 1 ⇒ 1≥1 escalate.
    await seed(reviewGraph('R0.rev.r0', 1));
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'R0.rev.r0',
        result_text: 'still 1 issue open after the fix round; cannot close',
        outcome: 'pass',
        has_findings: true,
      },
    });
    expect(res.status).toBe('blocked');
    expect(res.outcome).toBe('fail');
    expect(res.failure_class).toBe('user_decision_needed');
    expect(res.promoted_node_ids).toEqual([]);
    expect((await aps.get(WI)).nodes).toHaveLength(1); // no splice past budget
    const decisions = await aps.readDecisions(WI);
    expect(decisions.at(-1)?.decision).toBe('escalate');
    expect(decisions.at(-1)?.failure_class).toBe('user_decision_needed');
  });

  test('has_findings on a non-review node is ignored (normal pass path)', async () => {
    await seed(
      graph({
        nodes: [
          {
            id: 'N1',
            kind: 'design',
            owner: 'planner',
            purpose: 'plan the change',
            status: 'running',
            depends_on: [],
            acceptance_refs: ['ac-1'],
            evidence_refs: [],
            attempts: { fix: 0, switch: 0 },
          },
        ],
      }),
    );
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N1',
        result_text: 'planned the change against ac-1 with a 3-step plan',
        outcome: 'pass',
        has_findings: true,
      },
    });
    expect(res.status).toBe('passed');
    expect(res.promoted_node_ids).toEqual([]);
    expect((await aps.get(WI)).nodes).toHaveLength(1);
  });

  const securityGraph = (secId: string, converge = 3): Autopilot =>
    graph({
      nodes: [
        {
          id: secId,
          kind: 'security',
          owner: 'security-reviewer',
          purpose: 'security pass over the change',
          status: 'running',
          depends_on: [],
          acceptance_refs: ['ac-1'],
          evidence_refs: [],
          attempts: { fix: 0, switch: 0 },
        },
      ],
      caps: { fix_per_node: 2, switch_per_node: 1, converge_rounds: converge },
    });

  test('security with findings splices a fix + security re-check (same lane, not generic review)', async () => {
    await seed(securityGraph('S0'));
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'S0',
        result_text:
          'security pass on ac-1; found 1 injection sink that must be fixed before close',
        outcome: 'pass',
        has_findings: true,
      },
    });
    expect(res.status).toBe('passed');
    expect(res.promoted_node_ids).toEqual(['S0.fix.r0', 'S0.rev.r0']);
    const g = await aps.get(WI);
    const fix = g.nodes.find((n) => n.id === 'S0.fix.r0');
    expect(fix?.kind).toBe('fix');
    expect(fix?.owner).toBe('implementer');
    const recheck = g.nodes.find((n) => n.id === 'S0.rev.r0');
    expect(recheck?.kind).toBe('security'); // re-check stays in the security lane
    expect(recheck?.owner).toBe('security-reviewer');
    expect(recheck?.depends_on).toEqual(['S0.fix.r0']);
  });

  test('security with findings at the convergence budget escalates (blocked, never passes)', async () => {
    await seed(securityGraph('S0.rev.r0', 1)); // one forward marker → round 1 ≥ budget 1
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'S0.rev.r0',
        result_text: 'the injection sink is still reachable after the fix round; cannot close',
        outcome: 'pass',
        has_findings: true,
      },
    });
    expect(res.status).toBe('blocked');
    expect(res.failure_class).toBe('user_decision_needed');
    expect((await aps.get(WI)).nodes).toHaveLength(1); // no splice past budget
  });

  test('security with no findings closes the loop (plain pass, no splice)', async () => {
    await seed(securityGraph('S0'));
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'S0',
        result_text: 'security pass on ac-1; zero findings, no exploitable sink',
        outcome: 'pass',
        has_findings: false,
      },
    });
    expect(res.status).toBe('passed');
    expect(res.promoted_node_ids).toEqual([]);
    expect((await aps.get(WI)).nodes).toHaveLength(1);
  });
});

describe('nextNode parallel wave (ac-3: spawn the whole file-overlap-admitted wave)', () => {
  // file_scope per node comes from workItem.changed_files (loop.ts). An empty
  // changed_files makes every node's scope disjoint (empty claims nothing), so the
  // file-overlap gate admits the whole ready wave.
  const node = (
    id: string,
    kind: 'research' | 'implement' | 'cleanup',
    owner: 'researcher' | 'implementer' | 'driver',
    depends_on: string[] = [],
  ) => ({
    id,
    kind,
    owner,
    purpose: `${kind} ${id}`,
    status: 'pending' as const,
    depends_on,
    acceptance_refs: ['ac-1'],
    evidence_refs: [],
    attempts: { fix: 0, switch: 0 },
  });

  beforeEach(async () => {
    // disjoint scopes for every node — admit the whole wave
    await wis.update(WI, (w) => ({ ...w, changed_files: [] }));
  });

  test('2 disjoint ready non-mutating nodes → spawn_wave with both dispatched', async () => {
    await seed(
      graph({
        nodes: [node('R1', 'research', 'researcher'), node('R2', 'research', 'researcher')],
      }),
    );
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('spawn_wave');
    if (res.action !== 'spawn_wave') throw new Error('expected spawn_wave');
    expect(res.spawns.map((s) => s.node_id).sort()).toEqual(['R1', 'R2']);
    expect(res.spawns.every((s) => s.owner === 'researcher')).toBe(true);
    expect(res.spawns.every((s) => s.packet.task.length > 0)).toBe(true);
    // both dispatched to running, persisted
    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === 'R1')?.status).toBe('running');
    expect(after.nodes.find((n) => n.id === 'R2')?.status).toBe('running');
  });

  test('1 ready node → single spawn (unchanged), node running', async () => {
    await seed(graph({ nodes: [node('R1', 'research', 'researcher')] }));
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('spawn');
    if (res.action !== 'spawn') throw new Error('expected spawn');
    expect(res.node_id).toBe('R1');
    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === 'R1')?.status).toBe('running');
  });

  test('a driver (cleanup) node is not folded into a wave — single cleanup path', async () => {
    await seed(
      graph({
        nodes: [node('C1', 'cleanup', 'driver'), node('R2', 'research', 'researcher')],
      }),
    );
    const res = await nextNode(repo, WI);
    // only R2 is wave-eligible (driver excluded) → fall back to single-node path,
    // and the first admitted node (C1) is the deterministic cleanup step.
    expect(res.action).toBe('cleanup');
    if (res.action !== 'cleanup') throw new Error('expected cleanup');
    expect(res.node_id).toBe('C1');
    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === 'R2')?.status).toBe('pending');
  });

  test('main-session(e2e-author) 노드는 wave에 절대 포함되지 않는다 (O-10 동시성 가드)', async () => {
    await seed(
      graph({
        nodes: [
          {
            id: 'E1',
            kind: 'e2e-author' as const,
            owner: 'main-session' as const,
            purpose: 'author journeys with the user',
            status: 'pending' as const,
            depends_on: [],
            acceptance_refs: [],
            evidence_refs: [],
            attempts: { fix: 0, switch: 0 },
          },
          node('R2', 'research', 'researcher'),
        ],
      }),
    );
    const res = await nextNode(repo, WI);
    // main-session은 wave-eligible이 아니므로 spawn_wave에 실리지 않고,
    // 단일 노드 경로에서 main_session 액션으로 인터셉트된다.
    expect(res.action).not.toBe('spawn_wave');
    if (res.action === 'main_session') {
      expect(res.node_id).toBe('E1');
    }
    const after = await aps.get(WI);
    // 어느 쪽이 먼저 선택되든 main-session 노드가 wave spawn으로 흘러가지 않았다.
    const e1 = after.nodes.find((n) => n.id === 'E1');
    expect(e1?.status === 'pending' || e1?.status === 'running').toBe(true);
  });

  test('F1: 2 approved mutating nodes are NOT both dispatched in one wave (≤1 mutating per wave)', async () => {
    // Both implementer nodes are otherwise wave-eligible (approval allowed, empty
    // changed_files → disjoint scopes). file_scope can't actually separate their real
    // writes, so the wave admits at most one mutating node; the other stays pending.
    await seed(
      graph({
        approval_gate: {
          status: 'approved',
          source: 'user',
          approved_at: NOW.toISOString(),
          approved_by: 'user',
          evidence_refs: [],
        },
        nodes: [node('I1', 'implement', 'implementer'), node('I2', 'implement', 'implementer')],
      }),
    );
    const res = await nextNode(repo, WI);
    // only one mutating node is eligible → single spawn path, the other stays pending.
    expect(res.action).toBe('spawn');
    if (res.action !== 'spawn') throw new Error('expected spawn');
    const after = await aps.get(WI);
    const running = after.nodes.filter((n) => n.status === 'running');
    expect(running).toHaveLength(1); // at most one mutating node dispatched
    expect(after.nodes.filter((n) => n.status === 'pending')).toHaveLength(1);
  });

  test('approval-gated mutating nodes are not folded into a wave — single present_plan path', async () => {
    await seed(
      graph({
        approval_gate: {
          status: 'pending',
          source: null,
          approved_at: null,
          approved_by: null,
          evidence_refs: [],
        },
        nodes: [node('I1', 'implement', 'implementer'), node('I2', 'implement', 'implementer')],
      }),
    );
    const res = await nextNode(repo, WI);
    // both mutating + gate pending → neither wave-eligible → single-node path,
    // which surfaces the approval gate rather than dispatching.
    expect(res.action).toBe('present_plan');
    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === 'I1')?.status).toBe('pending');
    expect(after.nodes.find((n) => n.id === 'I2')?.status).toBe('pending');
  });
});

describe('nextNode per-node file_scope + cross-call overlap (B2 ac-2/ac-3)', () => {
  const APPROVED = {
    status: 'approved' as const,
    source: 'user' as const,
    approved_at: NOW.toISOString(),
    approved_by: 'user',
    evidence_refs: [],
  };
  const mut = (id: string, file_scope?: string[], status: 'pending' | 'running' = 'pending') => ({
    id,
    kind: 'implement' as const,
    owner: 'implementer' as const,
    purpose: `implement ${id}`,
    status,
    depends_on: [] as string[],
    acceptance_refs: ['ac-1'],
    evidence_refs: [],
    attempts: { fix: 0, switch: 0 },
    ...(file_scope !== undefined ? { file_scope } : {}),
  });

  test('ac-2: 2 mutating nodes with DISJOINT per-node file_scope → both admitted into a wave (per-node scope used, not the shared changed_files)', async () => {
    // changed_files is non-empty AND shared — if the loop used the shared list both
    // would collide. Disjoint per-node file_scope proves the per-node scope is used.
    await wis.update(WI, (w) => ({ ...w, changed_files: ['src/shared.ts'] }));
    await seed(
      graph({
        approval_gate: APPROVED,
        nodes: [mut('I1', ['src/a.ts']), mut('I2', ['src/b.ts'])],
      }),
    );
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('spawn_wave');
    if (res.action !== 'spawn_wave') throw new Error('expected spawn_wave');
    expect(res.spawns.map((s) => s.node_id).sort()).toEqual(['I1', 'I2']);
    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === 'I1')?.status).toBe('running');
    expect(after.nodes.find((n) => n.id === 'I2')?.status).toBe('running');
  });

  test('ac-2 fallback: a node WITHOUT file_scope falls back to workItem.changed_files', async () => {
    // I1 (scope ['src/a.ts']) and I2 (no scope → falls back to changed_files
    // ['src/a.ts']) overlap → not both in one wave (the fallback put them on the
    // same file). Proves the absent-scope branch uses changed_files.
    await wis.update(WI, (w) => ({ ...w, changed_files: ['src/a.ts'] }));
    await seed(
      graph({
        approval_gate: APPROVED,
        nodes: [mut('I1', ['src/a.ts']), mut('I2')],
      }),
    );
    await nextNode(repo, WI);
    const after = await aps.get(WI);
    const running = after.nodes.filter((n) => n.status === 'running');
    expect(running).toHaveLength(1); // overlap via fallback → only one dispatched
    expect(after.nodes.filter((n) => n.status === 'pending')).toHaveLength(1);
  });

  test('ac-3 cross-call: a running mutating node claims its file_scope — a ready mutating node with OVERLAPPING scope is NOT dispatched (serializes to a later call)', async () => {
    await wis.update(WI, (w) => ({ ...w, changed_files: [] }));
    await seed(
      graph({
        approval_gate: APPROVED,
        nodes: [mut('A', ['src/x.ts'], 'running'), mut('B', ['src/x.ts'])],
      }),
    );
    const res = await nextNode(repo, WI);
    // B overlaps the running A's claim → gate serializes it → nothing to dispatch.
    expect(res.action).toBe('waiting');
    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === 'B')?.status).toBe('pending');
    expect(after.nodes.find((n) => n.id === 'A')?.status).toBe('running');
  });

  test('ac-3 cross-call: a ready mutating node with DISJOINT scope from a running mutating node MAY dispatch', async () => {
    await wis.update(WI, (w) => ({ ...w, changed_files: [] }));
    await seed(
      graph({
        approval_gate: APPROVED,
        nodes: [mut('A', ['src/x.ts'], 'running'), mut('B', ['src/y.ts'])],
      }),
    );
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('spawn');
    if (res.action !== 'spawn') throw new Error('expected spawn');
    expect(res.node_id).toBe('B');
    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === 'B')?.status).toBe('running');
  });

  test('ac-3 within-wave: 2 ready mutating nodes with OVERLAPPING per-node file_scope are NOT both in one wave', async () => {
    await wis.update(WI, (w) => ({ ...w, changed_files: [] }));
    await seed(
      graph({
        approval_gate: APPROVED,
        nodes: [mut('I1', ['src/x.ts']), mut('I2', ['src/x.ts'])],
      }),
    );
    await nextNode(repo, WI);
    const after = await aps.get(WI);
    const running = after.nodes.filter((n) => n.status === 'running');
    expect(running).toHaveLength(1); // overlap → gate serializes the second
    expect(after.nodes.filter((n) => n.status === 'pending')).toHaveLength(1);
  });
});

// ac-2 (wi_26060678y): next-node dispatch creates an active-node lease; the matching
// record-result removes it on node termination so the active-lease count returns to 0.
describe('active-node lease lifecycle (ac-2: create on dispatch, remove on terminate)', () => {
  test('single-node dispatch creates a lease with node_id + file_scope', async () => {
    await seed(graph()); // N1 (planner) ready; changed_files = ['src/x.ts']
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('spawn');
    const leases = await new ActiveNodeLeaseStore(repo).listActive(WI);
    expect(leases).toHaveLength(1);
    expect(leases[0]?.node_id).toBe('N1');
    expect(leases[0]?.file_scope).toEqual(['src/x.ts']);
    expect(leases[0]?.work_item_id).toBe(WI);
  });

  test('record-result on a pass removes the lease (→ 0 active leases)', async () => {
    await seed(graph());
    await nextNode(repo, WI); // creates the N1 lease
    expect(await new ActiveNodeLeaseStore(repo).listActive(WI)).toHaveLength(1);
    await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N1',
        result_text: 'Wrote the plan: 3 steps mapping to ac-1, see plan.md.',
        outcome: 'pass',
        evidence_refs: [{ kind: 'file', path: 'plan.md', summary: 'plan' }],
      },
    });
    expect(await new ActiveNodeLeaseStore(repo).listActive(WI)).toHaveLength(0);
  });

  test('record-result on a (non-contentful) fail→retry also releases the lease', async () => {
    await seed(graph());
    await nextNode(repo, WI);
    await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: { node_id: 'N1', result_text: 'done', outcome: 'pass' }, // ack-only → fixable retry
    });
    // node re-armed to pending; no lease should leak while it is not running.
    expect(await new ActiveNodeLeaseStore(repo).listActive(WI)).toHaveLength(0);
  });
});

describe('nextNode main-session (e2e-author) node — wi_260610p9h g5', () => {
  const e2eAuthor = (id: string) => ({
    id,
    kind: 'e2e-author' as const,
    owner: 'main-session' as const,
    purpose: `author journeys ${id}`,
    status: 'pending' as const,
    depends_on: [] as string[],
    acceptance_refs: [] as string[],
    evidence_refs: [],
    attempts: { fix: 0, switch: 0 },
  });
  const research = (id: string) => ({
    id,
    kind: 'research' as const,
    owner: 'researcher' as const,
    purpose: `research ${id}`,
    status: 'pending' as const,
    depends_on: [] as string[],
    acceptance_refs: ['ac-1'],
    evidence_refs: [],
    attempts: { fix: 0, switch: 0 },
  });

  test('a main-session node is intercepted before spawn: action=main_session, dispatched to running', async () => {
    await seed(graph({ nodes: [e2eAuthor('E1')] }));
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('main_session');
    if (res.action !== 'main_session') throw new Error('expected main_session');
    expect(res.node_id).toBe('E1');
    expect(res.reason).toContain('e2e-author');
    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === 'E1')?.status).toBe('running');
  });

  test('a main-session node is not folded into a wave — single main_session path', async () => {
    await wis.update(WI, (w) => ({ ...w, changed_files: [] }));
    await seed(graph({ nodes: [e2eAuthor('E1'), research('R2')] }));
    const res = await nextNode(repo, WI);
    // only R2 is wave-eligible (main-session excluded) → single-node path, and the
    // first admitted node (E1) is the inline main-session step — same shape as the
    // driver/cleanup interception.
    expect(res.action).toBe('main_session');
    if (res.action !== 'main_session') throw new Error('expected main_session');
    expect(res.node_id).toBe('E1');
    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === 'R2')?.status).toBe('pending');
  });

  test('record-result closes a main-session node like any other (driver ran it inline)', async () => {
    await seed(graph({ nodes: [e2eAuthor('E1')] }));
    await nextNode(repo, WI); // dispatch E1 to running
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'E1',
        result_text:
          'Authored journey checkout-flow with the user; DSL at e2e/journeys/checkout.journey.md, conformance pass (exit 0).',
        outcome: 'pass',
        evidence_refs: [
          { kind: 'file', path: 'e2e/journeys/checkout.journey.md', summary: 'journey DSL' },
        ],
      },
    });
    expect(res.status).toBe('passed');
    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === 'E1')?.status).toBe('passed');
  });
});

describe('recordResult ac-closing evidence guard (n2: pass with pass-verdict but empty evidence_refs → fixable)', () => {
  const verifyGraph = (
    id: string,
    kind: 'verify' | 'review' | 'security',
    owner: string,
  ): Autopilot =>
    graph({
      nodes: [
        {
          id,
          kind,
          owner: owner as never,
          purpose: `${kind} the change against ac-1`,
          status: 'running',
          depends_on: [],
          acceptance_refs: ['ac-1'],
          evidence_refs: [],
          attempts: { fix: 0, switch: 0 },
        },
      ],
    });

  test('(a) verifier pass with ac_verdicts pass + empty evidence_refs → downgraded to fixable failure, node stays running', async () => {
    await seed(verifyGraph('V0', 'verify', 'verifier'));
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V0',
        result_text: 'verified ac-1 passes — ran the suite, all green',
        outcome: 'pass',
        ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'pass' }],
        evidence_refs: [],
      },
    });
    expect(res.outcome).toBe('fail');
    expect(res.failure_class).toBe('fixable');
    expect(res.guard_contentful).toBe(false);
    const node = (await aps.get(WI)).nodes.find((n) => n.id === 'V0');
    expect(node?.status).not.toBe('passed'); // pass transition blocked; goes to retry
  });

  test('(a2) verifier pass with empty top-level evidence_refs but per-AC evidence_refs on the pass verdict → NOT downgraded', async () => {
    await seed(verifyGraph('V0', 'verify', 'verifier'));
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V0',
        result_text: 'verified ac-1 — attached the suite output to the per-AC verdict',
        outcome: 'pass',
        ac_verdicts: [
          {
            criterion_id: 'ac-1',
            verdict: 'pass',
            evidence_refs: [{ kind: 'command', command: 'bun test', summary: 'all green' }],
          },
        ],
        evidence_refs: [],
      },
    });
    expect(res.outcome).toBe('pass');
    expect(res.status).toBe('passed');
    const node = (await aps.get(WI)).nodes.find((n) => n.id === 'V0');
    // per-AC evidence is preserved on the node for the completion bridge
    expect(node?.ac_verdicts?.[0]?.evidence_refs).toEqual([
      { kind: 'command', command: 'bun test', summary: 'all green' },
    ]);
  });

  test('(a3) two pass AC: one with per-AC evidence, one without, top-level empty → downgraded (the bare one is not proof)', async () => {
    await seed(verifyGraph('V0', 'verify', 'verifier'));
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V0',
        result_text: 'verified two criteria; only evidenced one',
        outcome: 'pass',
        ac_verdicts: [
          {
            criterion_id: 'ac-1',
            verdict: 'pass',
            evidence_refs: [{ kind: 'command', command: 'bun test', summary: 'green' }],
          },
          { criterion_id: 'ac-2', verdict: 'pass' },
        ],
        evidence_refs: [],
      },
    });
    expect(res.outcome).toBe('fail');
    expect(res.failure_class).toBe('fixable');
    // message guides the caller to either evidence path
    expect(res.reason).toMatch(/evidence_refs/);
    expect(res.reason).toMatch(/ac_verdict/);
  });

  test('(a4) empty top-level evidence_refs and pass AC with empty per-AC evidence_refs array → downgraded', async () => {
    await seed(verifyGraph('V0', 'verify', 'verifier'));
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V0',
        result_text: 'verified ac-1 — but no evidence anywhere',
        outcome: 'pass',
        ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'pass', evidence_refs: [] }],
        evidence_refs: [],
      },
    });
    expect(res.outcome).toBe('fail');
    expect(res.failure_class).toBe('fixable');
  });

  test('(b) review forward-expansion (has_findings=true) with ac_verdicts pass + empty evidence_refs → still downgraded, no splice', async () => {
    await seed(verifyGraph('R0', 'review', 'reviewer'));
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'R0',
        result_text: 'reviewed against ac-1; 1 issue remains but I marked ac-1 pass',
        outcome: 'pass',
        has_findings: true,
        ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'pass' }],
        evidence_refs: [],
      },
    });
    expect(res.outcome).toBe('fail');
    expect(res.failure_class).toBe('fixable');
    expect(res.promoted_node_ids).toEqual([]);
    expect((await aps.get(WI)).nodes).toHaveLength(1); // no forward splice
    const node = (await aps.get(WI)).nodes.find((n) => n.id === 'R0');
    expect(node?.status).not.toBe('passed');
  });

  test('(b2) security forward-expansion (has_findings=true) with ac_verdicts pass + empty evidence_refs → downgraded', async () => {
    await seed(verifyGraph('S0', 'security', 'security-reviewer'));
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'S0',
        result_text: 'security review of ac-1; finding open but claimed pass',
        outcome: 'pass',
        has_findings: true,
        ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'pass' }],
        evidence_refs: [],
      },
    });
    expect(res.outcome).toBe('fail');
    expect(res.failure_class).toBe('fixable');
    expect((await aps.get(WI)).nodes).toHaveLength(1);
  });

  test('(c) ac_verdicts with no pass (only fail/partial) + empty evidence_refs → NOT downgraded (per-AC granularity preserved)', async () => {
    await seed(verifyGraph('V0', 'verify', 'verifier'));
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V0',
        result_text:
          'verified ac-1 — it is partial / failing, recording the per-AC non-pass verdict',
        outcome: 'pass',
        ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'fail' }],
        evidence_refs: [],
      },
    });
    expect(res.outcome).toBe('pass');
    expect(res.status).toBe('passed');
  });

  test('(d) design pass (generated_nodes, no evidence_refs) → NOT downgraded by the new guard', async () => {
    await seed(verifyGraph('N1', 'verify', 'verifier'));
    // overwrite to a design/planner node
    await aps.write(WI, {
      ...(await aps.get(WI)),
      nodes: [
        {
          id: 'N1',
          kind: 'design',
          owner: 'planner',
          purpose: 'plan the change',
          status: 'running',
          depends_on: [],
          acceptance_refs: ['ac-1'],
          evidence_refs: [],
          ac_verdicts: [],
          attempts: { fix: 0, switch: 0 },
        },
      ],
    });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N1',
        result_text: 'plan: implement node then review node; generated the subgraph',
        outcome: 'pass',
        generated_nodes: [
          {
            id: 'G1',
            kind: 'implement',
            purpose: 'impl',
            depends_on: ['N1'],
            acceptance_refs: ['ac-1'],
          },
        ],
        evidence_refs: [],
      },
    });
    expect(res.outcome).toBe('pass');
    expect(res.status).toBe('passed');
    expect(res.promoted_node_ids).toEqual(['G1']);
  });

  test('(e) design plan-stage close projects the on-disk coverage.json path into node.evidence_refs', async () => {
    await seed(verifyGraph('N1', 'verify', 'verifier'));
    await aps.write(WI, {
      ...(await aps.get(WI)),
      nodes: [
        {
          id: 'N1',
          kind: 'design',
          owner: 'planner',
          purpose: 'plan the change',
          status: 'running',
          depends_on: [],
          acceptance_refs: ['ac-1'],
          evidence_refs: [],
          ac_verdicts: [],
          attempts: { fix: 0, switch: 0 },
        },
      ],
    });
    // a real coverage sweep ran → coverage.json exists on disk
    await new CoverageStore(repo).writeMap(WI, {
      schema_version: '0.1.0',
      work_item_id: WI,
      root_id: 'root',
      nodes: [],
    });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N1',
        result_text: 'plan closed: 6-axis coverage swept dry, brief produced',
        outcome: 'pass',
        evidence_refs: [],
        plan_brief: {
          change_surface: ['src/x.ts'],
          interface_changes: [],
          dod: [],
          test_scenarios: [],
          tier_inputs: {
            changedFileCount: 1,
            interfaceChanged: false,
            risk: { non_local: false, irreversible: false, unaudited: false },
            large: false,
          },
        },
      },
    });
    expect(res.outcome).toBe('pass');
    const node = (await aps.get(WI)).nodes.find((n) => n.id === 'N1');
    expect(
      node?.evidence_refs.some((e) => e.kind === 'file' && e.path?.includes('coverage.json')),
    ).toBe(true);
  });
});
