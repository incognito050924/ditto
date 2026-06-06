import { describe, expect, test } from 'bun:test';
// The capture runner's assertion grammar lives in a plain ESM module so it is
// importable both by the node runner (playwright-runner.mjs) and by bun tests.
import { classifyAssertion, summarizeResult } from '~/core/e2e/assertion.mjs';

describe('classifyAssertion (checkable predicate vs unverifiable NL)', () => {
  test('"<selector> contains <text>" → contains', () => {
    expect(classifyAssertion('#title contains Ditto E2E Works')).toEqual({
      kind: 'contains',
      selector: '#title',
      text: 'Ditto E2E Works',
    });
  });

  test('"<selector> visible" → visible', () => {
    expect(classifyAssertion('.banner visible')).toEqual({ kind: 'visible', selector: '.banner' });
  });

  test('"<selector> hidden" → hidden', () => {
    expect(classifyAssertion('#spinner hidden')).toEqual({ kind: 'hidden', selector: '#spinner' });
  });

  test('a bare CSS selector → present', () => {
    expect(classifyAssertion('#title')).toEqual({ kind: 'present', selector: '#title' });
    expect(classifyAssertion('div.card')).toEqual({ kind: 'present', selector: 'div.card' });
  });

  // The repro (wi_260606e43 e2e_axis3_demo): a free-text Korean NL assertion is
  // NOT a CSS selector. The old runner ran `locator(NL).count()`, which threw and
  // fabricated a `fail`. It must classify as unverifiable instead.
  test('free-text NL prose → unverifiable (the false-fail repro)', () => {
    expect(classifyAssertion('페이지에 Example Domain 텍스트가 보인다')).toEqual({
      kind: 'unverifiable',
    });
    expect(classifyAssertion('redirected to dashboard')).toEqual({ kind: 'unverifiable' });
    expect(classifyAssertion('the page shows a welcome banner')).toEqual({ kind: 'unverifiable' });
  });
});

describe('summarizeResult (checkable=false ⇒ unverified, never a fabricated fail)', () => {
  test('a single unverifiable assertion → unverified, NOT fail (the repro fix)', () => {
    expect(summarizeResult([{ satisfied: false, checkable: false }])).toBe('unverified');
  });

  test('all checkable and held → pass', () => {
    expect(
      summarizeResult([
        { satisfied: true, checkable: true },
        { satisfied: true, checkable: true },
      ]),
    ).toBe('pass');
  });

  test('a checkable assertion that did not hold → fail (a real contradiction)', () => {
    expect(
      summarizeResult([
        { satisfied: true, checkable: true },
        { satisfied: false, checkable: true },
      ]),
    ).toBe('fail');
  });

  test('a real failure outranks an unverifiable one → fail (not unverified)', () => {
    expect(
      summarizeResult([
        { satisfied: false, checkable: true },
        { satisfied: false, checkable: false },
      ]),
    ).toBe('fail');
  });

  test('held + unverifiable (no failure) → unverified', () => {
    expect(
      summarizeResult([
        { satisfied: true, checkable: true },
        { satisfied: false, checkable: false },
      ]),
    ).toBe('unverified');
  });
});
