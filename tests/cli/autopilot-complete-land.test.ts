import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runtime evidence (verify-node frontier) for the verified→landed wiring
// (wi_260627vl6 ac-1/ac-2/ac-5): `ditto autopilot complete` must, on a
// flip-eligible pass, LAND the work item's changed_files (one git-revertable
// commit per owning sub-repo) BEFORE flipping status→done; a land FAILURE must
// close status=blocked (not done); the land step must never run on the
// blocking-follow-up exit path; and the land result must be surfaced in both
// json and human output. Only the CLI path exercises the land→flip ordering.
const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const WI = 'wi_landcli1';

let dir: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

function head(): string {
  return git(['rev-parse', 'HEAD']);
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

function complete(format: 'json' | 'human' = 'json') {
  return spawnDitto(['autopilot', 'complete', '--workItem', WI, '--output', format]);
}

function parseJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout.slice(stdout.indexOf('{')));
}

async function write(name: string, obj: unknown): Promise<void> {
  await writeFile(
    join(dir, '.ditto', 'local', 'work-items', WI, name),
    `${JSON.stringify(obj, null, 2)}\n`,
    'utf8',
  );
}

async function readWorkItem(): Promise<{ status: string; re_entry?: unknown }> {
  const raw = await readFile(
    join(dir, '.ditto', 'local', 'work-items', WI, 'work-item.json'),
    'utf8',
  );
  return JSON.parse(raw);
}

interface FollowUpSeed {
  kind: 'bug' | 'idea';
  note: string;
  severity?: string;
  self_caused?: boolean;
  resolved?: boolean;
  materialized_wi?: string;
}

async function seedWorkItem(opts: {
  status?: string;
  changedFiles: string[];
  followUps?: FollowUpSeed[];
}): Promise<void> {
  const status = opts.status ?? 'in_progress';
  await write('work-item.json', {
    schema_version: '0.1.0',
    id: WI,
    title: 'land cli',
    source_request: 'land the change',
    goal: 'the change lands',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'ac-1 holds', verdict: 'unverified', evidence: [] },
    ],
    status,
    owner_profile: 'workspace-write',
    child_ids: [],
    changed_files: opts.changedFiles,
    ...(opts.followUps ? { follow_ups: opts.followUps } : {}),
    risks: [],
    runs: [],
    created_at: '2026-06-27T00:00:00.000Z',
    updated_at: '2026-06-27T00:00:00.000Z',
  });
}

