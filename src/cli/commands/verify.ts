import { defineCommand } from 'citty';
import {
  NOT_IMPLEMENTED_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

export const verifyCommand = defineCommand({
  meta: {
    name: 'verify',
    description: 'Run acceptance verifications for a work item and record evidence',
  },
  args: {
    workId: {
      type: 'positional',
      description: 'Work item id to verify',
      required: true,
    },
    criterion: {
      type: 'string',
      description: 'Optional acceptance criterion id; defaults to all',
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
        action: 'verify',
        status: 'not_implemented',
        input: {
          workId: args.workId,
          criterion: args.criterion ?? null,
        },
      });
    } else {
      writeHuman(`verify for ${args.workId} is not implemented yet (v0.1 skeleton).`);
    }
    writeError('ditto verify: not implemented in v0.1 skeleton');
    process.exit(NOT_IMPLEMENTED_EXIT);
  },
});
