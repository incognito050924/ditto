import { defineCommand, runMain } from 'citty';
import '~/core/hosts';
import { bridgeCommand } from './commands/bridge';
import { contextCommand } from './commands/context';
import { doctorCommand } from './commands/doctor';
import { runCommand } from './commands/run';
import { verifyCommand } from './commands/verify';
import { workCommand } from './commands/work';

const main = defineCommand({
  meta: {
    name: 'ditto',
    version: '0.0.0',
    description: 'Coding agent work orchestration layer',
  },
  subCommands: {
    work: workCommand,
    run: runCommand,
    verify: verifyCommand,
    doctor: doctorCommand,
    bridge: bridgeCommand,
    context: contextCommand,
  },
});

// Pre-slice rawArgs at the first `--` so citty's runMain (which does a flat
// rawArgs.includes('--help') ignoring the `--` separator) cannot capture
// provider-side tokens. process.argv is left intact so extractDashDashTail
// still resolves the tail for commands that opt into pass-through.
const dashDashIdx = process.argv.indexOf('--', 2);
const wrapperRawArgs =
  dashDashIdx === -1 ? process.argv.slice(2) : process.argv.slice(2, dashDashIdx);
runMain(main, { rawArgs: wrapperRawArgs });
