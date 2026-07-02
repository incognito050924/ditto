import { describe, expect, test } from 'bun:test';
import { blockFrontMatter, journeyFrontMatter } from '~/schemas/journey-dsl';

const minimalJourney = () => ({
  ditto_journey: 'v2',
  id: 'jrn-checkout-coupon',
  name: '쿠폰 적용 결제',
  description: '쿠폰을 적용해 결제가 완료되는 핵심 가치 경로',
  surfaces: ['page:/checkout', 'api:POST /api/orders', 'component:src/components/Coupon*.tsx'],
  implementation_intent: '로그인 사용자가 유효 쿠폰으로 할인 결제를 완료한다',
});

const richJourney = () => ({
  ...minimalJourney(),
  constraints: ['쿠폰은 1회만 적용', '만료 쿠폰은 거부'],
  edge_cases: [{ case: '만료 쿠폰', handling: '만료 안내 후 원가 결제 허용' }],
  failure_states: [{ trigger: '재고 없음', expected: '품절 오류 노출' }],
  secret_vars: ['coupon_code'],
  auth: {
    credentials: { admin: 'env:ADMIN_PASSWORD', user: 'secret:USER_TOKEN' },
    login_block: 'login-as-user',
    storage_state: 'e2e/.auth/admin.json',
  },
  initial_state: { description: '카트에 상품 1개', setup_ref: 'e2e/fixtures/cart.ts' },
  seed: { spec_ref: 'e2e/seed.spec.ts', data_ref: 'env:SEED_DATA' },
  uses_blocks: ['login-as-user'],
  flaky_history: [{ date: '2026-06-01', case: 'coupon apply timeout', note: 'CI only' }],
});

describe('journeyFrontMatter (DSL v2)', () => {
  test('parses a rich v2 journey (all rich-context + auth/seed/initial_state)', () => {
    const parsed = journeyFrontMatter.parse(richJourney());
    expect(parsed.ditto_journey).toBe('v2');
    expect(parsed.implementation_intent).toBe('로그인 사용자가 유효 쿠폰으로 할인 결제를 완료한다');
    expect(parsed.constraints).toEqual(['쿠폰은 1회만 적용', '만료 쿠폰은 거부']);
    expect(parsed.edge_cases[0]).toEqual({
      case: '만료 쿠폰',
      handling: '만료 안내 후 원가 결제 허용',
    });
    expect(parsed.failure_states[0]).toEqual({ trigger: '재고 없음', expected: '품절 오류 노출' });
    expect(parsed.secret_vars).toEqual(['coupon_code']);
    expect(parsed.auth?.credentials.admin).toBe('env:ADMIN_PASSWORD');
    expect(parsed.auth?.credentials.user).toBe('secret:USER_TOKEN');
    expect(parsed.initial_state?.description).toBe('카트에 상품 1개');
    expect(parsed.seed?.spec_ref).toBe('e2e/seed.spec.ts');
    expect(parsed.seed?.data_ref).toBe('env:SEED_DATA');
  });

  test('applies rich-context defaults on a minimal v2 journey', () => {
    const parsed = journeyFrontMatter.parse(minimalJourney());
    expect(parsed.constraints).toEqual([]);
    expect(parsed.edge_cases).toEqual([]);
    expect(parsed.failure_states).toEqual([]);
    expect(parsed.secret_vars).toEqual([]);
    expect(parsed.uses_blocks).toEqual([]);
    expect(parsed.flaky_history).toEqual([]);
    expect(parsed.auth).toBeUndefined();
    expect(parsed.initial_state).toBeUndefined();
    expect(parsed.seed).toBeUndefined();
  });

  test('defaults seed.spec_ref when seed present without it', () => {
    const parsed = journeyFrontMatter.parse({ ...minimalJourney(), seed: {} });
    expect(parsed.seed?.spec_ref).toBe('e2e/seed.spec.ts');
  });

  test('rejects a v1 marker (clean break, no back-compat)', () => {
    expect(journeyFrontMatter.safeParse({ ...minimalJourney(), ditto_journey: 'v1' }).success).toBe(
      false,
    );
  });

  test('rejects a missing implementation_intent (required)', () => {
    const { implementation_intent: _drop, ...rest } = minimalJourney();
    expect(journeyFrontMatter.safeParse(rest).success).toBe(false);
  });

  test('rejects a literal credential (envRef requires env:/secret:)', () => {
    expect(
      journeyFrontMatter.safeParse({
        ...minimalJourney(),
        auth: { credentials: { user: 'a@b.com' } },
      }).success,
    ).toBe(false);
  });

  test('rejects an unknown/extra front-matter field (.strict())', () => {
    expect(journeyFrontMatter.safeParse({ ...minimalJourney(), bogus_field: 'x' }).success).toBe(
      false,
    );
  });

  test('rejects a mistyped field (constraints must be an array)', () => {
    expect(
      journeyFrontMatter.safeParse({ ...minimalJourney(), constraints: 'not-an-array' }).success,
    ).toBe(false);
  });

  test('rejects an unknown key inside a nested edge_case (.strict())', () => {
    expect(
      journeyFrontMatter.safeParse({
        ...minimalJourney(),
        edge_cases: [{ case: '만료', handling: '안내', bogus: 1 }],
      }).success,
    ).toBe(false);
  });

  test('rejects an id without the jrn- prefix', () => {
    expect(journeyFrontMatter.safeParse({ ...minimalJourney(), id: 'checkout' }).success).toBe(
      false,
    );
  });

  test('rejects empty surfaces and a surface without a prefix', () => {
    expect(journeyFrontMatter.safeParse({ ...minimalJourney(), surfaces: [] }).success).toBe(false);
    expect(
      journeyFrontMatter.safeParse({ ...minimalJourney(), surfaces: ['/checkout'] }).success,
    ).toBe(false);
    expect(
      journeyFrontMatter.safeParse({ ...minimalJourney(), surfaces: ['api:/api/orders'] }).success,
    ).toBe(false);
  });
});

describe('blockFrontMatter (DSL v2)', () => {
  test('parses a valid v2 block front-matter and defaults params', () => {
    const parsed = blockFrontMatter.parse({
      ditto_block: 'v2',
      id: 'login-as-user',
      name: '사용자로 로그인',
    });
    expect(parsed.ditto_block).toBe('v2');
    expect(parsed.params).toEqual([]);
  });

  test('rejects a v1 block marker (clean break)', () => {
    expect(
      blockFrontMatter.safeParse({ ditto_block: 'v1', id: 'login-as-user', name: '로그인' })
        .success,
    ).toBe(false);
  });

  test('rejects a journey front-matter fed as a block', () => {
    expect(blockFrontMatter.safeParse(richJourney()).success).toBe(false);
  });
});
