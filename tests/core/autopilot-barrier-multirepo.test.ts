import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { affectedBarrierDirs, executeTestBarrier, planBarrierRuns } from '~/core/autopilot-loop';
import { AutopilotStore } from '~/core/autopilot-store';
import type { TestRunOutcome, TestRunner } from '~/core/test-runner';
import { type Autopilot, type AutopilotNode, autopilot } from '~/schemas/autopilot';
import { recipe as recipeSchema } from '~/schemas/recipe';

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
    autopilot_id: 'orch_barriermulti',
    work_item_id: wi,
    root_goal: 'goal',
    approval_gate: { status: 'not_required', source: 'small_reversible_policy' },
    nodes,
    caps: { fix_per_node: 2, switch_per_node: 1, converge_rounds: 3 },
    continue_policy: {},
    stop_conditions: [],
  });

/** A runner that returns a per-command outcome and records (command, cwd) of every call. */
const recordingRunner = (
  map: Record<string, TestRunOutcome>,
  calls: Array<{ command: string; cwd: string }>,
): TestRunner => {
  const runner: TestRunner = async (command, cwd) => {
    calls.push({ command, cwd });
    return map[command] ?? { kind: 'passed' };
  };
  return runner;
};

// ── The pure changed-file → affected-sub-repo mapping (deepest dir prefix, distinct set) ──
describe('affectedBarrierDirs (changed files → affected sub-repo dirs)', () => {
  const recFeBe = recipeSchema.parse({
    barrier_test_command: 'bun test',
    repos: [
      { dir: 'frontend', barrier_test_command: 'fe test' },
      { dir: 'backend', barrier_test_command: 'be test' },
    ],
  });

  test('a file under each sub-repo → both sub-repo dirs (distinct, in first-seen order)', () => {
    expect(affectedBarrierDirs(['frontend/a.ts', 'backend/b.ts'], recFeBe)).toEqual([
      'frontend',
      'backend',
    ]);
  });

  test('a root-level file (under no repos[].dir) maps to ROOT ("")', () => {
    expect(affectedBarrierDirs(['src/x.ts'], recFeBe)).toEqual(['']);
  });

  test('mixes root + sub-repo, de-duplicating each dir', () => {
    expect(affectedBarrierDirs(['src/x.ts', 'frontend/a.ts', 'frontend/b.ts'], recFeBe)).toEqual([
      '',
      'frontend',
    ]);
  });

  test('picks the DEEPEST matching dir prefix (nested repos)', () => {
    const nested = recipeSchema.parse({
      barrier_test_command: 'bun test',
      repos: [{ dir: 'apps' }, { dir: 'apps/api', barrier_test_command: 'api test' }],
    });
    expect(affectedBarrierDirs(['apps/api/src/x.ts'], nested)).toEqual(['apps/api']);
  });

  test('no changed files → ROOT only (byte-identical to the single-run path)', () => {
    expect(affectedBarrierDirs([], recFeBe)).toEqual(['']);
  });

  test('no repos[] in the recipe → every file maps to ROOT', () => {
    const rootOnly = recipeSchema.parse({ barrier_test_command: 'bun test' });
    expect(affectedBarrierDirs(['frontend/a.ts', 'src/x.ts'], rootOnly)).toEqual(['']);
  });
});

// ── planBarrierRuns: affected dir → resolved command + absolute cwd ──
describe('planBarrierRuns (affected dir → command + cwd under the workspace root)', () => {
  test('resolves each sub-repo OWN command with cwd = workspaceRoot/dir', () => {
    const rec = recipeSchema.parse({
      barrier_test_command: 'bun test',
      repos: [
        { dir: 'frontend', barrier_test_command: 'fe test' },
        { dir: 'backend', barrier_test_command: 'be test' },
      ],
    });
    const runs = planBarrierRuns(rec, ['frontend/a.ts', 'backend/b.ts'], '/ws');
    expect(runs).toEqual([
      { dir: 'frontend', command: 'fe test', cwd: '/ws/frontend' },
      { dir: 'backend', command: 'be test', cwd: '/ws/backend' },
    ]);
  });

  test('a sub-repo without its own command falls back to the top-level command', () => {
    const rec = recipeSchema.parse({
      barrier_test_command: 'root test',
      repos: [{ dir: 'frontend' }],
    });
    const runs = planBarrierRuns(rec, ['frontend/a.ts'], '/ws');
    expect(runs).toEqual([{ dir: 'frontend', command: 'root test', cwd: '/ws/frontend' }]);
  });

  test('root-only changed_files → ONE run at the workspace root', () => {
    const rec = recipeSchema.parse({ barrier_test_command: 'root test' });
    expect(planBarrierRuns(rec, ['src/x.ts'], '/ws')).toEqual([
      { dir: '', command: 'root test', cwd: '/ws' },
    ]);
  });
});

