import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `ditto coverage suggest` (ac-3, wi_260622kb4). When a verify node fails and that
 * failure may be a coverage MISS (a dry-closed category that was judged safe yet
 * broke, or an unseeded floor category), this command surfaces a copy-paste
 * `ditto coverage feedback` template the user can run to record the escape. It
 * SUGGESTS ONLY — it never records, never classifies automatically, and never
 * mutates the ledger. It reads the SAME coverage.json the far-field verdict reads.
 */
const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const WI = 'wi_covsug0001';

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

/**
 * Seed a coverage.json for WI with one resolved (dry-closed) floor category, one
 * still-open floor category, and a skipped (out_of_scope) one — so the suggest
 * command can pick out only the dry-closed candidate.
 */
async function seedCoverage(): Promise<void> {
  const runDir = join(dir, '.ditto', 'local', 'runs', WI);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, 'coverage.json'),
    `${JSON.stringify({
      schema_version: '0.1.0',
      work_item_id: WI,
      root_id: 'cov-root',
      nodes: [
        {
          id: 'cov-root',
          parent_id: null,
          label: 'original intent',
          origin: 'seed',
          depth_weight: 1,
          state: 'open',
          children: ['cov-cat-authentication', 'cov-cat-data-integrity', 'cov-cat-observability'],
        },
        {
          id: 'cov-cat-authentication',
          parent_id: 'cov-root',
          label: 'auth lens',
          origin: 'seed',
          depth_weight: 1,
          state: 'resolved',
          children: [],
        },
        {
          id: 'cov-cat-data-integrity',
          parent_id: 'cov-root',
          label: 'data integrity lens',
          origin: 'seed',
          depth_weight: 1,
          state: 'open',
          children: [],
        },
        {
          id: 'cov-cat-observability',
          parent_id: 'cov-root',
          label: 'observability lens',
          origin: 'seed',
          depth_weight: 1,
          state: 'out_of_scope',
          close_reason: 'no logging surface in this change',
          children: [],
        },
      ],
    })}\n`,
    'utf8',
  );
}

async function readLedger(): Promise<Record<string, unknown>[]> {
  const path = join(dir, '.ditto', 'local', 'coverage-feedback.jsonl');
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  return (await file.text())
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

async function ledgerExists(): Promise<boolean> {
  return Bun.file(join(dir, '.ditto', 'local', 'coverage-feedback.jsonl')).exists();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-covsug-'));
  git(['init']);
  git(['config', 'user.email', 't@t.test']);
  git(['config', 'user.name', 't']);
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto coverage suggest', () => {
  test('coverage.json present: dry-closed category → feedback template (category + depth fault_kind)', async () => {
    await seedCoverage();
    const res = spawnDitto(['coverage', 'suggest', '--wi', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.coverage_present).toBe(true);
    // The resolved (dry-closed) floor category is the depth candidate.
    const bySug: Record<string, Record<string, unknown>> = {};
    for (const s of payload.suggestions) bySug[s.category_id as string] = s;

    const auth = bySug.authentication;
    expect(auth).toBeDefined();
    expect(auth?.fault_kind).toBe('depth');
    expect(String(auth?.template)).toContain('ditto coverage feedback');
    expect(String(auth?.template)).toContain('--wi');
    expect(String(auth?.template)).toContain(WI);
    expect(String(auth?.template)).toContain('--category authentication');

    // The still-open and out_of_scope categories are NOT suggested (not dry-closed).
    expect(bySug['data-integrity']).toBeUndefined();
    expect(bySug.observability).toBeUndefined();
  });

  test('coverage.json present: human output prints copy-paste command lines', async () => {
    await seedCoverage();
    const res = spawnDitto(['coverage', 'suggest', '--wi', WI]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('ditto coverage feedback --wi');
    expect(res.stdout).toContain('--category authentication');
  });

  test('coverage.json absent: no-sweep guidance, empty suggestions, exit 0', async () => {
    const res = spawnDitto(['coverage', 'suggest', '--wi', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.coverage_present).toBe(false);
    expect(payload.suggestions).toEqual([]);
    expect(String(payload.hint)).toContain('sweep');
  });

  test('never records: ledger file stays unchanged (absent) after suggest', async () => {
    await seedCoverage();
    expect(await ledgerExists()).toBe(false);
    spawnDitto(['coverage', 'suggest', '--wi', WI, '--output', 'json']);
    expect(await ledgerExists()).toBe(false);
    expect(await readLedger()).toEqual([]);
  });

  test('invalid --output is a usage error (exit 65)', async () => {
    await seedCoverage();
    const res = spawnDitto(['coverage', 'suggest', '--wi', WI, '--output', 'xml']);
    expect(res.exitCode).toBe(65);
  });

  test('--node is accepted and surfaced in the suggestion context', async () => {
    await seedCoverage();
    const res = spawnDitto([
      'coverage',
      'suggest',
      '--wi',
      WI,
      '--node',
      'verify-impl-foo',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout).failed_node).toBe('verify-impl-foo');
  });
});
