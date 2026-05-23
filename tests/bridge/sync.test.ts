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
  dir = await mkdtemp(join(tmpdir(), 'ditto-bridge-cli-'));
  await writeFile(join(dir, 'AGENTS.md'), '# AGENTS\nshared instruction line 1\n', 'utf8');
  await writeFile(join(dir, 'CLAUDE.md'), 'free area\n', 'utf8');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('bridge sync CLI', () => {
  test('syncs claude-code projection and rejects codex target', async () => {
    const sync = run(['bridge', 'sync', '--host', 'claude-code', '--output', 'json']);
    expect(sync.exitCode).toBe(0);
    expect(sync.stderr.toString()).toContain('appended new managed block');
    const text = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
    expect(text).toContain('free area');
    expect(text).toContain('shared instruction line 1');

    await writeFile(join(dir, 'AGENTS.md'), '# AGENTS\nchanged\n', 'utf8');
    const check = run(['bridge', 'sync', '--host', 'claude-code', '--check', '--output', 'json']);
    expect(check.exitCode).toBe(1);
    expect(JSON.parse(check.stdout.toString()).action).toBe('would-update');

    const codex = run(['bridge', 'sync', '--host', 'codex']);
    expect(codex.exitCode).toBe(65);
  });
});
