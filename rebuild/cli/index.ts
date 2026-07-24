import { defineCommand, runMain } from 'citty';

import { githubCommand } from './commands/github';
import { hookCommand } from './commands/hook';
import { knowledgeCommand } from './commands/knowledge';
import { memoryCommand } from './commands/memory';

/**
 * Rebuild host CLI spine. Fronts the rebuilt engines (imported by RELATIVE path
 * — the `~/` alias resolves to the OLD `src/`, never rebuild/). This is the #68
 * host surface; it is built to a distinct artifact and does NOT overwrite the
 * live `bin/ditto` (that flip is #69, user-gated). Commands are wired one
 * engine-backed capability at a time.
 */
const main = defineCommand({
  meta: {
    name: 'ditto',
    version: '0.0.0-rebuild',
    description: 'Coding agent work orchestration layer (rebuild)',
  },
  subCommands: {
    knowledge: knowledgeCommand,
    memory: memoryCommand,
    github: githubCommand,
    hook: hookCommand,
  },
});

// Pre-slice rawArgs at the first `--` so citty's runMain (which does a flat
// rawArgs.includes('--help') ignoring the `--` separator) cannot capture
// provider-side tokens. process.argv is left intact so a command that opts into
// pass-through can still resolve the tail.
const dashDashIdx = process.argv.indexOf('--', 2);
const wrapperRawArgs =
  dashDashIdx === -1 ? process.argv.slice(2) : process.argv.slice(2, dashDashIdx);
// Top-level await keeps the process alive until the whole command chain settles
// (a pending promise alone does not ref Bun's event loop).
await runMain(main, { rawArgs: wrapperRawArgs });
