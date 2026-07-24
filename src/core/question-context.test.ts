import { describe, expect, test } from 'bun:test';
import type { InterviewQuestionOption } from '~/schemas/interview-state';
import { type QuestionContextCandidate, validateQuestionContext } from './question-context';

// A syllable of Korean is 3 UTF-8 bytes, so 60 syllables = 180 bytes > the 160-byte
// OPTION_DESCRIPTION_BUDGET — used to force the self-sufficiency briefing path.
const OVER_BUDGET = '가'.repeat(60);

const baseOptions: [InterviewQuestionOption, InterviewQuestionOption] = [
  {
    label: '로컬 파일',
    expected_effect: '데이터가 프로젝트 폴더에 남아요',
    ripple: '백업 대상이 늘어나요',
    root_cause_approach: '보관 위치를 직접 정해 근본 원인을 해결해요',
  },
  {
    label: '메모리',
    expected_effect: '종료하면 사라져요',
    ripple: '재시작하면 초기화돼요',
    root_cause_approach: '임시 방편이라 근본 원인은 남아요',
  },
];

// A complete, options-bearing 4-element choice-situation, all within budget (baseline
// PASS). Each element of question-epistemology §1 is present: background (el.1),
// user_explanation = issue/intent (el.2), options + recommended_answer (el.3), and every
// option's {expected_effect, ripple, root_cause_approach} (el.4).
const baseComplete: QuestionContextCandidate = {
  text: '데이터를 어디에 저장할까요?',
  why_matters: '이 선택이 데이터 보관 위치를 정합니다',
  user_explanation: '데이터를 어디에 저장할지 정하는 질문이에요. 답에 따라 파일 위치가 달라져요',
  recommended_answer: '로컬 파일 저장을 추천해요',
  background: '지금은 임시 폴더에 저장돼요',
  options: baseOptions,
};

const hasField = (verdict: ReturnType<typeof validateQuestionContext>, field: string): boolean =>
  verdict.violations.some((v) => v.field === field);

describe('validateQuestionContext — 4-element choice-situation (ac-1)', () => {
  test('complete options-bearing question passes', () => {
    expect(validateQuestionContext(baseComplete).ok).toBe(true);
  });

  test('missing element-1 (background) rejects naming background', () => {
    const v = validateQuestionContext({ ...baseComplete, background: undefined });
    expect(v.ok).toBe(false);
    expect(hasField(v, 'background')).toBe(true);
  });

  test('missing element-3 recommendation (recommended_answer) rejects', () => {
    const v = validateQuestionContext({ ...baseComplete, recommended_answer: undefined });
    expect(v.ok).toBe(false);
    expect(hasField(v, 'recommended_answer')).toBe(true);
  });

  test('missing element-4 per-option expected_effect rejects naming it', () => {
    const v = validateQuestionContext({
      ...baseComplete,
      options: [{ ...baseOptions[0], expected_effect: undefined }, baseOptions[1]],
    });
    expect(v.ok).toBe(false);
    expect(hasField(v, 'option_expected_effect')).toBe(true);
  });

  test('missing element-4 per-option ripple rejects naming it', () => {
    const v = validateQuestionContext({
      ...baseComplete,
      options: [{ ...baseOptions[0], ripple: undefined }, baseOptions[1]],
    });
    expect(v.ok).toBe(false);
    expect(hasField(v, 'option_ripple')).toBe(true);
  });

  test('missing element-4 per-option root_cause_approach rejects naming it', () => {
    const v = validateQuestionContext({
      ...baseComplete,
      options: [{ ...baseOptions[0], root_cause_approach: undefined }, baseOptions[1]],
    });
    expect(v.ok).toBe(false);
    expect(hasField(v, 'option_root_cause_approach')).toBe(true);
  });

  test('a question with NO options is not options-bearing — no element-4/background violation', () => {
    const noOptions: QuestionContextCandidate = {
      text: baseComplete.text,
      why_matters: baseComplete.why_matters,
      user_explanation: baseComplete.user_explanation,
      recommended_answer: baseComplete.recommended_answer,
      // no background, no options
    };
    const v = validateQuestionContext(noOptions);
    expect(hasField(v, 'background')).toBe(false);
    expect(hasField(v, 'option_expected_effect')).toBe(false);
    expect(hasField(v, 'option_self_sufficiency')).toBe(false);
    expect(v.ok).toBe(true);
  });
});

describe('validateQuestionContext — self-sufficiency (ac-2)', () => {
  test('over-budget disclosure carried per-option (each option carries its own prose) passes', () => {
    const v = validateQuestionContext({
      ...baseComplete,
      background: OVER_BUDGET,
      options: baseOptions.map((o) => ({
        ...o,
        expected_effect: OVER_BUDGET,
        ripple: OVER_BUDGET,
        root_cause_approach: OVER_BUDGET,
      })),
    });
    expect(v.ok).toBe(true);
    expect(hasField(v, 'option_self_sufficiency')).toBe(false);
  });

  test('over-budget disclosure only in general briefing (options thin) rejects', () => {
    // background overflows the budget, but each option keeps only short (present) prose,
    // so the disclosure lives ONLY in the general briefing — not per-option.
    const v = validateQuestionContext({ ...baseComplete, background: OVER_BUDGET });
    expect(v.ok).toBe(false);
    expect(hasField(v, 'option_self_sufficiency')).toBe(true);
  });
});

describe('validateQuestionContext — admission does not read effect-difference (ac-6)', () => {
  test('same verdict when only expected_effect magnitude text differs', () => {
    const bigEffect = validateQuestionContext({
      ...baseComplete,
      options: [
        {
          ...baseOptions[0],
          expected_effect: '영향이 아주 크게 달라집니다 매우 큰 차이',
        },
        { ...baseOptions[1], expected_effect: '영향이 거의 없습니다 아주 작은 차이' },
      ],
    });
    const baseline = validateQuestionContext(baseComplete);
    // Differing effect magnitude prose must not change WHETHER the question fires.
    expect(bigEffect.ok).toBe(baseline.ok);
    expect(baseline.ok).toBe(true);
  });
});
