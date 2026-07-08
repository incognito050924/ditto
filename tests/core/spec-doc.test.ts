import { describe, expect, test } from 'bun:test';
import { compileSpecDoc, computeSpecDigest } from '~/core/spec-doc';

/** Minimal valid spec doc following the 13-section spec template titles. */
function specDoc(overrides: Partial<Record<string, string>> = {}): string {
  const ac =
    overrides.ac ??
    `| id | 완료 조건 (관찰가능 술어) | evidence |
|---|---|---|
| ac-1 | 호출 시 200과 score 0-100을 반환한다 | test |
| ac-2 | 잘못된 입력은 422로 거부된다 | test |`;
  return `# 데모 — 스펙 문서

> 소비자: DITTO(design → implement → verify) + 사람.

## 1. 기능

- 이름: 데모

## 2. 요약

${overrides.summary ?? '비밀번호 강도 점수 API를 추가한다.'}

## 3. 배경 [장]

기존 회원가입에 강도 검증이 없다.

## 4. 목표

${overrides.goals ?? '- 점수 API 제공\n- 가입 폼 연동'}

## 5. 비목표 (변경 경계) [장]

${overrides.nonGoals ?? '- 비밀번호 정책 변경은 하지 않는다'}

## 6. 완료 조건 (Acceptance Criteria)

${ac}

## 7. 위험 / Pre-mortem

| 위험 | 처리 | 플래그 |
|---|---|---|
| 사전 기반 공격 강도 미달 | unknown — 측정 후 결정 | — |

## 8. 계획 (Plan) [단]

> ⚠ 비구속(non-binding) 설계 힌트.

${overrides.plan ?? '엔드포인트 모양 힌트.'}

## 9. 영향도 · 의존성

signup 폼.

## 10. 기각된 대안 [장]

없음.

## 11. 마일스톤 [단]

미정.

## 12. 인터뷰 기록

없음.

## 13. 빌드 후 처리

승격 예정.
`;
}

describe('compileSpecDoc', () => {
  test('compiles a valid doc into intent fields with a digest', () => {
    const res = compileSpecDoc(specDoc());
    if (res.status !== 'compiled') throw new Error(res.reasons.join('; '));
    expect(res.fields.goal).toBe('비밀번호 강도 점수 API를 추가한다.');
    expect(res.fields.in_scope).toEqual(['점수 API 제공', '가입 폼 연동']);
    expect(res.fields.out_of_scope).toEqual(['비밀번호 정책 변경은 하지 않는다']);
    expect(res.fields.acceptance_criteria).toEqual([
      {
        id: 'ac-1',
        statement: '호출 시 200과 score 0-100을 반환한다',
        verdict: 'unverified',
        evidence: [],
        evidence_required: ['test'],
      },
      {
        id: 'ac-2',
        statement: '잘못된 입력은 422로 거부된다',
        verdict: 'unverified',
        evidence: [],
        evidence_required: ['test'],
      },
    ]);
    // 위험 표에서 처리=unknown 으로 표시된 행은 unknowns로 수집된다
    expect(res.fields.unknowns).toEqual(['사전 기반 공격 강도 미달']);
    expect(res.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('rejects when a required compile-input section is missing (fail-closed, with location)', () => {
    const doc = specDoc().replace(/## 5\. 비목표[^\n]*\n\n[^\n]+\n/, '');
    const res = compileSpecDoc(doc);
    expect(res.status).toBe('rejected');
    if (res.status === 'rejected') {
      expect(res.reasons.join('\n')).toContain('비목표');
    }
  });

  test('rejects duplicate AC ids', () => {
    const res = compileSpecDoc(
      specDoc({
        ac: `| id | 완료 조건 | evidence |
|---|---|---|
| ac-1 | 호출 시 200을 반환한다 | test |
| ac-1 | 잘못된 입력은 422로 거부된다 | test |`,
      }),
    );
    expect(res.status).toBe('rejected');
    if (res.status === 'rejected') {
      expect(res.reasons.join('\n')).toContain('ac-1');
    }
  });

  test('rejects an AC row whose evidence kind is not in the enum', () => {
    const res = compileSpecDoc(
      specDoc({
        ac: `| id | 완료 조건 | evidence |
|---|---|---|
| ac-1 | 호출 시 200을 반환한다 | vibes |`,
      }),
    );
    expect(res.status).toBe('rejected');
    if (res.status === 'rejected') {
      expect(res.reasons.join('\n')).toContain('vibes');
    }
  });

  test('rejects when the AC table has no rows', () => {
    const res = compileSpecDoc(specDoc({ ac: '(작성 예정)' }));
    expect(res.status).toBe('rejected');
  });

  test('rejects a duplicated compile-input section (ambiguous source)', () => {
    const doc = `${specDoc()}\n## 4. 목표\n\n- 중복 섹션\n`;
    const res = compileSpecDoc(doc);
    expect(res.status).toBe('rejected');
    if (res.status === 'rejected') {
      expect(res.reasons.join('\n')).toContain('목표');
    }
  });
});

describe('computeSpecDigest (해시 범위 = 컴파일 입력 섹션: 요약·목표·비목표·AC·위험)', () => {
  test('editing a non-compile-input section (계획) does not change the digest', () => {
    const a = computeSpecDigest(specDoc());
    const b = computeSpecDigest(specDoc({ plan: '완전히 다른 설계 힌트로 교체.' }));
    expect(a).toBe(b);
  });

  test('editing a compile-input section (목표) changes the digest', () => {
    const a = computeSpecDigest(specDoc());
    const b = computeSpecDigest(specDoc({ goals: '- 다른 목표' }));
    expect(a).not.toBe(b);
  });

  test('line endings and trailing whitespace are normalized', () => {
    const doc = specDoc();
    const noisy = doc.replace(/\n/g, '\r\n').replace(/점수 API 제공/, '점수 API 제공   ');
    expect(computeSpecDigest(noisy)).toBe(computeSpecDigest(doc));
  });
});
