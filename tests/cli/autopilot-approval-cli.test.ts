import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const WI = 'wi_apvcli001';

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

async function seedGraph(gateStatus: string): Promise<void> {
  const wiDir = join(dir, '.ditto', 'local', 'work-items', WI);
  await mkdir(wiDir, { recursive: true });
  await writeFile(
    join(wiDir, 'autopilot.json'),
    `${JSON.stringify(
      {
        schema_version: '0.1.0',
        autopilot_id: 'orch_apvcli01',
        work_item_id: WI,
        mode: 'autopilot',
        root_goal: 'approve gate via CLI',
        completion_boundary: 'entire_work_item',
        approval_gate: {
          status: gateStatus,
          source: null,
          approved_at: null,
          approved_by: null,
          evidence_refs: [],
          change_surface: ['src/foo.ts'],
          plan_brief: {
            interface_changes: ['add foo()'],
            dod: ['foo returns bar'],
            test_scenarios: ['unit: foo(1) === bar'],
          },
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

async function readGate(): Promise<Record<string, unknown>> {
  const graph = JSON.parse(
    await Bun.file(join(dir, '.ditto', 'local', 'work-items', WI, 'autopilot.json')).text(),
  );
  return graph.approval_gate;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-apvcli-'));
  git(['init']);
  git(['config', 'user.email', 't@t.test']);
  git(['config', 'user.name', 't']);
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto autopilot status', () => {
  test('renders the gate, brief, and node progress (json)', async () => {
    await seedGraph('pending');
    const res = spawnDitto(['autopilot', 'status', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.approval_gate.status).toBe('pending');
    expect(out.approval_gate.plan_brief.dod).toContain('foo returns bar');
    expect(out.approval_gate.change_surface).toEqual(['src/foo.ts']);
    expect(out.nodes.total).toBe(3);
    expect(out.nodes.by_status.pending).toBe(3);
  });

  test('human output mentions the brief', async () => {
    await seedGraph('pending');
    const res = spawnDitto(['autopilot', 'status', '--workItem', WI]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('add foo()');
    expect(res.stdout).toContain('pending');
  });

  test('unknown work item errors clearly', async () => {
    const res = spawnDitto(['autopilot', 'status', '--workItem', 'wi_nope0000']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('autopilot.json missing');
  });
});

describe('ditto autopilot approve', () => {
  test('pending → approved with source/approved_by', async () => {
    await seedGraph('pending');
    const res = spawnDitto([
      'autopilot',
      'approve',
      '--workItem',
      WI,
      '--by',
      'hskim',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const gate = await readGate();
    expect(gate.status).toBe('approved');
    expect(gate.source).toBe('user');
    expect(gate.approved_by).toBe('hskim');
    expect(gate.approved_at).not.toBeNull();
  });

  test('rejects approving a non-pending gate', async () => {
    await seedGraph('not_required');
    const res = spawnDitto(['autopilot', 'approve', '--workItem', WI]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('not pending');
  });

  test('rejects an invalid --source (usage error)', async () => {
    await seedGraph('pending');
    const res = spawnDitto(['autopilot', 'approve', '--workItem', WI, '--source', 'bogus']);
    expect(res.exitCode).toBe(65);
    expect(res.stderr).toContain('invalid');
  });
});

describe('ditto autopilot reject', () => {
  test('pending → rejected, reason recorded as a note', async () => {
    await seedGraph('pending');
    const res = spawnDitto([
      'autopilot',
      'reject',
      '--workItem',
      WI,
      '--reason',
      'brief too vague',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const gate = await readGate();
    expect(gate.status).toBe('rejected');
    expect(gate.evidence_refs).toEqual([{ kind: 'note', summary: 'brief too vague' }]);
  });

  test('rejects rejecting a non-pending gate', async () => {
    await seedGraph('approved');
    const res = spawnDitto(['autopilot', 'reject', '--workItem', WI]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('not pending');
  });
});

describe('ditto autopilot exempt (B escape hatch)', () => {
  async function seedWorkItem(): Promise<void> {
    const wiDir = join(dir, '.ditto', 'local', 'work-items', WI);
    await mkdir(wiDir, { recursive: true });
    await writeFile(
      join(wiDir, 'work-item.json'),
      `${JSON.stringify(
        {
          schema_version: '0.1.0',
          id: WI,
          title: 'exempt cli test',
          source_request: 'mark exempt',
          goal: 'work item can close without autopilot',
          acceptance_criteria: [
            { id: 'ac-1', statement: 'x', verdict: 'unverified', evidence: [] },
          ],
          status: 'in_progress',
          owner_profile: 'workspace-write',
          child_ids: [],
          changed_files: [],
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
  }

  async function readExempt(): Promise<unknown> {
    const wi = JSON.parse(
      await Bun.file(join(dir, '.ditto', 'local', 'work-items', WI, 'work-item.json')).text(),
    );
    return wi.autopilot_exempt;
  }

  test('sets autopilot_exempt=true', async () => {
    await seedWorkItem();
    const res = spawnDitto(['autopilot', 'exempt', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    expect(await readExempt()).toBe(true);
  });

  test('--unset clears the flag', async () => {
    await seedWorkItem();
    spawnDitto(['autopilot', 'exempt', '--workItem', WI]);
    const res = spawnDitto(['autopilot', 'exempt', '--workItem', WI, '--unset']);
    expect(res.exitCode).toBe(0);
    expect(await readExempt()).toBeUndefined();
  });

  test('unknown work item errors clearly', async () => {
    const res = spawnDitto(['autopilot', 'exempt', '--workItem', 'wi_nope0000']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('not found');
  });
});
