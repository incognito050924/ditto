import { describe, expect, test } from 'bun:test';
import { checkStepConformance } from '~/core/e2e/conformance';

/**
 * ac-3: every DSL step (journey + used blocks) must be traceable to a
 * `// @step <owner-id>/<step-id>` marker in the generated spec (or its
 * imported support helpers); a missing correspondence is a FAILURE, not a
 * warning.
 */

const JOURNEY = `---
ditto_journey: v2
id: jrn-login-basic
name: 기본 로그인
description: 등록 사용자가 로그인할 수 있다.
surfaces:
  - page:/login
implementation_intent: 등록 사용자가 로그인하면 대시보드로 이동한다.
uses_blocks:
  - blk-login
flaky_history: []
---

1. [s1] 블록: blk-login (user=user@example.com, password=secret123)
2. [s2] 확인: url contains /dashboard
`;

const BLOCK = `---
ditto_block: v2
id: blk-login
name: 로그인
params:
  - user
  - password
---

1. [b1] 방문: /login
2. [b2] 클릭: "로그인" 버튼
`;

const GENERATED_OK = `/**
 * @ditto-generated
 */
import { test, expect } from '@playwright/test';
import { blkLogin } from './support/blk-login.block';

test('jrn-login-basic', async ({ page }) => {
  // @step jrn-login-basic/s1 블록: blk-login (user=user@example.com, password=secret123)
  await blkLogin(page, { user: 'user@example.com', password: 'secret123' });
  // @step jrn-login-basic/s2 확인: url contains /dashboard
  await expect(page).toHaveURL(/\\/dashboard/);
});
`;

const SUPPORT_OK = `/**
 * @ditto-generated
 */
export async function blkLogin(page, params) {
  // @step blk-login/b1 방문: /login
  await page.goto('/login');
  // @step blk-login/b2 클릭: "로그인" 버튼
  await page.getByRole('button', { name: '로그인' }).click();
}
`;

