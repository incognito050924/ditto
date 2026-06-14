import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'citty';
import { resolveCodexPluginRoot, setupCommand } from '~/cli/commands/setup';

describe('setup command', () => {
  test('source repo invocation prefers dist/codex-plugin over the source repo root', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ditto-setup-command-repo-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'ditto-setup-command-target-'));
    try {
      const resourcesDir = join(repo, 'resources', 'managed');
      const distRoot = join(repo, 'dist', 'codex-plugin');
      await mkdir(join(repo, '.codex-plugin'), { recursive: true });
      await mkdir(resourcesDir, { recursive: true });
      await mkdir(join(distRoot, '.codex-plugin'), { recursive: true });
      await mkdir(join(distRoot, '.codex', 'agents'), { recursive: true });

      await writeFile(join(repo, '.codex-plugin', 'plugin.json'), '{}\n');
      await writeFile(join(distRoot, '.codex-plugin', 'plugin.json'), '{}\n');
      await writeFile(join(distRoot, '.codex', 'agents', 'reviewer.toml'), 'name = "reviewer"\n');

      await expect(resolveCodexPluginRoot(resourcesDir, projectRoot)).resolves.toBe(distRoot);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test('accepts the target project as a positional argument after options', () => {
    const args = parseArgs(['--host', 'codex', '/tmp/ditto-target'], setupCommand.args ?? {});

    expect(args.host).toBe('codex');
    expect(args.target).toBe('/tmp/ditto-target');
  });
});
