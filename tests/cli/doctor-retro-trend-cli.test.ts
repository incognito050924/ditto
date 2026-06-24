import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `ditto doctor retro-trend` (ADR-0024 결정4 retract-condition consumer). The
 * RetroMetricLedger persisted cross-WI retro measurements but nothing READ the
 * trend; this command reads the ledger back and surfaces per-metric trend stats
 * (n/first/last/mean/min/max) plus the per-WI rows, so the retract condition
 * ("does the floor reduce weak-planner variance?") can be evaluated from real data.
 */
const cliEntry = join(process.cwd(), 'src/cli/index.ts');

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

async function seedLedger(rows: Record<string, unknown>[]): Promise<void> {
  const localDir = join(dir, '.ditto', 'local');
  await mkdir(localDir, { recursive: true });
  await writeFile(
    join(localDir, 'retro-metrics.jsonl'),
    `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`,
    'utf8',
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-retro-trend-'));
  git(['init']);
  git(['config', 'user.email', 't@t.test']);
  git(['config', 'user.name', 't']);
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto doctor retro-trend', () => {
  test('reads the ledger and surfaces per-metric trend + per-WI rows (json)', async () => {
    await seedLedger([
      {
        schema_version: '0.1.0',
        work_item_id: 'wi_a',
        recorded_at: '2026-06-01T00:00:00.000Z',
        metrics: { outcome_floor: { coverage: 0.5, unit_only_closures: 2 } },
      },
      {
        schema_version: '0.1.0',
        work_item_id: 'wi_b',
        recorded_at: '2026-06-02T00:00:00.000Z',
        metrics: {
          outcome_floor: { coverage: 0.8, unit_only_closures: 0 },
          process_health: { post_cost: 4 },
        },
      },
    ]);

    const res = spawnDitto(['doctor', 'retro-trend', '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    // per-WI rows preserved (chronological)
    expect(payload.rows).toHaveLength(2);
    expect(payload.rows.map((r: { work_item_id: string }) => r.work_item_id)).toEqual([
      'wi_a',
      'wi_b',
    ]);
    // per-metric trend
    expect(payload.summary.work_items).toBe(2);
    expect(payload.summary.coverage).toEqual({
      n: 2,
      first: 0.5,
      last: 0.8,
      mean: 0.65,
      min: 0.5,
      max: 0.8,
    });
    // post_cost grounded in only one row → n=1, still present
    expect(payload.summary.post_cost.n).toBe(1);
  });

  test('empty ledger → zero work items, empty rows, exit 0', async () => {
    const res = spawnDitto(['doctor', 'retro-trend', '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.summary.work_items).toBe(0);
    expect(payload.rows).toEqual([]);
  });

  test('human output names each grounded metric', async () => {
    await seedLedger([
      {
        schema_version: '0.1.0',
        work_item_id: 'wi_a',
        recorded_at: '2026-06-01T00:00:00.000Z',
        metrics: { outcome_floor: { coverage: 0.5 } },
      },
    ]);
    const res = spawnDitto(['doctor', 'retro-trend']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('coverage');
    expect(res.stdout).toContain('wi_a');
  });

  test('invalid --output is a usage error (exit 65)', async () => {
    const res = spawnDitto(['doctor', 'retro-trend', '--output', 'xml']);
    expect(res.exitCode).toBe(65);
  });
});
