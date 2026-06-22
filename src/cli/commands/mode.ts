import { defineCommand } from 'citty';
import { resolveRepoRootForCreate } from '~/core/fs';
import { collectModeReport, formatModeHuman } from '~/core/mode-doctor';
import {
  InvalidOutputFormatError,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

const MODE_RUNTIME_ERROR_EXIT = 70;

/**
 * `ditto mode` (WI-A) — the active form of the SessionStart mode banner: answer
 * "what ditto am I running, is the installed plugin stale, and what do I run?"
 * on demand from any terminal. The pure verdict + presentation live in
 * `~/core/mode-doctor` (shared with the SessionStart hook); this only wires IO.
 */
export const modeCommand = defineCommand({
  meta: {
    name: 'mode',
    description:
      'Report which ditto this session runs (dev working-tree vs installed), whether the installed plugin is stale, and the deploy action to take',
  },
  args: {
    output: { type: 'string', default: 'human', description: 'Output format: human|json' },
  },
  run: async ({ args }) => {
    try {
      const format = parseOutputFormat(args.output);
      const repoRoot = await resolveRepoRootForCreate();
      const { report, inDittoRepo } = collectModeReport(repoRoot);
      if (format === 'json') {
        writeJson({ ...report, inDittoRepo });
      } else {
        for (const line of formatModeHuman(report, inDittoRepo)) writeHuman(line);
      }
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(
        err instanceof InvalidOutputFormatError ? USAGE_ERROR_EXIT : MODE_RUNTIME_ERROR_EXIT,
      );
    }
  },
});
