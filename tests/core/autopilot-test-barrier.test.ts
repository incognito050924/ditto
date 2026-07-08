import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapAutopilot } from '~/core/autopilot-bootstrap';
import { assembleCompletionFromGraph } from '~/core/autopilot-complete';
import { OWNER_TOOLS, isMutatingOwner } from '~/core/autopilot-dispatch';
import { kindToOwner, selectReadyNodes } from '~/core/autopilot-graph';
import { nextNode, recordResult } from '~/core/autopilot-loop';
import { AutopilotStore } from '~/core/autopilot-store';
import { WorkItemStore } from '~/core/work-item-store';
import {
  type Autopilot,
  type AutopilotNode,
  autopilot,
  nodeKind,
  nodeOwner,
} from '~/schemas/autopilot';
import { intentContract } from '~/schemas/intent';
import type { WorkItem } from '~/schemas/work-item';

const NOW = new Date('2026-07-08T00:00:00.000Z');

const node = (over: Partial<AutopilotNode> & Pick<AutopilotNode, 'id'>): AutopilotNode => ({
  kind: 'verify',
  owner: 'verifier',
  purpose: 'verify',
  status: 'passed',
  depends_on: [],
  acceptance_refs: [],
  evidence_refs: [],
  ac_verdicts: [],
  attempts: { fix: 0, switch: 0 },
  ...over,
});

const graphWith = (nodes: AutopilotNode[]): Autopilot =>
  autopilot.parse({
    schema_version: '0.1.0',
    autopilot_id: 'orch_barriertest',
    work_item_id: 'wi_barriertest',
    root_goal: 'goal',
    approval_gate: { status: 'not_required', source: 'small_reversible_policy' },
    nodes,
    caps: { fix_per_node: 2, switch_per_node: 1, converge_rounds: 3 },
    continue_policy: {},
    stop_conditions: [],
  });

const workItemWith = (acIds: string[]): WorkItem =>
  ({
    id: 'wi_barriertest',
    changed_files: ['src/x.ts'],
    goal: 'the goal',
    acceptance_criteria: acIds.map((id) => ({
      id,
      statement: `${id} is met`,
      verdict: 'unverified',
      evidence: [],
    })),
  }) as unknown as WorkItem;

const ev = (path: string) => ({ kind: 'file' as const, path, summary: `evidence ${path}` });
const cmdEv = (command: string) => ({ kind: 'command' as const, command, summary: 'exit 0' });

// A per-AC verify node that closes ac-1 with real evidence — the "all AC pass" leg
// the barrier disposition is AND'd against.
const passingAc1 = () =>
  node({ id: 'V1', kind: 'verify', acceptance_refs: ['ac-1'], evidence_refs: [ev('verify.log')] });

// wi_260708ds9 ac-1 (impl-test-tier-plumbing): the settled-tree test barrier as a
// first-class graph+completion citizen. This suite mocks nothing external — it
// asserts the pure enum/mapping/completion plumbing.

describe('(a) test/tester enum + tester owner tooling', () => {
  test('`test` is a valid node kind and `tester` a valid owner', () => {
    expect(nodeKind.parse('test')).toBe('test');
    expect(nodeOwner.parse('tester')).toBe('tester');
  });

  // wi_260708ds9 (impl-barrier-runtime): the barrier became a DETERMINISTIC engine step,
  // so `test` maps to the `driver` pseudo-owner (run in-process by executeTestBarrier), NOT
  // an LLM `tester` subagent — an LLM tester could rationalize a red result into a green
  // claim, the false-green this WI closes.
  test('kindToOwner maps test → driver (deterministic engine step, not an LLM tester)', () => {
    expect(kindToOwner('test')).toBe('driver');
  });

  // `tester` is now VESTIGIAL (no kind maps to it) but kept: it is still in the nodeOwner
  // enum, so OWNER_TOOLS must stay a total map. It remains non-mutating (were it ever
  // reused, a mutating tester would deadlock 0-changed-file green barriers).
  test('tester is NON-mutating (vestigial but total-map-required): no Edit/Write in its toolset', () => {
    expect(OWNER_TOOLS.tester).toBeDefined();
    expect(OWNER_TOOLS.tester).not.toContain('Edit');
    expect(OWNER_TOOLS.tester).not.toContain('Write');
    // It DOES need Bash (run the suite) + read tools.
    expect(OWNER_TOOLS.tester).toContain('Bash');
    expect(OWNER_TOOLS.tester).toContain('Read');
    expect(isMutatingOwner('tester')).toBe(false);
  });
});

