import { describe, expect, test } from 'bun:test';
import {
  type AuthoredRedClass,
  type CaptureResult,
  type TestRunOutcome,
  captureTestCommand,
  classifyAuthoredRed,
  phantomRedGate,
} from '~/core/test-runner';
import * as testRunnerModule from '~/core/test-runner';

/**
 * WHY THIS FILE EXISTS (wi_2607105qy N2 ac-3 Part A — phantom-red HARD gate):
 *
 * Before the approval gate presents the authored red tests, they must be RUN and
 * confirmed to fail on the AC ASSERTION itself, not on a compile/import error (a
 * phantom-red proves nothing). The barrier runner (runTestCommand) is intentionally
 * exit-code-only; this is a DISTINCT, deterministic capture+classify path that
 * discriminates assertion-red from compile/import-red, degrading to `indeterminate`
 * (→ never hard-block, ADR-0018) when the output is not deterministically classifiable.
 *
 * These are mock/unit-tier: the classifier is PURE over fixture strings; the gate runs
 * against an injected runner; captureTestCommand runs a trivial real shell command.
 */

describe('classifyAuthoredRed (pure discriminator) — assertion vs compile/import', () => {
  test('a bun assertion failure ⇒ assertion_red', () => {
    const captured = [
      '(fail) POST /pw > returns 200',
      '  error: expect(received).toBe(expected)',
      '  Expected: 200',
      '  Received: 404',
      ' 0 pass',
      ' 1 fail',
    ].join('\n');
    expect(classifyAuthoredRed({ kind: 'failed', exitCode: 1 }, captured)).toBe('assertion_red');
  });

  test('a module-resolution error ⇒ compile_import_red (phantom)', () => {
    const captured = [
      "error: Cannot find module './handler' from '/repo/tests/authored-ac1.test.ts'",
      ' 0 pass',
      ' 0 fail',
    ].join('\n');
    expect(classifyAuthoredRed({ kind: 'failed', exitCode: 1 }, captured)).toBe(
      'compile_import_red',
    );
  });

  test('a syntax/transform error ⇒ compile_import_red (phantom)', () => {
    const captured = 'error: Expected ")" but found "}"\nSyntaxError: Unexpected token';
    expect(classifyAuthoredRed({ kind: 'failed', exitCode: 1 }, captured)).toBe(
      'compile_import_red',
    );
  });

  test('an exit-0 (passed) run ⇒ ran_green (not actually red)', () => {
    expect(classifyAuthoredRed({ kind: 'passed' }, ' 1 pass\n 0 fail')).toBe('ran_green');
  });

  test('an unrunnable outcome ⇒ indeterminate (→ degrade, never block)', () => {
    expect(classifyAuthoredRed({ kind: 'unrunnable', reason: 'bun not found' }, '')).toBe(
      'indeterminate',
    );
  });

  test('a timeout outcome ⇒ indeterminate (→ degrade, never block)', () => {
    expect(classifyAuthoredRed({ kind: 'timeout', timeoutMs: 1000 }, '')).toBe('indeterminate');
  });

  test('a failed run whose output matches no known marker ⇒ indeterminate (degrade, never false-block)', () => {
    expect(classifyAuthoredRed({ kind: 'failed', exitCode: 1 }, 'weird unknowable output')).toBe(
      'indeterminate',
    );
  });
});

describe('captureTestCommand — a SEPARATE capture path (barrier stays exit-code-only)', () => {
  test('captures stdout of a real command and classifies its terminal', async () => {
    const res = await captureTestCommand('echo hello-capture; exit 1', process.cwd());
    expect(res.outcome.kind).toBe('failed');
    expect(res.captured).toContain('hello-capture');
  });

  test('an absent command degrades to unrunnable (never throws)', async () => {
    const res = await captureTestCommand('this-command-does-not-exist-xyz', process.cwd());
    expect(res.outcome.kind).toBe('unrunnable');
  });
});

