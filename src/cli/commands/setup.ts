import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineCommand } from 'citty';
import { resolveRepoRootForCreate } from '~/core/fs';
import { setup } from '~/core/setup';
import { RUNTIME_ERROR_EXIT, writeError, writeHuman } from '../util';

/**
 * Resolve the bundled resources directory. Under the installed plugin layout the
 * plugin root is `${CLAUDE_PLUGIN_ROOT}`. Otherwise (manual/dev invocation) walk
 * up from this module to the first ancestor that holds `resources/managed`. This
 * is depth-independent, so it resolves correctly whether the entry point is the
 * source file (src/cli/commands), the repo-root bundle (bin/ditto), or the
 * product bundle (dist/plugin/bin/ditto) — a fixed `../../..` only matched the
 * first and last, silently mis-resolving the repo-root bundle.
 */
function resolveResourcesDir(): string {
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    return join(process.env.CLAUDE_PLUGIN_ROOT, 'resources', 'managed');
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'resources', 'managed');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last-resort: the original source-layout guess (src/cli/commands → repo root).
  return join(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
    'resources',
    'managed',
  );
}

export const setupCommand = defineCommand({
  meta: {
    name: 'setup',
    description:
      'Install ditto managed resources, scaffold .ditto/, and allowlist the target project',
  },
  args: {
    dir: {
      type: 'string',
      required: false,
      description: 'Target project directory; defaults to the nearest .ditto/.git root or cwd',
    },
  },
  run: async ({ args }) => {
    try {
      const projectRoot = args.dir ? resolve(args.dir) : await resolveRepoRootForCreate();
      const resourcesDir = resolveResourcesDir();

      // Self-host no-op: the ditto repo must not manage itself. Detect by the
      // bundled resources dir resolving inside the target (resourcesDir's plugin
      // root == projectRoot), mirroring install-plugin.mjs's `target === repo`.
      const pluginRoot = resolve(resourcesDir, '..', '..');
      if (pluginRoot === projectRoot) {
        writeHuman(`setup: skipped (self-host — target IS the ditto repo at ${projectRoot})`);
        return;
      }

      const result = await setup({
        resourcesDir,
        projectRoot,
        homeDir: homedir(),
        now: new Date(),
      });

      writeHuman(`setup: installed into ${projectRoot}`);
      for (const r of result.resources) {
        const tag = r.status === 'corrupted' ? 'SKIPPED (corrupted markers)' : `→ ${r.destPath}`;
        const bak = r.backupPath ? ` (backup ${r.backupPath})` : '';
        writeHuman(`  ${r.filename} [${r.scope}] ${tag}${bak}`);
      }
      writeHuman(
        `.ditto/: ${result.scaffold.alreadyInitialized ? 'already initialized' : 'created'} · allowlist: ${result.allowlistPath}`,
      );
    } catch (err) {
      writeError(`setup failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});
