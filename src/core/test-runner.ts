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
// ── Pre-approval authored-red DISCRIMINATION path (wi_2607105qy N2 ac-3 Part A) ──
// A DISTINCT capability from the barrier above: the barrier judges pass/fail from the
// EXIT CODE only (invariant preserved). This path CAPTURES output and deterministically
// discriminates an AC-assertion red from a compile/import (phantom) red — used ONLY to
// vet authored red tests BEFORE the approval gate opens. On any output it cannot
// deterministically classify it returns `indeterminate` → the caller DEGRADES to
// unverified (never hard-blocks on tool absence/ambiguity, ADR-0018).

/** A capture run: the barrier terminal PLUS the captured stdout+stderr text. */
export interface CaptureResult {
  outcome: TestRunOutcome;
  captured: string;
}

export type AuthoredRedClass =
  | 'assertion_red' // a test RAN and its assertion failed — a legitimate red.
  | 'compile_import_red' // the file never loaded (syntax/module error) — a phantom red.
  | 'ran_green' // the "red" test actually passed — not red at all (vacuous).
  | 'indeterminate'; // uncapturable / unclassifiable output → caller degrades.

// bun-test-shaped load-error markers (a file that never loaded ⇒ phantom red). Any other
// runner's output that matches none of these falls through to `indeterminate` (degrade),
// so a non-bun host never false-blocks.
const LOAD_ERROR_MARKERS: readonly RegExp[] = [
  /Cannot find module/i,
  /Cannot find package/i,
  /Could not resolve/i,
  /error: Failed to (load|resolve)/i,
  /SyntaxError/i,
  /Transform failed/i,
  /Parse error/i,
];
// A test that actually RAN and failed its assertion (bun's per-test fail marker / expect).
const ASSERTION_MARKERS: readonly RegExp[] = [/\(fail\)/, /error: expect\(/i, /Expected:/];

/**
 * PURE discriminator. Compile/import markers are checked FIRST (a file that failed to
 * load never truly ran, even if later text looks assertion-like), then assertion markers.
 * Anything else → `indeterminate` (degrade, never a false block).
 */
export function classifyAuthoredRed(outcome: TestRunOutcome, captured: string): AuthoredRedClass {
  if (outcome.kind === 'passed') return 'ran_green';
  if (outcome.kind !== 'failed') return 'indeterminate'; // unrunnable | timeout
  if (LOAD_ERROR_MARKERS.some((re) => re.test(captured))) return 'compile_import_red';
  if (ASSERTION_MARKERS.some((re) => re.test(captured))) return 'assertion_red';
  return 'indeterminate';
}

export interface PhantomRedResult {
  /** `present` = every authored test is a genuine assertion-red (gate may open);
   *  `block` = ≥1 phantom (compile/import red) OR a supposed-red that is green;
   *  `degrade` = no definite phantom, but ≥1 could not be deterministically confirmed. */
  verdict: 'present' | 'block' | 'degrade';
  perTest: { criterion_id: string; test_path: string; classification: AuthoredRedClass }[];
  reasons: string[];
}

/**
 * Vet the authored red tests before the approval gate presents them. Runs each authored
 * test through the injected capture `runOne`, classifies it, then folds:
 *  - any `compile_import_red` / `ran_green` ⇒ BLOCK (a definite phantom wins over any
 *    sibling indeterminate — a block is never softened to a degrade).
 *  - else any `indeterminate` (or no tests at all) ⇒ DEGRADE (proceed unverified, ADR-0018).
 *  - else (all assertion_red) ⇒ PRESENT.
 * `runOne` is injected so the fold is unit-testable with a mock and the production wiring
 * supplies a real capture runner.
 */
export async function phantomRedGate(args: {
  tests: readonly { criterion_id: string; test_path: string }[];
  runOne: (test_path: string) => Promise<CaptureResult>;
}): Promise<PhantomRedResult> {
  const perTest = await Promise.all(
    args.tests.map(async ({ criterion_id, test_path }) => {
      const { outcome, captured } = await args.runOne(test_path);
      return { criterion_id, test_path, classification: classifyAuthoredRed(outcome, captured) };
    }),
  );
  const phantoms = perTest.filter(
    (t) => t.classification === 'compile_import_red' || t.classification === 'ran_green',
  );
  if (phantoms.length > 0) {
    return {
      verdict: 'block',
      perTest,
      reasons: phantoms.map(
        (t) =>
          `${t.test_path} (${t.criterion_id}) is a phantom red: ${t.classification} — it did not fail on the AC assertion; re-author before the gate opens`,
      ),
    };
  }
  const indeterminate = perTest.filter((t) => t.classification === 'indeterminate');
  if (indeterminate.length > 0 || perTest.length === 0) {
    return {
      verdict: 'degrade',
      perTest,
      reasons:
        perTest.length === 0
          ? ['no authored test to confirm — proceeding unverified (ADR-0018)']
          : indeterminate.map(
              (t) =>
                `${t.test_path} (${t.criterion_id}) could not be deterministically confirmed as assertion-red — proceeding unverified (ADR-0018)`,
            ),
    };
  }
  return { verdict: 'present', perTest, reasons: [] };
}

/**
 * Capture variant of {@link runTestCommand}: same shell-spawn + timeout classification,
 * but PIPES stdout/stderr and returns the captured text alongside the terminal. Kept
 * separate so the barrier runner stays exit-code-pure (no output-reading in the barrier's
 * pass/fail judgment). Never throws — a spawn failure is `unrunnable`.
 */
export const captureTestCommand = async (
  command: string,
  cwd: string,
  opts: { timeoutMs?: number } = {},
): Promise<CaptureResult> => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BARRIER_TIMEOUT_MS;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(['sh', '-c', command], {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (err) {
    return {
      outcome: { kind: 'unrunnable', reason: err instanceof Error ? err.message : String(err) },
      captured: '',
    };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
  }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const captured = `${stdout}${stderr}`;
    if (timedOut) return { outcome: { kind: 'timeout', timeoutMs }, captured };
    if (code === 0) return { outcome: { kind: 'passed' }, captured };
    if (code === 126 || code === 127) {
      return {
        outcome: {
          kind: 'unrunnable',
          reason: `test command not found or not executable (exit ${code})`,
        },
        captured,
      };
    }
    return { outcome: { kind: 'failed', exitCode: code }, captured };
  } finally {
    clearTimeout(timer);
  }
};

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
