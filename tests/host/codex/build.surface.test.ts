// Codex host surface: build output (N3-codex-plugin-build, wi_260613f9d).
//
// Asserts `bun run build:codex-plugin` assembles a loadable Codex plugin in
// dist/codex-plugin: the manifest parses as JSON with the required fields, and
// the manifest + bin + hooks files exist. Runs the build fresh so the test is
// self-contained.
//
// M4: the build now runs under `bun` (it imports the .ts agent-projection
// module) and also emits .codex/agents/*.toml.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..', '..');
const OUT = join(REPO, 'dist', 'codex-plugin');

describe('Codex host surface — build:codex-plugin', () => {
  test('build assembles a loadable Codex plugin', () => {
    const proc = Bun.spawnSync(['bun', 'scripts/build-codex-plugin.mjs'], {
      cwd: REPO,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(0);

    const manifestPath = join(OUT, '.codex-plugin', 'plugin.json');
    expect(existsSync(manifestPath)).toBe(true);
    expect(existsSync(join(OUT, 'bin', 'ditto'))).toBe(true);
    expect(existsSync(join(OUT, 'hooks', 'hooks.json'))).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.name).toBe('ditto');
    expect(typeof manifest.version).toBe('string');
    expect(typeof manifest.description).toBe('string');
    expect(manifest.skills).toBeDefined();
    expect(manifest.hooks).toBeDefined();

    // M4: agent projection emitted into the build artifact.
    const agentsDir = join(OUT, '.codex', 'agents');
    const tomls = readdirSync(agentsDir).filter((f) => f.endsWith('.toml'));
    expect(tomls.length).toBe(20);
    expect(tomls).toContain('reviewer.toml');
  });

  test('dialectic Codex routing instructions are host-aware in the shipped artifact', () => {
    const proc = Bun.spawnSync(['bun', 'scripts/build-codex-plugin.mjs'], {
      cwd: REPO,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(0);

    const skill = readFileSync(join(OUT, 'skills', 'dialectic', 'SKILL.md'), 'utf8');
    const opponent = readFileSync(join(OUT, '.codex', 'agents', 'dialectic-opponent.toml'), 'utf8');
    for (const text of [skill, opponent]) {
      expect(text).toContain('Codex host');
      expect(text).toContain('Claude Code host');
      expect(text).toContain('separate context');
      expect(text).toContain('generic Codex subagent');
      expect(text).toContain('do not call Claude Code');
      expect(text).not.toContain('ditto never spawns Codex itself');
      expect(text).not.toContain('spawn the `dialectic-opponent` agent on the Claude fallback');
    }
  });
});
