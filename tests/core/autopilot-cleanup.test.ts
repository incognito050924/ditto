import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupApprovalGate, planCleanup, runCleanup } from '~/core/autopilot-cleanup';
import { nextNode } from '~/core/autopilot-loop';
import { AutopilotStore } from '~/core/autopilot-store';
import { WorkItemStore } from '~/core/work-item-store';
import { createWorktreeForRun, listRunWorktrees } from '~/core/worktree';
import type { Autopilot, AutopilotNode } from '~/schemas/autopilot';

let repo: string;
let aps: AutopilotStore;
let wis: WorkItemStore;
let WI: string;
const NOW = new Date('2026-06-02T00:00:00.000Z');

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function cleanupNode(overrides: Partial<AutopilotNode> = {}): AutopilotNode {
  return {
    id: 'C1',
    kind: 'cleanup',
    owner: 'driver',
    purpose: 'tear down run worktrees',
    status: 'pending',
    depends_on: [],
    acceptance_refs: ['ac-1'],
    evidence_refs: [],
    attempts: { fix: 0, switch: 0 },
    ...overrides,
  };
}

function graph(nodes: AutopilotNode[], approval = 'not_required'): Autopilot {
  return {
    schema_version: '0.1.0',
    autopilot_id: 'orch_cleanuptest',
    work_item_id: WI,
    mode: 'autopilot',
    root_goal: 'goal',
    completion_boundary: 'entire_work_item',
    approval_gate: {
      status: approval as Autopilot['approval_gate']['status'],
      source: approval === 'approved' ? 'user' : 'small_reversible_policy',
      approved_at: null,
      approved_by: null,
      evidence_refs: [],
    },
    nodes,
    caps: { fix_per_node: 2, switch_per_node: 1, converge_rounds: 3 },
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
  repo = await mkdtemp(join(tmpdir(), 'ditto-cleanup-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'ditto@example.test']);
  git(['config', 'user.name', 'DITTO Test']);
  await writeFile(join(repo, 'README.md'), 'hello\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'initial']);
  aps = new AutopilotStore(repo);
  wis = new WorkItemStore(repo);
  const wi = await wis.create(
    {
      title: 'cleanup test',
      source_request: 'test cleanup',
      goal: 'cleanup tears down run worktrees',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'worktrees removed', verdict: 'unverified', evidence: [] },
      ],
    },
    NOW,
  );
  WI = wi.id;
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('planCleanup / listRunWorktrees (deterministic plan)', () => {
  test('lists only the per-run worktrees DITTO created', async () => {
    expect(planCleanup(repo).worktrees).toEqual([]);
    await createWorktreeForRun(repo, 'run_aaa');
    await createWorktreeForRun(repo, 'run_bbb');
    const found = planCleanup(repo).worktrees.sort();
    expect(found).toEqual(['.ditto/local/worktrees/run_aaa', '.ditto/local/worktrees/run_bbb']);
    // the main worktree is never in the teardown plan
    expect(found).not.toContain('.');
  });
});

describe('cleanupApprovalGate (irreversible git → explicit approval)', () => {
  test('the small-reversible waiver (not_required) does NOT authorize', () => {
    expect(cleanupApprovalGate('not_required', false).allowed).toBe(false);
  });
  test('an explicit approved gate authorizes', () => {
    expect(cleanupApprovalGate('approved', false).allowed).toBe(true);
  });
  test('an operator --approve authorizes regardless of gate status', () => {
    expect(cleanupApprovalGate('pending', true).allowed).toBe(true);
    expect(cleanupApprovalGate('not_required', true).allowed).toBe(true);
  });
});

describe('runCleanup (gated deterministic teardown)', () => {
  test('blocks the node and leaves worktrees intact when there is work but no approval', async () => {
    await createWorktreeForRun(repo, 'run_keep');
    await aps.write(WI, graph([cleanupNode()], 'not_required'));
    const res = await runCleanup(repo, { workItemId: WI, nodeId: 'C1', approve: false, now: NOW });
    expect(res.status).toBe('blocked');
    if (res.status !== 'blocked') throw new Error('expected blocked');
    expect(res.plan).toEqual(['.ditto/local/worktrees/run_keep']);
    // worktree NOT destroyed
    expect(listRunWorktrees(repo)).toEqual(['.ditto/local/worktrees/run_keep']);
    const node = (await aps.get(WI)).nodes.find((n) => n.id === 'C1');
    expect(node?.status).toBe('blocked');
    const decisions = await aps.readDecisions(WI);
    expect(decisions.at(-1)?.failure_class).toBe('user_decision_needed');
  });

  test('with --approve removes the worktrees and passes the node with evidence', async () => {
    await createWorktreeForRun(repo, 'run_x');
    await createWorktreeForRun(repo, 'run_y');
    await aps.write(WI, graph([cleanupNode()], 'not_required'));
    const res = await runCleanup(repo, { workItemId: WI, nodeId: 'C1', approve: true, now: NOW });
    expect(res.status).toBe('passed');
    if (res.status !== 'passed') throw new Error('expected passed');
    expect(res.removed.sort()).toEqual([
      '.ditto/local/worktrees/run_x',
      '.ditto/local/worktrees/run_y',
    ]);
    expect(res.skipped).toEqual([]);
    expect(listRunWorktrees(repo)).toEqual([]); // actually gone
    const node = (await aps.get(WI)).nodes.find((n) => n.id === 'C1');
    expect(node?.status).toBe('passed');
    expect(node?.evidence_refs.length).toBeGreaterThan(0);
  });

  test('an explicitly approved gate authorizes without --approve', async () => {
    await createWorktreeForRun(repo, 'run_z');
    await aps.write(WI, graph([cleanupNode()], 'approved'));
    const res = await runCleanup(repo, { workItemId: WI, nodeId: 'C1', approve: false, now: NOW });
    expect(res.status).toBe('passed');
    expect(listRunWorktrees(repo)).toEqual([]);
  });

  test('an empty plan passes trivially regardless of approval (nothing to authorize)', async () => {
    await aps.write(WI, graph([cleanupNode()], 'not_required'));
    const res = await runCleanup(repo, { workItemId: WI, nodeId: 'C1', approve: false, now: NOW });
    expect(res.status).toBe('passed');
    if (res.status !== 'passed') throw new Error('expected passed');
    expect(res.removed).toEqual([]);
    const node = (await aps.get(WI)).nodes.find((n) => n.id === 'C1');
    expect(node?.status).toBe('passed');
  });

  test('rejects a non-cleanup node', async () => {
    await aps.write(WI, graph([cleanupNode({ kind: 'implement', owner: 'implementer' })]));
    let err: unknown;
    try {
      await runCleanup(repo, { workItemId: WI, nodeId: 'C1', approve: true, now: NOW });
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.message).toContain('not cleanup');
  });
});

describe('nextNode driver interception (cleanup is not spawned)', () => {
  test('a ready cleanup node returns action=cleanup and dispatches to running', async () => {
    await aps.write(WI, graph([cleanupNode()]));
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('cleanup');
    if (res.action !== 'cleanup') throw new Error('expected cleanup');
    expect(res.node_id).toBe('C1');
    const node = (await aps.get(WI)).nodes.find((n) => n.id === 'C1');
    expect(node?.status).toBe('running'); // dispatched, not spawned
  });
});
