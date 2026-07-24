import { describe, expect, test } from 'bun:test';
import { validateQuestionContext } from '~/core/question-context';
import { assertSelectedPresentationContract } from '~/core/question-round';
import type { ScoredQuestion } from '~/schemas/question-round';

// ─────────────────────────────────────────────────────────────────────────────
// Named regression oracle (wi_260723lny, ac-1/ac-8): after the 4-element choice
// violation fields exist (option_expected_effect / option_ripple /
// option_root_cause_approach / option_self_sufficiency), the prism SELECTED-face
// whitelist ROUND_SURFACE_FIELDS (question-round.ts:33 = {user_explanation,
// unexplained_identifier}) must produce ZERO new rejections on a prism round (which
// carries no `options`). A red here means a new violation name leaked into the
// whitelist — a real regression.
// ─────────────────────────────────────────────────────────────────────────────

function prismQ(over: Partial<ScoredQuestion> = {}): ScoredQuestion {
  return {
    text: '점수 계산 방식을 어떻게 정할까요?',
    property: 'orientation',
    why_matters: '응답 형태를 좌우합니다',
    user_explanation: '이 질문이 무엇을 결정하는지 쉬운 말로 설명합니다.',
    scores: { consensus: 1, quality: 0.8, necessity: 0.7, answer_value: 0.6 },
    ...over,
  };
}

describe('prism whitelist — 0 new rejections after element-4 violations exist', () => {
  test('oracle-2: prism round yields 0 rejections; element-4 names are NOT whitelisted', () => {
    // A clean prism round (proper user_explanation, NO options, and — legitimately — no
    // recommended_answer) produces ZERO rejections. The recommended_answer violation
    // validateQuestionContext reports for a prism round is filtered by the whitelist; this pins
    // that non-whitelisted violations do not reject the prism face.
    expect(() => assertSelectedPresentationContract([prismQ()])).not.toThrow();

    // A whitelisted violation DOES reject — pins that user_explanation ∈ ROUND_SURFACE_FIELDS.
    expect(() =>
      assertSelectedPresentationContract([prismQ({ user_explanation: undefined })]),
    ).toThrow();

    // The new element-4 violation names are REAL (validateQuestionContext emits them) …
    const verdict = validateQuestionContext(
      {
        text: 'x',
        why_matters: 'y',
        user_explanation: 'z',
        options: [{ expected_effect: '', ripple: '', root_cause_approach: '' }],
      },
      [],
    );
    const fields = verdict.violations.map((v) => v.field);
    expect(fields).toContain('option_expected_effect');
    expect(fields).toContain('option_ripple');
    expect(fields).toContain('option_root_cause_approach');

    // … but they are NOT whitelisted onto the prism SELECTED face. ScoredQuestion carries no
    // `options`, so assertSelectedPresentationContract never forwards them, and none of these
    // names are in ROUND_SURFACE_FIELDS — so a prism round can never reject on them (0 new).
    expect(() => assertSelectedPresentationContract([prismQ(), prismQ()])).not.toThrow();
  });
});
