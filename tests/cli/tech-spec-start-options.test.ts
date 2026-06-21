import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ac-1: the 9 question-elicitation options + single-char aliases parse and
// schema-validate at `ditto tech-spec start`, and bad values (out-of-range
// intensity, undefined enum, generators∉1..6, threshold∉0..1) are rejected.

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
let dir: string;

function ditto(args: string[]): { stdout: string; stderr: string; exitCode: number | null } {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], { cwd: dir, env: { ...process.env } });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

let wiId: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-tsopts-'));
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

describe('ditto tech-spec start — question-elicitation options (ac-1)', () => {
  test('defaults parse and persist behavior-preserving config (ac-6)', async () => {
    const r = start(['--output', 'json']);
    expect(r.exitCode).toBe(0);
    const state = JSON.parse(
      await readFile(join(dir, '.ditto/local/work-items', wiId, 'tech-spec-state.json'), 'utf8'),
    );
    expect(state.question_config.intensity).toBe(60);
    expect(state.question_config.generators).toBe(2);
    expect(state.question_config.threshold).toBe(0.6);
  });

  test('long flags + single-char aliases resolve through precedence (ac-1/3/4)', async () => {
    // -p deep -i 50 ⇒ effective intensity 50; -g 6 overrides preset generators
    const r = start([
      '-p',
      'deep',
      '-i',
      '50',
      '-g',
      '6',
      '-q',
      '4',
      '-r',
      '2',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    const state = JSON.parse(
      await readFile(join(dir, '.ditto/local/work-items', wiId, 'tech-spec-state.json'), 'utf8'),
    );
    expect(state.question_config.intensity).toBe(50);
    expect(state.question_config.generators).toBe(6);
    expect(state.question_config.max_questions).toBe(4);
    expect(state.question_config.max_rounds).toBe(2);
  });

  test('threshold/granularity overrides parse and mark the override flags (ac-2)', async () => {
    const r = start(['-t', '0.2', '-d', 'high', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const state = JSON.parse(
      await readFile(join(dir, '.ditto/local/work-items', wiId, 'tech-spec-state.json'), 'utf8'),
    );
    expect(state.question_config.threshold).toBe(0.2);
    expect(state.question_config.granularity).toBe('high');
    expect(state.question_config.threshold_override).toBe(true);
    expect(state.question_config.granularity_override).toBe(true);
  });

  test('rejects out-of-range intensity', () => {
    const r = start(['-i', '150']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/intensity/);
  });

  test('rejects generators outside 1..6', () => {
    const r = start(['-g', '7']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/generators/);
  });

  test('rejects an undefined performance preset', () => {
    const r = start(['-p', 'turbo']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/performance/);
  });

  test('rejects threshold outside [0,1]', () => {
    const r = start(['-t', '1.5']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/threshold/);
  });

  test('rejects an undefined gate-mode', () => {
    const r = start(['-m', 'sometimes']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/gate-mode/);
  });

  test('rejects an undefined generator-effort', () => {
    const r = start(['-e', 'turbo']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/generator-effort/);
  });

  test('rejects an undefined granularity', () => {
    const r = start(['-d', 'extreme']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/granularity/);
  });

  test('malformed config.json → start still succeeds (fail-open) but warns on stderr', async () => {
    await mkdir(join(dir, '.ditto', 'local'), { recursive: true });
    await writeFile(join(dir, '.ditto', 'local', 'config.json'), '{ not valid json', 'utf8');
    const r = start(['--output', 'json']);
    expect(r.exitCode).toBe(0); // fail-open: a broken config never blocks start
    expect(r.stderr).toMatch(/config\.json/i); // but the user is warned it was ignored
  });
});
