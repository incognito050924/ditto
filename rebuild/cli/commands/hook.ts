import { defineCommand } from 'citty';

import { type HookStdin, runStopHook } from '../../hook/stop-hook';
import { RUNTIME_ERROR_EXIT, USAGE_ERROR_EXIT, writeError } from '../util';

/**
 * `ditto hook <event>` — host entry point Claude Code calls at each lifecycle
 * event. The rebuild only backs `stop` so far (via runStopHook); the other five
 * known events have NO rebuilt handler yet, so they fail LOUDLY rather than
 * masquerade as no-ops. Any unrecognized event string is a usage error.
 *
 * The engine stays deterministic: the CLI injects the clock (`nowIso`) and the
 * environment; the hook payload arrives on stdin as the Claude Code hook JSON.
 */

// The five lifecycle events the OLD surface dispatched alongside `stop`. Known
// but not yet rebuilt — distinguished from a typo so the error can be precise.
const KNOWN_NOT_REBUILT = new Set([
  'session-start',
  'user-prompt-submit',
  'pre-tool-use',
  'post-tool-use',
  'pre-compact',
]);

function parseHookStdin(raw: string): HookStdin {
  try {
    return raw.trim() ? (JSON.parse(raw) as HookStdin) : {};
  } catch {
    return {};
  }
}

export const hookCommand = defineCommand({
  meta: {
    name: 'hook',
    description: "Claude Code lifecycle hook entry point (only 'stop' is rebuilt)",
  },
  args: {
    event: {
      type: 'positional',
      description: 'Lifecycle event: stop (others not yet rebuilt)',
      required: true,
    },
  },
  run: async ({ args }) => {
    const event = String(args.event);

    if (event === 'stop') {
      const raw = await Bun.stdin.text().catch(() => '');
      const stdin = parseHookStdin(raw);
      const result = await runStopHook(stdin, process.env, new Date().toISOString());
      if (result.stderr) writeError(result.stderr);
      process.exit(result.exitCode);
    }

    if (KNOWN_NOT_REBUILT.has(event)) {
      writeError(`event ${event} not yet rebuilt (only 'stop' is implemented)`);
      process.exit(RUNTIME_ERROR_EXIT);
    }

    writeError(`unknown hook event "${event}"; expected one of: session-start, user-prompt-submit, pre-tool-use, post-tool-use, pre-compact, stop`);
    process.exit(USAGE_ERROR_EXIT);
  },
});
