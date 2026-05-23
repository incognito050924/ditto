import { defineCommand, runMain } from 'citty';
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
  },
});

runMain(main);
