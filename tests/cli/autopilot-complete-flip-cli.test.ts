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

// A flip-eligible run LANDS its `changed_files` before the done-flip. Create the
// declared changed file on disk + git-add it (leaving it uncommitted) so the land
// step actually commits it (→ committed → flip done), matching a real run.
async function stageChangedFile(): Promise<void> {
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'x.ts'), 'export const x = 1;\n', 'utf8');
  git(['add', 'src/x.ts']);
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
  // Realistic repo. Real ditto repos gitignore `.ditto/` (runtime state is never
  // committed), so `git status` never sees the work-item files. Without this the
  // untracked `.ditto/` reads as unrelated working-tree dirt and the wired-in land
  // step aborts (→ status=blocked) instead of flipping to done.
  git(['config', 'user.email', 'flipcli@example.com']);
  git(['config', 'user.name', 'flip cli']);
  await mkdir(join(dir, '.ditto', 'local', 'work-items', WI), { recursive: true });
  await writeFile(join(dir, '.gitignore'), '.ditto/\n', 'utf8');
  // Commit a clean baseline so land sees no unrelated dirt. The .gitignore itself
  // must be tracked — left untracked it would read as dirt and abort the land.
  git(['add', '.gitignore']);
  git(['commit', '-m', 'baseline']);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto autopilot complete — pass→done flip (ac-3)', () => {
  test('pass completion flips the work item to done', async () => {
    await seedWorkItem('in_progress');
    await seedGraph(true);
    await stageChangedFile();
    const res = spawnDitto(['autopilot', 'complete', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    expect(out.final_verdict).toBe('pass');
    expect(out.auto_close?.outcome).toBe('flipped');
    expect(await readStatus()).toBe('done');
  });

  test('pass flip mirrors derived verdict + evidence onto work-item acceptance (wi_260627273)', async () => {
    await seedWorkItem('in_progress'); // ac-1 created as unverified, no evidence
    await seedGraph(true); // verify node passed WITH command evidence → ac-1 pass
    await stageChangedFile();
    const res = spawnDitto(['autopilot', 'complete', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    expect(await readStatus()).toBe('done');
    // The bug: the work item kept its stale `unverified` while completion.json said
    // pass. The mirror reconciles work-item.json acceptance_criteria.
    const raw = await readFile(
      join(dir, '.ditto', 'local', 'work-items', WI, 'work-item.json'),
      'utf8',
    );
    const acs = JSON.parse(raw).acceptance_criteria as Array<{
      id: string;
      verdict: string;
      evidence: Array<{ kind: string }>;
    }>;
    const ac1 = acs.find((c) => c.id === 'ac-1');
    expect(ac1?.verdict).toBe('pass');
    expect(ac1?.evidence.some((e) => e.kind === 'command')).toBe(true);
    expect(acs.filter((c) => c.verdict === 'unverified')).toHaveLength(0);
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

// D4 dialectic 결정 (a) (wi_2606278qa): at done-flip, surface this run's unresolved
// materialized follow-up WIs + their pick-up command (materialize != drive — the
// control boundary is NOT relaxed; the user still starts each follow-up).
describe('ditto autopilot complete — follow-ups to pick up (D4-a)', () => {
  async function seedWithFollowUps(): Promise<void> {
    await write('work-item.json', {
      schema_version: '0.1.0',
      id: WI,
      title: 'flip cli',
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
      // one unresolved materialized (surface it), one resolved (skip), one idea
      // candidate with no materialized_wi (skip — not a tracked WI to pick up).
      follow_ups: [
        { kind: 'bug', note: 'open materialized follow-up', materialized_wi: 'wi_followup01' },
        {
          kind: 'bug',
          note: 'already resolved',
          materialized_wi: 'wi_followup02',
          resolved: true,
        },
        { kind: 'idea', note: 'candidate only, no WI' },
      ],
      created_at: '2026-06-06T00:00:00.000Z',
      updated_at: '2026-06-06T00:00:00.000Z',
    });
  }

  test('pass completion surfaces only unresolved materialized follow-ups + pick-up command', async () => {
    await seedWithFollowUps();
    await seedGraph(true);
    await stageChangedFile();
    const res = spawnDitto(['autopilot', 'complete', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    expect(out.auto_close?.outcome).toBe('flipped');
    // only the unresolved + materialized one; resolved + idea-without-WI excluded.
    expect(out.follow_ups_to_pick_up).toEqual([
      { work_item_id: 'wi_followup01', note: 'open materialized follow-up' },
    ]);
    // human output carries the pick-up command for that WI.
    const human = spawnDitto(['autopilot', 'complete', '--workItem', WI, '--output', 'human']);
    expect(human.stdout).toContain('wi_followup01');
    expect(human.stdout).toContain('ditto work set-criteria wi_followup01');
  });

  test('no follow-ups → empty list', async () => {
    await seedWorkItem('in_progress');
    await seedGraph(true);
    await stageChangedFile();
    const res = spawnDitto(['autopilot', 'complete', '--workItem', WI, '--output', 'json']);
    const out = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    expect(out.follow_ups_to_pick_up).toEqual([]);
  });

  // ac-2 (wi_260710tjd): the ADVISORY `priority` orders the pick-up surfacing.
  // Lower rank = surfaced first; a follow-up WITHOUT priority sorts LAST (never a
  // NaN-induced scramble). Ordering only — it drives nothing (no-auto-pick).
  async function seedWithPriorities(): Promise<void> {
    await write('work-item.json', {
      schema_version: '0.1.0',
      id: WI,
      title: 'flip cli',
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
      // insertion order deliberately NOT priority order; one entry has no priority.
      follow_ups: [
        { kind: 'bug', note: 'rank three', materialized_wi: 'wi_rankthree', priority: 3 },
        { kind: 'bug', note: 'rank one', materialized_wi: 'wi_rankone01', priority: 1 },
        { kind: 'bug', note: 'no rank', materialized_wi: 'wi_norank001' },
        { kind: 'bug', note: 'rank two', materialized_wi: 'wi_ranktwo01', priority: 2 },
      ],
      created_at: '2026-06-06T00:00:00.000Z',
      updated_at: '2026-06-06T00:00:00.000Z',
    });
  }

  test('follow_ups_to_pick_up is ordered by advisory priority, undefined LAST', async () => {
    await seedWithPriorities();
    await seedGraph(true);
    await stageChangedFile();
    const res = spawnDitto(['autopilot', 'complete', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    expect(out.follow_ups_to_pick_up.map((f: { work_item_id: string }) => f.work_item_id)).toEqual([
      'wi_rankone01', // priority 1
      'wi_ranktwo01', // priority 2
      'wi_rankthree', // priority 3
      'wi_norank001', // undefined → last
    ]);
  });

  // no-auto-pick invariant (ADR-20260627): priority is display/ordering metadata
  // ONLY. Sorting the surface must not leak `priority` into the pick-up drive
  // shape, and must not change the completion outcome (no follow-up is auto-driven
  // — materialize != drive). Same {work_item_id, note} shape, just reordered.
  test('priority drives nothing: pick-up shape stays {work_item_id, note}, outcome unchanged', async () => {
    await seedWithPriorities();
    await seedGraph(true);
    await stageChangedFile();
    const res = spawnDitto(['autopilot', 'complete', '--workItem', WI, '--output', 'json']);
    const out = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    // outcome is decided by the completion gate, NOT by any follow-up priority.
    expect(out.auto_close?.outcome).toBe('flipped');
    // the drive surface exposes ONLY {work_item_id, note} — priority is never a
    // drive signal, so it must not appear on the pick-up entries.
    for (const f of out.follow_ups_to_pick_up as Array<Record<string, unknown>>) {
      expect(Object.keys(f).sort()).toEqual(['note', 'work_item_id']);
      expect(f.priority).toBeUndefined();
    }
    expect(out.follow_ups_to_pick_up).toHaveLength(4);
  });
});
