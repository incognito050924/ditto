import { describe, expect, test } from 'bun:test';
import {
  type CaptureResult,
  captureTestCommand,
  classifyAuthoredRed,
  phantomRedGate,
} from '~/core/test-runner';

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
