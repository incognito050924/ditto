import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleCompletionFromGraph } from '~/core/autopilot-complete';
import { executeTestBarrier, nextNode, resolveBarrierCommand } from '~/core/autopilot-loop';
import { AutopilotStore } from '~/core/autopilot-store';
import type { TestRunner } from '~/core/test-runner';
import { WorkItemStore } from '~/core/work-item-store';
import { type Autopilot, type AutopilotNode, autopilot } from '~/schemas/autopilot';
import { recipe as recipeSchema } from '~/schemas/recipe';
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

const graphWith = (nodes: AutopilotNode[], wi: string): Autopilot =>
  autopilot.parse({
    schema_version: '0.1.0',
    autopilot_id: 'orch_barrierrt',
    work_item_id: wi,
    root_goal: 'goal',
    approval_gate: { status: 'not_required', source: 'small_reversible_policy' },
    nodes,
    caps: { fix_per_node: 2, switch_per_node: 1, converge_rounds: 3 },
    continue_policy: {},
    stop_conditions: [],
  });

const workItemWith = (acIds: string[]): WorkItem =>
  ({
    id: 'wi_barrierrt',
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

/** The single `test` barrier node in a graph (throws if absent — no non-null assertion). */
const barrierOf = (g: Autopilot): AutopilotNode => {
  const b = g.nodes.find((n) => n.kind === 'test');
  if (!b) throw new Error('no barrier node in graph');
  return b;
};

// Mock runners — the exit-code discriminator is unit-tested separately (test-runner.test.ts);
// here the barrier ORCHESTRATION is isolated by injecting each terminal directly.
const passRunner: TestRunner = async () => ({ kind: 'passed' });
const failRunner: TestRunner = async () => ({ kind: 'failed', exitCode: 1 });
const unrunnableRunner: TestRunner = async () => ({
  kind: 'unrunnable',
  reason: 'command not found',
});
const timeoutRunner: TestRunner = async () => ({ kind: 'timeout', timeoutMs: 100 });

describe('resolveBarrierCommand (per-repo → top-level fallback, push-gate symmetric)', () => {
  const rec = recipeSchema.parse({
    barrier_test_command: 'bun test --filter unit',
    repos: [
      { dir: 'apps/api', barrier_test_command: 'cd apps/api && npm test' },
      { dir: 'apps/web' }, // no own barrier command → falls back to top-level
    ],
  });
  test("root (repoRelDir='') resolves the top-level command", () => {
    expect(resolveBarrierCommand(rec, '')).toBe('bun test --filter unit');
  });
  test('a declared sub-repo resolves its OWN barrier command', () => {
    expect(resolveBarrierCommand(rec, 'apps/api')).toBe('cd apps/api && npm test');
  });
  test('a sub-repo without an own command falls back to the top-level command', () => {
    expect(resolveBarrierCommand(rec, 'apps/web')).toBe('bun test --filter unit');
  });
  test('an absent top-level command → undefined (drives the runtime degrade)', () => {
    expect(resolveBarrierCommand(recipeSchema.parse({}), '')).toBeUndefined();
  });
});

describe('executeTestBarrier — deterministic exit-code → node disposition', () => {
  let repo: string;
  const WI = 'wi_barrierrt';

  const seedBarrierOnly = async (): Promise<void> => {
    const g = graphWith(
      [node({ id: 'BAR', kind: 'test', owner: 'driver', status: 'pending' })],
      WI,
    );
    await new AutopilotStore(repo).write(WI, g);
  };
  const barrierNode = async (): Promise<AutopilotNode> => {
    const g = await new AutopilotStore(repo).get(WI);
    const b = g.nodes.find((n) => n.kind === 'test');
    if (!b) throw new Error('no barrier');
    return b;
  };

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-barrier-rt-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test('GREEN (exit 0) → node passed WITH command-kind evidence (proven-green)', async () => {
    await seedBarrierOnly();
    const aps = new AutopilotStore(repo);
    const res = await executeTestBarrier({
      aps,
      workItemId: WI,
      node: await barrierNode(),
      caps: (await aps.get(WI)).caps,
      runs: [{ dir: '', command: 'bun test', cwd: repo }],
      runner: passRunner,
      now: NOW,
    });
    expect(res.disposition).toBe('green');
    const b = await barrierNode();
    expect(b.status).toBe('passed');
    expect(b.evidence_refs.some((e) => e.kind === 'command')).toBe(true);
  });

  test('126/127 unrunnable → DEGRADE (proceed: passed, NO command evidence; NOT block, NOT claim pass)', async () => {
    await seedBarrierOnly();
    const aps = new AutopilotStore(repo);
    const res = await executeTestBarrier({
      aps,
      workItemId: WI,
      node: await barrierNode(),
      caps: (await aps.get(WI)).caps,
      runs: [{ dir: '', command: 'nope', cwd: repo }],
      runner: unrunnableRunner,
      now: NOW,
    });
    expect(res.disposition).toBe('degrade');
    const b = await barrierNode();
    // Proceeds (passed) but carries NO command evidence → the completion seam floors ≠pass.
    expect(b.status).toBe('passed');
    expect(b.evidence_refs.some((e) => e.kind === 'command')).toBe(false);
    // Logged auditably as an in-flow surface (blocked_external).
    const decisions = await aps.readDecisions(WI);
    expect(decisions.some((d) => d.decision === 'surface' && d.node_id === 'BAR')).toBe(true);
  });

  test('timeout/hang → DEGRADE/surface (proceed, never an infinite stall)', async () => {
    await seedBarrierOnly();
    const aps = new AutopilotStore(repo);
    const res = await executeTestBarrier({
      aps,
      workItemId: WI,
      node: await barrierNode(),
      caps: (await aps.get(WI)).caps,
      runs: [{ dir: '', command: 'sleep 999', cwd: repo }],
      runner: timeoutRunner,
      now: NOW,
    });
    expect(res.disposition).toBe('timeout');
    const b = await barrierNode();
    expect(b.status).toBe('passed');
    expect(b.evidence_refs.some((e) => e.kind === 'command')).toBe(false);
  });

  test('absent barrier command (undefined) → DEGRADE (proceed, tests unverified)', async () => {
    await seedBarrierOnly();
    const aps = new AutopilotStore(repo);
    const res = await executeTestBarrier({
      aps,
      workItemId: WI,
      node: await barrierNode(),
      caps: (await aps.get(WI)).caps,
      runs: [{ dir: '', command: undefined, cwd: repo }],
      runner: failRunner, // never consulted — no command to run
      now: NOW,
    });
    expect(res.disposition).toBe('degrade');
    const b = await barrierNode();
    expect(b.status).toBe('passed');
    expect(b.evidence_refs.some((e) => e.kind === 'command')).toBe(false);
  });

  test('RED (non-zero) → bounded auto-retry up to N (caps.fix_per_node=2) then FAILED', async () => {
    await seedBarrierOnly();
    const aps = new AutopilotStore(repo);
    const dispositions: string[] = [];
    // caps.fix_per_node=2 → two retries, then the third RED exhausts the cap → failed.
    for (let i = 0; i < 3; i++) {
      const g = await aps.get(WI);
      const res = await executeTestBarrier({
        aps,
        workItemId: WI,
        node: barrierOf(g),
        caps: g.caps,
        runs: [{ dir: '', command: 'bun test', cwd: repo }],
        runner: failRunner,
        now: NOW,
      });
      dispositions.push(res.disposition);
    }
    expect(dispositions).toEqual(['red_retry', 'red_retry', 'red_failed']);
    const b = await barrierNode();
    expect(b.status).toBe('failed');
    // The terminal RED escalates (a persistent red suite is a user-owned decision).
    const decisions = await aps.readDecisions(WI);
    expect(decisions.some((d) => d.decision === 'escalate' && d.node_id === 'BAR')).toBe(true);
  });
});

describe('executeTestBarrier feeds the completion seam (execution → final verdict)', () => {
  let repo: string;
  const WI = 'wi_barrierrt';
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-barrier-rt-comp-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const seed = async () => {
    const g = graphWith(
      [
        node({ id: 'V1', kind: 'verify', acceptance_refs: ['ac-1'], evidence_refs: [ev('v.log')] }),
        node({ id: 'BAR', kind: 'test', owner: 'driver', status: 'pending' }),
      ],
      WI,
    );
    await new AutopilotStore(repo).write(WI, g);
  };

  test('GREEN barrier execution → no in-scope unverified → final_verdict=pass', async () => {
    await seed();
    const aps = new AutopilotStore(repo);
    const g0 = await aps.get(WI);
    await executeTestBarrier({
      aps,
      workItemId: WI,
      node: barrierOf(g0),
      caps: g0.caps,
      runs: [{ dir: '', command: 'bun test', cwd: repo }],
      runner: passRunner,
      now: NOW,
    });
    const c = assembleCompletionFromGraph(await aps.get(WI), workItemWith(['ac-1']), { now: NOW });
    expect(c.unverified.filter((u) => !u.out_of_scope)).toEqual([]);
    expect(c.final_verdict).toBe('pass');
  });

  test('DEGRADE barrier execution → in-scope unverified injected → final_verdict≠pass', async () => {
    await seed();
    const aps = new AutopilotStore(repo);
    const g0 = await aps.get(WI);
    await executeTestBarrier({
      aps,
      workItemId: WI,
      node: barrierOf(g0),
      caps: g0.caps,
      runs: [{ dir: '', command: 'nope', cwd: repo }],
      runner: unrunnableRunner,
      now: NOW,
    });
    const c = assembleCompletionFromGraph(await aps.get(WI), workItemWith(['ac-1']), { now: NOW });
    expect(c.final_verdict).not.toBe('pass');
    expect(c.unverified.some((u) => !u.out_of_scope && u.item.includes('BAR'))).toBe(true);
  });
});

// End-to-end wiring: nextNode intercepts a ready `test` barrier, resolves the recipe
// command, and RUNS it via the REAL runner (deterministic trivial shell commands).
describe('nextNode wires the barrier (recipe command → real run → verdict)', () => {
  let repo: string;
  let WI: string;

  const settledGraph = (): AutopilotNode[] => [
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
      evidence_refs: [ev('v.log')],
    }),
    node({ id: 'BAR', kind: 'test', owner: 'driver', status: 'pending', depends_on: ['N2'] }),
  ];

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-barrier-wire-'));
    const wi = await new WorkItemStore(repo).create(
      {
        title: 'barrier wire',
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

  const writeRecipe = async (command: string): Promise<void> => {
    await writeFile(join(repo, 'recipe.yaml'), `barrier_test_command: "${command}"\n`, 'utf8');
  };

  test('recipe command exits 0 → nextNode returns action=barrier disposition=green; node passed + command evidence', async () => {
    await writeRecipe('exit 0');
    await new AutopilotStore(repo).write(WI, {
      ...graphWith(settledGraph(), WI),
      work_item_id: WI,
    });
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('barrier');
    if (res.action !== 'barrier') throw new Error('expected barrier');
    expect(res.disposition).toBe('green');
    const b = (await new AutopilotStore(repo).get(WI)).nodes.find((n) => n.kind === 'test');
    expect(b?.status).toBe('passed');
    expect(b?.evidence_refs.some((e) => e.kind === 'command')).toBe(true);
  });

  test('recipe command exits non-zero → nextNode returns action=barrier disposition=red_retry (bounded retry, not a stall)', async () => {
    await writeRecipe('exit 1');
    await new AutopilotStore(repo).write(WI, {
      ...graphWith(settledGraph(), WI),
      work_item_id: WI,
    });
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('barrier');
    if (res.action !== 'barrier') throw new Error('expected barrier');
    expect(res.disposition).toBe('red_retry');
    const b = (await new AutopilotStore(repo).get(WI)).nodes.find((n) => n.kind === 'test');
    expect(b?.status).toBe('pending'); // re-armed for the next poll
  });

  test('NO recipe command (absent) → nextNode returns action=barrier disposition=degrade (proceed, never a validation error)', async () => {
    // no recipe.yaml written
    await new AutopilotStore(repo).write(WI, {
      ...graphWith(settledGraph(), WI),
      work_item_id: WI,
    });
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('barrier');
    if (res.action !== 'barrier') throw new Error('expected barrier');
    expect(res.disposition).toBe('degrade');
  });
});
