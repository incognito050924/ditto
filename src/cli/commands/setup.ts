import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineCommand } from 'citty';
import { resolveRepoRootForCreate } from '~/core/fs';
import { setup } from '~/core/setup';
import { RUNTIME_ERROR_EXIT, writeError, writeHuman } from '../util';

/**
 * Resolve the bundled resources directory. Under the installed plugin layout the
 * plugin root is `${CLAUDE_PLUGIN_ROOT}`; otherwise fall back to the repo root
 * derived from this module's location (src/cli/commands → repo root).
 */
function resolveResourcesDir(): string {
  const pluginRoot =
    process.env.CLAUDE_PLUGIN_ROOT ??
    resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  return join(pluginRoot, 'resources', 'managed');
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
