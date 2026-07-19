import { describe, expect, test } from 'bun:test';

import type { Evidence } from './evidence';
import {
  acVerdict,
  completionContract,
  deriveFinalVerdict,
} from './completion-contract';

const ref: Evidence = {
  kind: 'test',
  path: 'rebuild/schemas/completion-contract.ts',
  summary: 'verified by test',
};

describe('deriveFinalVerdict', () => {
  test('all pass with evidence => pass', () => {
    expect(
      deriveFinalVerdict([
        { criterion_id: 'ac-1', verdict: 'pass', evidence: [ref] },
        { criterion_id: 'ac-2', verdict: 'pass', evidence: [ref] },
      ]),
    ).toBe('pass');
  });

  test('one unverified => unverified', () => {
    expect(
      deriveFinalVerdict([
        { criterion_id: 'ac-1', verdict: 'pass', evidence: [ref] },
        { criterion_id: 'ac-2', verdict: 'unverified', evidence: [] },
      ]),
    ).toBe('unverified');
  });

  test('pass with empty evidence => unverified (no-evidence pass)', () => {
    expect(
      deriveFinalVerdict([
        { criterion_id: 'ac-1', verdict: 'pass', evidence: [] },
      ]),
    ).toBe('unverified');
  });

  test('any fail => fail', () => {
    expect(
      deriveFinalVerdict([
        { criterion_id: 'ac-1', verdict: 'pass', evidence: [ref] },
        { criterion_id: 'ac-2', verdict: 'fail', evidence: [ref] },
        { criterion_id: 'ac-3', verdict: 'unverified', evidence: [] },
      ]),
    ).toBe('fail');
  });

  test('empty criteria => unverified', () => {
    expect(deriveFinalVerdict([])).toBe('unverified');
  });
});

describe('completionContract', () => {
  test('accepts a contract whose final_verdict matches derived pass', () => {
    const parsed = completionContract.parse({
      work_item_id: 'wi_1',
      criteria: [{ criterion_id: 'ac-1', verdict: 'pass', evidence: [ref] }],
      final_verdict: 'pass',
    });
    expect(parsed.final_verdict).toBe('pass');
  });

  test('rejects final_verdict=pass when an AC is unverified', () => {
    const result = completionContract.safeParse({
      work_item_id: 'wi_1',
      criteria: [
        { criterion_id: 'ac-1', verdict: 'pass', evidence: [ref] },
        { criterion_id: 'ac-2', verdict: 'unverified', evidence: [] },
      ],
      final_verdict: 'pass',
    });
    expect(result.success).toBe(false);
  });

  test('rejects final_verdict=pass when an AC has empty evidence', () => {
    const result = completionContract.safeParse({
      work_item_id: 'wi_1',
      criteria: [{ criterion_id: 'ac-1', verdict: 'pass', evidence: [] }],
      final_verdict: 'pass',
    });
    expect(result.success).toBe(false);
  });

  test('requires at least one criterion', () => {
    const result = completionContract.safeParse({
      work_item_id: 'wi_1',
      criteria: [],
      final_verdict: 'unverified',
    });
    expect(result.success).toBe(false);
  });

  test('acVerdict requires a non-empty criterion_id', () => {
    const result = acVerdict.safeParse({
      criterion_id: '',
      verdict: 'pass',
      evidence: [ref],
    });
    expect(result.success).toBe(false);
  });
});
