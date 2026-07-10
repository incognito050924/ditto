import { beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `ditto deep-interview semantic-targets|semantic-record` (wi_260709hzg, #15). The A1
 * achieve-vs-characterize semantic critic ported to the intent layer, wired as the
 * dissent-briefs/dissent-record twin: `semantic-targets` emits covered (fragment,dimension)
 * pairs deterministically (no model call); `semantic-record` folds the host verdict onto the
 * advisory dimension.semantic_* fields — validated, fail-closed on foreign dimension ids,
 * host_absent on whitespace (ADR-0018). Advisory: nothing here blocks finalize.
 */

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const USAGE_ERROR_EXIT = 65;
const RUNTIME_ERROR_EXIT = 1;

describe('deep-interview semantic critic CLI (wi_260709hzg #15)', () => {
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
  // Seed a WI whose intent shares tokens with one resolved dimension's notes → one covered pair.
  function seedWiWithResolvedDim(): string {
    const wi = JSON.parse(
      spawnDitto([
        'work',
        'start',
        'password strength score endpoint',
        '--request',
        'Return a password strength score from the endpoint',
        '--output',
        'json',
      ]).stdout,
    ).work_item_id as string;
    expect(
      spawnDitto(['deep-interview', 'start', '--workItem', wi, '--output', 'json']).exitCode,
    ).toBe(0);
    const rt = spawnDitto([
      'deep-interview',
      'record-turn',
      '--workItem',
      wi,
      '--json',
      JSON.stringify({
        dimension: {
          id: 'd-score',
          critical: true,
          state: 'resolved',
          ambiguity: 0.05,
          notes: 'what score does the endpoint return',
        },
        question: { text: 'range?', why_matters: 'shape', info_gain_estimate: 'high' },
        answer: { text: 'integer 0..100', kind: 'user' },
        readiness_score: 0.85,
      }),
      '--output',
      'json',
    ]);
    expect(rt.exitCode).toBe(0);
    return wi;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ditto-semantic-cli-'));
    git(['init']);
  });

  test('semantic-targets emits the covered (fragment,dimension) pair', () => {
    const wi = seedWiWithResolvedDim();
    const res = spawnDitto([
      'deep-interview',
      'semantic-targets',
      '--workItem',
      wi,
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      semantic_targets: { dimension_id: string; fragment_id: string }[];
      skipped_by_cap: number;
    };
    expect(parsed.semantic_targets.some((t) => t.dimension_id === 'd-score')).toBe(true);
    expect(parsed.skipped_by_cap).toBe(0);
  });

  test('semantic-record foreign dimension_id → RUNTIME_ERROR fail-closed', () => {
    const wi = seedWiWithResolvedDim();
    const res = spawnDitto([
      'deep-interview',
      'semantic-record',
      '--workItem',
      wi,
      '--json',
      JSON.stringify({ verdicts: [{ dimension_id: 'd-ghost', text: 'x' }] }),
    ]);
    expect(res.exitCode).toBe(RUNTIME_ERROR_EXIT);
    expect(res.stderr).toContain('d-ghost');
  });

  test('semantic-record invalid JSON → USAGE_ERROR', () => {
    const wi = seedWiWithResolvedDim();
    const res = spawnDitto([
      'deep-interview',
      'semantic-record',
      '--workItem',
      wi,
      '--json',
      '{ bad',
    ]);
    expect(res.exitCode).toBe(USAGE_ERROR_EXIT);
  });

  test('semantic-record engaged verdict → persisted, json reports engaged', () => {
    const wi = seedWiWithResolvedDim();
    const res = spawnDitto([
      'deep-interview',
      'semantic-record',
      '--workItem',
      wi,
      '--json',
      JSON.stringify({
        verdicts: [
          { dimension_id: 'd-score', text: 'only characterizes the score, never fixes the range' },
        ],
      }),
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout) as { engaged: string[]; degraded: string[] };
    expect(parsed.engaged).toEqual(['d-score']);
  });
});