describe('phantomRedGate — HARD block on phantom, degrade on indeterminate, present on assertion-red', () => {
  const mkRunner =
    (byPath: Record<string, CaptureResult>) =>
    async (test_path: string): Promise<CaptureResult> =>
      byPath[test_path] ?? { outcome: { kind: 'unrunnable', reason: 'no fixture' }, captured: '' };

  const assertionRed: CaptureResult = {
    outcome: { kind: 'failed', exitCode: 1 },
    captured: '(fail) t > x\n error: expect(received).toBe(expected)\n 0 pass\n 1 fail',
  };
  const compileRed: CaptureResult = {
    outcome: { kind: 'failed', exitCode: 1 },
    captured: "error: Cannot find module './x'\n 0 pass\n 0 fail",
  };
  const green: CaptureResult = { outcome: { kind: 'passed' }, captured: ' 1 pass\n 0 fail' };
  const uncapturable: CaptureResult = {
    outcome: { kind: 'unrunnable', reason: 'bun absent' },
    captured: '',
  };

  test('every authored test is assertion-red ⇒ present (gate may open)', async () => {
    const res = await phantomRedGate({
      tests: [{ criterion_id: 'ac-1', test_path: 'tests/a.test.ts' }],
      runOne: mkRunner({ 'tests/a.test.ts': assertionRed }),
    });
    expect(res.verdict).toBe('present');
    expect(res.perTest[0]?.classification).toBe('assertion_red');
  });

  test('a compile/import red ⇒ BLOCK (phantom-red must not reach approval presentation)', async () => {
    const res = await phantomRedGate({
      tests: [
        { criterion_id: 'ac-1', test_path: 'tests/a.test.ts' },
        { criterion_id: 'ac-2', test_path: 'tests/b.test.ts' },
      ],
      runOne: mkRunner({ 'tests/a.test.ts': assertionRed, 'tests/b.test.ts': compileRed }),
    });
    expect(res.verdict).toBe('block');
    expect(res.reasons.join(' ')).toContain('tests/b.test.ts');
  });

  test('a supposed-red test that actually passes ⇒ BLOCK (vacuous / not red)', async () => {
    const res = await phantomRedGate({
      tests: [{ criterion_id: 'ac-1', test_path: 'tests/a.test.ts' }],
      runOne: mkRunner({ 'tests/a.test.ts': green }),
    });
    expect(res.verdict).toBe('block');
  });

  test('an uncapturable run (no compile/import block) ⇒ DEGRADE (proceed unverified, ADR-0018)', async () => {
    const res = await phantomRedGate({
      tests: [{ criterion_id: 'ac-1', test_path: 'tests/a.test.ts' }],
      runOne: mkRunner({ 'tests/a.test.ts': uncapturable }),
    });
    expect(res.verdict).toBe('degrade');
  });

  test('a definite phantom (block) WINS over a sibling indeterminate (block is not softened to degrade)', async () => {
    const res = await phantomRedGate({
      tests: [
        { criterion_id: 'ac-1', test_path: 'tests/a.test.ts' },
        { criterion_id: 'ac-2', test_path: 'tests/b.test.ts' },
      ],
      runOne: mkRunner({ 'tests/a.test.ts': uncapturable, 'tests/b.test.ts': compileRed }),
    });
    expect(res.verdict).toBe('block');
  });

  test('no test_backed entries ⇒ degrade (nothing deterministically confirmed; never a false present)', async () => {
    const res = await phantomRedGate({ tests: [], runOne: mkRunner({}) });
    expect(res.verdict).toBe('degrade');
  });
});

/**
 * WHY THIS BLOCK EXISTS (wi_2607103tp ac-1 — phantom-red runner language-neutralization):
 *
 * The pre-approval phantom-red gate runs each authored red test through a PER-FILE runner
 * command. Today that command is HARDCODED to `bun test <path>` (autopilot-loop.ts:2460-2462),
 * so on any non-bun stack (pytest, `go test`, …) every authored red loads-as-nothing and the
 * gate degrades or false-blocks — the dogfood stack leaks into arbitrary user projects
 * (violates the meta-tool-must-fit-the-user-project floor).
 *
 * ac-1 CONTRACT: the per-file runner command must be DERIVED from recipe config —
 * `authored_test_command ?? barrier_test_command` — as the base, with the test path appended
 * using the SAME `${JSON.stringify(path)}` quoting the current inline code uses. A pure,
 * exported helper `buildAuthoredRedRunCommand(recipe, testPath)` must build that string so the
 * derivation is unit-testable (today it is inlined in the loop and untestable).
 *
 * These assertions pin: (1) with a non-bun `authored_test_command`, the derived command uses
 * it, NOT the hardcoded `bun test`; (2) with no `authored_test_command`, it falls back to
 * `barrier_test_command`. Each computes its `actual` by REPRODUCING the CURRENT production
 * behavior (the inline `bun test ${JSON.stringify(path)}`) when the helper is not yet exported,
 * so the RED is a genuine ASSERTION about the derived command ("expected pytest …, got bun test
 * …") — never a missing-symbol import/compile (phantom) red. s1i turns these green by exporting
 * `buildAuthoredRedRunCommand`.
 */
