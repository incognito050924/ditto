import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');
const cli = join(repoRoot, 'src', 'cli', 'index.ts');
let dir: string;
let home: string;

function run(args: string[]) {
  return Bun.spawnSync(['bun', 'run', cli, ...args], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, HOME: home },
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-doctor-surface-'));
  home = await mkdtemp(join(tmpdir(), 'ditto-home-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('doctor surface', () => {
  test('passes matching surface inventory', async () => {
    await mkdir(join(dir, '.ditto'), { recursive: true });
    await mkdir(join(dir, '.claude', 'commands'), { recursive: true });
    await cp(
      join(repoRoot, 'tests', 'fixtures', 'doctor', 'claude-code', 'surface-ok', 'surfaces.json'),
      join(dir, '.ditto', 'surfaces.json'),
    );
    await cp(
      join(repoRoot, 'tests', 'fixtures', 'doctor', 'claude-code', 'surface-ok', 'hello.md'),
      join(dir, '.claude', 'commands', 'hello.md'),
    );
    const proc = run(['doctor', 'surface', '--host', 'claude-code', '--output', 'json']);
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString()).mismatch_count).toBe(0);
  });

  test('reports missing surface inventory entries', async () => {
    await mkdir(join(dir, '.ditto'), { recursive: true });
    await cp(
      join(
        repoRoot,
        'tests',
        'fixtures',
        'doctor',
        'claude-code',
        'surface-mismatch',
        'surfaces.json',
      ),
      join(dir, '.ditto', 'surfaces.json'),
    );
    const proc = run(['doctor', 'surface', '--host', 'claude-code', '--output', 'json']);
    expect(proc.exitCode).toBe(1);
    expect(JSON.parse(proc.stdout.toString()).findings[0].mismatch).toBe('missing_file');
  });

  test('discovers claude-code agent markdown files', async () => {
    await mkdir(join(dir, '.claude', 'agents'), { recursive: true });
    await writeFile(join(dir, '.claude', 'agents', 'reviewer.md'), '# reviewer\n', 'utf8');
    await writeFile(join(dir, '.claude', 'agents', '.DS_Store'), 'noise\n', 'utf8');
    const proc = run(['doctor', 'surface', '--host', 'claude-code', '--output', 'json']);
    expect(proc.exitCode).toBe(0);
    const json = JSON.parse(proc.stdout.toString());
    expect(
      json.surfaces.some(
        (surface: { kind: string; id: string }) =>
          surface.kind === 'agent' && surface.id === 'reviewer',
      ),
    ).toBe(true);
    expect(
      json.surfaces.some(
        (surface: { kind: string; id: string }) =>
          surface.kind === 'agent' && surface.id === '.DS_Store',
      ),
    ).toBe(false);
  });
});
