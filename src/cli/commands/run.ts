import { defineCommand } from 'citty';
import {
  NOT_IMPLEMENTED_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

const runRecord = defineCommand({
  meta: {
    name: 'record',
    description: 'Attach a provider invocation to a work item as a recorded run',
  },
  args: {
    workId: {
      type: 'positional',
      description: 'Work item id to attach this run to',
      required: true,
    },
    provider: {
      type: 'string',
      description: 'Provider name: codex|claude-code|opencode|openagent|other',
      required: true,
    },
    profile: {
      type: 'string',
      description: 'Execution profile',
      default: 'workspace-write',
    },
    prompt: {
      type: 'string',
      description: 'Path to prompt/context packet file',
      required: false,
    },
    output: {
      type: 'string',
      description: 'Output format: human|json',
      default: 'human',
    },
  },
  run: ({ args }) => {
    const format = parseOutputFormat(args.output);
    if (format === 'json') {
      writeJson({
        action: 'run.record',
        status: 'not_implemented',
        input: {
          workId: args.workId,
          provider: args.provider,
          profile: args.profile,
          prompt: args.prompt ?? null,
        },
      });
    } else {
      writeHuman('run.record is not implemented yet (v0.1 skeleton).');
    }
    writeError('ditto run record: not implemented in v0.1 skeleton');
    process.exit(NOT_IMPLEMENTED_EXIT);
  },
});

export const runCommand = defineCommand({
  meta: {
    name: 'run',
    description: 'Record and inspect provider runs',
  },
  subCommands: {
    record: runRecord,
  },
});
