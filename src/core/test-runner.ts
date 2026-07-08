/**
 * Deterministic test-command runner (wi_260708ds9) — the exit-code discriminator the
 * settled-tree test barrier binds to. The barrier verdict is derived from the command's
 * EXIT CODE, never an LLM's read of the output: that is the whole reason this WI exists
 * (stop false-green — an LLM tester could rationalize a red result into a green claim).
 *
 * This is the reusable shape of `src/cli/commands/push-gate.ts` `defaultRunTest` PLUS a
 * WALL-CLOCK TIMEOUT that classifies a hang as a DISTINCT terminal (`timeout`). The
 * push-gate runner has no timeout — a pre-existing defect that is out of scope here;
 * migrating push-gate onto this helper is a follow-up (do NOT edit push-gate.ts).
 *
 * The four terminals (the barrier routes each differently — see autopilot-loop.ts):
 *  - `passed`     exit 0                       → GREEN (barrier proven green).
 *  - `failed`     ran, non-zero (≠126/127)     → RED (bounded retry, then block).
 *  - `unrunnable` 126/127 or a spawn throw     → DEGRADE (proceed, ADR-0018 — the
 *                 (command not found / not exec)  barrier INVERTS push-gate: absence
 *                                                 degrades-to-unverified, never blocks).
 *  - `timeout`    killed past the wall clock    → DEGRADE/surface (never an infinite stall).
 */
export type TestRunOutcome =
  | { kind: 'passed' }
  | { kind: 'failed'; exitCode: number }
  | { kind: 'unrunnable'; reason: string }
  | { kind: 'timeout'; timeoutMs: number };

/** Run `command` in `cwd` and classify the terminal. Injectable so the barrier is unit-testable. */
export type TestRunner = (
  command: string,
  cwd: string,
  opts?: { timeoutMs?: number },
) => Promise<TestRunOutcome>;

/**
 * Wall-clock ceiling for a barrier run. The recipe barrier command is a side-effect-free
 * UNIT SUBSET (recipe.ts caveat), so a fast suite finishes well under this; the ceiling
 * only exists so a HUNG command (deadlock, waiting on stdin) becomes a `timeout` terminal
 * instead of stalling the autopilot loop forever.
 */
export const DEFAULT_BARRIER_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Production runner: spawn through a shell (so a recipe command may use pipes / `&&`),
 * streaming output to the terminal. A POSIX `127`/`126` exit means the command itself
 * was not found / not executable — the runner is ABSENT, distinct from tests that ran
 * and failed. A command still alive past `timeoutMs` is force-killed and reported as a
 * `timeout` terminal (the `timedOut` latch classifies it regardless of the kill's exit
 * code). Never throws — a spawn failure is caught and returned as `unrunnable`.
 */
export const runTestCommand: TestRunner = async (command, cwd, opts = {}) => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BARRIER_TIMEOUT_MS;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(['sh', '-c', command], {
      cwd,
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
    });
  } catch (err) {
    return { kind: 'unrunnable', reason: err instanceof Error ? err.message : String(err) };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // SIGKILL (9): a hung command may ignore SIGTERM — force death so the loop advances.
    proc.kill(9);
  }, timeoutMs);
  try {
    const code = await proc.exited;
    // The timeout latch wins regardless of the kill's exit code (a signalled process may
    // report 137/null) — a killed-for-hanging run is a timeout, not a false `failed`.
    if (timedOut) return { kind: 'timeout', timeoutMs };
    if (code === 0) return { kind: 'passed' };
    if (code === 126 || code === 127) {
      return {
        kind: 'unrunnable',
        reason: `test command not found or not executable (exit ${code})`,
      };
    }
    return { kind: 'failed', exitCode: code };
  } finally {
    clearTimeout(timer);
  }
};
