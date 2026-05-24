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

runMain(main);
