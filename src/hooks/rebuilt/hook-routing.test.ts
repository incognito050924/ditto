import { describe, expect, test } from 'bun:test';
import { parseHookHost, resolveHookHandlers } from '~/cli/commands/hook';
import { preToolUseHandler as legacyPreToolUseHandler } from '../pre-tool-use';
import { stopHandler as legacyStopHandler } from '../stop';
import { preToolUseHandler as rebuiltPreToolUseHandler } from './pre-tool-use';
import { stopHandler as rebuiltStopHandler } from './stop';

/**
 * Host-parsing gate for `ditto hook` (rebuild increment 3).
 *
 * WHY: ADR-20260722-claude-code-only-host supersedes the dual-host decision
 * (ADR-0016) — ditto targets the Claude Code hook contract ONLY. A `--host codex`
 * invocation must FAIL LOUD (non-zero, clear English error naming the supersede)
 * instead of running gates that were never validated for that envelope: a gate
 * that silently no-ops on codex would look green while enforcing nothing
 * (false-green), which is worse than an honest refusal.
 *
 * Edge cases pinned: absent/empty host still defaults to claude-code (the
 * hooks.json entries pass no --host), and an arbitrary junk host stays an error.
 */
describe('parseHookHost — Claude-Code-only host contract', () => {
  test('codex host fails loud, naming the superseding ADR', () => {
    expect(() => parseHookHost('codex')).toThrow(/ADR-20260722-claude-code-only-host/);
  });

  test('absent / empty host defaults to claude-code', () => {
    expect(parseHookHost(undefined)).toBe('claude-code');
    expect(parseHookHost(null)).toBe('claude-code');
    expect(parseHookHost('')).toBe('claude-code');
  });

  test('claude-code passes through', () => {
    expect(parseHookHost('claude-code')).toBe('claude-code');
  });

  test('an unknown host is still an error', () => {
    expect(() => parseHookHost('vim')).toThrow(/invalid --host/);
  });
});

/**
 * Dispatch routing (rebuild increment 3): the rebuilt handlers are the DEFAULT;
 * DITTO_HOOKS_LEGACY=1 flips every event back to the dormant legacy handlers
 * (the rollback path). Pinned on identity so a table typo cannot silently route
 * an event to the wrong generation.
 */
describe('resolveHookHandlers — rebuilt default, legacy flip', () => {
  test('default env dispatches the rebuilt handlers', () => {
    const handlers = resolveHookHandlers({});
    expect(handlers['pre-tool-use']).toBe(rebuiltPreToolUseHandler);
    expect(handlers.stop).toBe(rebuiltStopHandler);
  });

  test('DITTO_HOOKS_LEGACY=1 flips back to the legacy handlers', () => {
    const handlers = resolveHookHandlers({ DITTO_HOOKS_LEGACY: '1' });
    expect(handlers['pre-tool-use']).toBe(legacyPreToolUseHandler);
    expect(handlers.stop).toBe(legacyStopHandler);
  });

  test('both sets cover the same six events', () => {
    expect(Object.keys(resolveHookHandlers({})).sort()).toEqual(
      Object.keys(resolveHookHandlers({ DITTO_HOOKS_LEGACY: '1' })).sort(),
    );
    expect(Object.keys(resolveHookHandlers({})).length).toBe(6);
  });
});
