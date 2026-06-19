import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ac-1: `ditto tech-spec next-round` relays the persisted question_config levers
// and a cap signal (cap_reached/cap_reason) computed from the round trail.

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
let dir: string;
let wiId: string;

function ditto(args: string[]): { stdout: string; stderr: string; exitCode: number | null } {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], { cwd: dir, env: { ...process.env } });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

const score = { consensus: 2, quality: 0.8, necessity: 0.7, answer_value: 0.9 };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-tsnr-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
  const r = ditto([
    'work',
    'start',
    'observable goal',
    '--request',
    'do the thing',
    '--output',
    'json',
  ]);
  wiId = JSON.parse(r.stdout).work_item_id ?? JSON.parse(r.stdout).id;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function start(extra: string[]) {
  return ditto([
    'tech-spec',
    'start',
    '--work-item',
    wiId,
    '--doc',
    '.ditto/specs/demo.md',
    ...extra,
  ]);
}
function recordRound(payload: unknown) {
  return ditto([
    'tech-spec',
    'record-round',
    '--work-item',
    wiId,
    '--json',
    JSON.stringify(payload),
    '--output',
    'json',
  ]);
}

describe('ditto tech-spec next-round — per-round levers + cap signal (ac-1)', () => {
  test('json relays persisted levers and counts from the round trail', () => {
    expect(start(['-g', '4', '-i', '80', '--output', 'json']).exitCode).toBe(0);
    expect(
      recordRound({
        round: 1,
        dry: false,
        selected: [{ text: 'q1', property: 'blind-spot', scores: score }],
      }).exitCode,
    ).toBe(0);
    const r = ditto(['tech-spec', 'next-round', '--work-item', wiId, '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.generators).toBe(4);
    expect(out.threshold).toBe(0.8); // intensity 80 → 0.8
    expect(out.round).toBe(2);
    expect(out.rounds_so_far).toBe(1);
    expect(out.questions_so_far).toBe(1);
    expect(out.cap_reached).toBe(false);
  });

  test('cap_reached=true + reason when max_rounds ceiling hit (ac-3)', () => {
    expect(start(['-r', '1', '--output', 'json']).exitCode).toBe(0);
    expect(recordRound({ round: 1, dry: true }).exitCode).toBe(0);
    const out = JSON.parse(
      ditto(['tech-spec', 'next-round', '--work-item', wiId, '--output', 'json']).stdout,
    );
    expect(out.cap_reached).toBe(true);
    expect(out.cap_reason).toBe('max_rounds');
  });

  test('human output shows a cap line when capped', () => {
    start(['-r', '1', '--output', 'json']);
    recordRound({ round: 1, dry: true });
    const r = ditto(['tech-spec', 'next-round', '--work-item', wiId]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/cap/i);
  });

  test('non-started tech-spec → non-zero exit (ac-4)', () => {
    const r = ditto(['tech-spec', 'next-round', '--work-item', wiId, '--output', 'json']);
    expect(r.exitCode).not.toBe(0);
  });
});
