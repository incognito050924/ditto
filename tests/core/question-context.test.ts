import { describe, expect, test } from 'bun:test';
import {
  OPTION_DESCRIPTION_BUDGET,
  REVIEW_REGENERATE_CAP,
  isBranchSeam,
  needsBriefing,
  orderByContinuity,
  resolveReviewDecision,
  routeForReview,
  selectSingleFire,
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
    recommended_answer: 'bcrypt(cost 12)를 추천합니다.',
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
      recommended_answer: '추천하는 기본 답',
    });
    expect(v.ok).toBe(true);
  });
});

// ac-1 (impl-di-recommended-answer): recommended_answer is hard-required at the check-question
// gate — EXACTLY mirroring user_explanation (optional in the schema, gate-required by
// validateQuestionContext). A candidate missing/blank recommended_answer is rejected; one that
// carries it passes. Precedent: user_explanation is `.optional()` yet gate-required.
describe('validateQuestionContext requires recommended_answer (ac-1)', () => {
  const base = {
    text: '비밀번호 해시는 무엇을 쓸까요?',
    why_matters: '저장 형식을 좌우합니다.',
    user_explanation: '비밀번호를 안전하게 저장하는 방식을 정하는 질문이에요.',
  };

  test('rejects a candidate missing recommended_answer', () => {
    const v = validateQuestionContext(base);
    expect(v.ok).toBe(false);
    expect(v.violations.map((x) => x.field)).toContain('recommended_answer');
  });

  test('rejects an empty/whitespace recommended_answer', () => {
    const v = validateQuestionContext({ ...base, recommended_answer: '   ' });
    expect(v.ok).toBe(false);
    expect(v.violations.map((x) => x.field)).toContain('recommended_answer');
  });

  test('passes when recommended_answer is present', () => {
    const v = validateQuestionContext({ ...base, recommended_answer: 'bcrypt를 추천합니다.' });
    expect(v.ok).toBe(true);
    expect(v.violations.map((x) => x.field)).not.toContain('recommended_answer');
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
    recommended_answer: '추천하는 기본 답이에요.',
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
      recommended_answer: 'bcrypt를 추천합니다.',
    });
    expect(v.ok).toBe(true);
  });
});

