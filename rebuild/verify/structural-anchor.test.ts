import { describe, expect, test } from 'bun:test';

import {
  checkStructuralAnchor,
  type ObservedStructure,
  type StructuralExpectation,
} from './structural-anchor';

describe('checkStructuralAnchor — guardrail ②-anchor (ac-4)', () => {
  test('NEGATIVE path: change missing a promised file is flagged as mismatch', () => {
    // The locked AC promised a file that the change never produced. A green test
    // must NOT hide this — the anchor detects the structural mismatch.
    const expected: StructuralExpectation[] = [
      { criterion_id: 'ac-4', kind: 'file', target: 'rebuild/verify/structural-anchor.ts' },
    ];
    const observed: ObservedStructure[] = [
      { kind: 'file', target: 'rebuild/verify/something-else.ts' },
    ];

    const result = checkStructuralAnchor(expected, observed);

    expect(result.status).toBe('mismatch');
    expect(result.missing).toEqual(expected);
    expect(result.reasons).toEqual([
      'structural mismatch: ac-4 promised file "rebuild/verify/structural-anchor.ts", but the change did not produce it',
    ]);
  });

  test('POSITIVE path: change producing every promised artifact matches', () => {
    const expected: StructuralExpectation[] = [
      { criterion_id: 'ac-4', kind: 'file', target: 'rebuild/verify/structural-anchor.ts' },
      { criterion_id: 'ac-4', kind: 'symbol', target: 'checkStructuralAnchor' },
    ];
    const observed: ObservedStructure[] = [
      { kind: 'file', target: 'rebuild/verify/structural-anchor.ts' },
      { kind: 'symbol', target: 'checkStructuralAnchor' },
      // extra observed artifacts are allowed; the anchor only checks promises.
      { kind: 'file', target: 'rebuild/verify/other.ts' },
    ];

    const result = checkStructuralAnchor(expected, observed);

    expect(result.status).toBe('matched');
    expect(result.missing).toEqual([]);
    expect(result.reasons).toEqual([]);
  });

  test('kind matters: right target under the wrong kind is a mismatch', () => {
    // A green test on a symbol that should have been a file must still be caught.
    const expected: StructuralExpectation[] = [
      { criterion_id: 'ac-4', kind: 'file', target: 'anchor' },
    ];
    const observed: ObservedStructure[] = [{ kind: 'symbol', target: 'anchor' }];

    const result = checkStructuralAnchor(expected, observed);

    expect(result.status).toBe('mismatch');
    expect(result.missing).toEqual(expected);
  });

  test('partial: reports only the promises the change failed to produce', () => {
    const expected: StructuralExpectation[] = [
      { criterion_id: 'ac-4', kind: 'file', target: 'a.ts' },
      { criterion_id: 'ac-4', kind: 'shape', target: 'StructuralAnchorResult' },
    ];
    const observed: ObservedStructure[] = [{ kind: 'file', target: 'a.ts' }];

    const result = checkStructuralAnchor(expected, observed);

    expect(result.status).toBe('mismatch');
    expect(result.missing).toEqual([
      { criterion_id: 'ac-4', kind: 'shape', target: 'StructuralAnchorResult' },
    ]);
    expect(result.reasons).toEqual([
      'structural mismatch: ac-4 promised shape "StructuralAnchorResult", but the change did not produce it',
    ]);
  });

  test('fail-closed: no locked expectations cannot claim a match', () => {
    const result = checkStructuralAnchor([], [{ kind: 'file', target: 'a.ts' }]);

    expect(result.status).toBe('unverified');
    expect(result.missing).toEqual([]);
    expect(result.reasons).toEqual([
      'structural anchor: no locked expectations to check → unverified',
    ]);
  });
});
