import { describe, expect, test } from 'bun:test';

import { evaluateAcTwoFacet } from './ac-2facet';

describe('evaluateAcTwoFacet — §5 AC 2-facet gate', () => {
  test('both facets pass: local pass + evidence, external verified', () => {
    const verdict = evaluateAcTwoFacet({
      id: 'ac-1',
      status: 'pass',
      evidence_ref: 'ref: green',
      crossCheck: 'verified',
    });
    expect(verdict).toEqual({
      id: 'ac-1',
      localFacet: 'pass',
      externalFacet: 'pass',
      verdict: 'pass',
      reasons: [],
    });
  });

  test('local blocked by missing evidence (null); external still pass', () => {
    const verdict = evaluateAcTwoFacet({
      id: 'ac-2',
      status: 'pass',
      evidence_ref: null,
      crossCheck: 'verified',
    });
    expect(verdict.localFacet).toBe('blocked');
    expect(verdict.externalFacet).toBe('pass');
    expect(verdict.verdict).toBe('blocked');
    expect(verdict.reasons).toEqual([
      'local facet blocked: status=pass, evidence absent',
    ]);
  });

  test('local blocked by non-pass status even with evidence + external verified', () => {
    const verdict = evaluateAcTwoFacet({
      id: 'ac-3',
      status: 'unverified',
      evidence_ref: 'ref: x',
      crossCheck: 'verified',
    });
    expect(verdict.localFacet).toBe('blocked');
    expect(verdict.externalFacet).toBe('pass');
    expect(verdict.verdict).toBe('blocked');
    expect(verdict.reasons).toEqual([
      'local facet blocked: status=unverified, evidence present',
    ]);
  });

  test('external blocked by crossCheck refuted; local pass', () => {
    const verdict = evaluateAcTwoFacet({
      id: 'ac-4',
      status: 'pass',
      evidence_ref: 'ref: x',
      crossCheck: 'refuted',
    });
    expect(verdict.localFacet).toBe('pass');
    expect(verdict.externalFacet).toBe('blocked');
    expect(verdict.verdict).toBe('blocked');
    expect(verdict.reasons).toEqual([
      'external facet blocked: crossCheck=refuted',
    ]);
  });

  test('external blocked by crossCheck unverified; local pass', () => {
    const verdict = evaluateAcTwoFacet({
      id: 'ac-4b',
      status: 'pass',
      evidence_ref: 'ref: x',
      crossCheck: 'unverified',
    });
    expect(verdict.localFacet).toBe('pass');
    expect(verdict.externalFacet).toBe('blocked');
    expect(verdict.verdict).toBe('blocked');
    expect(verdict.reasons).toEqual([
      'external facet blocked: crossCheck=unverified',
    ]);
  });

  test('both blocked: fail status, whitespace evidence, unverified crossCheck', () => {
    const verdict = evaluateAcTwoFacet({
      id: 'ac-5',
      status: 'fail',
      evidence_ref: '   ',
      crossCheck: 'unverified',
    });
    expect(verdict.localFacet).toBe('blocked');
    expect(verdict.externalFacet).toBe('blocked');
    expect(verdict.verdict).toBe('blocked');
    expect(verdict.reasons).toEqual([
      'local facet blocked: status=fail, evidence absent',
      'external facet blocked: crossCheck=unverified',
    ]);
  });
});