describe('buildAuthoredRedRunCommand — per-file runner derives from recipe, not hardcoded bun test', () => {
  // Access via the module namespace so the file still LOADS before s1i exports the helper
  // (a missing property is `undefined`, not an import error) — keeping the failure an assertion.
  const derive = (
    testRunnerModule as unknown as {
      buildAuthoredRedRunCommand?: (recipe: unknown, testPath: string) => string;
    }
  ).buildAuthoredRedRunCommand;

  // Mirrors the CURRENT hardcoded production behavior (autopilot-loop.ts:2462). Used only as the
  // stand-in when the derivation helper does not yet exist, so the assertion (not a throw) fails.
  const currentHardcoded = (path: string): string => `bun test ${JSON.stringify(path)}`;

  test('with a non-bun authored_test_command, the per-file command uses it (NOT hardcoded bun test)', () => {
    const recipe = { authored_test_command: 'pytest', barrier_test_command: 'bun test' };
    const path = 'tests/authored-ac1.test.py';
    const actual = derive ? derive(recipe, path) : currentHardcoded(path);
    expect(actual).toBe(`pytest ${JSON.stringify(path)}`);
  });

  test('with no authored_test_command, it falls back to barrier_test_command', () => {
    const recipe = { barrier_test_command: 'go test ./...' };
    const path = 'tests/core/foo_test.go';
    const actual = derive ? derive(recipe, path) : currentHardcoded(path);
    expect(actual).toBe(`go test ./... ${JSON.stringify(path)}`);
  });
});

/**
 * WHY THIS BLOCK EXISTS (wi_2607103tp ac-2 — phantom-red classification must be RUNNER-AWARE):
 *
 * `classifyAuthoredRed` matches its markers (LOAD_ERROR_MARKERS / ASSERTION_MARKERS) on OUTPUT
 * CONTENT ONLY — runner-blind. Those markers are BUN-SHAPED. On a NON-bun stack (go test, cargo,
 * pytest) the runner's own output can COINCIDENTALLY contain a bun-shaped phrase — e.g. a Go build
 * error "cannot find module …" or a Python "SyntaxError" — and the runner-blind classifier then
 * returns `compile_import_red`, which phantomRedGate folds to a HARD `block`. That is a FALSE
 * BLOCK: a legitimately-authored red on a non-bun host is rejected because its runner's chatter
 * happened to look bun-shaped. The meta-tool must fit the user's project or DEGRADE — never
 * false-block a foreign stack (ADR-0018).
 *
 * ac-2 CONTRACT: classification must be gated on a RUNNER-SHAPE signal. The bun-shaped markers
 * apply ONLY when the runner is bun-shaped. For ANY non-bun runner, `classifyAuthoredRed` must
 * return `indeterminate` (→ phantomRedGate `degrade`), NEVER `compile_import_red`/`assertion_red`
 * (which can block). This needs a `runnerIsBunShaped: boolean` threaded into classification.
 *
 * These assertions pin: a NON-bun runner (runnerIsBunShaped=false) whose captured output WOULD
 * match a bun LOAD_ERROR marker must classify as `indeterminate`, not `compile_import_red`. The
 * classifier is reached via the module namespace typed with the FUTURE 3-arg signature, so the
 * file still LOADS today (the current 2-arg impl runs and IGNORES the 3rd arg) — making the RED a
 * genuine ASSERTION ("expected indeterminate, got compile_import_red"), not an import/compile
 * (phantom) red. s2i turns these green by adding the `runnerIsBunShaped` param and gating the
 * bun-shaped markers on it.
 */