// ── executeTestBarrier: N runs → ONE worst-wins barrier node outcome ──
describe('executeTestBarrier — per-sub-repo runs, worst-wins into ONE barrier node', () => {
  let repo: string;
  const WI = 'wi_barriermulti';

  const seedBarrierOnly = async (): Promise<AutopilotNode> => {
    const g = graphWith(
      [node({ id: 'BAR', kind: 'test', owner: 'driver', status: 'pending' })],
      WI,
    );
    await new AutopilotStore(repo).write(WI, g);
    const b = g.nodes.find((n) => n.kind === 'test');
    if (!b) throw new Error('no barrier');
    return b;
  };
  const barrierNode = async (): Promise<AutopilotNode> => {
    const b = (await new AutopilotStore(repo).get(WI)).nodes.find((n) => n.kind === 'test');
    if (!b) throw new Error('no barrier');
    return b;
  };
  const hasCommandEvidence = async (): Promise<boolean> =>
    (await barrierNode()).evidence_refs.some((e) => e.kind === 'command');

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-barrier-multi-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  // (a) each affected sub-repo command is invoked exactly once with the right cwd.
  test('runs each affected sub-repo command exactly once with cwd = workspaceRoot/dir', async () => {
    const bar = await seedBarrierOnly();
    const aps = new AutopilotStore(repo);
    const calls: Array<{ command: string; cwd: string }> = [];
    const rec = recipeSchema.parse({
      barrier_test_command: 'root test',
      repos: [
        { dir: 'frontend', barrier_test_command: 'fe test' },
        { dir: 'backend', barrier_test_command: 'be test' },
      ],
    });
    const res = await executeTestBarrier({
      aps,
      workItemId: WI,
      node: bar,
      caps: (await aps.get(WI)).caps,
      runs: planBarrierRuns(rec, ['frontend/a.ts', 'backend/b.ts'], repo),
      runner: recordingRunner({}, calls),
      now: NOW,
    });
    expect(res.disposition).toBe('green');
    expect(calls).toEqual([
      { command: 'fe test', cwd: join(repo, 'frontend') },
      { command: 'be test', cwd: join(repo, 'backend') },
    ]);
  });

  // (b) worst-wins: [passed, failed] → RED (node not green, no command evidence).
  test('[passed, failed] → RED (failed dominates): node not passed-green', async () => {
    const bar = await seedBarrierOnly();
    const aps = new AutopilotStore(repo);
    const res = await executeTestBarrier({
      aps,
      workItemId: WI,
      node: bar,
      caps: (await aps.get(WI)).caps,
      runs: [
        { dir: 'frontend', command: 'fe test', cwd: join(repo, 'frontend') },
        { dir: 'backend', command: 'be test', cwd: join(repo, 'backend') },
      ],
      runner: recordingRunner({ 'be test': { kind: 'failed', exitCode: 1 } }, []),
      now: NOW,
    });
    expect(res.disposition).toBe('red_retry');
    expect(await hasCommandEvidence()).toBe(false);
  });

  // (b) worst-wins: [passed, unrunnable] → DEGRADE (proceed, no command evidence).
  test('[passed, unrunnable] → DEGRADE: node passed but NO command evidence', async () => {
    const bar = await seedBarrierOnly();
    const aps = new AutopilotStore(repo);
    const res = await executeTestBarrier({
      aps,
      workItemId: WI,
      node: bar,
      caps: (await aps.get(WI)).caps,
      runs: [
        { dir: 'frontend', command: 'fe test', cwd: join(repo, 'frontend') },
        { dir: 'backend', command: 'be test', cwd: join(repo, 'backend') },
      ],
      runner: recordingRunner(
        { 'be test': { kind: 'unrunnable', reason: 'command not found' } },
        [],
      ),
      now: NOW,
    });
    expect(res.disposition).toBe('degrade');
    expect((await barrierNode()).status).toBe('passed');
    expect(await hasCommandEvidence()).toBe(false);
  });

  // (b) worst-wins: [passed, passed] → GREEN (with command evidence).
  test('[passed, passed] → GREEN: node passed WITH command evidence', async () => {
    const bar = await seedBarrierOnly();
    const aps = new AutopilotStore(repo);
    const res = await executeTestBarrier({
      aps,
      workItemId: WI,
      node: bar,
      caps: (await aps.get(WI)).caps,
      runs: [
        { dir: 'frontend', command: 'fe test', cwd: join(repo, 'frontend') },
        { dir: 'backend', command: 'be test', cwd: join(repo, 'backend') },
      ],
      runner: recordingRunner({}, []),
      now: NOW,
    });
    expect(res.disposition).toBe('green');
    expect((await barrierNode()).status).toBe('passed');
    expect(await hasCommandEvidence()).toBe(true);
  });

  // (b) worst-wins: a sub-repo with NO resolved command → DEGRADE (no command evidence).
  test('a sub-repo missing a barrier command → DEGRADE (no command evidence)', async () => {
    const bar = await seedBarrierOnly();
    const aps = new AutopilotStore(repo);
    const res = await executeTestBarrier({
      aps,
      workItemId: WI,
      node: bar,
      caps: (await aps.get(WI)).caps,
      runs: [
        { dir: 'frontend', command: 'fe test', cwd: join(repo, 'frontend') },
        { dir: 'backend', command: undefined, cwd: join(repo, 'backend') },
      ],
      runner: recordingRunner({}, []),
      now: NOW,
    });
    expect(res.disposition).toBe('degrade');
    expect(await hasCommandEvidence()).toBe(false);
  });

  // (c) root-only changed_files → EXACTLY ONE root command, no sub-repo command.
  test('root-only changed_files → exactly ONE root run (no sub-repo command)', async () => {
    const bar = await seedBarrierOnly();
    const aps = new AutopilotStore(repo);
    const calls: Array<{ command: string; cwd: string }> = [];
    const rec = recipeSchema.parse({
      barrier_test_command: 'root test',
      repos: [{ dir: 'frontend', barrier_test_command: 'fe test' }],
    });
    const res = await executeTestBarrier({
      aps,
      workItemId: WI,
      node: bar,
      caps: (await aps.get(WI)).caps,
      runs: planBarrierRuns(rec, ['src/x.ts'], repo),
      runner: recordingRunner({}, calls),
      now: NOW,
    });
    expect(res.disposition).toBe('green');
    expect(calls).toEqual([{ command: 'root test', cwd: repo }]);
  });
});
