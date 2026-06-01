import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listHostAdapters } from '~/core/hosts';
import { generateSurfaceCatalog } from '~/core/surface-inventory';

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
    // Seed a matching catalog — absent catalog now fails strictly (M1.6); this
    // test asserts *discovery* (reviewer surfaced, .DS_Store filtered), not drift.
    await mkdir(join(dir, '.ditto'), { recursive: true });
    await writeFile(
      join(dir, '.ditto', 'surfaces.json'),
      JSON.stringify({
        schema_version: '0.1.0',
        surfaces: [
          {
            host: 'claude-code',
            kind: 'agent',
            id: 'reviewer',
            path: '.claude/agents/reviewer.md',
          },
        ],
      }),
    );
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

  test('--advisory keeps drift exit code at zero for surface', async () => {
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
    const proc = run([
      'doctor',
      'surface',
      '--host',
      'claude-code',
      '--advisory',
      '--output',
      'json',
    ]);
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString()).mismatch_count).toBeGreaterThan(0);
  });

  test('home-scope skills are inventoried but excluded from mismatch comparison', async () => {
    await mkdir(join(home, '.claude', 'skills', 'extra-a'), { recursive: true });
    await mkdir(join(home, '.claude', 'skills', 'extra-b'), { recursive: true });
    await mkdir(join(home, '.claude', 'skills', 'extra-c'), { recursive: true });
    await mkdir(join(dir, '.ditto'), { recursive: true });
    await mkdir(join(dir, '.claude', 'commands'), { recursive: true });
    await writeFile(join(dir, '.claude', 'commands', 'hello.md'), '# hello\n', 'utf8');
    await writeFile(
      join(dir, '.ditto', 'surfaces.json'),
      JSON.stringify({
        schema_version: '0.1.0',
        surfaces: [
          {
            host: 'claude-code',
            kind: 'command',
            id: 'hello',
            path: '.claude/commands/hello.md',
          },
        ],
      }),
      'utf8',
    );
    const proc = run(['doctor', 'surface', '--host', 'claude-code', '--output', 'json']);
    expect(proc.exitCode).toBe(0);
    const json = JSON.parse(proc.stdout.toString());
    expect(json.mismatch_count).toBe(0);
    expect(
      json.surfaces.some(
        (surface: { kind: string; id: string }) =>
          surface.kind === 'skill' && surface.id === 'extra-a',
      ),
    ).toBe(true);
    expect(json.findings.some((finding: { id: string }) => finding.id === 'extra-a')).toBe(false);
  });
});

describe('generated surface catalog (G6: code-generated, no hand drift)', () => {
  test('regenerating from code equals the committed .ditto/surfaces.json', async () => {
    const committed = JSON.parse(readFileSync(join(repoRoot, '.ditto', 'surfaces.json'), 'utf8'));
    const generated = await generateSurfaceCatalog(listHostAdapters(), repoRoot);
    // committed catalog IS the generator's output; a surface added without
    // running scripts/gen-surfaces.ts makes this fail (drift caught, not silent).
    expect(generated).toEqual(committed);
  });
});
