import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listHostAdapters } from '~/core/hosts';
import { setup } from '~/core/setup';
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

function hookEntry(command: string) {
  return [{ matcher: '', hooks: [{ type: 'command', command }] }];
}

async function makeCodexPluginFixture(): Promise<string> {
  const pluginRoot = await mkdtemp(join(tmpdir(), 'ditto-doctor-codex-plugin-'));
  await mkdir(join(pluginRoot, 'resources', 'managed'), { recursive: true });
  await mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true });
  await mkdir(join(pluginRoot, '.codex', 'agents'), { recursive: true });
  await mkdir(join(pluginRoot, 'skills', 'verify'), { recursive: true });
  await mkdir(join(pluginRoot, 'hooks'), { recursive: true });

  await writeFile(join(pluginRoot, 'resources', 'managed', 'AGENTS.md'), '# Agent rules\n');
  await writeFile(join(pluginRoot, 'resources', 'managed', 'GLOBAL_AGENTS.md'), '# Global rules\n');
  await writeFile(
    join(pluginRoot, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'ditto', version: '0.0.0', description: 'test' }),
  );
  await writeFile(join(pluginRoot, '.codex', 'agents', 'verifier.toml'), 'name = "verifier"\n');
  await writeFile(join(pluginRoot, 'skills', 'verify', 'SKILL.md'), '# Verify\n');
  await writeFile(
    join(pluginRoot, 'hooks', 'hooks.json'),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: hookEntry(
          '"${CLAUDE_PLUGIN_ROOT}/bin/ditto" hook user-prompt-submit --host codex',
        ),
        Stop: hookEntry('"${CLAUDE_PLUGIN_ROOT}/bin/ditto" hook stop --host codex'),
        PreCompact: hookEntry('"${CLAUDE_PLUGIN_ROOT}/bin/ditto" hook pre-compact --host codex'),
        PostToolUse: hookEntry('"${CLAUDE_PLUGIN_ROOT}/bin/ditto" hook post-tool-use --host codex'),
        PreToolUse: hookEntry('"${CLAUDE_PLUGIN_ROOT}/bin/ditto" hook pre-tool-use --host codex'),
      },
    }),
  );
  return pluginRoot;
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
    await mkdir(join(dir, '.ditto', 'local'), { recursive: true });
    await mkdir(join(dir, '.claude', 'commands'), { recursive: true });
    await cp(
      join(repoRoot, 'tests', 'fixtures', 'doctor', 'claude-code', 'surface-ok', 'surfaces.json'),
      join(dir, '.ditto', 'local', 'surfaces.json'),
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
    await mkdir(join(dir, '.ditto', 'local'), { recursive: true });
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
      join(dir, '.ditto', 'local', 'surfaces.json'),
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
    await mkdir(join(dir, '.ditto', 'local'), { recursive: true });
    await writeFile(
      join(dir, '.ditto', 'local', 'surfaces.json'),
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
    await mkdir(join(dir, '.ditto', 'local'), { recursive: true });
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
      join(dir, '.ditto', 'local', 'surfaces.json'),
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
    await mkdir(join(dir, '.ditto', 'local'), { recursive: true });
    await mkdir(join(dir, '.claude', 'commands'), { recursive: true });
    await writeFile(join(dir, '.claude', 'commands', 'hello.md'), '# hello\n', 'utf8');
    await writeFile(
      join(dir, '.ditto', 'local', 'surfaces.json'),
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

  test('codex setup target passes surface/instructions and reports plugin enable need', async () => {
    const pluginRoot = await makeCodexPluginFixture();
    try {
      await setup({
        resourcesDir: join(pluginRoot, 'resources', 'managed'),
        projectRoot: dir,
        homeDir: home,
        now: new Date('2026-06-14T00:00:00.000Z'),
        host: 'codex',
        pluginRoot,
      });

      const surface = run(['doctor', 'surface', '--host', 'codex', '--output', 'json']);
      expect(surface.exitCode).toBe(0);
      expect(JSON.parse(surface.stdout.toString()).mismatch_count).toBe(0);

      const capability = run(['doctor', 'capability', '--host', 'codex', '--output', 'json']);
      expect(capability.exitCode).toBe(1);
      const capabilityJson = JSON.parse(capability.stdout.toString());
      expect(capabilityJson.findings).toContainEqual(
        expect.objectContaining({
          kind: 'codex_plugin_needs_user_action',
          capability: 'plugin-enabled',
        }),
      );

      const instructions = run(['doctor', 'instructions', '--host', 'codex', '--output', 'json']);
      expect(instructions.exitCode).toBe(0);
      expect(JSON.parse(instructions.stdout.toString()).findings).toEqual([]);
    } finally {
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });
});

describe('generated surface catalog (G6: code-generated, no hand drift)', () => {
  test('code-generated catalog has the source-pinned surface count (no hand drift)', async () => {
    // Code-self-contained (wi_260715ujg): assert the pure code scan against a committed
    // count literal instead of diffing the gitignored, per-developer
    // .ditto/local/surfaces.json (absent on a fresh clone/worktree, and whose pre-push
    // regen flaked concurrent pushes). The hardcoded 49 is the anchor — a surface added
    // or removed changes the scan count and fails here (drift caught, not silent).
    const generated = await generateSurfaceCatalog(listHostAdapters(), repoRoot);
    expect(generated.surfaces.length).toBe(49);
  });
});
