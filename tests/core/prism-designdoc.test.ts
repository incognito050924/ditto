import { describe, expect, test } from 'bun:test';
import { type DesignDocInput, emitDesignDoc, renderDesignDoc } from '~/core/prism/designdoc';
import { parseSpecSections } from '~/core/spec-doc';

const REPO_ROOT = '/tmp/prism-designdoc-fixture';
const OK_PATH = '.ditto/specs/wi_demo-design.md';

/** A fully valid design-doc input; each test overrides only the field under test. */
function baseInput(o: Partial<DesignDocInput> = {}): DesignDocInput {
  return {
    feature: o.feature ?? '데모 기능',
    summary: o.summary ?? '비밀번호 강도 점수 API를 추가한다.',
    goals: o.goals ?? ['점수 API 제공', '가입 폼 연동'],
    nonGoals: o.nonGoals ?? ['비밀번호 정책 변경은 하지 않는다'],
    acceptanceCriteria: o.acceptanceCriteria ?? [
      { id: 'ac-1', statement: '호출 시 200과 score 0-100을 반환한다', evidence: 'test' },
    ],
    risks: o.risks ?? [{ risk: '사전 기반 공격', handling: 'unknown — 측정 후 결정', flag: '—' }],
    background: o.background ?? [
      { claim: '기존 회원가입에 강도 검증이 없다', grounding: 'src/core/signup.ts:42' },
    ],
    impact: o.impact ?? [
      { claim: 'signup 폼이 영향받는다', grounding: 'src/ui/signup-form.tsx:20' },
    ],
    interviewSummary:
      o.interviewSummary ?? '강도 기준을 인터뷰로 확정 (요약; 링크: memevt_abc123).',
  };
}

const OPTS = { targetPath: OK_PATH, repoRoot: REPO_ROOT };

