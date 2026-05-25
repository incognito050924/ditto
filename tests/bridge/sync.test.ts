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

  test('free-area-only edits leave managed block unchanged and preserve user lines', async () => {
    const first = run(['bridge', 'sync', '--host', 'claude-code', '--output', 'json']);
    expect(first.exitCode).toBe(0);
    const beforeUserEdit = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
    await writeFile(join(dir, 'CLAUDE.md'), `${beforeUserEdit}\n사용자 추가 줄\n`);
    const second = run(['bridge', 'sync', '--host', 'claude-code', '--output', 'json']);
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout.toString()).action).toBe('unchanged');
    const after = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
    expect(after).toContain('사용자 추가 줄');
    expect(after).toContain('shared instruction line 1');
  });

  test('refuses sync when CLAUDE.md has multiple managed blocks', async () => {
    await writeFile(
      join(dir, 'CLAUDE.md'),
      [
        '<!-- ditto:managed:start source=AGENTS.md sha256=0000000000000000000000000000000000000000000000000000000000000000 -->',
        'block 1',
        '<!-- ditto:managed:end -->',
        '',
        'free area',
        '',
        '<!-- ditto:managed:start source=AGENTS.md sha256=1111111111111111111111111111111111111111111111111111111111111111 -->',
        'block 2',
        '<!-- ditto:managed:end -->',
        '',
      ].join('\n'),
    );
    const before = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
    const proc = run(['bridge', 'sync', '--host', 'claude-code', '--output', 'json']);
    expect(proc.exitCode).toBe(1);
    const json = JSON.parse(proc.stdout.toString());
    expect(json.action).toBe('refused-multiple-markers');
    expect(proc.stderr.toString()).toContain('clean up to exactly one block');
    const after = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
    expect(after).toBe(before);
  });
});
