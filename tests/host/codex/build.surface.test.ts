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
    expect(tomls.length).toBe(15);
    expect(tomls).toContain('reviewer.toml');
  });
});
