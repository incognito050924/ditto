import { describe, expect, test } from 'bun:test';
import {
  extractBlockCalls,
  extractCaseNames,
  extractStepIds,
  extractStepMarkers,
  parseBlockDoc,
  parseJourneyDoc,
} from '~/core/e2e/journey-dsl';

const journeyDoc = `---
ditto_journey: v2
id: jrn-checkout-coupon
name: 쿠폰 적용 결제
description: 쿠폰을 적용해 결제가 완료되는 핵심 가치 경로
surfaces:
  - "page:/checkout"
  - "api:POST /api/orders"
implementation_intent: 로그인 사용자가 유효 쿠폰으로 할인 결제를 완료한다
constraints:
  - 쿠폰은 1회만 적용
edge_cases:
  - case: 만료 쿠폰
    handling: 만료 안내 후 원가 결제 허용
failure_states:
  - trigger: 재고 없음
    expected: 품절 오류 노출
secret_vars:
  - coupon_code
auth:
  credentials:
    admin: "env:ADMIN_PASSWORD"
  login_block: login-as-user
  storage_state: "e2e/.auth/admin.json"
initial_state:
  description: 카트에 상품 1개
seed:
  spec_ref: "e2e/seed.spec.ts"
  data_ref: "env:SEED_DATA"
uses_blocks:
  - login-as-user
flaky_history:
  - date: "2026-06-01"
    case: coupon apply timeout
    note: CI only
---

# 쿠폰 적용 결제

1. [s1] 이동: /checkout
2. [s2] (쿠폰이 있으면) 입력: 쿠폰 코드 WELCOME10
3. [s3] 클릭: 결제하기 버튼
`;

const blockDoc = `---
ditto_block: v2
id: login-as-user
name: 사용자로 로그인
params:
  - email
---

1. [b1] 이동: /login
2. [b2] 입력: {email}
`;

describe('parseJourneyDoc (v2)', () => {
  test('parses rich v2 front-matter through the zod schema and extracts step ids', () => {
    const out = parseJourneyDoc(journeyDoc);
    if (!out.ok) throw new Error(out.error);
    expect(out.frontMatter.ditto_journey).toBe('v2');
    expect(out.frontMatter.id).toBe('jrn-checkout-coupon');
    expect(out.frontMatter.surfaces).toEqual(['page:/checkout', 'api:POST /api/orders']);
    expect(out.frontMatter.implementation_intent).toBe(
      '로그인 사용자가 유효 쿠폰으로 할인 결제를 완료한다',
    );
    expect(out.frontMatter.edge_cases[0]?.handling).toBe('만료 안내 후 원가 결제 허용');
    expect(out.frontMatter.failure_states[0]?.trigger).toBe('재고 없음');
    expect(out.frontMatter.auth?.credentials.admin).toBe('env:ADMIN_PASSWORD');
    expect(out.frontMatter.seed?.data_ref).toBe('env:SEED_DATA');
    expect(out.frontMatter.uses_blocks).toEqual(['login-as-user']);
    expect(out.frontMatter.flaky_history[0]?.note).toBe('CI only');
    // structural extraction on a v2 body still returns the [sN] ids
    expect(out.stepIds).toEqual(['s1', 's2', 's3']);
  });

  test('fails on a document without front-matter fences', () => {
    const out = parseJourneyDoc('# just markdown\n\n1. [s1] 이동: /checkout\n');
    expect(out.ok).toBe(false);
  });

  test('fails on a v1 front-matter (clean break, no auto-migration)', () => {
    const v1 = journeyDoc.replace('ditto_journey: v2', 'ditto_journey: v1');
    expect(parseJourneyDoc(v1).ok).toBe(false);
  });

  test('fails on front-matter that violates the schema (bad id)', () => {
    const bad = journeyDoc.replace('id: jrn-checkout-coupon', 'id: checkout');
    const out = parseJourneyDoc(bad);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('id');
  });

  test('fails on a literal credential in the front-matter (envRef)', () => {
    const bad = journeyDoc.replace('admin: "env:ADMIN_PASSWORD"', 'admin: "a@b.com"');
    expect(parseJourneyDoc(bad).ok).toBe(false);
  });

  test('fails when a block document is fed as a journey', () => {
    expect(parseJourneyDoc(blockDoc).ok).toBe(false);
  });

  test('duplicate step ids are a parse failure (O-5: 추적성이 조용히 합쳐지지 않게)', () => {
    const dup = journeyDoc.replace('2. [s2]', '2. [s1]');
    const out = parseJourneyDoc(dup);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('s1');
  });
});

