import { resolve } from 'node:path';
import { defineCommand } from 'citty';
import { resolveRepoRootForCreate } from '~/core/fs';
import { initScaffold } from '~/core/init-scaffold';
import { RUNTIME_ERROR_EXIT, parseOutputFormat, writeError, writeHuman, writeJson } from '../util';

export const initCommand = defineCommand({
  meta: {
    name: 'init',
    description: 'Scaffold a .ditto/ workspace in the target project (idempotent)',
  },
  args: {
    dir: {
      type: 'string',
      required: false,
      description: 'Target directory; defaults to the nearest .ditto/.git root or cwd',
    },
    output: { type: 'string', default: 'human', description: 'Output format: human|json' },
  },
  run: async ({ args }) => {
    try {
      const format = parseOutputFormat(args.output);
      const repoRoot = args.dir ? resolve(args.dir) : await resolveRepoRootForCreate();
      const result = await initScaffold(repoRoot, new Date());

      if (format === 'json') {
        writeJson(result);
        return;
      }

      if (result.alreadyInitialized) {
        writeHuman(`.ditto/ already initialized at ${result.repoRoot}`);
      } else {
        writeHuman(`initialized .ditto/ at ${result.repoRoot}`);
      }
      writeHuman(
        `dirs: ${result.createdDirs.length} created · files: ${result.createdFiles.length} created, ${result.skippedFiles.length} kept`,
      );
      for (const path of result.createdFiles) writeHuman(`  + ${path}`);
      for (const path of result.skippedFiles) writeHuman(`  = ${path} (kept)`);
    } catch (err) {
      writeError(`init failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});