describe('prism design-doc — grounding fail-closed + digest binding (ac-5/ac-6)', () => {
  // (a) ac-5: 근거 없는 사실 주장 → 확정 거부 (fail-closed)
  test('(a) 배경 절의 근거 없는 사실 주장은 확정을 거부한다', () => {
    const r = emitDesignDoc(baseInput({ background: [{ claim: '기존 검증이 없다' }] }), OPTS);
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') expect(r.reasons.join(' ')).toContain('근거');
  });

  test('(a2) 근거가 붙은 사실 주장은 통과한다', () => {
    const r = emitDesignDoc(
      baseInput({ background: [{ claim: '검증 없음', grounding: 'src/core/signup.ts:42' }] }),
      OPTS,
    );
    expect(r.status).toBe('emitted');
  });

  // (b) ac-6: compile-input 절 수정 시 digest 변화
  test('(b) compile-input 절(요약) 수정 시 digest가 바뀐다', () => {
    const a = emitDesignDoc(baseInput({ summary: '요약 A' }), OPTS);
    const b = emitDesignDoc(baseInput({ summary: '요약 B' }), OPTS);
    expect(a.status).toBe('emitted');
    expect(b.status).toBe('emitted');
    if (a.status === 'emitted' && b.status === 'emitted') expect(a.digest).not.toBe(b.digest);
  });

  test('(b2) 비-compile-input 절(배경) 수정은 digest를 바꾸지 않는다', () => {
    const a = emitDesignDoc(baseInput({ background: [{ claim: 'X', grounding: 'a.ts:1' }] }), OPTS);
    const b = emitDesignDoc(
      baseInput({ background: [{ claim: 'Y 완전히 다른 배경 문장', grounding: 'b.ts:2' }] }),
      OPTS,
    );
    expect(a.status).toBe('emitted');
    expect(b.status).toBe('emitted');
    if (a.status === 'emitted' && b.status === 'emitted') expect(a.digest).toBe(b.digest);
  });

  // (c) DI-1: 코드펜스 속 "## "가 절 경계를 하이재킹하지 않는다
  test('(c) 코드펜스 속 "## " heading은 절 경계로 인식되지 않는다', () => {
    const md = [
      '## 요약',
      '실제 요약 본문',
      '',
      '```md',
      '## 위험',
      '펜스 안 가짜 위험 텍스트',
      '```',
      '',
      '## 위험',
      '실제 위험 내용',
      '',
    ].join('\n');
    const { sections } = parseSpecSections(md);
    // 펜스 안 "## 위험"은 요약 본문에 그대로 남아야 한다 (절 경계 하이재킹 금지)
    expect(sections.get('summary')).toContain('## 위험');
    expect(sections.get('summary')).toContain('펜스 안 가짜 위험 텍스트');
    // 진짜 위험 절만 위험으로 인식
    expect(sections.get('risks')).toBe('실제 위험 내용');
  });

  // (d) V-1: containment — repo 밖(../) 경로 거부
  test('(d) repo 밖(../) 경로는 containment로 거부된다', () => {
    const r = emitDesignDoc(baseInput(), { targetPath: '../evil.md', repoRoot: REPO_ROOT });
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected')
      expect(r.reasons.join(' ')).toMatch(/경로|contain|escap|parent|절대/i);
  });

  // (e) scrub: 원문 전사(코드블록) 대신 요약+링크
  test('(e) 사실 절의 원문 전사(코드블록)는 거부된다 — 요약+링크만 허용', () => {
    const r = emitDesignDoc(
      baseInput({
        background: [
          {
            claim: '설정은 다음과 같다:\n```\nSECRET=abc\nconst x = 1\n```',
            grounding: 'config.ts:1',
          },
        ],
      }),
      OPTS,
    );
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') expect(r.reasons.join(' ')).toMatch(/전사|요약|링크/);
  });

  test('(e2) 요약+링크로 표현된 사실 주장은 통과한다', () => {
    const r = emitDesignDoc(
      baseInput({
        background: [{ claim: '설정 키 3개 사용 (요약)', grounding: 'src/config.ts:12' }],
      }),
      OPTS,
    );
    expect(r.status).toBe('emitted');
  });

  // (f) 미달 방출은 명시 플래그로만 + 미해결 항목 표기
  test('(f) 근거 미달 방출은 명시 플래그로만 가능하며 미해결 항목을 표기한다', () => {
    const input = baseInput({ background: [{ claim: '근거 없는 사실 주장' }] });
    const blocked = emitDesignDoc(input, OPTS);
    expect(blocked.status).toBe('rejected');

    const forced = emitDesignDoc(input, { ...OPTS, allowUngrounded: true });
    expect(forced.status).toBe('emitted');
    if (forced.status === 'emitted') {
      expect(forced.unresolved.length).toBeGreaterThan(0);
      expect(forced.markdown).toMatch(/미해결|근거 없음/);
    }
  });

  // scrub 재사용: 방출 전 남은 토큰형 시크릿 스크럽
  test('방출 전 남은 토큰형 시크릿은 스크럽된다', () => {
    const secret = `ghp_${'a'.repeat(30)}`;
    const r = emitDesignDoc(baseInput({ summary: `요약 본문 ${secret} 참조` }), OPTS);
    expect(r.status).toBe('emitted');
    if (r.status === 'emitted') {
      expect(r.markdown).not.toContain(secret);
      expect(r.markdown).toContain('[redacted]');
    }
  });

  // ac-6: 렌더 제목은 SPEC_SECTIONS에서 끌어와야 하고, 결과는 동형 문서로 파싱된다
  test('렌더된 문서는 SPEC_SECTIONS 형식으로 파싱되고 digest가 결박된다', () => {
    const md = renderDesignDoc(baseInput());
    const { sections } = parseSpecSections(md);
    expect(sections.get('summary')).toContain('비밀번호 강도 점수 API');
    expect(sections.has('goals')).toBe(true);
    expect(sections.has('non-goals')).toBe(true);
    expect(sections.has('acceptance-criteria')).toBe(true);
    expect(sections.has('risks')).toBe(true);
  });
});
