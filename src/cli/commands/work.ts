import { defineCommand } from 'citty';
import {
  NOT_IMPLEMENTED_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

const workStart = defineCommand({
  meta: {
    name: 'start',
    description: 'Create a new work item from a request and initial goal',
  },
  args: {
    goal: {
      type: 'positional',
      description: 'Observable outcome stated in project terms',
      required: true,
    },
    request: {
      type: 'string',
      description: 'Verbatim user request that produced this work item',
      required: true,
    },
    title: {
      type: 'string',
      description: 'Short title; defaults to goal truncated',
      required: false,
    },
    profile: {
      type: 'string',
      description: 'Owner profile: read-only|workspace-write|networked|reviewer|isolated',
      default: 'workspace-write',
    },
    output: {
      type: 'string',
      description: 'Output format: human|json',
      default: 'human',
    },
  },
  run: ({ args }) => {
    const format = parseOutputFormat(args.output);
    const payload = {
      action: 'work.start',
      status: 'not_implemented',
      input: {
        goal: args.goal,
        request: args.request,
        title: args.title ?? null,
        profile: args.profile,
      },
    };
    if (format === 'json') {
      writeJson(payload);
    } else {
      writeHuman('work.start is not implemented yet (v0.1 skeleton).');
      writeHuman(`goal: ${args.goal}`);
      writeHuman(`profile: ${args.profile}`);
    }
    writeError('ditto work start: not implemented in v0.1 skeleton');
    process.exit(NOT_IMPLEMENTED_EXIT);
  },
});

const workStatus = defineCommand({
  meta: {
    name: 'status',
    description: 'Show current state of one or all work items',
  },
  args: {
    workId: {
      type: 'positional',
      description: 'Work item id; if omitted, lists all work items',
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
        action: 'work.status',
        status: 'not_implemented',
        input: { workId: args.workId ?? null },
      });
    } else {
      writeHuman('work.status is not implemented yet (v0.1 skeleton).');
    }
    writeError('ditto work status: not implemented in v0.1 skeleton');
    process.exit(NOT_IMPLEMENTED_EXIT);
  },
});

const workHandoff = defineCommand({
  meta: {
    name: 'handoff',
    description: 'Generate or refresh the handoff document for a work item',
  },
  args: {
    workId: {
      type: 'positional',
      description: 'Work item id to hand off',
      required: true,
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
        action: 'work.handoff',
        status: 'not_implemented',
        input: { workId: args.workId },
      });
    } else {
      writeHuman(`work.handoff for ${args.workId} is not implemented yet (v0.1 skeleton).`);
    }
    writeError('ditto work handoff: not implemented in v0.1 skeleton');
    process.exit(NOT_IMPLEMENTED_EXIT);
  },
});

export const workCommand = defineCommand({
  meta: {
    name: 'work',
    description: 'Manage work items (start, status, handoff)',
  },
  subCommands: {
    start: workStart,
    status: workStatus,
    handoff: workHandoff,
  },
});
