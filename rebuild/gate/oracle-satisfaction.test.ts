import { describe, expect, test } from 'bun:test';

import type { AcOracle } from '../schemas/oracle';
import { oracleSatisfaction } from './oracle-satisfaction';

function oracle(overrides: Partial<AcOracle> = {}): AcOracle {
  return {
    criterion_id: 'ac1',
    statement: '테스트가 green이다',
    verification_method: 'dynamic_test',
    direction: 'forward',
    maps_to: { kind: 'ac', ref: 'ac1' },
    ...overrides,
  };
}

describe('oracleSatisfaction — presence-gated, fail-closed', () => {
  test('no evidence at all blocks (never silently passes)', () => {
    const result = oracleSatisfaction(oracle(), []);
    expect(result.decision).toBe('block');
  });

  test('dynamic_test is satisfied by a referenced test/command run', () => {
    const pass = oracleSatisfaction(oracle(), [
      { kind: 'test', path: 'rebuild/x.test.ts', summary: '297 pass 0 fail exit 0' },
    ]);
    expect(pass.decision).toBe('pass');
    expect(pass.grounds).toContain('297 pass');

    const alsoPass = oracleSatisfaction(oracle(), [
      { kind: 'command', path: 'cmd.log', summary: 'bun test exit 0' },
    ]);
    expect(alsoPass.decision).toBe('pass');
  });

  test('dynamic_test is NOT satisfied by file/behavior evidence (class mismatch)', () => {
    const result = oracleSatisfaction(oracle(), [
      { kind: 'file', path: 'out/report.json', summary: '산출물 존재' },
      { kind: 'behavior', path: 'shot.png', summary: '화면 확인' },
    ]);
    expect(result.decision).toBe('block');
  });

  test('static_scan requires a re-scan artifact reference', () => {
    const scan = oracle({ verification_method: 'static_scan' });
    expect(
      oracleSatisfaction(scan, [
        { kind: 'file', path: 'scan/rescan-output.txt', summary: '재스캔 0 위반' },
      ]).decision,
    ).toBe('pass');
    // 재스캔 앵커 없는 test 증거로는 안 닫힌다 (분석기 부재 → unverified 정신)
    expect(
      oracleSatisfaction(scan, [
        { kind: 'test', path: 'x.test.ts', summary: 'green' },
      ]).decision,
    ).toBe('block');
  });

  test('soft_judgment requires an observed-behavior/review reference', () => {
    const soft = oracle({ verification_method: 'soft_judgment' });
    expect(
      oracleSatisfaction(soft, [
        { kind: 'behavior', path: 'reviews/r1.md', summary: '리뷰어 승인' },
      ]).decision,
    ).toBe('pass');
    expect(
      oracleSatisfaction(soft, [
        { kind: 'command', path: 'c.log', summary: 'exit 0' },
      ]).decision,
    ).toBe('block');
  });

  test('blocked results never carry grounds (no over-claim through the primitive)', () => {
    const result = oracleSatisfaction(oracle(), []);
    expect(result).toEqual({ decision: 'block' });
  });
});
