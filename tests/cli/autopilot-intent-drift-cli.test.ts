import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const WI = 'wi_driftcli1';

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

const GOAL = 'the endpoint returns 200';
const REQUEST = 'add a health endpoint';

async function write(name: string, obj: unknown): Promise<void> {
  await writeFile(
    join(dir, '.ditto', 'local', 'work-items', WI, name),
    `${JSON.stringify(obj, null, 2)}\n`,
    'utf8',
  );
}

async function seedIntent(acIds: string[]): Promise<void> {
  await write('intent.json', {
    schema_version: '0.1.0',
    work_item_id: WI,
    source_request: REQUEST,
    goal: GOAL,
    in_scope: [],
    out_of_scope: [],
    acceptance_criteria: acIds.map((id) => ({ id, statement: `${id} returns 200` })),
    unknowns: [],
    follow_up_candidates: [],
  });
}

async function seedWorkItem(acIds: string[], goal = GOAL): Promise<void> {
  await write('work-item.json', {
    schema_version: '0.1.0',
    id: WI,
    title: 'drift cli',
    source_request: REQUEST,
    goal,
    acceptance_criteria: acIds.map((id) => ({
      id,
      statement: `${id} returns 200`,
      verdict: 'unverified',
      evidence: [],
    })),
    status: 'in_progress',
    owner_profile: 'workspace-write',
    child_ids: [],
    changed_files: [],
    risks: [],
    runs: [],
    created_at: '2026-06-06T00:00:00.000Z',
    updated_at: '2026-06-06T00:00:00.000Z',
  });
}

async function seedGraph(refs: string[], rootGoal = GOAL): Promise<void> {
  await write('autopilot.json', {
    schema_version: '0.1.0',
    autopilot_id: 'orch_driftcli1',
    work_item_id: WI,
    mode: 'autopilot',
    root_goal: rootGoal,
    completion_boundary: 'entire_work_item',
    approval_gate: {
      status: 'not_required',
      source: null,
      approved_at: null,
      approved_by: null,
      evidence_refs: [],
    },
    nodes: [
      {
        id: 'N3',
        kind: 'verify',
        owner: 'verifier',
        purpose: 'verify every criterion',
        status: 'pending',
        depends_on: [],
        acceptance_refs: refs,
        evidence_refs: [],
        attempts: { fix: 0, switch: 0 },
      },
    ],
    caps: { fix_per_node: 2, switch_per_node: 1 },
    continue_policy: {},
    stop_conditions: [],
    user_interrupt_policy: 'ask_only_for_user_owned_decisions',
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-driftcli-'));
  git(['init']);
  await mkdir(join(dir, '.ditto', 'local', 'work-items', WI), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const json = (stdout: string) => JSON.parse(stdout.slice(stdout.indexOf('{')));

describe('ditto autopilot intent-drift CLI', () => {
  test('conserved chain → PASS, exit 0', async () => {
    await seedIntent(['ac-1', 'ac-2']);
    await seedWorkItem(['ac-1', 'ac-2']);
    await seedGraph(['ac-1', 'ac-2']);
    const res = spawnDitto(['autopilot', 'intent-drift', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const out = json(res.stdout);
    expect(out.pass).toBe(true);
    expect(out.reasons).toEqual([]);
  });

  test('AC scope-grow (node invents a ref) → FAIL, non-zero exit', async () => {
    await seedIntent(['ac-1', 'ac-2']);
    await seedWorkItem(['ac-1', 'ac-2']);
    await seedGraph(['ac-1', 'ac-2', 'ac-9']);
    const res = spawnDitto(['autopilot', 'intent-drift', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).not.toBe(0);
    const out = json(res.stdout);
    expect(out.pass).toBe(false);
    expect(out.reasons.join(' ')).toContain('ac-9');
  });

  test('goal-string divergence is ADVISORY → PASS, exit 0, advisory reported', async () => {
    await seedIntent(['ac-1', 'ac-2']);
    await seedWorkItem(['ac-1', 'ac-2']);
    await seedGraph(['ac-1', 'ac-2'], 'do something else entirely');
    const res = spawnDitto(['autopilot', 'intent-drift', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const out = json(res.stdout);
    expect(out.pass).toBe(true);
    expect(out.advisories.join(' ')).toContain('root_goal');
  });

  test('missing autopilot.json → runtime error, non-zero exit', async () => {
    await seedIntent(['ac-1']);
    await seedWorkItem(['ac-1']);
    const res = spawnDitto(['autopilot', 'intent-drift', '--workItem', WI]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('autopilot.json');
  });
});
