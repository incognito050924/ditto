import { defineCommand } from 'citty';
import { executeHook } from '~/hooks/io';
import { postToolUseHandler as legacyPostToolUseHandler } from '~/hooks/post-tool-use';
import { preCompactHandler as legacyPreCompactHandler } from '~/hooks/pre-compact';
import { preToolUseHandler as legacyPreToolUseHandler } from '~/hooks/pre-tool-use';
import { postToolUseHandler } from '~/hooks/rebuilt/post-tool-use';
import { preCompactHandler } from '~/hooks/rebuilt/pre-compact';
import { preToolUseHandler } from '~/hooks/rebuilt/pre-tool-use';
import { sessionStartHandler } from '~/hooks/rebuilt/session-start';
import { stopHandler } from '~/hooks/rebuilt/stop';
import { userPromptSubmitHandler } from '~/hooks/rebuilt/user-prompt-submit';
import type { HookHandler } from '~/hooks/runtime';
import { sessionStartHandler as legacySessionStartHandler } from '~/hooks/session-start';
import { stopHandler as legacyStopHandler } from '~/hooks/stop';
import { userPromptSubmitHandler as legacyUserPromptSubmitHandler } from '~/hooks/user-prompt-submit';

/**
 * `ditto hook <event>` — the self-contained hook entry (wi_2606068sy).
 *
 * Claude Code decides WHICH hook fires (by event) and the plugin's `hooks.json`
 * maps each event to `bun "${CLAUDE_PLUGIN_ROOT}/bin/ditto" hook <event>`; this
 * command just dispatches the named handler. `bin/ditto` is a `bun build
 * --target=bun` JS bundle (src + deps in one file), invoked via `bun <bundle>`,
 * so a target project needs NO `src/` and NO `node_modules` — only `bun` on PATH
 * plus the single bundle. The bundle is portable JS that `bun` runs on every OS
 * (including Windows), which is why hooks invoke it through `bun` rather than
 * executing the file directly. This replaces the old `bun run hooks/<event>.ts`
 * entries that depended on the source tree.
 *
 * Routing (rebuild increment 3): the REBUILT handlers under `src/hooks/rebuilt/`
 * are the default; setting `DITTO_HOOKS_LEGACY=1` flips every event back to the
 * dormant legacy handlers (the rollback path — legacy sources stay untouched).
 */
const REBUILT_HANDLERS: Record<string, HookHandler> = {
  'session-start': sessionStartHandler,
  'user-prompt-submit': userPromptSubmitHandler,
  'pre-tool-use': preToolUseHandler,
  'post-tool-use': postToolUseHandler,
  'pre-compact': preCompactHandler,
  stop: stopHandler,
};

const LEGACY_HANDLERS: Record<string, HookHandler> = {
  'session-start': legacySessionStartHandler,
  'user-prompt-submit': legacyUserPromptSubmitHandler,
  'pre-tool-use': legacyPreToolUseHandler,
  'post-tool-use': legacyPostToolUseHandler,
  'pre-compact': legacyPreCompactHandler,
  stop: legacyStopHandler,
};

/** The active handler set: rebuilt by default; DITTO_HOOKS_LEGACY=1 flips back. */
export function resolveHookHandlers(
  env: Record<string, string | undefined>,
): Record<string, HookHandler> {
  return env.DITTO_HOOKS_LEGACY === '1' ? LEGACY_HANDLERS : REBUILT_HANDLERS;
}

export const HOOK_EVENTS = Object.keys(REBUILT_HANDLERS);

/**
 * ditto is a Claude-Code-only host product (ADR-20260722-claude-code-only-host
 * supersedes the dual-host decision). A `codex` host must FAIL LOUD instead of
 * running gates that would vacuously pass (false-green is worse than refusal).
 */
export function parseHookHost(value: unknown): 'claude-code' {
  if (value === undefined || value === null || value === '') return 'claude-code';
  if (value === 'claude-code') return value;
  if (value === 'codex') {
    throw new Error(
      'the codex host is no longer supported: ditto is Claude-Code-only (ADR-20260722-claude-code-only-host supersedes the dual-host decision); run hooks without --host or with --host claude-code',
    );
  }
  throw new Error(`invalid --host ${String(value)} (expected claude-code)`);
}

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
      description: 'Host whose hook envelope feeds stdin/env: claude-code only.',
    },
  },
  run: async ({ args }) => {
    const handler = resolveHookHandlers(process.env)[args.event];
    if (!handler) {
      process.stderr.write(
        `ditto hook: unknown event "${args.event}"; expected one of: ${HOOK_EVENTS.join(', ')}\n`,
      );
      process.exit(2);
    }
    let host: 'claude-code';
    try {
      host = parseHookHost(args.host);
    } catch (err) {
      process.stderr.write(`ditto hook: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    }
    // executeHook reads stdin, runs the fail-open wrapper, writes stdout/stderr,
    // and process.exit()s with the hook's exit code — so it never returns.
    await executeHook(handler, host);
  },
});