describe('(b) bootstrap seeds a settled-tree barrier depending on the implement frontier', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-barrier-boot-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function bootstrapped() {
    const wi = await new WorkItemStore(repo).create({
      title: 'pw',
      source_request: 'add endpoint',
      goal: 'POST /pw returns a score',
      acceptance_criteria: [
        {
          id: 'ac-1',
          statement: 'POST /pw returns 200 with a numeric score',
          verdict: 'unverified',
          evidence: [],
        },
      ],
    });
    const intent = intentContract.parse({
      schema_version: '0.1.0',
      work_item_id: wi.id,
      source_request: 'add endpoint',
      goal: 'POST /pw returns a score',
      acceptance_criteria: [
        {
          id: 'ac-1',
          statement: 'POST /pw returns 200 with a numeric score',
          evidence_required: ['test'],
        },
      ],
      question_policy: 'ask_only_if_user_only_can_answer',
    });
    const result = await bootstrapAutopilot(repo, {
      workItem: wi,
      intent,
      risk: { non_local: false, irreversible: false, unaudited: false },
    });
    if (result.status !== 'created') throw new Error(`expected created, got ${result.status}`);
    return result.graph;
  }

  test('the seed graph carries a `test` barrier owned by driver with acceptance_refs:[]', async () => {
    const g = await bootstrapped();
    const barrier = g.nodes.find((n) => n.kind === 'test');
    expect(barrier).toBeDefined();
    expect(barrier?.owner).toBe('driver');
    // acceptance_refs:[] keeps it OUT of the per-AC deriveAcVerdicts fold.
    expect(barrier?.acceptance_refs).toEqual([]);
  });

  test('the barrier depends on the implement node (implement frontier), not on design/verify', async () => {
    const g = await bootstrapped();
    const barrier = g.nodes.find((n) => n.kind === 'test');
    const implement = g.nodes.find((n) => n.kind === 'implement');
    expect(barrier?.depends_on).toEqual([implement?.id]);
  });
});

describe('(c) re-attach: on planner promotion the barrier tracks the promoted implement frontier (retro analogue) and does NOT keep the superseded seed implement', () => {
  let repo: string;
  let WI: string;
  const NOW2 = new Date('2026-07-08T00:00:00.000Z');

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-barrier-reattach-'));
    const wi = await new WorkItemStore(repo).create(
      {
        title: 'reattach',
        source_request: 'planner expansion',
        goal: 'barrier re-anchors on the promoted frontier',
        acceptance_criteria: [
          { id: 'ac-1', statement: 'one', verdict: 'unverified', evidence: [] },
          { id: 'ac-2', statement: 'two', verdict: 'unverified', evidence: [] },
        ],
      },
      NOW2,
    );
    WI = wi.id;
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test('design promotion supersedes the seed implement (barrier no longer keeps it) and re-points the barrier onto the promoted implement', async () => {
    // A bootstrap-shaped graph: N1(design) → N2(implement) → N3(verify) + barrier on N2.
    const g: Autopilot = {
      ...graphWith([
        node({
          id: 'N1',
          kind: 'design',
          owner: 'planner',
          status: 'pending',
          acceptance_refs: ['ac-1', 'ac-2'],
        }),
        node({
          id: 'N2',
          kind: 'implement',
          owner: 'implementer',
          status: 'pending',
          depends_on: ['N1'],
          acceptance_refs: ['ac-1', 'ac-2'],
        }),
        node({
          id: 'N3',
          kind: 'verify',
          owner: 'verifier',
          status: 'pending',
          depends_on: ['N2'],
          acceptance_refs: ['ac-1', 'ac-2'],
        }),
        node({
          id: 'test-barrier',
          kind: 'test',
          owner: 'tester',
          status: 'pending',
          depends_on: ['N2'],
        }),
      ]),
      work_item_id: WI,
    };
    await new AutopilotStore(repo).write(WI, g);
    await nextNode(repo, WI); // dispatch N1 (running)
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW2,
      payload: {
        node_id: 'N1',
        result_text: 'plan: G1 implements both ACs, G2 verifies both; seed successors covered',
        outcome: 'pass',
        generated_nodes: [
          {
            id: 'G1',
            kind: 'implement',
            purpose: 'impl',
            depends_on: ['N1'],
            acceptance_refs: ['ac-1', 'ac-2'],
          },
          {
            id: 'G2',
            kind: 'verify',
            purpose: 'verify',
            depends_on: ['G1'],
            acceptance_refs: ['ac-1', 'ac-2'],
          },
        ],
      },
    });
    // Regression guard: the seed implement N2 (and verify N3) are superseded — the
    // barrier's dependency on N2 must NOT have kept them alive.
    expect(res.superseded_node_ids?.sort()).toEqual(['N2', 'N3']);
    const grown = await new AutopilotStore(repo).get(WI);
    expect(grown.nodes.some((n) => n.id === 'N2')).toBe(false);
    // The barrier survives (acceptance_refs:[] → never a supersede candidate) and now
    // depends on the PROMOTED implement frontier (G1), not the removed seed N2.
    const barrier = grown.nodes.find((n) => n.kind === 'test');
    expect(barrier).toBeDefined();
    expect(barrier?.depends_on).toEqual(['G1']);
  });
});

