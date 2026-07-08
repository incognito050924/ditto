import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { runTestCommand } from '~/core/test-runner';

// wi_260708ds9 (impl-barrier-runtime): the DETERMINISTIC exit-code discriminator +
// wall-clock timeout the settled-tree test barrier binds to. The barrier verdict is
// derived from the command's EXIT CODE, never an LLM's read of the output — so these
// assertions pin the exit-code → terminal mapping with REAL (fast) shell commands.
describe('runTestCommand — deterministic exit-code discriminator', () => {
  const cwd = tmpdir();

  test('exit 0 → passed', async () => {
    expect(await runTestCommand('exit 0', cwd)).toEqual({ kind: 'passed' });
  });

  test('a non-zero exit that RAN → failed with the exit code', async () => {
    expect(await runTestCommand('exit 3', cwd)).toEqual({ kind: 'failed', exitCode: 3 });
  });

  test('exit 127 (command not found) → unrunnable, NOT failed (the runner is absent)', async () => {
    const out = await runTestCommand('this_command_does_not_exist_zzz', cwd);
    expect(out.kind).toBe('unrunnable');
  });

  test('exit 126 (not executable) → unrunnable', async () => {
    // `sh -c 'exit 126'` reproduces the 126 terminal deterministically.
    const out = await runTestCommand('exit 126', cwd);
    expect(out.kind).toBe('unrunnable');
  });

  test('a hang past the wall-clock timeout → timeout (a distinct terminal, never an infinite stall)', async () => {
    const out = await runTestCommand('sleep 5', cwd, { timeoutMs: 50 });
    expect(out.kind).toBe('timeout');
  });
});
