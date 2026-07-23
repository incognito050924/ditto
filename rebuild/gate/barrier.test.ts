import { describe, expect, test } from 'bun:test';

import { barrierCompletionDisposition, classifyBarrierRun } from './barrier';

describe('classifyBarrierRun — 3-value verdict, unrunnable is not red', () => {
  test('exit 0 with a declared command is passed', () => {
    expect(
      classifyBarrierRun({ command: 'bun test rebuild/', exitCode: 0 }),
    ).toBe('passed');
  });

  test('non-zero exit is failed', () => {
    expect(
      classifyBarrierRun({ command: 'bun test rebuild/', exitCode: 1 }),
    ).toBe('failed');
  });

  test('absent command, spawn failure, and exit 126/127 are unrunnable — never failed', () => {
    expect(classifyBarrierRun({})).toBe('unrunnable');
    expect(
      classifyBarrierRun({ command: 'bun test', spawnFailed: true }),
    ).toBe('unrunnable');
    expect(classifyBarrierRun({ command: 'bun test', exitCode: 126 })).toBe(
      'unrunnable',
    );
    expect(classifyBarrierRun({ command: 'bun test', exitCode: 127 })).toBe(
      'unrunnable',
    );
  });
});

describe('barrierCompletionDisposition — 완료측 처분 (push측 fail-closed와 의도된 비대칭)', () => {
  test('passed proceeds with no verdict cap', () => {
    expect(barrierCompletionDisposition('passed')).toEqual({
      proceed: true,
      verdictCap: 'pass',
    });
  });

  test('unrunnable degrades honestly to unverified and PROCEEDS (no fabricated green, no stall)', () => {
    expect(barrierCompletionDisposition('unrunnable')).toEqual({
      proceed: true,
      verdictCap: 'unverified',
    });
  });

  test('failed blocks completion', () => {
    expect(barrierCompletionDisposition('failed')).toEqual({
      proceed: false,
      verdictCap: 'fail',
    });
  });
});
