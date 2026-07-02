import { describe, expect, test } from 'bun:test';
import {
  assertionMapGate,
  buildAssertionMap,
  renderAssertionMapDoc,
} from '~/core/e2e/assertion-mapping';
import type { RedactionRule } from '~/core/e2e/secret-redaction';
import { assertionMap } from '~/schemas/e2e-assertion-map';

// A journey with three 확인 (confirm) steps + a generated spec whose emitted
// assertions weaken / drop / faithfully reproduce them. Only 확인 steps map.
const journeyBody = [
  '1. [s1] 방문: /cart',
  '2. [s2] 확인: contains {total}',
  '3. [s3] 확인: visible 로그인 폼',
  '4. [s4] 확인: present 결과 항목',
].join('\n');

const generatedSpec = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test('cart', async ({ page }) => {",
  '  // @step jrn-cart/s1 방문: /cart',
  "  await page.goto('/cart');",
  '  // @step jrn-cart/s2 확인: contains {total}',
  "  await expect(page.getByTestId('total')).toBeVisible();",
  '  // @step jrn-cart/s3 확인: visible 로그인 폼',
  "  await expect(page.getByRole('form')).toBeVisible();",
  '  // @step jrn-cart/s4 확인: present 결과 항목',
  "  await page.getByText('결과').click();",
  '});',
].join('\n');

describe('buildAssertionMap (ac-6)', () => {
  const map = buildAssertionMap({
    journeyId: 'jrn-cart',
    journeyBody,
    generatedSpec,
    workItemId: 'wi_2607026qs',
    generatedSpecPath: 'e2e/generated/cart.spec.ts',
  });

  test('only 확인 steps become entries (방문: is skipped)', () => {
    expect(map.entries.map((e) => e.step_id).sort()).toEqual(['s2', 's3', 's4']);
  });

  test('contains weakened to only toBeVisible → strength weaker, flagged', () => {
    const s2 = map.entries.find((e) => e.step_id === 's2');
    expect(s2?.dsl_form).toBe('contains');
    expect(s2?.strength).toBe('weaker');
    expect(s2?.flag).toBe(true);
    expect(s2?.emitted_matcher).toBe('toBeVisible');
    expect(map.weakened_count).toBe(1);
  });

  test('dropped assertion (no expect in region) → strength unmapped', () => {
    const s4 = map.entries.find((e) => e.step_id === 's4');
    expect(s4?.strength).toBe('unmapped');
    expect(s4?.flag).toBe(true);
    expect(s4?.emitted_matcher).toBe('');
    expect(map.unmapped_count).toBe(1);
  });

  test('faithful reproduction (visible → toBeVisible) → strength exact, not flagged', () => {
    const s3 = map.entries.find((e) => e.step_id === 's3');
    expect(s3?.dsl_form).toBe('visible');
    expect(s3?.strength).toBe('exact');
    expect(s3?.flag).toBe(false);
  });

  test('result validates against the assertionMap schema', () => {
    expect(() => assertionMap.parse(map)).not.toThrow();
  });
});

describe('redaction (Contract 6)', () => {
  test('secret VALUE never appears literally in dsl/emitted assertion', () => {
    const rule: RedactionRule = {
      secretVars: ['TOKEN'],
      credentialRefs: [],
      envValues: { TOKEN: 'supersecret123' },
    };
    const map = buildAssertionMap({
      journeyId: 'jrn-x',
      journeyBody: '1. [s1] 확인: contains supersecret123',
      generatedSpec: [
        '// @step jrn-x/s1 확인: contains supersecret123',
        "await expect(page.getByText('supersecret123')).toContainText('supersecret123');",
      ].join('\n'),
      workItemId: 'wi_2607026qs',
      generatedSpecPath: 'e2e/generated/x.spec.ts',
      rule,
    });
    const entry = map.entries[0];
    expect(entry?.strength).toBe('exact');
    expect(entry?.dsl_assertion).not.toContain('supersecret123');
    expect(entry?.dsl_assertion).toContain('<env:TOKEN>');
    expect(entry?.emitted_assertion).not.toContain('supersecret123');
  });
});

describe('renderAssertionMapDoc + gate', () => {
  const map = buildAssertionMap({
    journeyId: 'jrn-cart',
    journeyBody,
    generatedSpec,
    workItemId: 'wi_2607026qs',
    generatedSpecPath: 'e2e/generated/cart.spec.ts',
  });

  test('doc renders a table and a 검토 필요 list surfacing flagged rows', () => {
    const doc = renderAssertionMapDoc(map);
    expect(doc).toContain('## 검토 필요');
    expect(doc).toContain('s2');
    expect(doc).toContain('s4');
  });

  test('gate hard-fails when unmapped_count > 0', () => {
    const gate = assertionMapGate(map);
    expect(gate.hardFail).toBe(true);
    expect(gate.flagged).toBe(true);
  });
});

// ac-6: detectForm must recognise all 5 forms in BOTH orders — keyword-first
// (`contains X`, `visible`, ...) AND target-first (`"대시보드" visible`,
// `"총 결제금액" contains 9,000원`). A target-first author is a common mistake;
// silently dropping it produces a vacuous PASS (worse than a hard fail).
describe('detectForm: keyword-first AND target-first (ac-6)', () => {
  const body = [
    '1. [s1] 확인: "대시보드" visible', // target-first visible
    '2. [s2] 확인: "로딩 스피너" hidden', // target-first hidden
    '3. [s3] 확인: "총 결제금액" contains 9,000원', // target-first contains
    '4. [s4] 확인: url contains /orders/', // keyword-first url-contains
  ].join('\n');
  const spec = [
    '// @step jrn-x/s1 확인: "대시보드" visible',
    "await expect(page.getByText('대시보드')).toBeVisible();",
    '// @step jrn-x/s2 확인: "로딩 스피너" hidden',
    "await expect(page.getByText('로딩 스피너')).toBeHidden();",
    '// @step jrn-x/s3 확인: "총 결제금액" contains 9,000원',
    "await expect(page.getByText('총 결제금액')).toContainText('9,000원');",
    '// @step jrn-x/s4 확인: url contains /orders/',
    'await expect(page).toHaveURL(/\\/orders\\//);',
  ].join('\n');
  const map = buildAssertionMap({
    journeyId: 'jrn-x',
    journeyBody: body,
    generatedSpec: spec,
    workItemId: 'wi_2607026qs',
    generatedSpecPath: 'e2e/generated/x.spec.ts',
  });

  test('target-first "대시보드" visible → mapped, form visible, exact', () => {
    const s1 = map.entries.find((e) => e.step_id === 's1');
    expect(s1?.dsl_form).toBe('visible');
    expect(s1?.strength).toBe('exact');
  });

  test('target-first hidden → mapped, form hidden', () => {
    const s2 = map.entries.find((e) => e.step_id === 's2');
    expect(s2?.dsl_form).toBe('hidden');
    expect(s2?.strength).toBe('exact');
  });

  test('target-first contains → mapped, form contains', () => {
    const s3 = map.entries.find((e) => e.step_id === 's3');
    expect(s3?.dsl_form).toBe('contains');
    expect(s3?.strength).toBe('exact');
  });

  test('keyword-first url contains still classified as url-contains', () => {
    const s4 = map.entries.find((e) => e.step_id === 's4');
    expect(s4?.dsl_form).toBe('url-contains');
  });

  test('none of the four confirm steps is silently dropped', () => {
    expect(map.entries.map((e) => e.step_id).sort()).toEqual(['s1', 's2', 's3', 's4']);
    expect(map.unmapped_count).toBe(0);
  });
});

// ac-6: a truly unclassifiable 확인 step (free sentence, no form keyword) must
// NOT vanish — it becomes an `unmapped` entry so the gate hard-fails visibly.
describe('unclassifiable 확인 step is never silently dropped (ac-6)', () => {
  const body = '1. [s1] 확인: 결제가 잘 된다';
  const spec = [
    '// @step jrn-f/s1 확인: 결제가 잘 된다',
    "await expect(page.getByText('결제')).toBeVisible();",
  ].join('\n');
  const map = buildAssertionMap({
    journeyId: 'jrn-f',
    journeyBody: body,
    generatedSpec: spec,
    workItemId: 'wi_2607026qs',
    generatedSpecPath: 'e2e/generated/f.spec.ts',
  });

  test('free-sentence confirm becomes an unmapped entry (count > 0, not 0)', () => {
    expect(map.entries).toHaveLength(1);
    expect(map.entries[0]?.step_id).toBe('s1');
    expect(map.entries[0]?.strength).toBe('unmapped');
    expect(map.unmapped_count).toBe(1);
  });

  test('gate hard-fails on the unclassifiable assertion (no vacuous pass)', () => {
    expect(assertionMapGate(map).hardFail).toBe(true);
  });

  test('unmapped entry still validates against the schema', () => {
    expect(() => assertionMap.parse(map)).not.toThrow();
  });
});
