import { describe, expect, test } from 'bun:test';

import { declaredRisk } from '../schemas/work-item-record';
import {
  openRiskStatements,
  passCloseResidualGate,
  unverifiedCriterionIds,
} from './residual';

describe('declaredRisk.disposition — risk가 완료 게이트 입력으로 살아남는 경로', () => {
  test('disposition is additive-optional: open/accepted/mitigated', () => {
    expect(declaredRisk.safeParse({ statement: 's' }).success).toBe(true);
    for (const disposition of ['open', 'accepted', 'mitigated']) {
      expect(
        declaredRisk.safeParse({ statement: 's', disposition }).success,
      ).toBe(true);
    }
    expect(
      declaredRisk.safeParse({ statement: 's', disposition: 'ignored' })
        .success,
    ).toBe(false);
  });
});

describe('residual surface derivation', () => {
  test('unverifiedCriterionIds excludes pass and superseded criteria', () => {
    const ids = unverifiedCriterionIds([
      { id: 'a', statement: 's', verdict: 'pass', evidence: [] },
      { id: 'b', statement: 's', verdict: 'unverified', evidence: [] },
      { id: 'c', statement: 's', verdict: 'fail', evidence: [] },
      {
        id: 'd',
        statement: 's',
        verdict: 'unverified',
        evidence: [],
        superseded: true,
      },
    ]);
    expect(ids).toEqual(['b', 'c']);
  });

  test('openRiskStatements keeps only undisposed risks (absent disposition = open)', () => {
    const open = openRiskStatements([
      { statement: '위험 A' },
      { statement: '위험 B', disposition: 'open' },
      { statement: '위험 C', disposition: 'accepted' },
      { statement: '위험 D', disposition: 'mitigated' },
    ]);
    expect(open).toEqual(['위험 A', '위험 B']);
  });
});

describe('passCloseResidualGate — in-scope 잔여가 pass-close를 차단한다', () => {
  test('clean surfaces pass', () => {
    expect(
      passCloseResidualGate({ unverified: [], open_risks: [] }).decision,
    ).toBe('pass');
  });

  test('unverified criteria block pass-close, and the blockers are named', () => {
    const result = passCloseResidualGate({
      unverified: ['ac2'],
      open_risks: [],
    });
    expect(result.decision).toBe('block');
    expect(result.blockers.unverified).toEqual(['ac2']);
  });

  test('open declared risks block pass-close', () => {
    const result = passCloseResidualGate({
      unverified: [],
      open_risks: ['롤백 경로 미검증'],
    });
    expect(result.decision).toBe('block');
    expect(result.blockers.open_risks).toEqual(['롤백 경로 미검증']);
  });

  test('presence-keyed grandfather: an absent surface never blocks (legacy records close as-is)', () => {
    expect(passCloseResidualGate({}).decision).toBe('pass');
    expect(
      passCloseResidualGate({ unverified: undefined, open_risks: [] })
        .decision,
    ).toBe('pass');
  });
});