describe('(d) completion seam: barrier-green AND per-AC oracles', () => {
  test('GREEN barrier (passed + command evidence) + all AC pass → final_verdict=pass', () => {
    const graph = graphWith([
      passingAc1(),
      node({
        id: 'BARRIER',
        kind: 'test',
        owner: 'tester',
        acceptance_refs: [],
        status: 'passed',
        evidence_refs: [cmdEv('bun test')],
      }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), { now: NOW });
    expect(c.acceptance.find((a) => a.criterion_id === 'ac-1')?.verdict).toBe('pass');
    expect(c.unverified.filter((u) => !u.out_of_scope)).toEqual([]);
    expect(c.final_verdict).toBe('pass');
  });

  test('DEGRADE barrier (passed, NO command evidence: could not execute) + all AC pass → final_verdict≠pass, in-scope unverified injected', () => {
    const graph = graphWith([
      passingAc1(),
      node({
        id: 'BARRIER',
        kind: 'test',
        owner: 'tester',
        acceptance_refs: [],
        status: 'passed',
        evidence_refs: [
          { kind: 'note', summary: 'no test runner on host — suite did not execute' },
        ],
      }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), { now: NOW });
    // The per-AC oracle still passed…
    expect(c.acceptance.find((a) => a.criterion_id === 'ac-1')?.verdict).toBe('pass');
    // …but the degraded barrier floors the final verdict off pass (honest, ADR-0018).
    expect(c.final_verdict).not.toBe('pass');
    const inScope = c.unverified.filter((u) => !u.out_of_scope);
    expect(inScope.length).toBe(1);
    expect(inScope[0]?.item).toContain('BARRIER');
  });

  test('RED barrier (failed) present at completion → final_verdict≠pass even with all AC pass (no false-green through the completion path)', () => {
    const graph = graphWith([
      passingAc1(),
      node({
        id: 'BARRIER',
        kind: 'test',
        owner: 'tester',
        acceptance_refs: [],
        status: 'failed',
        evidence_refs: [cmdEv('bun test')],
      }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), { now: NOW });
    expect(c.final_verdict).not.toBe('pass');
    expect(c.unverified.some((u) => !u.out_of_scope && u.item.includes('BARRIER'))).toBe(true);
  });
});

describe('(c) settled-tree HOLD: barrier is held while any implement node is non-terminal', () => {
  // design(passed) → implement(pending) ; barrier depends on design (ready), but must
  // be held because an implement node is still non-terminal (else it fires on an
  // unsettled tree — the B3 hazard, violating the "settled tree" invariant).
  const treeWithBarrier = (implStatus: AutopilotNode['status']): AutopilotNode[] => [
    node({ id: 'N1', kind: 'design', owner: 'planner', status: 'passed' }),
    node({
      id: 'N2',
      kind: 'implement',
      owner: 'implementer',
      status: implStatus,
      depends_on: ['N1'],
    }),
    node({ id: 'BAR', kind: 'test', owner: 'tester', status: 'pending', depends_on: ['N1'] }),
  ];

  test('barrier is NOT ready while an implement node is pending (even though its own deps passed)', () => {
    const ready = selectReadyNodes(treeWithBarrier('pending')).map((n) => n.id);
    expect(ready).not.toContain('BAR');
  });

  test('barrier is NOT ready while an implement node is running', () => {
    const ready = selectReadyNodes(treeWithBarrier('running')).map((n) => n.id);
    expect(ready).not.toContain('BAR');
  });

  test('barrier BECOMES ready once every implement node is terminal (settled tree)', () => {
    const ready = selectReadyNodes(treeWithBarrier('passed')).map((n) => n.id);
    expect(ready).toContain('BAR');
  });
});

describe('(c2) settled-tree HOLD extends to converge-spliced fix nodes (mutating in flight)', () => {
  // A review found a defect, so converge forward-spliced a `fix` node (owner
  // implementer = MUTATING) that depends on the review, NOT on the barrier. The
  // barrier's own deps (the implement frontier N2) are already passed, so it is
  // dependency-ready — but a fix subagent is still editing the tree. Firing the
  // full suite now yields a false RED (spurious retry) or, worse, passes BEFORE
  // the fix lands and never re-runs → STALE GREEN. The hold must count the fix.
  const treeWithFixInFlight = (fixStatus: AutopilotNode['status']): AutopilotNode[] => [
    node({ id: 'N1', kind: 'design', owner: 'planner', status: 'passed' }),
    node({
      id: 'N2',
      kind: 'implement',
      owner: 'implementer',
      status: 'passed',
      depends_on: ['N1'],
    }),
    node({ id: 'R1', kind: 'review', owner: 'reviewer', status: 'passed', depends_on: ['N2'] }),
    node({ id: 'FIX', kind: 'fix', owner: 'implementer', status: fixStatus, depends_on: ['R1'] }),
    node({ id: 'BAR', kind: 'test', owner: 'tester', status: 'pending', depends_on: ['N2'] }),
  ];

  test('barrier is NOT ready while a fix node is pending (implement frontier settled, but a fix mutates the tree)', () => {
    const ready = selectReadyNodes(treeWithFixInFlight('pending')).map((n) => n.id);
    expect(ready).not.toContain('BAR');
  });

  test('barrier is NOT ready while a fix node is running', () => {
    const ready = selectReadyNodes(treeWithFixInFlight('running')).map((n) => n.id);
    expect(ready).not.toContain('BAR');
  });

  test('barrier BECOMES ready once the fix node is terminal (tree settled again)', () => {
    const ready = selectReadyNodes(treeWithFixInFlight('passed')).map((n) => n.id);
    expect(ready).toContain('BAR');
  });
});

describe('(e) legacy fall-through: structural absence grandfathers to AC-only completion', () => {
  test('a legacy graph with ZERO test nodes + all AC pass → final_verdict=pass (no deadlock, no injected unverified)', () => {
    const graph = graphWith([passingAc1()]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), { now: NOW });
    expect(c.acceptance.find((a) => a.criterion_id === 'ac-1')?.verdict).toBe('pass');
    expect(c.unverified.filter((u) => !u.out_of_scope)).toEqual([]);
    expect(c.final_verdict).toBe('pass');
  });
});

describe('(d/loop) a persistent-RED barrier blocks: nextNode → done, all_passed=false', () => {
  let repo: string;
  let WI: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-barrier-loop-'));
    const wi = await new WorkItemStore(repo).create(
      {
        title: 'barrier loop',
        source_request: 'settled-tree barrier',
        goal: 'the barrier gates completion',
        acceptance_criteria: [
          { id: 'ac-1', statement: 'suite green', verdict: 'unverified', evidence: [] },
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

  const seedGraph = (barrierStatus: AutopilotNode['status']): Autopilot =>
    graphWith([
      node({ id: 'N1', kind: 'design', owner: 'planner', status: 'passed' }),
      node({
        id: 'N2',
        kind: 'implement',
        owner: 'implementer',
        status: 'passed',
        depends_on: ['N1'],
      }),
      node({
        id: 'N3',
        kind: 'verify',
        owner: 'verifier',
        status: 'passed',
        depends_on: ['N2'],
        acceptance_refs: ['ac-1'],
        evidence_refs: [ev('verify.log')],
      }),
      node({
        id: 'BAR',
        kind: 'test',
        owner: 'tester',
        status: barrierStatus,
        depends_on: ['N2'],
        evidence_refs: [cmdEv('bun test')],
      }),
    ]);

  test('all terminal, barrier FAILED → done with all_passed=false (RED barrier blocks the pass)', async () => {
    const g = { ...seedGraph('failed'), work_item_id: WI };
    await new AutopilotStore(repo).write(WI, g);
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('done');
    if (res.action !== 'done') throw new Error('expected done');
    expect(res.all_passed).toBe(false);
  });

  test('control: same graph, barrier PASSED (green) → all_passed=true (barrier does not spuriously block)', async () => {
    const g = { ...seedGraph('passed'), work_item_id: WI };
    await new AutopilotStore(repo).write(WI, g);
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('done');
    if (res.action !== 'done') throw new Error('expected done');
    expect(res.all_passed).toBe(true);
  });
});
