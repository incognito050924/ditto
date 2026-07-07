import { beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// End-to-end: a per-user .ditto/local/config.json `deep_interview` block must
// actually reach `deep-interview start` (config → resolved options), with CLI
// flags still winning and a broken config failing open with a warning. This is
// the "does the config actually fire" guarantee — not just that the file parses.
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

async function writeConfig(obj: unknown): Promise<void> {
  const localDir = join(dir, '.ditto', 'local');
  await mkdir(localDir, { recursive: true });
  await writeFile(
    join(localDir, 'config.json'),
    typeof obj === 'string' ? obj : JSON.stringify(obj),
    'utf8',
  );
}

function startInterviewJson(extraArgs: string[] = []): {
  threshold: number;
  question_cap: number;
  generators: number;
} {
  const wi = JSON.parse(
    spawnDitto([
      'work',
      'start',
      'interview config target',
      '--request',
      'di config e2e',
      '--output',
      'json',
    ]).stdout,
  ).work_item_id as string;
  const res = spawnDitto([
    'deep-interview',
    'start',
    '--workItem',
    wi,
    '--output',
    'json',
    ...extraArgs,
  ]);
  expect(res.exitCode).toBe(0);
  const parsed = JSON.parse(res.stdout);
  return { ...parsed, _stderr: res.stderr } as never;
}

describe('deep-interview start ← .ditto/local/config.json deep_interview block (wi_260621p6a)', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ditto-di-cfg-'));
    git(['init']);
  });

  test('config defaults are applied when no CLI flag is given', async () => {
    await writeConfig({ deep_interview: { threshold: 0.85, question_cap: 5, generators: 3 } });
    const r = startInterviewJson();
    expect(r.threshold).toBe(0.85);
    expect(r.question_cap).toBe(5);
    expect(r.generators).toBe(3);
  });

  test('absent config → code defaults (0.7 / 8 / 1)', async () => {
    const r = startInterviewJson();
    expect(r.threshold).toBe(0.7);
    expect(r.question_cap).toBe(8);
    expect(r.generators).toBe(1);
  });

  test('explicit CLI flag wins over config', async () => {
    await writeConfig({ deep_interview: { generators: 2, threshold: 0.8 } });
    const r = startInterviewJson(['--generators', '5']);
    expect(r.generators).toBe(5); // flag wins
    expect(r.threshold).toBe(0.8); // config still fills the unspecified one
  });

  test('partial config fills only its keys; rest fall to code defaults', async () => {
    await writeConfig({ deep_interview: { generators: 4 } });
    const r = startInterviewJson();
    expect(r.generators).toBe(4);
    expect(r.threshold).toBe(0.7);
    expect(r.question_cap).toBe(8);
  });

  test('malformed config → fail-open to defaults + stderr warning (not silent)', async () => {
    await writeConfig('{ not json');
    const wi = JSON.parse(
      spawnDitto(['work', 'start', 'x', '--request', 'y', '--output', 'json']).stdout,
    ).work_item_id as string;
    const res = spawnDitto(['deep-interview', 'start', '--workItem', wi, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout).generators).toBe(1);
    expect(res.stderr).toContain('config.json');
  });
});

// 기제 C (wi_260706n4w): the CLI `deep-interview start` is the seam that turns
// user-intent dimension seeding ON (driver default stays false, ac-6) — mirroring
// the coverage-next seam for `seedCategories`. The seeded ids are surfaced so the
// SKILL driver knows which user-intent lenses to carry into the interview.
describe('deep-interview start seeds user-intent far-field dimensions at the CLI seam (wi_260706n4w)', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ditto-di-seed-'));
    git(['init']);
  });

  test('start seeds floor user-intent categories as dimensions and surfaces them in JSON', async () => {
    const wi = JSON.parse(
      spawnDitto(['work', 'start', 'seed target', '--request', 'seed e2e', '--output', 'json'])
        .stdout,
    ).work_item_id as string;
    const res = spawnDitto(['deep-interview', 'start', '--workItem', wi, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout) as { seeded_dimensions: string[] };
    expect(parsed.seeded_dimensions).toContain('authorization-model');
    expect(parsed.seeded_dimensions).toContain('regulatory');
    // persisted in interview-state.json on disk, not just printed.
    const stateRaw = await readFile(
      join(dir, '.ditto', 'local', 'work-items', wi, 'interview-state.json'),
      'utf8',
    );
    const state = JSON.parse(stateRaw) as {
      dimensions: { id: string; critical: boolean; state: string }[];
    };
    const seeded = state.dimensions.filter(
      (d) => d.id === 'authorization-model' || d.id === 'regulatory',
    );
    expect(seeded).toHaveLength(2);
    for (const d of seeded) {
      expect(d.critical).toBe(false);
      expect(d.state).toBe('unknown');
    }
  });
});
