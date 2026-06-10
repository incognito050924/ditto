import { describe, expect, test } from 'bun:test';
import {
  extractStepIds,
  extractStepMarkers,
  parseBlockDoc,
  parseJourneyDoc,
} from '~/core/e2e/journey-dsl';

const journeyDoc = `---
ditto_journey: v1
id: jrn-checkout-coupon
name: 쿠폰 적용 결제
description: 쿠폰을 적용해 결제가 완료되는 핵심 가치 경로
surfaces:
  - "page:/checkout"
  - "api:POST /api/orders"
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
ditto_block: v1
id: login-as-user
name: 사용자로 로그인
params:
  - email
---

1. [b1] 이동: /login
2. [b2] 입력: {email}
`;

describe('parseJourneyDoc', () => {
  test('parses front-matter through the zod schema and extracts step ids', () => {
    const out = parseJourneyDoc(journeyDoc);
    if (!out.ok) throw new Error(out.error);
    expect(out.frontMatter.id).toBe('jrn-checkout-coupon');
    expect(out.frontMatter.surfaces).toEqual(['page:/checkout', 'api:POST /api/orders']);
    expect(out.frontMatter.uses_blocks).toEqual(['login-as-user']);
    expect(out.frontMatter.flaky_history[0]?.note).toBe('CI only');
    expect(out.stepIds).toEqual(['s1', 's2', 's3']);
  });

  test('fails on a document without front-matter fences', () => {
    const out = parseJourneyDoc('# just markdown\n\n1. [s1] 이동: /checkout\n');
    expect(out.ok).toBe(false);
  });

  test('fails on front-matter that violates the schema (bad id)', () => {
    const bad = journeyDoc.replace('id: jrn-checkout-coupon', 'id: checkout');
    const out = parseJourneyDoc(bad);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('id');
  });

  test('fails when a block document is fed as a journey', () => {
    expect(parseJourneyDoc(blockDoc).ok).toBe(false);
  });
});

describe('parseBlockDoc', () => {
  test('parses block front-matter and extracts [bN] step ids', () => {
    const out = parseBlockDoc(blockDoc);
    if (!out.ok) throw new Error(out.error);
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
