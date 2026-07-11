import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// wi_260710l33 (#24): the completion-boundary FROZEN-test breach floor, exercised
// through the REAL CLI. Frozen-test integrity was bound ONLY to in-loop mutating
// passes; a frozen red test breached OUT-OF-BAND after the last mutating pass was
// never re-checked, so `ditto autopilot complete` could still fold to
// final_verdict=pass (vacuous-green reopened at the boundary). Only the CLI path
// re-hashes the frozen manifest on disk, so ac-3 is verified here (not in the pure
// unit tests that inject the hash directly).
const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const WI = 'wi_frozencli1';
const FROZEN_PATH = 'tests/frozen.test.ts';

let dir: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

function sha256(content: string): string {
  return createHash('sha256').update(Buffer.from(content)).digest('hex');
}

function spawnDitto(args: string[]): { stdout: string; exitCode: number | null } {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], {
    cwd: dir,
    env: { ...process.env, DITTO_AUTOPILOT_BYPASS: '1' },
  });
  return { stdout: proc.stdout?.toString() ?? '', exitCode: proc.exitCode };
}

function complete() {
  return spawnDitto(['autopilot', 'complete', '--workItem', WI, '--output', 'json']);
}

function parseJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout.slice(stdout.indexOf('{')));
}

// The CLI stdout projects only a subset of the contract; the floor's `unverified[]`
// entry lives on the persisted completion.json — read it there (the durable evidence).
async function readCompletion(): Promise<{
  final_verdict: string;
  unverified?: { item: string; reason: string }[];
}> {
  const raw = await readFile(
    join(dir, '.ditto', 'local', 'work-items', WI, 'completion.json'),
    'utf8',
  );
  return JSON.parse(raw);
}

function namesFrozen(u: { item: string; reason: string }): boolean {
  return /frozen/i.test(`${u.item} ${u.reason}`);
}

async function write(name: string, obj: unknown): Promise<void> {
  await writeFile(
    join(dir, '.ditto', 'local', 'work-items', WI, name),
    `${JSON.stringify(obj, null, 2)}\n`,
    'utf8',
  );
}

async function seedWorkItem(): Promise<void> {
  await write('work-item.json', {
    schema_version: '0.1.0',
    id: WI,
    title: 'frozen cli',
    source_request: 'defense-in-depth frozen re-check',
    goal: 'the frozen breach is caught at completion',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'ac-1 holds', verdict: 'unverified', evidence: [] },
    ],
    status: 'in_progress',
    owner_profile: 'workspace-write',
    child_ids: [],
    changed_files: [FROZEN_PATH],
    risks: [],
    runs: [],
    created_at: '2026-07-10T00:00:00.000Z',
    updated_at: '2026-07-10T00:00:00.000Z',
  });
}

// A graph whose approval gate carries a FROZEN manifest (test-author freeze) with the
// given frozen_hash, plus a verify node closing ac-1 with COMMAND evidence → WITHOUT
// the frozen floor final_verdict would be `pass`. No `test` barrier node → the frozen
// floor is the only thing that can hold final_verdict off pass.
async function seedGraph(frozenHash: string): Promise<void> {
  await write('autopilot.json', {
    schema_version: '0.1.0',
    autopilot_id: 'orch_frozencli1',
    work_item_id: WI,
    mode: 'autopilot',
    root_goal: 'the frozen breach is caught at completion',
    completion_boundary: 'entire_work_item',
    approval_gate: {
      status: 'approved',
      source: 'approved_spec',
      plan_brief: {
        test_spec: {
          test_backed: [{ criterion_id: 'ac-1', test_path: FROZEN_PATH, frozen_hash: frozenHash }],
        },
      },
    },
    nodes: [
      {
        id: 'V1',
        kind: 'verify',
        owner: 'verifier',
        purpose: 'verify ac-1',
        status: 'passed',
        depends_on: [],
        acceptance_refs: ['ac-1'],
        evidence_refs: [{ kind: 'command', path: 'bun test', summary: 'ac-1 passes' }],
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
  dir = await mkdtemp(join(tmpdir(), 'ditto-frozencli-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'ditto@example.test']);
  git(['config', 'user.name', 'DITTO Test']);
  await writeFile(join(dir, '.gitignore'), '.ditto/\n', 'utf8');
  await writeFile(join(dir, 'README.md'), 'hello\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'initial']);
  await mkdir(join(dir, '.ditto', 'local', 'work-items', WI), { recursive: true });
  await mkdir(join(dir, 'tests'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto autopilot complete — completion-boundary frozen-breach floor (wi_260710l33, #24)', () => {
  test('INTACT: the frozen test on disk matches its frozen_hash → final_verdict=pass (floor inert)', async () => {
    const original = 'test("ac-1", () => { expect(real()).toBe(true); });\n';
    await writeFile(join(dir, FROZEN_PATH), original, 'utf8');
    await seedWorkItem();
    await seedGraph(sha256(original));

    const res = complete();
    expect(res.exitCode).toBe(0);
    const out = parseJson(res.stdout);
    expect(out.final_verdict).toBe('pass');
  });

  test('WEAKENED: the frozen test was edited after freeze (hash differs) → floored off pass with a frozen entry', async () => {
    const original = 'test("ac-1", () => { expect(real()).toBe(true); });\n';
    const weakened = 'test.skip("ac-1", () => {});\n'; // gutted after the last mutating pass
    await writeFile(join(dir, FROZEN_PATH), weakened, 'utf8');
    await seedWorkItem();
    await seedGraph(sha256(original)); // frozen_hash captured the ORIGINAL content

    const res = complete();
    const out = parseJson(res.stdout);
    expect(out.final_verdict).not.toBe('pass');
    const completion = await readCompletion();
    expect((completion.unverified ?? []).some(namesFrozen)).toBe(true);
    // the frozen entry names the breached file (grounds the surfaced reason)
    expect(
      (completion.unverified ?? []).some((u) => `${u.item} ${u.reason}`.includes(FROZEN_PATH)),
    ).toBe(true);
  });

  test('DELETED: the frozen test was removed after freeze → floored off pass', async () => {
    const original = 'test("ac-1", () => { expect(real()).toBe(true); });\n';
    // Do NOT write the file — it is gone at completion.
    await seedWorkItem();
    await seedGraph(sha256(original));

    const res = complete();
    const out = parseJson(res.stdout);
    expect(out.final_verdict).not.toBe('pass');
    const completion = await readCompletion();
    expect((completion.unverified ?? []).some(namesFrozen)).toBe(true);
  });
});
