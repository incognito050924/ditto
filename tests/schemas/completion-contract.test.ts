import { describe, expect, test } from 'bun:test';
import { completionContract } from '~/schemas/completion-contract';

// Minimal valid completion claim (final_verdict=pass) used as a base.
function baseClaim(): Record<string, unknown> {
  return {
    schema_version: '0.1.0',
    work_item_id: 'wi_test0001',
    declared_by: 'implementer',
    declared_at: '2026-06-16T00:00:00.000Z',
    summary: 'something changed',
    acceptance: [{ criterion_id: 'ac-1', verdict: 'pass' }],
    final_verdict: 'pass',
  };
}

describe('completionContract unverified.resolvability', () => {
  test('legacy unverified item without resolvability/grounding round-trips', () => {
    const claim = {
      ...baseClaim(),
      unverified: [{ item: 'edge case x', reason: 'no harness', out_of_scope: true }],
    };
    const parsed = completionContract.parse(claim);
    const u = parsed.unverified[0];
    expect(u.item).toBe('edge case x');
    expect(u.resolvability).toBeUndefined();
    expect(u.grounding).toBeUndefined();
  });

  test('resolvability accepts the four declared classes', () => {
    for (const cls of [
      'agent_resolvable',
      'blocked_external',
      'user_decision',
      'accepted_tradeoff',
    ] as const) {
      const claim = {
        ...baseClaim(),
        unverified: [{ item: 'i', reason: 'r', out_of_scope: true, resolvability: cls }],
      };
      const parsed = completionContract.parse(claim);
      expect(parsed.unverified[0].resolvability).toBe(cls);
    }
  });

  test('rejects an unknown resolvability value', () => {
    const claim = {
      ...baseClaim(),
      unverified: [{ item: 'i', reason: 'r', out_of_scope: true, resolvability: 'bogus' }],
    };
    expect(() => completionContract.parse(claim)).toThrow();
  });

  test('a non-resolvable class with grounding parses', () => {
    const claim = {
      ...baseClaim(),
      unverified: [
        {
          item: 'depends on upstream lib',
          reason: 'external dependency unpatched',
          out_of_scope: true,
          resolvability: 'blocked_external',
          grounding: 'ADR-0006 / left-pad@1.3.0',
        },
      ],
    };
    const parsed = completionContract.parse(claim);
    expect(parsed.unverified[0].grounding).toBe('ADR-0006 / left-pad@1.3.0');
  });

  test('grounding rejects an empty string', () => {
    const claim = {
      ...baseClaim(),
      unverified: [
        {
          item: 'i',
          reason: 'r',
          out_of_scope: true,
          resolvability: 'user_decision',
          grounding: '',
        },
      ],
    };
    expect(() => completionContract.parse(claim)).toThrow();
  });

  test('existing in-scope-unverified rule on final_verdict=pass is unchanged', () => {
    const claim = {
      ...baseClaim(),
      unverified: [
        { item: 'i', reason: 'r', out_of_scope: false, resolvability: 'agent_resolvable' },
      ],
    };
    expect(() => completionContract.parse(claim)).toThrow();
  });
});
