import { describe, expect, test } from 'bun:test';
import { blockFrontMatter, journeyFrontMatter } from '~/schemas/journey-dsl';

const validJourney = () => ({
  ditto_journey: 'v1',
  id: 'jrn-checkout-coupon',
  name: '쿠폰 적용 결제',
  description: '쿠폰을 적용해 결제가 완료되는 핵심 가치 경로',
  surfaces: ['page:/checkout', 'api:POST /api/orders', 'component:src/components/Coupon*.tsx'],
});

describe('journeyFrontMatter (DSL v1)', () => {
  test('parses a valid journey front-matter and applies defaults', () => {
    const parsed = journeyFrontMatter.parse(validJourney());
    expect(parsed.ditto_journey).toBe('v1');
    expect(parsed.uses_blocks).toEqual([]);
    expect(parsed.flaky_history).toEqual([]);
  });

  test('accepts uses_blocks and flaky_history when given', () => {
    const parsed = journeyFrontMatter.parse({
      ...validJourney(),
      uses_blocks: ['login-as-user'],
      flaky_history: [{ date: '2026-06-01', case: 'timeout on coupon apply', note: 'CI only' }],
    });
    expect(parsed.uses_blocks).toEqual(['login-as-user']);
    expect(parsed.flaky_history[0]?.case).toBe('timeout on coupon apply');
  });

  test('rejects a missing ditto_journey marker', () => {
    const { ditto_journey: _drop, ...rest } = validJourney();
    expect(journeyFrontMatter.safeParse(rest).success).toBe(false);
  });

  test('rejects an id without the jrn- prefix', () => {
    expect(journeyFrontMatter.safeParse({ ...validJourney(), id: 'checkout' }).success).toBe(false);
  });

  test('rejects empty surfaces', () => {
    expect(journeyFrontMatter.safeParse({ ...validJourney(), surfaces: [] }).success).toBe(false);
  });

  test('rejects a surface without one of the 3 prefixes', () => {
    expect(
      journeyFrontMatter.safeParse({ ...validJourney(), surfaces: ['/checkout'] }).success,
    ).toBe(false);
    // api: requires "<METHOD> <path>"
    expect(
      journeyFrontMatter.safeParse({ ...validJourney(), surfaces: ['api:/api/orders'] }).success,
    ).toBe(false);
  });
});

describe('blockFrontMatter (DSL v1)', () => {
  test('parses a valid block front-matter and defaults params', () => {
    const parsed = blockFrontMatter.parse({
      ditto_block: 'v1',
      id: 'login-as-user',
      name: '사용자로 로그인',
    });
    expect(parsed.params).toEqual([]);
  });

  test('rejects a journey front-matter fed as a block', () => {
    expect(blockFrontMatter.safeParse(validJourney()).success).toBe(false);
  });
});
