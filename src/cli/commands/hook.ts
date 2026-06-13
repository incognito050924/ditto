import { defineCommand } from 'citty';
import { executeHook } from '~/hooks/io';
import { postToolUseHandler } from '~/hooks/post-tool-use';
import { preCompactHandler } from '~/hooks/pre-compact';
import { preToolUseHandler } from '~/hooks/pre-tool-use';
import type { HookHandler } from '~/hooks/runtime';
import { stopHandler } from '~/hooks/stop';
import { userPromptSubmitHandler } from '~/hooks/user-prompt-submit';

/**
 * `ditto hook <event>` — the self-contained hook entry (wi_2606068sy).
 *
 * Claude Code decides WHICH hook fires (by event) and the plugin's `hooks.json`
 * maps each event to `ditto hook <event>`; this command just dispatches the named
 * handler. The binary is `bun --compile`d (src + deps bundled), so a target
 * project needs NO bun runtime, NO `src/`, NO `node_modules` — only the single
 * executable. This replaces the old `bun run hooks/<event>.ts` entries that
 * depended on all three (and broke on Windows).
 */
const HANDLERS: Record<string, HookHandler> = {
  'user-prompt-submit': userPromptSubmitHandler,
  'pre-tool-use': preToolUseHandler,
  'post-tool-use': postToolUseHandler,
  'pre-compact': preCompactHandler,
  stop: stopHandler,
};

export const HOOK_EVENTS = Object.keys(HANDLERS);

export const hookCommand = defineCommand({
  meta: {
    name: 'hook',
    description:
      'Run a DITTO hook handler by event name (called from hooks.json; reads the event JSON on stdin).',
  },
  args: {
    event: {
      type: 'positional',
      required: true,
      description: `Hook event: ${HOOK_EVENTS.join(' | ')}`,
    },
    host: {
      type: 'string',
      default: 'claude-code',
      description: 'Host whose hook envelope feeds stdin/env: claude-code | codex.',
    },
  },
  run: async ({ args }) => {
    const handler = HANDLERS[args.event];
    if (!handler) {
      process.stderr.write(
        `ditto hook: unknown event "${args.event}"; expected one of: ${HOOK_EVENTS.join(', ')}\n`,
      );
      process.exit(2);
    }
    const host = args.host === 'codex' ? 'codex' : 'claude-code';
    // executeHook reads stdin, runs the fail-open wrapper, writes stdout/stderr,
    // and process.exit()s with the hook's exit code — so it never returns.
    await executeHook(handler, host);
  },
});