describe('extractBlockCalls (O-14: body 블록 호출 추출)', () => {
  test('블록: 호출의 블록 id를 조건 유무와 무관하게 추출한다', () => {
    const body = [
      '1. [s1] 블록: blk-login (user=a@b.c, password=x)',
      '2. [s2] (coupon 있음) 블록: blk-apply-coupon (code={coupon})',
      '3. [s3] 클릭: "결제" 버튼',
      '본문에서 블록: blk-prose 를 언급해도 step 줄이 아니면 무시',
    ].join('\n');
    expect(extractBlockCalls(body)).toEqual(['blk-login', 'blk-apply-coupon']);
  });
});

describe('extractCaseNames (O-13: ## 케이스 테이블 파싱)', () => {
  test('케이스 테이블의 첫 열(케이스 이름)을 순서대로 추출한다', () => {
    const body = [
      '1. [s1] 방문: /checkout',
      '',
      '## 케이스',
      '',
      '| 케이스 | coupon | 유형 |',
      '|---|---|---|',
      '| 유효 쿠폰 | WELCOME10 | 성공 |',
      '| 만료 쿠폰 | EXPIRED99 | 실패 |',
      '',
      '## 다른 섹션',
      '| 표지만 비슷한 표 | x |',
    ].join('\n');
    expect(extractCaseNames(body)).toEqual(['유효 쿠폰', '만료 쿠폰']);
  });

  test('케이스 섹션이 없으면 빈 목록', () => {
    expect(extractCaseNames('1. [s1] 방문: /\n')).toEqual([]);
  });
});

describe('parseBlockDoc (v2)', () => {
  test('parses v2 block front-matter and extracts [bN] step ids', () => {
    const out = parseBlockDoc(blockDoc);
    if (!out.ok) throw new Error(out.error);
    expect(out.frontMatter.ditto_block).toBe('v2');
    expect(out.frontMatter.id).toBe('login-as-user');
    expect(out.frontMatter.params).toEqual(['email']);
    expect(out.stepIds).toEqual(['b1', 'b2']);
  });
});

describe('extractStepIds', () => {
  test('matches only "N. [sN|bN]" lines, not prose mentioning ids', () => {
    const body = [
      '1. [s1] 이동: /checkout',
      '본문에서 [s9] 를 언급해도 step이 아니다',
      '  2. [s2] 클릭: 결제',
      '- [s3] 리스트 불릿은 step 줄이 아니다',
      '3. [b1] 블록 step 모양도 잡힌다',
    ].join('\n');
    expect(extractStepIds(body)).toEqual(['s1', 's2', 'b1']);
  });
});

describe('extractStepMarkers (generated spec side)', () => {
  test('extracts "<owner-id>/<step-id>" refs from // @step markers', () => {
    const generated = [
      "test('checkout', async () => {",
      '  // @step jrn-checkout-coupon/s1 이동: /checkout',
      "  await page.goto('/checkout');",
      '  // @step login-as-user/b1 이동: /login',
      '  // not a marker: @step without comment slashes',
      '});',
    ].join('\n');
    expect(extractStepMarkers(generated)).toEqual(['jrn-checkout-coupon/s1', 'login-as-user/b1']);
  });
});
