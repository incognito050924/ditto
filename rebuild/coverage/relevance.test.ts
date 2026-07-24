import { describe, expect, test } from 'bun:test';

import { assembleRelevanceVerdicts } from './relevance';
import type { RawRelevanceJudgment, RelevanceRefute } from './schemas';

/**
 * ADR-20260625 — binary relevance gate. Each category is a binary
 * relevant/not-relevant decision, and the deterministic assembler enforces the
 * 4-safeguard skip rule so a category is never skipped at agent discretion.
 */
describe('assembleRelevanceVerdicts — 이진 관련성 게이트 (ADR-20260625)', () => {
  test('a well-formed not-relevant judgment that survives refute is the ONLY way to skip', () => {
    const judgments: RawRelevanceJudgment[] = [
      {
        id: 'regulatory',
        relevant: false,
        reason: '이 변경은 개인정보·규제 데이터 경로를 건드리지 않는다',
        residual_risk: '규제 의무가 뒤늦게 걸리면 미검토로 남는다',
      },
    ];
    const refutes: RelevanceRefute[] = [{ id: 'regulatory', refuted: false }];
    const verdicts = assembleRelevanceVerdicts(judgments, refutes);
    expect(verdicts).toEqual([
      {
        id: 'regulatory',
        relevant: false,
        reason: '이 변경은 개인정보·규제 데이터 경로를 건드리지 않는다',
        residual_risk: '규제 의무가 뒤늦게 걸리면 미검토로 남는다',
      },
    ]);
  });

  test('a refuted skip flips back to relevant — the adversary found a live path (§5-3)', () => {
    const judgments: RawRelevanceJudgment[] = [
      {
        id: 'injection',
        relevant: false,
        reason: '신뢰 경계 입력이 없다',
        residual_risk: '인젝션 싱크가 뒤늦게 드러나면 미검토',
      },
    ];
    const refutes: RelevanceRefute[] = [{ id: 'injection', refuted: true }];
    expect(assembleRelevanceVerdicts(judgments, refutes)).toEqual([
      { id: 'injection', relevant: true },
    ]);
  });

  test('a not-relevant judgment with NO refute is not skipped — every skip must pass refute', () => {
    const judgments: RawRelevanceJudgment[] = [
      {
        id: 'auditing',
        relevant: false,
        reason: '감사 로그 경로 아님',
        residual_risk: '부인방지 공백',
      },
    ];
    expect(assembleRelevanceVerdicts(judgments, [])).toEqual([
      { id: 'auditing', relevant: true },
    ]);
  });

  test('conservative default: not-relevant missing reason or residual_risk stays relevant', () => {
    const judgments: RawRelevanceJudgment[] = [
      { id: 'concurrency-ordering', relevant: false, reason: '단일 경로' },
      { id: 'time-clock', relevant: false, residual_risk: '만료 공백' },
      { id: 'boundary-edge', relevant: false },
    ];
    const refutes: RelevanceRefute[] = [
      { id: 'concurrency-ordering', refuted: false },
      { id: 'time-clock', refuted: false },
      { id: 'boundary-edge', refuted: false },
    ];
    expect(assembleRelevanceVerdicts(judgments, refutes)).toEqual([
      { id: 'concurrency-ordering', relevant: true },
      { id: 'time-clock', relevant: true },
      { id: 'boundary-edge', relevant: true },
    ]);
  });

  test('a relevant judgment always stays relevant regardless of refutes', () => {
    const judgments: RawRelevanceJudgment[] = [
      { id: 'authentication', relevant: true },
    ];
    expect(assembleRelevanceVerdicts(judgments, [])).toEqual([
      { id: 'authentication', relevant: true },
    ]);
  });
});
