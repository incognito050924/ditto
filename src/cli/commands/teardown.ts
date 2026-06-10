import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { defineCommand } from 'citty';
import { resolveRepoRootForCreate } from '~/core/fs';
import { teardown } from '~/core/teardown';
import { resolveResourcesDir } from '../resources';
import { RUNTIME_ERROR_EXIT, writeError, writeHuman } from '../util';

export const teardownCommand = defineCommand({
  meta: {
    name: 'teardown',
    description:
      'Undo ditto setup: strip managed blocks (preserving user content), remove the allow rule; keeps .ditto/',
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

      // Self-host no-op: the ditto repo must not manage itself. Mirrors setup's
      // guard (resourcesDir's plugin root == projectRoot).
      const pluginRoot = resolve(resourcesDir, '..', '..');
      if (pluginRoot === projectRoot) {
        writeHuman(`teardown: skipped (self-host — target IS the ditto repo at ${projectRoot})`);
        return;
      }

      const result = await teardown({ resourcesDir, projectRoot, homeDir: homedir() });

      // No discovered resources means nothing was actually stripped — saying
      // "reverted" here would be a false green (the pre-fix symptom).
      if (result.files.length === 0) {
        writeError(`teardown failed: no managed resources found at ${resourcesDir}`);
        process.exit(RUNTIME_ERROR_EXIT);
      }

      writeHuman(`teardown: reverted ${projectRoot}`);
      for (const f of result.files) {
        writeHuman(`  ${f.filename} [${f.scope}] ${f.action} → ${f.destPath}`);
      }
      writeHuman(`allowlist: removed Bash(ditto:*) from ${result.allowlistPath} · .ditto/ kept`);
    } catch (err) {
      writeError(`teardown failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});
