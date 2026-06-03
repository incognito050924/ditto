import { defineCommand, runMain } from 'citty';
import '~/core/hosts';
import { acgReviewCommand } from './commands/acg-review';
import { architectureCommand } from './commands/architecture';
import { autopilotCommand } from './commands/autopilot';
import { boundaryCommand } from './commands/boundary';
import { bridgeCommand } from './commands/bridge';
import { codeqlCommand } from './commands/codeql';
import { contextCommand } from './commands/context';
import { deepInterviewCommand } from './commands/deep-interview';
import { doctorCommand } from './commands/doctor';
import { e2eCommand } from './commands/e2e';
import { fitnessCommand } from './commands/fitness';
import { impactCommand } from './commands/impact';
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
    autopilot: autopilotCommand,
    'deep-interview': deepInterviewCommand,
    e2e: e2eCommand,
    'acg-review': acgReviewCommand,
    codeql: codeqlCommand,
    impact: impactCommand,
    fitness: fitnessCommand,
    boundary: boundaryCommand,
    architecture: architectureCommand,
  },
});

// Pre-slice rawArgs at the first `--` so citty's runMain (which does a flat
// rawArgs.includes('--help') ignoring the `--` separator) cannot capture
// provider-side tokens. process.argv is left intact so extractDashDashTail
// still resolves the tail for commands that opt into pass-through.
const dashDashIdx = process.argv.indexOf('--', 2);
const wrapperRawArgs =
  dashDashIdx === -1 ? process.argv.slice(2) : process.argv.slice(2, dashDashIdx);
// Top-level await so the process stays alive until the whole command chain
// settles. A pending promise alone does not ref Bun's event loop, and a spawned
// subprocess's `.exited` does not keep it alive — without this await, commands
// that spawn (e.g. `e2e run` → Playwright probe/runner) exit 0 mid-flight.
await runMain(main, { rawArgs: wrapperRawArgs });