describe('classifyAuthoredRed — RUNNER-AWARE: a non-bun runner never false-blocks on bun-shaped chatter', () => {
  // Access via the module namespace typed with the future 3-arg signature. The current 2-arg
  // `classifyAuthoredRed` exists and RUNS (ignoring the extra arg), so the failure is an assertion
  // about the RETURNED class — not a missing-symbol import error.
  const classifyRunnerAware = (
    testRunnerModule as unknown as {
      classifyAuthoredRed: (
        outcome: TestRunOutcome,
        captured: string,
        runnerIsBunShaped: boolean,
      ) => AuthoredRedClass;
    }
  ).classifyAuthoredRed;

  test('a NON-bun runner whose output contains "Cannot find module" ⇒ indeterminate (degrade), NOT compile_import_red (block)', () => {
    // A `go test` build failure that coincidentally reads like bun's module-resolution marker.
    const goBuildFailure = [
      '# example.com/pkg',
      './handler_test.go:7:2: cannot find module providing package ./handler',
      'FAIL    example.com/pkg [build failed]',
    ].join('\n');
    expect(classifyRunnerAware({ kind: 'failed', exitCode: 1 }, goBuildFailure, false)).toBe(
      'indeterminate',
    );
  });

  test('a NON-bun runner whose output contains "SyntaxError" ⇒ indeterminate (degrade), NOT compile_import_red (block)', () => {
    // A pytest collection error whose text matches bun's SyntaxError marker.
    const pytestFailure = [
      'E   SyntaxError: invalid syntax',
      'tests/test_ac1.py:3',
      '1 error in 0.04s',
    ].join('\n');
    expect(classifyRunnerAware({ kind: 'failed', exitCode: 1 }, pytestFailure, false)).toBe(
      'indeterminate',
    );
  });
});

/**
 * WHY THIS BLOCK EXISTS (wi_2607103tp ac-3 / M3 — INVARIANT guard: a DEFINITE phantom
 * still BLOCKS, never softened to degrade by the runner-aware change):
 *
 * ac-2 (s2i) makes classification RUNNER-AWARE so a NON-bun runner degrades instead of
 * false-blocking on bun-shaped chatter. That change must NOT leak into the DEFINITE-phantom
 * cases: a BUN-shaped compile/import red is still a phantom (BLOCK), and a supposed-red that
 * actually RAN GREEN is vacuous (BLOCK) REGARDLESS of runner shape (`ran_green` keys on the
 * PASSED outcome, not on any bun marker). This guard locks that invariant so a future
 * runner-aware refactor can't accidentally weaken a definite phantom to a degrade.
 *
 * This holds against the CURRENT code (green now) — it is a REGRESSION guard, not the red
 * driver of this node (the red lives in the completion-floor tests for ac-3). The classifier
 * is reached via the module namespace typed with the FUTURE 3-arg signature so the block
 * still LOADS whether or not s2i has added the `runnerIsBunShaped` param.
 */
describe('classifyAuthoredRed / phantomRedGate (wi_2607103tp ac-3 / M3): a DEFINITE phantom still BLOCKS', () => {
  const classifyRunnerAware = (
    testRunnerModule as unknown as {
      classifyAuthoredRed: (
        outcome: TestRunOutcome,
        captured: string,
        runnerIsBunShaped?: boolean,
      ) => AuthoredRedClass;
    }
  ).classifyAuthoredRed;

  const bunCompileRed = "error: Cannot find module './handler'\n 0 pass\n 0 fail";

  test('a BUN-shaped compile/import red (runnerIsBunShaped=true) is STILL compile_import_red — not softened to indeterminate', () => {
    expect(classifyRunnerAware({ kind: 'failed', exitCode: 1 }, bunCompileRed, true)).toBe(
      'compile_import_red',
    );
  });

  test('a passed run is ran_green REGARDLESS of runner shape (runner-independent — never degraded away)', () => {
    expect(classifyRunnerAware({ kind: 'passed' }, ' 1 pass\n 0 fail', true)).toBe('ran_green');
    expect(classifyRunnerAware({ kind: 'passed' }, ' 1 pass\n 0 fail', false)).toBe('ran_green');
  });

  test('phantomRedGate over a definite compile/import red ⇒ block (never degrade)', async () => {
    const res = await phantomRedGate({
      tests: [{ criterion_id: 'ac-1', test_path: 'tests/a.test.ts' }],
      runOne: async () => ({ outcome: { kind: 'failed', exitCode: 1 }, captured: bunCompileRed }),
    });
    expect(res.verdict).toBe('block');
  });

  test('phantomRedGate over a supposed-red that RAN GREEN ⇒ block (vacuous, never degrade)', async () => {
    const res = await phantomRedGate({
      tests: [{ criterion_id: 'ac-1', test_path: 'tests/a.test.ts' }],
      runOne: async () => ({ outcome: { kind: 'passed' }, captured: ' 1 pass\n 0 fail' }),
    });
    expect(res.verdict).toBe('block');
  });
});