// ac-2 (impl-di-recommended-answer): the deep-interview single-fire selector returns AT
// MOST ONE candidate — the top-1 by info_gain_estimate (high > medium > low). info_gain is
// a 3-value enum so TIES ARE ROUTINE; the tiebreak is deterministic — stable INPUT ORDER
// (first candidate among equals wins). Pure and unit-testable; lives on the deep-interview
// path only (NOT the shared question-round schema — that stays multi-select for prism).
describe('selectSingleFire (ac-2, deep-interview top-1 single-fire)', () => {
  test('3 above-threshold candidates → exactly the highest info_gain', () => {
    const out = selectSingleFire([
      { id: 'a', info_gain_estimate: 'medium' as const },
      { id: 'b', info_gain_estimate: 'high' as const },
      { id: 'c', info_gain_estimate: 'low' as const },
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.id).toBe('b');
  });

  test('all-tied → deterministic: the FIRST candidate in input order wins', () => {
    const out = selectSingleFire([
      { id: 'x', info_gain_estimate: 'medium' as const },
      { id: 'y', info_gain_estimate: 'medium' as const },
      { id: 'z', info_gain_estimate: 'medium' as const },
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.id).toBe('x');
  });

  test('empty input → empty result', () => {
    expect(selectSingleFire([])).toEqual([]);
  });

  test('single candidate → that one', () => {
    const out = selectSingleFire([{ id: 'solo', info_gain_estimate: 'low' as const }]);
    expect(out.length).toBe(1);
    expect(out[0]?.id).toBe('solo');
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

  // ac-2 (byte budget): the host truncates the option `description` by UTF-8 BYTES,
  // not UTF-16 code units. So the budget must be measured in bytes — otherwise a
  // Korean (3-bytes/syllable) context that LOOKS short in char count silently
  // overflows the host's byte-truncation limit and never briefs. This is the
  // byte-vs-char DISCRIMINATOR: the ASCII 'x'.repeat boundary test above cannot tell
  // the two apart (1 byte == 1 code unit for ASCII).
  test('DISCRIMINATOR: a Korean string under the char budget but over the BYTE budget briefs', () => {
    const s = '가'.repeat(60); // 60 UTF-16 code units, 180 UTF-8 bytes
    // char logic (rendered.length) would say false — under the 160 budget …
    expect(s.length).toBeLessThanOrEqual(OPTION_DESCRIPTION_BUDGET);
    // … but the host truncates by bytes, and 180 bytes > 160 → must brief.
    expect(Buffer.byteLength(s, 'utf8')).toBeGreaterThan(OPTION_DESCRIPTION_BUDGET);
    expect(needsBriefing(s)).toBe(true);
  });

  test('paired just-under: a Korean string within the BYTE budget does NOT brief', () => {
    const s = '가'.repeat(50); // 50 code units, 150 UTF-8 bytes ≤ 160
    expect(s.length).toBeLessThan(OPTION_DESCRIPTION_BUDGET);
    expect(Buffer.byteLength(s, 'utf8')).toBeLessThanOrEqual(OPTION_DESCRIPTION_BUDGET);
    expect(needsBriefing(s)).toBe(false);
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

// ac-4 (wi_260713cx4, #27, branch-walking): seam-detection. The DRIVER-side judgment of
// whether the current branch is at a SEAM — it opens no further value-bearing dependent
// decision (branch exhausted). A seam is what licenses a blind full re-survey. This must
// FAIL-OPEN: any ambiguity / under-detection reports NOT-a-seam (falls through to the
// unconditional cap backstop), because under-detection must never cause an early close.
// The seam marker is the per-turn `branch_judgment.opened === false`; a still-pending
// `to` target in the reference graph means a deferred value branch remains → NOT a seam.
describe('isBranchSeam (ac-4, branch-walking seam-detection, fail-open)', () => {
  test('seam detected: latest turn opened nothing AND no value branch remains', () => {
    // opened=false is the seam marker; every edge target is already resolved → dry.
    expect(
      isBranchSeam({
        edges: [{ from: 'auth', to: 'hash' }],
        resolvedIds: ['auth', 'hash'],
        latestJudgment: { opened: false },
      }),
    ).toBe(true);
  });

  test('seam detected: no edges at all AND the turn positively opened nothing', () => {
    expect(isBranchSeam({ edges: [], resolvedIds: [], latestJudgment: { opened: false } })).toBe(
      true,
    );
  });

  test('NOT a seam (fail-open): a deferred value branch remains (target unaddressed)', () => {
    // opened=false this turn, but an EARLIER-opened branch (`hash`) is still pending.
    expect(
      isBranchSeam({
        edges: [{ from: 'auth', to: 'hash' }],
        resolvedIds: ['auth'],
        latestJudgment: { opened: false },
      }),
    ).toBe(false);
  });

  test('NOT a seam: the latest turn opened a further value branch', () => {
    expect(
      isBranchSeam({
        edges: [{ from: 'auth', to: 'hash' }],
        resolvedIds: ['auth', 'hash'],
        latestJudgment: { opened: true },
      }),
    ).toBe(false);
  });

  test('NOT a seam (fail-open): no per-turn judgment recorded (under-detected / ambiguous)', () => {
    // Missing branch_judgment = detection did not run → must NOT report dry (cap backstop).
    expect(isBranchSeam({ edges: [], resolvedIds: [], latestJudgment: undefined })).toBe(false);
  });
});

// ac-5 (wi_260713cx4, #27, branch-walking): continuity-ordering. Given the pending
// questions/dimensions (branch follow-ups + fresh breadth), order them so a branch is
// walked CONTIGUOUSLY (dependency-connected items emitted together, `from` before `to`)
// and region transitions happen only at a seam (after a whole branch is done), preferring
// topical adjacency (shared whole-token keywords, reusing the fragmentKeywords tokenizer)
// so context-switch cost is minimized.
describe('orderByContinuity (ac-5, branch-walking continuity-ordering)', () => {
  test('walks a branch contiguously, then switches region by topical adjacency', () => {
    // Branch: auth-a → auth-b (dependency edge). Two fresh-breadth singletons: a
    // topically-adjacent one (session, shares "login") and an unrelated one (billing).
    // Input order interleaves them to prove ordering is by structure, not input order.
    const items = [
      { id: 'auth-a', text: 'password login' },
      { id: 'billing', text: 'invoice payment' },
      { id: 'auth-b', text: 'password hashing' },
      { id: 'session', text: 'session token login' },
    ];
    const edges = [{ from: 'auth-a', to: 'auth-b' }];
    const ordered = orderByContinuity(items, edges).map((i) => i.id);

    // branch walked contiguously and in dependency order (from before to)
    const ia = ordered.indexOf('auth-a');
    const ib = ordered.indexOf('auth-b');
    expect(ib).toBe(ia + 1);

    // region switch after the branch goes to the topically-adjacent singleton first
    expect(ordered.indexOf('session')).toBeLessThan(ordered.indexOf('billing'));
    // full expected deterministic order
    expect(ordered).toEqual(['auth-a', 'auth-b', 'session', 'billing']);
  });

  test('preserves every item exactly once (no drop, no dup)', () => {
    const items = [
      { id: 'x', text: 'alpha' },
      { id: 'y', text: 'beta' },
      { id: 'z', text: 'gamma' },
    ];
    const ordered = orderByContinuity(items, []).map((i) => i.id);
    expect(ordered.sort()).toEqual(['x', 'y', 'z']);
  });

  test('empty input → empty output', () => {
    expect(orderByContinuity([], [])).toEqual([]);
  });
});