// withEvidence true → verify node carries evidence → ac-1 pass → final pass.
async function seedGraph(withEvidence: boolean): Promise<void> {
  await write('autopilot.json', {
    schema_version: '0.1.0',
    autopilot_id: 'orch_landcli1',
    work_item_id: WI,
    mode: 'autopilot',
    root_goal: 'the change lands',
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
  dir = await mkdtemp(join(tmpdir(), 'ditto-landcli-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'ditto@example.test']);
  git(['config', 'user.name', 'DITTO Test']);
  // Real ditto repos gitignore the personal partition; do the same so the WI's
  // own .ditto/local state does not register as unrelated working-tree dirt.
  await writeFile(join(dir, '.gitignore'), '.ditto/\n', 'utf8');
  await writeFile(join(dir, 'README.md'), 'hello\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'initial']);
  await mkdir(join(dir, '.ditto', 'local', 'work-items', WI), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto autopilot complete — verified→landed flip-after-land (ac-1/ac-2)', () => {
  test('flip-eligible pass lands changed_files (committed) BEFORE flipping to done', async () => {
    await writeFile(join(dir, 'src.ts'), 'change\n', 'utf8');
    await seedWorkItem({ changedFiles: ['src.ts'] });
    await seedGraph(true);
    const before = head();

    const res = complete('json');
    expect(res.exitCode).toBe(0);
    const out = parseJson(res.stdout);

    expect(out.final_verdict).toBe('pass');
    // land ran and committed the changeset, per owning sub-repo (root '.')
    const land = out.land as { status: string; commits: { repo: string; sha: string }[] };
    expect(land.status).toBe('committed');
    expect(land.commits.length).toBe(1);
    expect(land.commits[0].repo).toBe('.');
    // the flip happened AFTER a successful land
    expect((out.auto_close as { outcome: string; status: string }).outcome).toBe('flipped');
    expect((out.auto_close as { status: string }).status).toBe('done');
    expect((await readWorkItem()).status).toBe('done');
    // a real, git-revertable commit landed (HEAD advanced to the reported sha)
    expect(head()).not.toBe(before);
    expect(head()).toBe(land.commits[0].sha);
    // ...and src.ts is now tracked (committed), not dangling in the working tree
    expect(git(['ls-files']).split('\n')).toContain('src.ts');
  });

  test('empty changeset → land no-op, still flips to done', async () => {
    await seedWorkItem({ changedFiles: [] });
    await seedGraph(true);
    const before = head();

    const res = complete('json');
    expect(res.exitCode).toBe(0);
    const out = parseJson(res.stdout);

    expect((out.land as { status: string }).status).toBe('noop');
    expect((out.auto_close as { outcome: string }).outcome).toBe('flipped');
    expect((await readWorkItem()).status).toBe('done');
    expect(head()).toBe(before); // no-op never commits
  });
});

describe('ditto autopilot complete — land never runs on the blocking-follow-up path (ac-2)', () => {
  test('a pass with an unresolved self-caused high-severity follow-up exits BEFORE landing', async () => {
    await writeFile(join(dir, 'src.ts'), 'change\n', 'utf8');
    await seedWorkItem({
      changedFiles: ['src.ts'],
      followUps: [
        {
          kind: 'bug',
          note: 'self-caused high regression',
          severity: 'high',
          self_caused: true,
          materialized_wi: 'wi_followupx1',
        },
      ],
    });
    await seedGraph(true);
    const before = head();

    const res = complete('json');
    // blocking-follow-up gate exits non-zero before the land step
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('cannot auto-close');
    // land was NEVER invoked: no commit, changeset still dangling, WI untouched
    expect(head()).toBe(before);
    expect(git(['status', '--porcelain'])).toContain('src.ts');
    expect((await readWorkItem()).status).toBe('in_progress');
  });
});

describe('ditto autopilot complete — land FAILURE → status=blocked (ac-2)', () => {
  test('unrelated dirt (aborted_dirty) blocks the WI instead of flipping to done', async () => {
    await writeFile(join(dir, 'src.ts'), 'change\n', 'utf8');
    await writeFile(join(dir, 'unrelated.ts'), 'not in changeset\n', 'utf8');
    await seedWorkItem({ changedFiles: ['src.ts'] });
    await seedGraph(true);
    const before = head();

    const res = complete('json');
    expect(res.exitCode).toBe(0);
    const out = parseJson(res.stdout);

    const land = out.land as { status: string; dirty: { repo: string; paths: string[] }[] };
    expect(land.status).toBe('aborted_dirty');
    expect(land.dirty.flatMap((d) => d.paths)).toContain('unrelated.ts');
    expect((out.auto_close as { outcome: string; status: string }).outcome).toBe('blocked');
    expect((out.auto_close as { status: string }).status).toBe('blocked');

    const wi = await readWorkItem();
    expect(wi.status).toBe('blocked'); // NOT done
    expect(wi.re_entry).toBeDefined();
    expect(head()).toBe(before); // no commit at all on a dirty abort

    // wi_260627jwb: the recorded reason must be ACTIONABLE about a likely
    // change_surface under-declaration (not a cryptic "unrelated dirt"): it names
    // the offending path, frames the likely cause, and gives the next step.
    const reEntry = wi.re_entry as { fresh_evidence_needed?: string[] };
    const reason = (reEntry.fresh_evidence_needed ?? []).join(' ');
    expect(reason).toContain('unrelated.ts');
    expect(reason).toContain('change_surface');
    expect(reason).toMatch(/git status|changed_files/);
  });

  test('detached HEAD (aborted_detached) blocks the WI instead of flipping to done', async () => {
    git(['checkout', '-q', '--detach']);
    await writeFile(join(dir, 'src.ts'), 'change\n', 'utf8');
    await seedWorkItem({ changedFiles: ['src.ts'] });
    await seedGraph(true);

    const res = complete('json');
    expect(res.exitCode).toBe(0);
    const out = parseJson(res.stdout);

    const land = out.land as { status: string; detached: string[] };
    expect(land.status).toBe('aborted_detached');
    expect(land.detached).toContain('.');
    expect((out.auto_close as { status: string }).status).toBe('blocked');
    expect((await readWorkItem()).status).toBe('blocked');
  });
});

describe('ditto autopilot complete — re-run reconcile from blocked (ac-1)', () => {
  test('a re-run after the blocker is cleared lands idempotently and flips to done', async () => {
    await writeFile(join(dir, 'src.ts'), 'change\n', 'utf8');
    await writeFile(join(dir, 'unrelated.ts'), 'not in changeset\n', 'utf8');
    await seedWorkItem({ changedFiles: ['src.ts'] });
    await seedGraph(true);

    // First run: unrelated dirt → blocked, nothing committed.
    const first = parseJson(complete('json').stdout);
    expect((first.land as { status: string }).status).toBe('aborted_dirty');
    expect((await readWorkItem()).status).toBe('blocked');

    // Clear the blocker, then re-run: land re-drives and reconciles → committed.
    await rm(join(dir, 'unrelated.ts'));
    const before = head();
    const second = parseJson(complete('json').stdout);
    expect((second.land as { status: string }).status).toBe('committed');
    expect((second.auto_close as { outcome: string }).outcome).toBe('flipped');
    expect((await readWorkItem()).status).toBe('done');
    expect(head()).not.toBe(before);
  });
});

describe('ditto autopilot complete — land result is surfaced, never silent (ac-1/ac-5)', () => {
  test('human output prints the per-repo committed sha (mirrors cleanup output)', async () => {
    await writeFile(join(dir, 'src.ts'), 'change\n', 'utf8');
    await seedWorkItem({ changedFiles: ['src.ts'] });
    await seedGraph(true);

    const res = complete('human');
    expect(res.exitCode).toBe(0);
    const sha = head();
    expect(res.stdout).toContain(`committed .: ${sha}`);
  });

  test('human output prints the abort reason on a land failure', async () => {
    await writeFile(join(dir, 'src.ts'), 'change\n', 'utf8');
    await writeFile(join(dir, 'unrelated.ts'), 'not in changeset\n', 'utf8');
    await seedWorkItem({ changedFiles: ['src.ts'] });
    await seedGraph(true);

    const res = complete('human');
    expect(res.stdout).toContain('land FAILED (aborted_dirty)');
    expect(res.stdout).toContain('unrelated.ts');
  });
});
