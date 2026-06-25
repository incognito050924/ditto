import { describe, expect, test } from 'bun:test';
import { assembleRelevanceVerdicts } from '~/core/coverage-relevance';

// wi_260625l0v §5 — the deterministic safety core of the relevance gate. The grounded
// relevance agent (§5-2) proposes per-category judgments and an adversarial refuter
// (§5-3) challenges each proposed skip; this assembler enforces — NOT at agent
// discretion — that a category is skipped ONLY when it is justified (reason ∧
// residual_risk) AND survived adversarial refute. Anything short of that flips to
// relevant (open) — 애매하면 포함 (§5-1). The output feeds the slice-1 gate.
describe('assembleRelevanceVerdicts — §5 safety (wi_260625l0v)', () => {
  test('a justified not-relevant judgment that survives refute → skip (relevant:false, carries reason+residual_risk)', () => {
    const v = assembleRelevanceVerdicts(
      [
        {
          id: 'authentication',
          relevant: false,
          reason: '인증 경로 미접촉',
          residual_risk: '오판 시 인증 실패 누락',
        },
      ],
      [{ id: 'authentication', refuted: false }],
    );
    expect(v).toEqual([
      {
        id: 'authentication',
        relevant: false,
        reason: '인증 경로 미접촉',
        residual_risk: '오판 시 인증 실패 누락',
      },
    ]);
  });

  test('a skip that the refuter overturns (found relevant) → flips to relevant (§5-3)', () => {
    const v = assembleRelevanceVerdicts(
      [{ id: 'authentication', relevant: false, reason: '무관', residual_risk: '누락' }],
      [{ id: 'authentication', refuted: true }],
    );
    expect(v).toEqual([{ id: 'authentication', relevant: true }]);
  });

  test('a not-relevant judgment with NO refute → not skipped (every skip must pass adversarial refute, §5-3)', () => {
    const v = assembleRelevanceVerdicts(
      [{ id: 'authentication', relevant: false, reason: '무관', residual_risk: '누락' }],
      [],
    );
    expect(v).toEqual([{ id: 'authentication', relevant: true }]);
  });

  test('a not-relevant judgment missing residual_risk → not skipped (no justification, §5-1)', () => {
    const v = assembleRelevanceVerdicts(
      [{ id: 'authentication', relevant: false, reason: '무관' }],
      [{ id: 'authentication', refuted: false }],
    );
    expect(v).toEqual([{ id: 'authentication', relevant: true }]);
  });

  test('a relevant judgment stays relevant regardless of refutes', () => {
    const v = assembleRelevanceVerdicts([{ id: 'data-integrity', relevant: true }], []);
    expect(v).toEqual([{ id: 'data-integrity', relevant: true }]);
  });

  test('mixed batch: only the justified, refute-surviving skip is dropped', () => {
    const v = assembleRelevanceVerdicts(
      [
        { id: 'authentication', relevant: false, reason: '무관', residual_risk: '누락' },
        { id: 'data-integrity', relevant: true },
        { id: 'time-clock', relevant: false, reason: '시간 무의존', residual_risk: '누락' },
      ],
      [
        { id: 'authentication', refuted: false }, // survives → skip
        { id: 'time-clock', refuted: true }, // overturned → relevant
      ],
    );
    expect(v).toEqual([
      { id: 'authentication', relevant: false, reason: '무관', residual_risk: '누락' },
      { id: 'data-integrity', relevant: true },
      { id: 'time-clock', relevant: true },
    ]);
  });
});
