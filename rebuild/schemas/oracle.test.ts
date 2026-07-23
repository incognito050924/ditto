import { describe, expect, test } from 'bun:test';

import { acOracle, verificationMethod } from './oracle';

const base = {
  criterion_id: 'ac1',
  statement: 'bun test rebuild/가 exit 0으로 끝난다',
  verification_method: 'dynamic_test',
  direction: 'forward',
  maps_to: { kind: 'ac', ref: 'ac1' },
};

describe('acOracle — 기계가 재평가 가능한 완료 통화', () => {
  test('verification_method is exactly the three classes', () => {
    expect(verificationMethod.options).toEqual([
      'dynamic_test',
      'static_scan',
      'soft_judgment',
    ]);
  });

  test('parses a forward dynamic_test oracle mapped to an AC', () => {
    const parsed = acOracle.parse(base);
    expect(parsed.criterion_id).toBe('ac1');
    expect(parsed.verification_method).toBe('dynamic_test');
  });

  test('forward oracles may not anchor to code pointers (they break on change)', () => {
    expect(
      acOracle.safeParse({
        ...base,
        maps_to: { kind: 'code', ref: 'src/x.ts:42' },
      }).success,
    ).toBe(false);
    // backward(발견 기반) oracle은 code 앵커가 유효하다
    expect(
      acOracle.safeParse({
        ...base,
        direction: 'backward',
        maps_to: { kind: 'code', ref: 'src/x.ts:42' },
      }).success,
    ).toBe(true);
  });

  test('rejects unknown verification methods and empty statements', () => {
    expect(
      acOracle.safeParse({ ...base, verification_method: 'llm_says_done' })
        .success,
    ).toBe(false);
    expect(acOracle.safeParse({ ...base, statement: '' }).success).toBe(false);
  });
});
