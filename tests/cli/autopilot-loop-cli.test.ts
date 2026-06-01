import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const WI = 'wi_loopcli01';

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

function node(id: string, kind: string, owner: string, depends_on: string[]) {
  return {
    id,
    kind,
    owner,
    purpose: `${kind} step`,
    status: 'pending',
    depends_on,
    acceptance_refs: ['ac-1'],
    evidence_refs: [],
    attempts: { fix: 0, switch: 0 },
  };
}

async function seed(): Promise<void> {
  const wiDir = join(dir, '.ditto', 'work-items', WI);
  await mkdir(wiDir, { recursive: true });
  await writeFile(
    join(wiDir, 'work-item.json'),
    `${JSON.stringify(
      {
        schema_version: '0.1.0',
        id: WI,
        title: 'loop cli test',
        source_request: 'drive the loop via CLI',
        goal: 'next-node and record-result work end to end',
        acceptance_criteria: [
          { id: 'ac-1', statement: 'loop steps work', verdict: 'unverified', evidence: [] },
        ],
        status: 'in_progress',
        owner_profile: 'workspace-write',
        child_ids: [],
        changed_files: ['src/x.ts'],
        risks: [],
        runs: [],
        created_at: '2026-06-01T00:00:00.000Z',
        updated_at: '2026-06-01T00:00:00.000Z',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(
    join(wiDir, 'autopilot.json'),
    `${JSON.stringify(
      {
        schema_version: '0.1.0',
        autopilot_id: 'orch_loopcli01',
        work_item_id: WI,
        mode: 'autopilot',
        root_goal: 'drive the loop',
        completion_boundary: 'entire_work_item',
        approval_gate: {
          status: 'not_required',
          source: 'small_reversible_policy',
          approved_at: null,
          approved_by: null,
          evidence_refs: [],
        },
        nodes: [
          node('N1', 'design', 'planner', []),
          node('N2', 'implement', 'implementer', ['N1']),
          node('N3', 'verify', 'verifier', ['N2']),
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
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-loopcli-'));
  git(['init']);
  git(['config', 'user.email', 't@t.test']);
  git(['config', 'user.name', 't']);
  await mkdir(join(dir, '.ditto'), { recursive: true });
  await seed();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto autopilot next-node / record-result (G9 loop step CLI)', () => {
  test('next-node dispatches the first ready node and returns a packet', async () => {
    const res = spawnDitto(['autopilot', 'next-node', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.action).toBe('spawn');
    expect(payload.node_id).toBe('N1');
    expect(payload.owner).toBe('planner');
    expect(payload.packet.context.file_scope).toEqual(['src/x.ts']);
    // persisted: N1 now running
    const graph = JSON.parse(
      await Bun.file(join(dir, '.ditto', 'work-items', WI, 'autopilot.json')).text(),
    );
    expect(graph.nodes.find((n: { id: string }) => n.id === 'N1').status).toBe('running');
  });

  test('record-result: G7 overrides an ack-only result claimed as pass to fixable', async () => {
    spawnDitto(['autopilot', 'next-node', '--workItem', WI, '--output', 'json']); // dispatch N1
    const res = spawnDitto([
      'autopilot',
      'record-result',
      '--workItem',
      WI,
      '--output',
      'json',
      '--json',
      JSON.stringify({ node_id: 'N1', result_text: 'done', outcome: 'pass' }),
    ]);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.guard_contentful).toBe(false);
    expect(payload.outcome).toBe('fail');
    expect(payload.status).toBe('pending');
    const graph = JSON.parse(
      await Bun.file(join(dir, '.ditto', 'work-items', WI, 'autopilot.json')).text(),
    );
    expect(graph.nodes.find((n: { id: string }) => n.id === 'N1').status).toBe('pending');
  });

  test('record-result rejects a fail payload missing failure_class (usage error)', async () => {
    spawnDitto(['autopilot', 'next-node', '--workItem', WI, '--output', 'json']);
    const res = spawnDitto([
      'autopilot',
      'record-result',
      '--workItem',
      WI,
      '--json',
      JSON.stringify({ node_id: 'N1', result_text: 'real failure detail here', outcome: 'fail' }),
    ]);
    expect(res.exitCode).toBe(65); // USAGE_ERROR_EXIT
    expect(res.stderr).toContain('failure_class');
  });

  test('next-node on an unknown work item errors with a clear message', async () => {
    const res = spawnDitto([
      'autopilot',
      'next-node',
      '--workItem',
      'wi_nope0000',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('autopilot.json missing');
  });
});
