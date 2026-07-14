import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NO_DISCRETIONARY_DECISIONS } from '~/core/autopilot-complete';

// ac-8 (wi_2607148yg): the `autopilot complete` end-summary must disclose EVERY
// internal autonomous decision, reconciled against the FULL append-only ledger —
// each entry surfaced (auto-handling / direction / defect-chain) or ACCOUNTED, and
// the explicit NO_DISCRETIONARY_DECISIONS token when none (a silent absence is not
// allowed — charter §4-5). This exercises the REAL CLI wiring
// (reconcileDecisionDisclosure) in the complete report.

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const WI = 'wi_disclose01';
let dir: string;

function ditto(args: string[]) {
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

function git(args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
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
    title: 'disclose cli',
    source_request: 'add a thing',
    goal: 'the thing works',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'ac-1 holds', verdict: 'unverified', evidence: [] },
    ],
    status: 'in_progress',
    owner_profile: 'workspace-write',
    child_ids: [],
    changed_files: ['src/x.ts'],
    risks: [],
    runs: [],
    created_at: '2026-07-14T00:00:00.000Z',
    updated_at: '2026-07-14T00:00:00.000Z',
  });
}

async function seedGraph(): Promise<void> {
  await write('autopilot.json', {
    schema_version: '0.1.0',
    autopilot_id: 'orch_disclose1',
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

async function stageChangedFile(): Promise<void> {
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'x.ts'), 'export const x = 1;\n', 'utf8');
  git(['add', 'src/x.ts']);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-disclose-'));
  git(['init']);
  git(['config', 'user.email', 'd@example.com']);
  git(['config', 'user.name', 'd']);
  await mkdir(join(dir, '.ditto', 'local', 'work-items', WI), { recursive: true });
  await writeFile(join(dir, '.gitignore'), '.ditto/\n', 'utf8');
  git(['add', '.gitignore']);
  git(['commit', '-m', 'baseline']);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto autopilot complete — decision disclosure reconciliation (ac-8)', () => {
  // (c) empty run: no discretionary decision → the explicit no-decision token, not a
  // silent empty list.
  test('a run with an EMPTY ledger surfaces the explicit NO_DISCRETIONARY_DECISIONS token', async () => {
    await seedWorkItem();
    await seedGraph();
    await stageChangedFile();

    const res = ditto(['autopilot', 'complete', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    expect(out.decision_disclosure).toBeDefined();
    expect(out.decision_disclosure.ledger_size).toBe(0);
    expect(out.decision_disclosure.no_decision).toBe(NO_DISCRETIONARY_DECISIONS);

    const human = ditto(['autopilot', 'complete', '--workItem', WI, '--output', 'human']);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toMatch(/결정 없음|no.*discretionary|no-discretionary-decisions/i);
  });

  // every ledger entry is reconciled: a defect-chain-driven decision is surfaced as a
  // candidate + rationale, and the disclosed bucket total reconciles against ledger_size
  // (no silent drop).
  test('a defect_chain_driven decision is disclosed and the buckets reconcile against ledger_size', async () => {
    await seedWorkItem();
    await seedGraph();
    await stageChangedFile();
    await writeFile(
      join(dir, '.ditto', 'local', 'work-items', WI, 'autopilot-decisions.jsonl'),
      `${JSON.stringify({
        ts: '2026-07-14T00:00:01.000Z',
        node_id: 'N3',
        decision: 'defect_chain_driven',
        resolvability: 'discovered_defect',
        reason:
          'reproduced null-deref in parseConfig; materialized wi_d1 and chain-drove it to done',
      })}\n`,
      'utf8',
    );

    const res = ditto(['autopilot', 'complete', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    const disc = out.decision_disclosure;
    expect(disc.ledger_size).toBe(1);
    expect(disc.no_decision).toBeNull();
    expect(disc.defect_chains).toHaveLength(1);
    expect(disc.defect_chains[0].reason).toMatch(/parseConfig/);
    // reconciliation: disclosed buckets sum to the ledger length (no silent drop).
    const disclosed =
      disc.auto_handling.auto_fixed.length +
      disc.auto_handling.surfaced.length +
      disc.auto_handling.materialized.length +
      disc.direction_decisions.length +
      disc.defect_chains.length +
      disc.accounted.length;
    expect(disclosed).toBe(disc.ledger_size);

    const human = ditto(['autopilot', 'complete', '--workItem', WI, '--output', 'human']);
    expect(human.stdout).toMatch(/parseConfig/);
  });
});