describe('checkStepConformance (ac-3)', () => {
  test('all journey + block steps covered by markers → ok with full required/found sets', () => {
    const report = checkStepConformance({
      journeyText: JOURNEY,
      blockTexts: { 'blk-login': BLOCK },
      generatedText: GENERATED_OK,
      supportTexts: [SUPPORT_OK],
    });
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.required).toEqual([
      'jrn-login-basic/s1',
      'jrn-login-basic/s2',
      'blk-login/b1',
      'blk-login/b2',
    ]);
  });

  test('a step without a marker is reported missing and fails the check', () => {
    const generatedMissingS2 = GENERATED_OK.replace(
      '  // @step jrn-login-basic/s2 확인: url contains /dashboard\n',
      '',
    );
    const report = checkStepConformance({
      journeyText: JOURNEY,
      blockTexts: { 'blk-login': BLOCK },
      generatedText: generatedMissingS2,
      supportTexts: [SUPPORT_OK],
    });
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(['jrn-login-basic/s2']);
  });

  test('a block step without a marker in the support helper fails the check', () => {
    const supportMissingB2 = SUPPORT_OK.replace(
      '  // @step blk-login/b2 클릭: "로그인" 버튼\n',
      '',
    );
    const report = checkStepConformance({
      journeyText: JOURNEY,
      blockTexts: { 'blk-login': BLOCK },
      generatedText: GENERATED_OK,
      supportTexts: [supportMissingB2],
    });
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(['blk-login/b2']);
  });

  test('uses_blocks declares a block with no provided file → error, not silent pass', () => {
    const report = checkStepConformance({
      journeyText: JOURNEY,
      blockTexts: {},
      generatedText: GENERATED_OK,
      supportTexts: [SUPPORT_OK],
    });
    expect(report.ok).toBe(false);
    expect(report.errors.join('\n')).toContain('blk-login');
  });

  test('journey body with zero step ids → failure, never a vacuous pass', () => {
    const journeyNoSteps = JOURNEY.split('\n')
      .filter((line) => !/^\d+\.\s+\[s\d+\]/.test(line))
      .join('\n');
    const report = checkStepConformance({
      journeyText: journeyNoSteps,
      blockTexts: { 'blk-login': BLOCK },
      generatedText: GENERATED_OK,
      supportTexts: [SUPPORT_OK],
    });
    expect(report.ok).toBe(false);
    expect(report.errors.join('\n')).toContain('step id');
  });

  test('referenced block with zero step ids → failure, never a vacuous pass', () => {
    const blockNoSteps = BLOCK.split('\n')
      .filter((line) => !/^\d+\.\s+\[b\d+\]/.test(line))
      .join('\n');
    const report = checkStepConformance({
      journeyText: JOURNEY,
      blockTexts: { 'blk-login': blockNoSteps },
      generatedText: GENERATED_OK,
      supportTexts: [SUPPORT_OK],
    });
    expect(report.ok).toBe(false);
    expect(report.errors.join('\n')).toContain('blk-login');
    expect(report.errors.join('\n')).toContain('step id');
  });

  test('unparsable journey → error (front-matter problem surfaces, no fabricated pass)', () => {
    const report = checkStepConformance({
      journeyText: 'no front matter here',
      blockTexts: {},
      generatedText: GENERATED_OK,
      supportTexts: [],
    });
    expect(report.ok).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);
  });

  test('block front-matter id ≠ uses_blocks 참조 키 → error (O-6: id↔파일명 드리프트)', () => {
    const renamedBlock = BLOCK.replace('id: blk-login', 'id: blk-signin');
    const report = checkStepConformance({
      journeyText: JOURNEY,
      blockTexts: { 'blk-login': renamedBlock },
      generatedText: GENERATED_OK,
      supportTexts: [SUPPORT_OK.replaceAll('blk-login/', 'blk-signin/')],
    });
    expect(report.ok).toBe(false);
    expect(report.errors.join('\n')).toContain('blk-signin');
  });

  test('body 블록: 호출이 uses_blocks에 없으면 error (O-14: 선언 드리프트)', () => {
    const journeyExtraCall = JOURNEY.replace(
      '2. [s2] 확인: url contains /dashboard',
      '2. [s2] 블록: blk-logout ()\n3. [s3] 확인: url contains /dashboard',
    );
    const generated = GENERATED_OK.replace(
      '  // @step jrn-login-basic/s2 확인: url contains /dashboard',
      '  // @step jrn-login-basic/s2 블록: blk-logout ()\n  // @step jrn-login-basic/s3 확인: url contains /dashboard',
    );
    const report = checkStepConformance({
      journeyText: journeyExtraCall,
      blockTexts: { 'blk-login': BLOCK },
      generatedText: generated,
      supportTexts: [SUPPORT_OK],
    });
    expect(report.ok).toBe(false);
    expect(report.errors.join('\n')).toContain('blk-logout');
    expect(report.errors.join('\n')).toContain('uses_blocks');
  });

  test('## 케이스 선언 케이스가 생성 spec에 없으면 error (O-13: 케이스 누락 게이트)', () => {
    const journeyWithCases = `${JOURNEY}\n## 케이스\n\n| 케이스 | user | 유형 |\n|---|---|---|\n| 정상 로그인 | user@example.com | 성공 |\n| 잠긴 계정 | locked@example.com | 실패 |\n`;
    const generatedOneCase = GENERATED_OK.replace(
      "test('jrn-login-basic'",
      "test('jrn-login-basic · 정상 로그인'",
    );
    const report = checkStepConformance({
      journeyText: journeyWithCases,
      blockTexts: { 'blk-login': BLOCK },
      generatedText: generatedOneCase,
      supportTexts: [SUPPORT_OK],
    });
    expect(report.ok).toBe(false);
    expect(report.errors.join('\n')).toContain('잠긴 계정');

    const generatedBothCases = generatedOneCase.replace(
      "import { blkLogin } from './support/blk-login.block';",
      "import { blkLogin } from './support/blk-login.block';\n// case: 잠긴 계정",
    );
    const ok = checkStepConformance({
      journeyText: journeyWithCases,
      blockTexts: { 'blk-login': BLOCK },
      generatedText: generatedBothCases,
      supportTexts: [SUPPORT_OK],
    });
    expect(ok.ok).toBe(true);
  });
});
