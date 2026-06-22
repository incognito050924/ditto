import { describe, expect, test } from 'bun:test';
import { validateQuestionContext } from '~/core/question-context';

// ac-2 (wi_260622ph8): the structural presentation-contract gate. A question may
// only be ASKED when it carries comprehensible, decision-sufficient context. This
// checks structural PRESENCE (the contract fields), not content quality.
describe('validateQuestionContext (ac-2, wi_260622ph8)', () => {
  const complete = {
    text: '비밀번호 해시는 무엇을 쓸까요?',
    why_matters: '저장 형식과 마이그레이션을 좌우합니다.',
    user_explanation: '비밀번호를 안전하게 저장하는 방식을 정하는 질문이에요.',
    background: '한 번 정하면 바꾸기 어렵습니다.',
    grounding: 'src/auth/store.ts:42',
    self_answer_attempts: [{ source: 'code' as const, result: '코드에 정책 없음' }],
  };

  test('accepts a context-complete candidate', () => {
    const v = validateQuestionContext(complete);
    expect(v.ok).toBe(true);
    expect(v.violations).toEqual([]);
  });

  test('rejects a candidate missing user_explanation (under-contextualized)', () => {
    const { user_explanation, ...withoutExplanation } = complete;
    const v = validateQuestionContext(withoutExplanation);
    expect(v.ok).toBe(false);
    expect(v.violations.map((x) => x.field)).toContain('user_explanation');
  });

  test('rejects an empty/whitespace user_explanation', () => {
    const v = validateQuestionContext({ ...complete, user_explanation: '   ' });
    expect(v.ok).toBe(false);
    expect(v.violations.map((x) => x.field)).toContain('user_explanation');
  });

  test('a minimal candidate (only why_matters + user_explanation) passes — background/grounding are optional progressive-disclosure tiers', () => {
    const v = validateQuestionContext({
      text: 'q?',
      why_matters: '결정에 영향',
      user_explanation: '왜 묻는지 쉬운 말 설명',
    });
    expect(v.ok).toBe(true);
  });
});
