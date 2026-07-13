import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');
const cli = join(repoRoot, 'src', 'cli', 'index.ts');

// Build a full consumer-style plugin root: the shipped surface Claude Code loads
// from the plugin cache. It carries NO src/ (a built distribution), so binary_fresh
// is vacuously fresh — freshness only matters in a dev checkout.
async function makePluginRoot(root: string) {
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ditto' }));
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(join(root, 'bin', 'ditto'), '#!/usr/bin/env bun\n');
  await mkdir(join(root, 'skills'), { recursive: true });
  await mkdir(join(root, 'agents'), { recursive: true });
  await mkdir(join(root, 'hooks'), { recursive: true });
  await writeFile(
    join(root, 'hooks', 'hooks.json'),
    JSON.stringify({ hooks: { SessionStart: [{ matcher: '', hooks: [] }] } }),
  );
}

describe('doctor distribution (consumer install: plugin root ≠ target)', () => {
  let target: string;
  let plugin: string;

  function runIn(args: string[], env: Record<string, string> = {}) {
    return Bun.spawnSync(['bun', 'run', cli, ...args], {
      cwd: target,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: plugin, ...env },
    });
  }

  beforeEach(async () => {
    target = await mkdtemp(join(tmpdir(), 'ditto-dist-target-'));
    plugin = await mkdtemp(join(tmpdir(), 'ditto-dist-plugin-'));
    await mkdir(join(target, '.ditto', 'knowledge'), { recursive: true });
    await writeFile(join(target, '.ditto', 'knowledge', 'glossary.json'), '{}');
    await makePluginRoot(plugin);
  });

  afterEach(async () => {
    await rm(target, { recursive: true, force: true });
    await rm(plugin, { recursive: true, force: true });
  });

  test('ac-1: a located plugin root with full surface reports ok, 0 findings', () => {
    const proc = runIn(['doctor', 'distribution', '--output', 'json']);
    const json = JSON.parse(proc.stdout.toString());
    expect(json.status).toBe('ok');
    expect(json.plugin_root).toBe(plugin);
    expect(json.plugin_root_source).toBe('env');
    expect(json.checks.plugin_surface_present).toBe(true);
    expect(json.checks.binary_built).toBe(true);
    expect(json.checks.hooks_registered).toBe(true);
    expect(proc.exitCode).toBe(0);
  });

  test("ac-3: the target's own src/ never misjudges binary_fresh (fresh is a plugin-root property)", async () => {
    // The reported bug: a consumer project that happens to ship its own src/ was
    // treated as a dev checkout. Freshness is probed at the PLUGIN root (no src/),
    // so the target's src/ is irrelevant.
    await mkdir(join(target, 'src'), { recursive: true });
    await writeFile(join(target, 'src', 'index.ts'), 'export {}');
    const proc = runIn(['doctor', 'distribution', '--output', 'json']);
    const json = JSON.parse(proc.stdout.toString());
    expect(json.checks.binary_fresh).toBe(true);
    expect(json.status).toBe('ok');
    expect(proc.exitCode).toBe(0);
  });
});
