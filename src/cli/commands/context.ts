import { defineCommand } from 'citty';
import { ContextBuildUsageError, buildContextPacket } from '~/core/context-packet';
import { resolveRepoRootForCreate } from '~/core/fs';
import { RUNTIME_ERROR_EXIT, USAGE_ERROR_EXIT, writeError, writeHuman } from '../util';

const contextBuild = defineCommand({
  meta: {
    name: 'build',
    description: 'Build a markdown context packet for a work item',
  },
  args: {
    workItem: {
      type: 'string',
      description: 'Work item id to build context for',
      required: true,
    },
    output: {
      type: 'string',
      description: 'Repo-relative output path; defaults to the work item context-packet.md',
      required: false,
    },
  },
  run: async ({ args }) => {
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const result = await buildContextPacket(repoRoot, {
        work_item_id: args.workItem,
        ...(args.output ? { output_path: args.output } : {}),
      });
      writeHuman(result.output_path);
    } catch (err) {
      if (err instanceof ContextBuildUsageError) {
        writeError(`context build failed: ${err.message}`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      writeError(`context build failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

export const contextCommand = defineCommand({
  meta: {
    name: 'context',
    description: 'Build and inspect context packets',
  },
  subCommands: {
    build: contextBuild,
  },
});
