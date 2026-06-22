import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `ditto coverage feedback` / `ditto coverage propose` (ac-11b outcome loop,
 * wi_260622qre). The feedback command attributes a coverage escape structurally
 * (depth/breadth/reject) off the SAME coverage.json the far-field verdict reads,
 * records accepted escapes to the cross-wi jsonl ledger, and exits non-zero on a
 * rejected (non-escape) report without recording. The propose command reads the
 * ledger back and surfaces per-category augmentation candidates (lens + triggering
 * evidence + fault_kind + recurrence). Neither mutates the taxonomy.
 */
const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const WI = 'wi_cov11b001';

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
 * Seed a coverage.json for WI. `floorState` sets the state of the seeded
 * authentication floor category node (cov-cat-authentication) so a test can drive
 * the depth (resolved) vs still-open attribution branch.
 */
async function seedCoverage(floorState: 'open' | 'resolved'): Promise<void> {
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
          children: ['cov-cat-authentication'],
        },
        {
          id: 'cov-cat-authentication',
          parent_id: 'cov-root',
          label: 'auth lens',
          origin: 'seed',
          depth_weight: 1,
          state: floorState,
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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-cov11b-'));
  git(['init']);
  git(['config', 'user.email', 't@t.test']);
  git(['config', 'user.name', 't']);
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto coverage feedback', () => {
  test('accept depth: resolved floor category escape → ledger append, fault_kind=depth (ac-1)', async () => {
    await seedCoverage('resolved');
    const res = spawnDitto([
      'coverage',
      'feedback',
      '--wi',
      WI,
      '--category',
      'authentication',
      '--evidence',
      'OAuth path slipped past the resolved auth sweep',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.accepted).toBe(true);
    expect(payload.fault_kind).toBe('depth');
    expect(payload.category_id).toBe('authentication');
    expect(payload.work_item_id).toBe(WI);
    const ledger = await readLedger();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.category_id).toBe('authentication');
    expect(ledger[0]?.fault_kind).toBe('depth');
    expect(ledger[0]?.evidence).toContain('OAuth path slipped');
    expect(typeof ledger[0]?.recorded_at).toBe('string');
  });

  test('accept breadth: category absent from floor AND map → fault_kind=breadth', async () => {
    await seedCoverage('resolved');
    const res = spawnDitto([
      'coverage',
      'feedback',
      '--wi',
      WI,
      '--category',
      'novel-domain-xyz',
      '--evidence',
      'a domain the floor never seeded broke',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout).fault_kind).toBe('breadth');
    expect(await readLedger()).toHaveLength(1);
  });

  test('reject: still-open floor category → NO ledger row, non-zero exit + reason (ac-2)', async () => {
    await seedCoverage('open');
    const res = spawnDitto([
      'coverage',
      'feedback',
      '--wi',
      WI,
      '--category',
      'authentication',
      '--evidence',
      'this is not a dry-closed escape',
      '--output',
      'json',
    ]);
    expect(res.exitCode).not.toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.accepted).toBe(false);
    expect(typeof payload.reason).toBe('string');
    expect(await readLedger()).toEqual([]);
  });

  test('invalid --output is a usage error (exit 65)', async () => {
    await seedCoverage('resolved');
    const res = spawnDitto([
      'coverage',
      'feedback',
      '--wi',
      WI,
      '--category',
      'authentication',
      '--evidence',
      'x',
      '--output',
      'xml',
    ]);
    expect(res.exitCode).toBe(65);
  });

  test('missing --evidence is a usage error (schema validation, exit 65)', async () => {
    await seedCoverage('resolved');
    const res = spawnDitto(['coverage', 'feedback', '--wi', WI, '--category', 'authentication']);
    expect(res.exitCode).toBe(65);
  });
});

describe('ditto coverage propose', () => {
  test('reads ledger back: lens + triggering evidence + fault_kind + recurrence (ac-3)', async () => {
    // Record two depth escapes for the same floor category (recurrence=2) and one
    // breadth escape for a non-floor category.
    await seedCoverage('resolved');
    spawnDitto([
      'coverage',
      'feedback',
      '--wi',
      WI,
      '--category',
      'authentication',
      '--evidence',
      'first auth escape',
      '--output',
      'json',
    ]);
    spawnDitto([
      'coverage',
      'feedback',
      '--wi',
      WI,
      '--category',
      'authentication',
      '--evidence',
      'second auth escape',
      '--output',
      'json',
    ]);
    spawnDitto([
      'coverage',
      'feedback',
      '--wi',
      WI,
      '--category',
      'novel-domain-xyz',
      '--evidence',
      'missing-lens escape',
      '--output',
      'json',
    ]);

    const res = spawnDitto(['coverage', 'propose', '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    const byCat: Record<string, Record<string, unknown>> = {};
    for (const c of payload.candidates) byCat[c.category_id as string] = c;

    const auth = byCat.authentication;
    expect(auth).toBeDefined();
    expect(auth?.recurrence).toBe(2);
    expect(auth?.fault_kind).toBe('depth');
    // floor category → lens is the floor probing question
    expect(String(auth?.lens)).toContain('인증');
    expect(auth?.evidence).toEqual(['first auth escape', 'second auth escape']);

    const novel = byCat['novel-domain-xyz'];
    expect(novel).toBeDefined();
    expect(novel?.recurrence).toBe(1);
    expect(novel?.fault_kind).toBe('breadth');
    // non-floor → lens falls back to the triggering evidence (no seeded lens)
    expect(novel?.evidence).toEqual(['missing-lens escape']);
  });

  test('empty ledger → no candidates, exit 0', async () => {
    const res = spawnDitto(['coverage', 'propose', '--output', 'json']);
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout).candidates).toEqual([]);
  });

  test('--wi filters the ledger to one work item', async () => {
    await seedCoverage('resolved');
    spawnDitto([
      'coverage',
      'feedback',
      '--wi',
      WI,
      '--category',
      'authentication',
      '--evidence',
      'wi-scoped escape',
      '--output',
      'json',
    ]);
    const res = spawnDitto(['coverage', 'propose', '--wi', 'wi_other00000', '--output', 'json']);
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout).candidates).toEqual([]);
  });
});
