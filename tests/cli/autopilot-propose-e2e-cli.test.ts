import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `ditto autopilot propose-e2e` (wi_260610p9h g5, ac-6): the deterministic half
 * of the E2E authoring proposal — detect web-surface changes from the diff,
 * record the user's accept/decline in autopilot-decisions.jsonl, and on accept
 * add an `e2e-author` (main-session owned) node to the graph. The proposal
 * dialogue itself stays with the driver; this CLI never asks.
 */
const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const WI = 'wi_prope2e01';

let dir: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
}

function spawnDitto(args: string[]): { stdout: string; stderr: string; exitCode: number | null } {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], { cwd: dir, env: { ...process.env } });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

async function seed(): Promise<void> {
  const wiDir = join(dir, '.ditto', 'local', 'work-items', WI);
  await mkdir(wiDir, { recursive: true });
  await writeFile(
    join(wiDir, 'work-item.json'),
    `${JSON.stringify({
      schema_version: '0.1.0',
      id: WI,
      title: 'propose-e2e cli test',
      source_request: 'propose e2e authoring',
      goal: 'the proposal CLI works',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'proposal works', verdict: 'unverified', evidence: [] },
      ],
      status: 'in_progress',
      owner_profile: 'workspace-write',
      child_ids: [],
      changed_files: [],
      risks: [],
      runs: [],
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
    })}\n`,
    'utf8',
  );
  await writeFile(
    join(wiDir, 'autopilot.json'),
    `${JSON.stringify({
      schema_version: '0.1.0',
      autopilot_id: 'orch_prope2e01',
      work_item_id: WI,
      mode: 'autopilot',
      root_goal: 'propose e2e',
      completion_boundary: 'entire_work_item',
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
          kind: 'implement',
          owner: 'implementer',
          purpose: 'implement step',
          status: 'passed',
          depends_on: [],
          acceptance_refs: ['ac-1'],
          evidence_refs: [],
          attempts: { fix: 0, switch: 0 },
        },
      ],
      caps: { fix_per_node: 2, switch_per_node: 1 },
      continue_policy: {
        continue_after_approval: true,
        continue_after_checkpoint: true,
        continue_after_fixable_failure: true,
        ask_user_only_for_user_owned_decisions: true,
      },
      stop_conditions: [],
      user_interrupt_policy: 'ask_only_for_user_owned_decisions',
    })}\n`,
    'utf8',
  );
}

async function readGraph(): Promise<{ nodes: { id: string; kind: string; owner: string }[] }> {
  return JSON.parse(
    await Bun.file(join(dir, '.ditto', 'local', 'work-items', WI, 'autopilot.json')).text(),
  );
}

async function readDecisions(): Promise<Record<string, unknown>[]> {
  const path = join(dir, '.ditto', 'local', 'work-items', WI, 'autopilot-decisions.jsonl');
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  return (await file.text())
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-prope2e-'));
  git(['init']);
  git(['config', 'user.email', 't@t.test']);
  git(['config', 'user.name', 't']);
  await mkdir(join(dir, '.ditto'), { recursive: true });
  await seed();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto autopilot propose-e2e', () => {
  test('no web surface in the diff → proposal not needed, exit 0, nothing recorded', async () => {
    const res = spawnDitto([
      'autopilot',
      'propose-e2e',
      '--workItem',
      WI,
      '--changedFiles',
      'src/core/graph.ts,README.md',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ web: false, surfaces: [], proposal_needed: false });
    expect(await readDecisions()).toEqual([]);
    expect((await readGraph()).nodes.map((n) => n.id)).toEqual(['N1']);
  });

  test('web surface detected, no --decision → detection only (driver asks the user)', async () => {
    const res = spawnDitto([
      'autopilot',
      'propose-e2e',
      '--workItem',
      WI,
      '--changedFiles',
      'src/pages/Home.tsx,src/api/users.ts',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.proposal_needed).toBe(true);
    expect(payload.surfaces).toEqual([
      { kind: 'frontend', path: 'src/pages/Home.tsx' },
      { kind: 'api', path: 'src/api/users.ts' },
    ]);
    // detection records nothing — the decision is the user's, not the CLI's
    expect(await readDecisions()).toEqual([]);
    expect((await readGraph()).nodes.map((n) => n.id)).toEqual(['N1']);
  });

  test('decline → decision logged, NO authoring node added (ac-6 decline path)', async () => {
    const res = spawnDitto([
      'autopilot',
      'propose-e2e',
      '--workItem',
      WI,
      '--changedFiles',
      'src/pages/Home.tsx',
      '--decision',
      'decline',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ web: true, decision: 'decline', node_id: null });
    const decisions = await readDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decision).toBe('e2e_decline');
    expect(decisions[0]?.reason).toContain('frontend:src/pages/Home.tsx');
    // graph unchanged: regular verification proceeds without an authoring node
    expect((await readGraph()).nodes.map((n) => n.id)).toEqual(['N1']);
  });

  test('accept → e2e-author (main-session) node added + decision logged (ac-6 accept path)', async () => {
    const res = spawnDitto([
      'autopilot',
      'propose-e2e',
      '--workItem',
      WI,
      '--changedFiles',
      'src/pages/Home.tsx',
      '--decision',
      'accept',
      '--journeys',
      'login then checkout',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      web: true,
      decision: 'accept',
      node_id: 'e2e-author-1',
    });
    const graph = await readGraph();
    const node = graph.nodes.find((n) => n.id === 'e2e-author-1');
    expect(node?.kind).toBe('e2e-author');
    expect(node?.owner).toBe('main-session');
    const decisions = await readDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decision).toBe('e2e_accept');
    expect(decisions[0]?.node_id).toBe('e2e-author-1');
    // accepted node is ready: next-node intercepts it as a main_session action
    const next = spawnDitto(['autopilot', 'next-node', '--workItem', WI, '--output', 'json']);
    expect(next.exitCode).toBe(0);
    const action = JSON.parse(next.stdout);
    expect(action.action).toBe('main_session');
    expect(action.node_id).toBe('e2e-author-1');
  });

  test('invalid --decision is a usage error', async () => {
    const res = spawnDitto([
      'autopilot',
      'propose-e2e',
      '--workItem',
      WI,
      '--changedFiles',
      'src/pages/Home.tsx',
      '--decision',
      'maybe',
    ]);
    expect(res.exitCode).toBe(65); // USAGE_ERROR_EXIT
    expect(res.stderr).toContain('--decision');
  });
});
