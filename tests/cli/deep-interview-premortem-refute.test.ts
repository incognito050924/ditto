import { beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `ditto deep-interview premortem-refute-record` (wi_260709d3m, #17 AC-2). The premortem twin
 * of `dissent-record`: the host runs the opponent, the CLI folds the structured verdict back
 * onto interview-state.premortem — validated, fail-closed on out-of-range/non-high-blast index
 * (§17 localization), host_absent on whitespace text (ADR-0018). CLI-subprocess over a temp repo.
 */

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const USAGE_ERROR_EXIT = 65;
const RUNTIME_ERROR_EXIT = 1;

describe('deep-interview premortem-refute-record CLI (wi_260709d3m #17)', () => {
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
  // Seed a WI with ONE recorded high-blast premortem item at index 0.
  function seedWiWithHighBlastItem(): string {
    const wi = JSON.parse(
      spawnDitto([
        'work',
        'start',
        'migration',
        '--request',
        'add a column migration',
        '--output',
        'json',
      ]).stdout,
    ).work_item_id as string;
    expect(
      spawnDitto(['deep-interview', 'start', '--workItem', wi, '--output', 'json']).exitCode,
    ).toBe(0);
    const pm = spawnDitto([
      'deep-interview',
      'premortem',
      '--workItem',
      wi,
      '--json',
      JSON.stringify({
        items: [
          {
            scenario: 'migration overwrites a column → data loss',
            likelihood: 'low',
            blast_radius: 'critical',
            reversibility: 'irreversible',
            early_signal: 'row counts drop',
            promoted_to: 'ac',
            ref: 'ac-1',
          },
        ],
      }),
      '--output',
      'json',
    ]);
    expect(pm.exitCode).toBe(0);
    return wi;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ditto-premortem-refute-cli-'));
    git(['init']);
  });

  test('invalid JSON → USAGE_ERROR', () => {
    const wi = seedWiWithHighBlastItem();
    const res = spawnDitto([
      'deep-interview',
      'premortem-refute-record',
      '--workItem',
      wi,
      '--json',
      '{ not json',
    ]);
    expect(res.exitCode).toBe(USAGE_ERROR_EXIT);
  });

  test('out-of-range index → RUNTIME_ERROR fail-closed (§17 localization)', () => {
    const wi = seedWiWithHighBlastItem();
    const res = spawnDitto([
      'deep-interview',
      'premortem-refute-record',
      '--workItem',
      wi,
      '--json',
      JSON.stringify({ verdicts: [{ index: 9, text: 'x' }] }),
    ]);
    expect(res.exitCode).toBe(RUNTIME_ERROR_EXIT);
    expect(res.stderr).toContain('9');
  });

  test('valid engaged verdict on high-blast item → persisted, json reports engaged', () => {
    const wi = seedWiWithHighBlastItem();
    const res = spawnDitto([
      'deep-interview',
      'premortem-refute-record',
      '--workItem',
      wi,
      '--json',
      JSON.stringify({
        verdicts: [{ index: 0, text: 'this risk is real; no pre-write snapshot exists' }],
      }),
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout) as { engaged: number[]; degraded: number[] };
    expect(parsed.engaged).toEqual([0]);
    expect(parsed.degraded).toEqual([]);
  });
});
