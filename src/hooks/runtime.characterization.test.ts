import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preToolUseHandler as legacyPreToolUseHandler } from './pre-tool-use';
import { preToolUseHandler as rebuiltPreToolUseHandler } from './rebuilt/pre-tool-use';
import { type HookInput, KILL_SWITCH, noOpHandler, runHook } from './runtime';

/**
 * Handler under test for the real-gate cases: the REBUILT handler by default,
 * the legacy handler under DITTO_HOOKS_LEGACY=1 (the dispatch env flip). The
 * runHook wrapper itself is SHARED by both generations and unchanged.
 */
const preToolUseHandler =
  process.env.DITTO_HOOKS_LEGACY === '1' ? legacyPreToolUseHandler : rebuiltPreToolUseHandler;

/**
 * Hook runtime CHARACTERIZATION tests — pin the fail-open wrapper's decision
 * surface before any hook rewiring (the prior hook test suite was deleted in
 * commit 6f298c8). Green against the CURRENT legacy runtime.
 *
 * The D4 two-layer contract pinned here:
 *  - a handler CRASH fails OPEN (exit 0) — a broken hook never breaks the
 *    user's session;
 *  - the KILL SWITCH (DITTO_SKIP_HOOKS) short-circuits to exit 0 without
 *    invoking the handler;
 *  - a gate VERDICT (the handler returning exit 2 itself) passes through
 *    unchanged — a judgment is not a crash.
 */

const roots: string[] = [];

function input(overrides: Partial<HookInput> = {}): HookInput {
  const root = mkdtempSync(join(tmpdir(), 'ditto-runtime-parity-'));
  roots.push(root);
  return { raw: {}, repoRoot: root, env: {}, ...overrides };
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('runHook characterization — kill switch', () => {
  test(`${KILL_SWITCH} set → exit 0 without invoking the handler`, async () => {
    let invoked = false;
    const out = await runHook(
      () => {
        invoked = true;
        return { exitCode: 2, stderr: 'should never surface\n' };
      },
      input({ env: { [KILL_SWITCH]: '1' } }),
    );
    expect(out.exitCode).toBe(0);
    expect(invoked).toBe(false);
  });
});

describe('runHook characterization — crash fails OPEN', () => {
  test('a throwing handler → exit 0 with a fail-open notice', async () => {
    const out = await runHook(() => {
      throw new Error('boom');
    }, input());
    expect(out.exitCode).toBe(0);
    expect(out.stderr ?? '').toContain('fail-open');
    expect(out.stderr ?? '').toContain('boom');
  });

  test('a rejecting async handler → exit 0 with a fail-open notice', async () => {
    const out = await runHook(() => Promise.reject(new Error('async boom')), input());
    expect(out.exitCode).toBe(0);
    expect(out.stderr ?? '').toContain('fail-open');
  });
});

describe('runHook characterization — gate verdicts pass through', () => {
  test('a handler exit-2 verdict is NOT swallowed by the wrapper', async () => {
    const out = await runHook(() => ({ exitCode: 2, stderr: 'gate verdict: blocked\n' }), input());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe('gate verdict: blocked\n');
  });

  test('a real gate verdict (destructive Bash through PreToolUse) → exit 2', async () => {
    const out = await runHook(
      preToolUseHandler,
      input({ raw: { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } } }),
    );
    expect(out.exitCode).toBe(2);
  });

  test('the same command with the kill switch set → exit 0 (skip)', async () => {
    const out = await runHook(
      preToolUseHandler,
      input({
        raw: { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } },
        env: { [KILL_SWITCH]: '1' },
      }),
    );
    expect(out.exitCode).toBe(0);
  });

  test('the no-op handler yields exit 0', async () => {
    const out = await runHook(noOpHandler, input());
    expect(out.exitCode).toBe(0);
  });
});
