import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');
const cli = join(repoRoot, 'src', 'cli', 'index.ts');
let dir: string;

function run(args: string[]) {
  return Bun.spawnSync(['bun', 'run', cli, ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-knowledge-cli-'));
  await writeFile(join(dir, 'CLAUDE.md'), 'free area\n', 'utf8');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('bridge knowledge CLI', () => {
  test('--check on a CLAUDE.md missing the knowledge block reports drift (exit 1)', async () => {
    const check = run(['bridge', 'knowledge', '--check', '--output', 'json']);
    expect(check.exitCode).toBe(1); // block absent → would append → drift
    expect(JSON.parse(check.stdout.toString()).action).toBe('would-update');
  });

  test('projects the knowledge block into CLAUDE.md and is idempotent', async () => {
    const written = run(['bridge', 'knowledge', '--output', 'json']);
    expect(written.exitCode).toBe(0);
    expect(JSON.parse(written.stdout.toString()).action).toBe('updated'); // appended the block
    const text = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
    expect(text).toContain('free area'); // user content preserved
    expect(text).toContain('DITTO Knowledge (projected');

    const again = run(['bridge', 'knowledge', '--check', '--output', 'json']);
    expect(again.exitCode).toBe(0); // projection current → no drift
    expect(JSON.parse(again.stdout.toString()).action).toBe('would-be-unchanged');
  });
});
