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
