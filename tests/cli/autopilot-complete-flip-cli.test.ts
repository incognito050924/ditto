import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runtime evidence (verify-node frontier): `ditto autopilot complete` is the
// real termination gate — on a pass completion it must flip the work item to
// done; on a non-pass it must NOT; on an already-terminal WI it must not silently
// overwrite. close()/reopen() unit tests are not enough — only the CLI path
// exercises the flip wiring.
const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const WI = 'wi_flipcli1';

let dir: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
}

function spawnDitto(args: string[]): { stdout: string; stderr: string; exitCode: number | null } {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], {
    cwd: dir,
    env: { ...process.env, DITTO_AUTOPILOT_BYPASS: '1' },
  });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

async function write(name: string, obj: unknown): Promise<void> {
  await writeFile(
    join(dir, '.ditto', 'local', 'work-items', WI, name),
    `${JSON.stringify(obj, null, 2)}\n`,
    'utf8',
  );
}

async function readStatus(): Promise<string> {
  const raw = await readFile(
    join(dir, '.ditto', 'local', 'work-items', WI, 'work-item.json'),
    'utf8',
  );
  return JSON.parse(raw).status as string;
}

async function seedWorkItem(status: string): Promise<void> {
  await write('work-item.json', {
    schema_version: '0.1.0',
    id: WI,
    title: 'flip cli',
    source_request: 'add a thing',
    goal: 'the thing works',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'ac-1 holds', verdict: 'unverified', evidence: [] },
    ],
    status,
    owner_profile: 'workspace-write',
    child_ids: [],
    changed_files: ['src/x.ts'],
    risks: [],
    runs: [],
    created_at: '2026-06-06T00:00:00.000Z',
    updated_at: '2026-06-06T00:00:00.000Z',
    ...(status === 'done' || status === 'abandoned'
      ? { closed_at: '2026-06-06T00:00:00.000Z' }
      : {}),
  });
}

// `withEvidence` true → verify node carries evidence → ac-1 pass → final pass.
// false → no evidence → ac-1 unverified → final non-pass.
async function seedGraph(withEvidence: boolean): Promise<void> {
  await write('autopilot.json', {
    schema_version: '0.1.0',
    autopilot_id: 'orch_flipcli1',
    work_item_id: WI,
    mode: 'autopilot',
    root_goal: 'the thing works',
    completion_boundary: 'entire_work_item',
    approval_gate: { status: 'not_required', source: 'small_reversible_policy' },
    nodes: [
      {
        id: 'N3',
        kind: 'verify',
        owner: 'verifier',
        purpose: 'verify ac-1',
        status: 'passed',
        depends_on: [],
        acceptance_refs: ['ac-1'],
        evidence_refs: withEvidence
          ? [{ kind: 'command', path: 'bun test', summary: 'ac-1 passes' }]
          : [],
        attempts: { fix: 0, switch: 0 },
      },
    ],
    caps: { fix_per_node: 2, switch_per_node: 1, converge_rounds: 3 },
    continue_policy: {},
    stop_conditions: [],
    user_interrupt_policy: 'ask_only_for_user_owned_decisions',
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-flipcli-'));
  git(['init']);
  await mkdir(join(dir, '.ditto', 'local', 'work-items', WI), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto autopilot complete — pass→done flip (ac-3)', () => {
  test('pass completion flips the work item to done', async () => {
    await seedWorkItem('in_progress');
    await seedGraph(true);
    const res = spawnDitto(['autopilot', 'complete', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    expect(out.final_verdict).toBe('pass');
    expect(out.auto_close?.outcome).toBe('flipped');
    expect(await readStatus()).toBe('done');
  });

  test('non-pass completion leaves status untouched (in_progress)', async () => {
    await seedWorkItem('in_progress');
    await seedGraph(false);
    const res = spawnDitto(['autopilot', 'complete', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    expect(out.final_verdict).not.toBe('pass');
    expect(out.auto_close?.outcome).toBe('skipped');
    expect(await readStatus()).toBe('in_progress');
  });

  test('an already-abandoned WI is not flipped to done (skipped, R1)', async () => {
    await seedWorkItem('abandoned');
    await seedGraph(true);
    const res = spawnDitto(['autopilot', 'complete', '--workItem', WI, '--output', 'json']);
    const out = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    expect(out.auto_close?.outcome).toBe('skipped');
    expect(await readStatus()).toBe('abandoned');
  });
});
