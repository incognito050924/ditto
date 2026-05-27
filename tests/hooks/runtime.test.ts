import { describe, expect, test } from 'bun:test';
import { type HookInput, KILL_SWITCH, noOpHandler, runHook } from '~/hooks/runtime';

const baseInput = (env: Record<string, string | undefined> = {}): HookInput => ({
  raw: {},
  repoRoot: '/tmp/repo',
  env,
});

describe('runHook fail-open wrapper (D4)', () => {
  test('passes through a normal handler result', async () => {
    const out = await runHook(() => ({ exitCode: 2, stderr: 'still working\n' }), baseInput());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe('still working\n');
  });

  test('a crashing hook fails OPEN (exit 0), session not broken', async () => {
    const out = await runHook(() => {
      throw new Error('boom');
    }, baseInput());
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('fail-open');
    expect(out.stderr).toContain('boom');
  });

  test('kill-switch short-circuits to exit 0 without running the handler', async () => {
    let ran = false;
    const out = await runHook(
      () => {
        ran = true;
        return { exitCode: 2 };
      },
      baseInput({ [KILL_SWITCH]: '1' }),
    );
    expect(out.exitCode).toBe(0);
    expect(ran).toBe(false);
  });

  test('no-op handler returns exit 0', async () => {
    expect((await runHook(noOpHandler, baseInput())).exitCode).toBe(0);
  });

  test('an exit-2 verdict from the handler is NOT swallowed (fail-closed verdicts survive)', async () => {
    const out = await runHook(
      () => ({ exitCode: 2, stderr: 'gate: 2 criteria unverified\n' }),
      baseInput(),
    );
    expect(out.exitCode).toBe(2);
  });
});
