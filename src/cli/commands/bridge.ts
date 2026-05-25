import { defineCommand } from 'citty';
import { syncClaudeCodeProjection } from '~/core/bridge-sync';
import { resolveRepoRootForCreate } from '~/core/fs';
import {
  InvalidOutputFormatError,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

const DRIFT_EXIT = 1;
const BRIDGE_RUNTIME_ERROR_EXIT = 70;

const bridgeSync = defineCommand({
  meta: {
    name: 'sync',
    description: 'Sync AGENTS.md into host instruction projection managed blocks',
  },
  args: {
    host: { type: 'string', default: 'claude-code', description: 'Sync target: claude-code' },
    check: { type: 'boolean', default: false, description: 'Dry-run without writing files' },
    output: { type: 'string', default: 'human', description: 'Output format: human|json' },
  },
  run: async ({ args }) => {
    try {
      const format = parseOutputFormat(args.output);
      if (args.host !== 'claude-code') {
        writeError('bridge sync supports only --host claude-code; codex reads AGENTS.md directly');
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const repoRoot = await resolveRepoRootForCreate();
      const result = await syncClaudeCodeProjection(repoRoot, { check: args.check });
      if (result.message) writeError(result.message);
      if (format === 'json') {
        writeJson(result);
      } else {
        writeHuman(`bridge sync: ${result.action}`);
        writeHuman(`  path: ${result.path}`);
        writeHuman(`  sha256: ${result.newSha256}`);
      }
      if (result.action === 'refused-multiple-markers') {
        process.exit(DRIFT_EXIT);
      }
      if (args.check && (result.action === 'would-create' || result.action === 'would-update')) {
        process.exit(DRIFT_EXIT);
      }
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(
        err instanceof InvalidOutputFormatError ? USAGE_ERROR_EXIT : BRIDGE_RUNTIME_ERROR_EXIT,
      );
    }
  },
});

export const bridgeCommand = defineCommand({
  meta: {
    name: 'bridge',
    description: 'Manage instruction bridges between hosts',
  },
  subCommands: {
    sync: bridgeSync,
  },
});
