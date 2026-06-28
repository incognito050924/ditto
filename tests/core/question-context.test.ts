import { describe, expect, test } from 'bun:test';
import {
  OPTION_DESCRIPTION_BUDGET,
  REVIEW_REGENERATE_CAP,
  needsBriefing,
  resolveReviewDecision,
  routeForReview,
  validateQuestionContext,
} from '~/core/question-context';

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

// ac-1 (D1): an internal identifier (ac-{n} · T-{n} · D{n} · (wi|orch|memevt|adr)_…)
// surfaced on the user-reaching face (text + user_explanation) with no inline gloss
// is rejected; the same identifier paired with a ±40-char gloss passes. Korean-robust
// (whitelist patterns, not broad \w+), code blocks stripped.
describe('validateQuestionContext identifier gloss (ac-1, D1)', () => {
  const base = {
    why_matters: '결과에 영향을 줍니다.',
    user_explanation: '왜 묻는지 쉬운 말로 설명하는 문장이에요.',
  };

  test('(a) rejects an unexplained ac-1 in the question text', () => {
    const v = validateQuestionContext({ ...base, text: 'ac-1을 어떻게 처리할까요?' });
    expect(v.ok).toBe(false);
    expect(v.violations.map((x) => x.field)).toContain('unexplained_identifier');
  });

  test('(b) accepts ac-1 with a parenthetical gloss (비밀번호 해시 정책)', () => {
    const v = validateQuestionContext({
      ...base,
      text: 'ac-1(비밀번호 해시 정책)을 어떻게 처리할까요?',
    });
    expect(v.ok).toBe(true);
    expect(v.violations.map((x) => x.field)).not.toContain('unexplained_identifier');
  });

  test('(c) accepts an ac-1 that only appears inside a code block / inline code', () => {
    const fenced = validateQuestionContext({
      ...base,
      text: '아래 정책을 볼까요?\n```\nac-1\n```',
    });
    expect(fenced.ok).toBe(true);
    const inline = validateQuestionContext({ ...base, text: '`ac-1` 항목 말이에요.' });
    expect(inline.ok).toBe(true);
  });

  test('(d) rejects an unexplained identifier adjacent to Korean text', () => {
    const v = validateQuestionContext({
      ...base,
      text: 'wi_260628p46 진행 상황을 알려주세요',
    });
    expect(v.ok).toBe(false);
    expect(v.violations.map((x) => x.field)).toContain('unexplained_identifier');
  });

  test('accepts a colon-separated gloss after the identifier', () => {
    const v = validateQuestionContext({
      ...base,
      text: 'D3: 기존 필드를 재사용하는 결정 말이에요',
    });
    expect(v.ok).toBe(true);
  });

  test('flags an unexplained identifier carried in user_explanation', () => {
    const v = validateQuestionContext({
      text: '어떤 방식이 좋을까요?',
      why_matters: '결과에 영향을 줍니다.',
      user_explanation: 'orch_26062148a 결과를 반영하는 질문이에요',
    });
    expect(v.ok).toBe(false);
    expect(v.violations.map((x) => x.field)).toContain('unexplained_identifier');
  });

  test('does not flag ordinary Korean/English prose (no broad \\w+ false-positive)', () => {
    const v = validateQuestionContext({
      text: '비밀번호 저장 방식을 bcrypt로 할까요 argon2로 할까요?',
      why_matters: '저장 형식을 좌우합니다.',
      user_explanation: '암호를 안전하게 저장하는 방법을 정하는 질문이에요.',
    });
    expect(v.ok).toBe(true);
  });
});

// ac-5 (D4): needsBriefing is a pure threshold over the rendered option description.
describe('needsBriefing (ac-5, D4)', () => {
  test('OPTION_DESCRIPTION_BUDGET is a positive named constant', () => {
    expect(OPTION_DESCRIPTION_BUDGET).toBeGreaterThan(0);
  });

  test('false at exactly the limit, true one char over (boundary)', () => {
    const atLimit = 'x'.repeat(OPTION_DESCRIPTION_BUDGET);
    const overLimit = 'x'.repeat(OPTION_DESCRIPTION_BUDGET + 1);
    expect(needsBriefing(atLimit, OPTION_DESCRIPTION_BUDGET)).toBe(false);
    expect(needsBriefing(overLimit, OPTION_DESCRIPTION_BUDGET)).toBe(true);
  });

  test('limit-agnostic: pure over whatever limit is passed', () => {
    expect(needsBriefing('abcd', 4)).toBe(false);
    expect(needsBriefing('abcde', 4)).toBe(true);
    expect(needsBriefing('', 0)).toBe(false);
  });
});

// ac-4 (D2): critical questions route to the session-blind reviewer; the per-question
// regeneration cap (2) and reviewer availability decide reviewed vs unverified-degraded.
describe('review routing + regeneration cap (ac-4, D2)', () => {
  test('critical questions route to review; non-critical skip it', () => {
    expect(routeForReview({ critical: true }).action).toBe('review');
    expect(routeForReview({ critical: false }).action).toBe('skip-review');
  });

  test('reviewer pass → reviewed', () => {
    const d = resolveReviewDecision({ passed: true, regenerations: 0, reviewerAvailable: true });
    expect(d.status).toBe('reviewed');
  });

  test('reviewer unavailable → unverified-degraded (honest, not silently asked)', () => {
    const d = resolveReviewDecision({ passed: false, regenerations: 0, reviewerAvailable: false });
    expect(d).toEqual({ status: 'unverified-degraded', reason: 'reviewer-unavailable' });
  });

  test('below cap and not passed → regenerate with incremented attempt', () => {
    const d = resolveReviewDecision({ passed: false, regenerations: 0, reviewerAvailable: true });
    expect(d).toEqual({ status: 'regenerate', attempt: 1 });
  });

  test('cap (2) exhausted → unverified-degraded, no stall', () => {
    const d = resolveReviewDecision({
      passed: false,
      regenerations: REVIEW_REGENERATE_CAP,
      reviewerAvailable: true,
    });
    expect(d).toEqual({ status: 'unverified-degraded', reason: 'cap-exhausted' });
    expect(REVIEW_REGENERATE_CAP).toBe(2);
  });
});
