import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordTurn, startInterview } from '~/core/interview-driver';
import { InterviewStore } from '~/core/interview-store';
import { loadGlossaryVocab } from '~/core/knowledge-bridge';
import {
  OPTION_DESCRIPTION_BUDGET,
  REVIEW_REGENERATE_CAP,
  findLoanwords,
  findUnexplainedIdentifiers,
  isBranchSeam,
  needsBriefing,
  normalizePresentedText,
  orderByContinuity,
  resolveReviewDecision,
  routeForReview,
  selectSingleFire,
  validateQuestionContext,
} from '~/core/question-context';
import { assertSelectedPresentationContract } from '~/core/question-round';
import { WorkItemStore } from '~/core/work-item-store';

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

// ac-1 (shared-detector-core): recommended_answer is shown to the user by default, so it is
// part of the user-reaching face and MUST be included in the un-glossed-leak scan. A candidate
// whose ONLY leak lives in recommended_answer (text + user_explanation clean) must be rejected.
describe('validateQuestionContext scans recommended_answer for leaks (ac-1)', () => {
  const clean = {
    text: '어떤 방식이 좋을까요?',
    why_matters: '결과에 영향을 줍니다.',
    user_explanation: '왜 묻는지 쉬운 말로 설명하는 문장이에요.',
  };

  test('rejects a leak that appears ONLY in recommended_answer', () => {
    const v = validateQuestionContext({ ...clean, recommended_answer: 'ac-1을 추천합니다.' });
    expect(v.ok).toBe(false);
    expect(v.violations.map((x) => x.field)).toContain('unexplained_identifier');
  });

  test('a glossed identifier in recommended_answer passes', () => {
    const v = validateQuestionContext({
      ...clean,
      recommended_answer: 'ac-1(비밀번호 해시 정책)을 추천합니다.',
    });
    expect(v.ok).toBe(true);
    expect(v.violations.map((x) => x.field)).not.toContain('unexplained_identifier');
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

// ── wi_260714aaq (#29): opaque internal-vocabulary leak detection ────────────────
//
// Beyond the shape-based IDENTIFIER_PATTERNS, findUnexplainedIdentifiers also flags a
// CLOSED, CURATED opaque-vocab set surfaced un-glossed on the QUESTION face: a hardcoded
// floor (axis names as EXACT literals; a small explicit set of coined compounds; curated
// schema field names in UNDERSCORE form) UNION the glossary's forbidden_abbreviations
// (RESOLVED BY THE CALLER, INJECTED — the detector stays pure). Membership is by CURATION,
// not a broad matcher; the ±40-char gloss rule is reused; the glossary set is matched as
// LITERAL substrings so a metachar-bearing entry can neither break nor backtrack the scan.
describe('findUnexplainedIdentifiers opaque-vocab floor (ac-1, must-flag)', () => {
  test('flags an un-glossed axis name (정합성 2축)', () => {
    expect(findUnexplainedIdentifiers('정합성 2축을 어떻게 맞출까요?')).toContain('정합성 2축');
  });

  test('flags an un-glossed coined compound (supersedes chain)', () => {
    expect(findUnexplainedIdentifiers('supersedes chain을 설명 없이 씁니다')).toContain(
      'supersedes chain',
    );
  });

  test('flags an un-glossed curated schema field in UNDERSCORE form (acceptance_criteria)', () => {
    expect(findUnexplainedIdentifiers('acceptance_criteria를 어떻게 처리할까요?')).toContain(
      'acceptance_criteria',
    );
  });

  test('an opaque-vocab hit carrying a nearby gloss passes (reuses the ±40-char rule)', () => {
    expect(findUnexplainedIdentifiers('정합성 2축(코드와 SoT의 두 관계)을 맞춥니다')).toEqual([]);
  });
});

describe('findUnexplainedIdentifiers opaque-vocab — zero false positive (ac-2)', () => {
  test('ordinary Korean prose does not flag', () => {
    expect(
      findUnexplainedIdentifiers('비밀번호를 안전하게 저장하는 방법을 정하는 질문이에요.'),
    ).toEqual([]);
  });

  test('common words used in everyday sense (run / evidence / request) do not flag', () => {
    expect(
      findUnexplainedIdentifiers('run 결과와 evidence를 확인하고 request를 처리합니다'),
    ).toEqual([]);
  });

  // These are glossary ALIASES (event→memory event, source→memory source,
  // projection→memory projection, stem→stem) — deliberately NOT in the hard-reject list
  // (coverage OBJ-1): treating them as leaks would invert the field contract and
  // false-positive on ordinary prose.
  test('alias-sourced common words (event / source / projection / stem) do not flag', () => {
    expect(
      findUnexplainedIdentifiers('event 와 source, projection, stem 모두 평범한 단어입니다'),
    ).toEqual([]);
  });

  // The banner uses the SPACE form "acceptance criteria"; only the UNDERSCORE
  // "acceptance_criteria" leaks. The space form must survive (keeps charter.test green).
  test('banner space-form "acceptance criteria" (space ≠ underscore) does not flag', () => {
    expect(findUnexplainedIdentifiers('모든 acceptance criteria를 증거와 함께 닫습니다')).toEqual(
      [],
    );
  });
});

// ac-1 (shared-detector-core): un-agreed doc/section references (§N, §N-M, canonical
// ADR-YYYYMMDD-slug, legacy ADR-<digits>) are ALWAYS a leak on the user face. CRITICAL: they
// are NOT run through the ±40-char isGlossed window — a trailing `-slug` / `-number` or adjacent
// prose would be MIS-READ as a gloss separator + explanatory word and false-negative the very
// doc-ref. A section number / ADR id cannot be "explained" by adjacent prose, so a matched
// doc/section ref is an unconditional leak.
describe('findUnexplainedIdentifiers doc/section refs (ac-1, always-leak)', () => {
  test('flags a §N-M section ref inside Korean prose', () => {
    expect(findUnexplainedIdentifiers('§4-6 규칙을 따르세요')).toContain('§4-6');
  });

  test('flags a bare §N section ref', () => {
    expect(findUnexplainedIdentifiers('§8 원칙을 보세요')).toContain('§8');
  });

  test('flags a slug-bearing canonical ADR id (ADR-YYYYMMDD-slug)', () => {
    expect(findUnexplainedIdentifiers('ADR-20260714-language-axis를 반영합니다')).toContain(
      'ADR-20260714-language-axis',
    );
  });

  test('flags a legacy ADR-<digits> id', () => {
    expect(findUnexplainedIdentifiers('ADR-0024를 확인하세요')).toContain('ADR-0024');
  });

  // The load-bearing regression: a doc-ref carrying a parenthetical / dash "gloss" must STILL be
  // flagged, because isGlossed would false-negative it. This is what makes the doc-ref path
  // separate from (and never routed through) the gloss window.
  test('flags a §N-M ref EVEN WITH an adjacent parenthetical (never glossable)', () => {
    expect(findUnexplainedIdentifiers('§4-6(위임 규율 조항)을 따르세요')).toContain('§4-6');
  });

  test('flags a canonical ADR id whose trailing -slug looks like a gloss separator', () => {
    // `-language-axis` after `ADR-20260714` is exactly the dash + explanatory-word shape
    // isGlossed treats as a gloss; the always-leak path flags it anyway.
    expect(
      findUnexplainedIdentifiers('ADR-20260714-language-axis-followups-terminated 참고'),
    ).toContain('ADR-20260714-language-axis-followups-terminated');
  });

  test('a doc-ref only inside a code fence is exempt (code stripped first)', () => {
    expect(findUnexplainedIdentifiers('```\n§4-6\n```')).toEqual([]);
  });
});

// ac-3 (shared-detector-core): a BOUNDED loanword advisory. A seed loanword (외래어 with a plain
// Korean equivalent) in free-standing prose produces an advisory signal; the SAME token inside a
// code fence / inline code / glued into an ASCII identifier is exempt, and ordinary Korean prose
// (and legitimately-kept technical terms like 커밋/테스트/코드) never flags. Matched by indexOf,
// never a broad \w+ scan.
describe('findLoanwords (ac-3, bounded advisory)', () => {
  test('flags a seed loanword in Korean prose (밸런스 -> 균형)', () => {
    const out = findLoanwords('밸런스를 맞추는 게 중요합니다');
    expect(out.map((x) => x.loanword)).toContain('밸런스');
    expect(out.find((x) => x.loanword === '밸런스')?.suggestion).toBe('균형');
  });

  test('flags each of several distinct seed loanwords (케이스, 이슈, 리스크)', () => {
    const flagged = findLoanwords('이 케이스는 이슈와 리스크가 있어요').map((x) => x.loanword);
    expect(flagged.sort()).toEqual(['리스크', '이슈', '케이스']);
  });

  test('does NOT flag a seed loanword inside a code fence (stripCode)', () => {
    expect(findLoanwords('```\n밸런스\n```')).toEqual([]);
  });

  test('does NOT flag a seed loanword inside inline code', () => {
    expect(findLoanwords('`밸런스` 항목')).toEqual([]);
  });

  test('does NOT flag a seed loanword glued into an ASCII identifier (boundary)', () => {
    expect(findLoanwords('밸런스value 라는 변수')).toEqual([]);
    expect(findLoanwords('config_밸런스 라는 변수')).toEqual([]);
  });

  test('does NOT flag ordinary Korean prose with no seed loanword', () => {
    expect(findLoanwords('비밀번호를 안전하게 저장하는 방법을 정합니다')).toEqual([]);
  });

  test('does NOT flag legitimately-kept technical terms (커밋 / 테스트 / 코드)', () => {
    expect(findLoanwords('커밋과 테스트, 코드를 확인합니다')).toEqual([]);
  });
});

// ac-2 (shared-detector-core): a deterministic display normalizer, SEPARATE from the gate. It
// strips broken/garbage chars (U+FFFD replacement char, C0/C1 control chars incl. ESC/CSI) and
// canonicalizes typographic chars (em/en dash -> hyphen, curly quotes -> straight, ellipsis -> ...).
// Must be idempotent.
describe('normalizePresentedText (ac-2, display transform)', () => {
  test('strips the Unicode replacement char (U+FFFD)', () => {
    expect(normalizePresentedText('a�b')).toBe('ab');
  });

  test('strips ESC (U+001B) and C1 CSI (U+009B) control chars', () => {
    const out = normalizePresentedText('red\x1b[31mtext\x9b0m');
    expect(out.includes('\x1b')).toBe(false);
    expect(out.includes('\x9b')).toBe(false);
  });

  test('keeps ordinary whitespace (\\n, \\t) but strips other C0 controls (\\r, NUL)', () => {
    expect(normalizePresentedText('a\nb\tc')).toBe('a\nb\tc');
    expect(normalizePresentedText('a\r\x00b')).toBe('ab');
  });

  test('normalizes em-dash and en-dash to a plain hyphen', () => {
    expect(normalizePresentedText('a—b–c')).toBe('a-b-c');
  });

  test('normalizes curly single and double quotes to straight quotes', () => {
    expect(normalizePresentedText('“hi” ‘yo’')).toBe('"hi" \'yo\'');
  });

  test('normalizes the ellipsis char to three dots', () => {
    expect(normalizePresentedText('wait…')).toBe('wait...');
  });

  test('is idempotent: normalize(normalize(x)) === normalize(x)', () => {
    const x = 'a�—“q”…\x1b[0m\r'; // mix of every case
    const once = normalizePresentedText(x);
    expect(normalizePresentedText(once)).toBe(once);
  });
});

describe('findUnexplainedIdentifiers injected glossary vocab (ac-1, unit)', () => {
  test('flags an injected forbidden_abbreviation via the vocab param', () => {
    expect(findUnexplainedIdentifiers('zqx를 설명 없이 씁니다', ['zqx'])).toContain('zqx');
  });

  // Literal (non-regex) matching: 'a.c' as a REGEX would match 'abc'; as a LITERAL it
  // must match only 'a.c'. Proves the glossary set is matched by literal substring
  // (metachar entries are inert — no ReDoS, no injection).
  test('literal matching: a metachar-bearing entry flags itself but NOT a regex-would-match string', () => {
    expect(findUnexplainedIdentifiers('a.c를 설명 없이 씁니다', ['a.c'])).toContain('a.c');
    expect(findUnexplainedIdentifiers('abc를 설명 없이 씁니다', ['a.c'])).toEqual([]);
  });
});

// ac-3 asymmetry — the prism selected face is a HARD gate (like the deep-interview
// question face): an un-glossed opaque-vocab hit rejects the round before persist.
describe('assertSelectedPresentationContract opaque-vocab (ac-3, prism HARD)', () => {
  test('rejects a selected question surfacing an un-glossed axis name (opaque-vocab floor)', () => {
    const selected = [
      {
        text: '정합성 2축을 어떻게 정할까요?',
        property: 'orientation' as const,
        user_explanation: '왜 묻는지 쉬운 말로 설명하는 문장이에요',
        scores: { consensus: 1, quality: 0.9, necessity: 0.9, answer_value: 0.9 },
      },
    ];
    expect(() => assertSelectedPresentationContract(selected)).toThrow();
  });
});

// ac-1 / ac-3 (HARD) — the CONSUMER path: recordTurn (the deep-interview QUESTION face)
// resolves the glossary vocab at runtime and applies it. Proves the glossary is genuinely
// READ (coverage OBJ-2 — not false-green), not a unit-only inline list.
describe('recordTurn opaque-vocab consumer path (ac-1/ac-3, glossary READ at runtime)', () => {
  async function makeRepo(forbidden: string[] | null): Promise<{ repo: string; wiId: string }> {
    const repo = await mkdtemp(join(tmpdir(), 'ditto-qc-vocab-'));
    if (forbidden !== null) {
      await mkdir(join(repo, '.ditto', 'knowledge'), { recursive: true });
      await writeFile(
        join(repo, '.ditto', 'knowledge', 'glossary.json'),
        JSON.stringify({
          schema_version: '0.1.0',
          project_name: 'test',
          updated_at: '2026-07-14T00:00:00+09:00',
          entries: [
            { term: 'x-term', aliases: [], definition: 'd', forbidden_abbreviations: forbidden },
          ],
        }),
      );
    }
    const wi = await new WorkItemStore(repo).create({
      title: 't',
      source_request: 'r',
      goal: 'g',
      acceptance_criteria: [{ id: 'ac-1', statement: 'TBD', verdict: 'unverified', evidence: [] }],
    });
    await startInterview(repo, { workItemId: wi.id });
    return { repo, wiId: wi.id };
  }

  const question = {
    text: 'zqx를 어떻게 정할까요?',
    why_matters: '결과에 영향을 줍니다.',
    user_explanation: '왜 묻는지 쉬운 말로 설명하는 문장이에요.',
    recommended_answer: '추천하는 기본 답이에요.',
    info_gain_estimate: 'high' as const,
  };
  const dimension = {
    id: 'd1',
    critical: false,
    state: 'partial' as const,
    ambiguity: 0.5,
    notes: '',
  };

  test('rejects a question surfacing a glossary forbidden_abbreviation un-glossed', async () => {
    const { repo, wiId } = await makeRepo(['zqx']);
    try {
      await expect(
        recordTurn(repo, { workItemId: wiId, payload: { dimension, question } }),
      ).rejects.toThrow();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('does NOT reject the same question when no glossary is present (flag is glossary-sourced)', async () => {
    const { repo, wiId } = await makeRepo(null);
    try {
      const state = await recordTurn(repo, { workItemId: wiId, payload: { dimension, question } });
      expect(state.questions.length).toBe(1);
      expect(await new InterviewStore(repo).exists(wiId)).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

// The glossary loader (wi_260714aaq, #29): the fail-open READ that resolves the injected vocab.
// Shaped like loadFarFieldTaxonomy — missing → [], malformed → warn + [] (no silent
// zero-signal), version-skew tolerant, and the aliases/terms field contract preserved.
describe('loadGlossaryVocab (ac-1 source / ac-2 field-contract / edge fail-open)', () => {
  async function writeGlossary(body: unknown): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), 'ditto-gloss-'));
    await mkdir(join(repo, '.ditto', 'knowledge'), { recursive: true });
    await writeFile(
      join(repo, '.ditto', 'knowledge', 'glossary.json'),
      typeof body === 'string' ? body : JSON.stringify(body),
    );
    return repo;
  }

  test('reads non-empty forbidden_abbreviations from a real glossary (consumer source, not inline)', async () => {
    const repo = await writeGlossary({
      schema_version: '0.1.0',
      project_name: 't',
      updated_at: '2026-07-14T00:00:00+09:00',
      entries: [
        { term: 'work item', aliases: [], definition: 'd', forbidden_abbreviations: ['wi'] },
        { term: 'x', aliases: [], definition: 'd', forbidden_abbreviations: [] },
      ],
    });
    try {
      expect(await loadGlossaryVocab(repo)).toEqual(['wi']);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  // Field contract (coverage OBJ-1): aliases and terms are NOT vocab — a glossary whose
  // entries carry only aliases (event/source/projection/stem) yields [].
  test('excludes aliases and terms — a glossary with aliases but empty forbidden_abbreviations yields []', async () => {
    const repo = await writeGlossary({
      schema_version: '0.1.0',
      project_name: 't',
      updated_at: '2026-07-14T00:00:00+09:00',
      entries: [
        {
          term: 'memory event',
          aliases: ['event', 'source', 'projection', 'stem'],
          definition: 'd',
          forbidden_abbreviations: [],
        },
      ],
    });
    try {
      expect(await loadGlossaryVocab(repo)).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('missing glossary → [] (floor only), no throw', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ditto-gloss-'));
    try {
      expect(await loadGlossaryVocab(repo)).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('malformed glossary → onMalformed called + [], no throw (no silent zero-signal fail-open)', async () => {
    const repo = await writeGlossary('{ this is not valid json');
    try {
      let warned = false;
      const vocab = await loadGlossaryVocab(repo, () => {
        warned = true;
      });
      expect(vocab).toEqual([]);
      expect(warned).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('schema-version-skewed glossary still yields its forbidden_abbreviations (tolerant read)', async () => {
    const repo = await writeGlossary({
      schema_version: '9.9.9',
      project_name: 't',
      updated_at: '2026-07-14T00:00:00+09:00',
      some_future_field: true,
      entries: [{ term: 'a', aliases: [], definition: 'd', forbidden_abbreviations: ['zzz'] }],
    });
    try {
      expect(await loadGlossaryVocab(repo)).toEqual(['zzz']);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
