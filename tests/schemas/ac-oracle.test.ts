import { describe, expect, test } from 'bun:test';
import { intentContract } from '~/schemas/intent';
import { acceptanceCriterion } from '~/schemas/work-item';

// ADR-0024 §3 / wi_260623uap ac-1: per-AC oracle (verification_method × maps_to + direction).
// Additive + OPTIONAL: legacy ACs with no `oracle` parse byte-unchanged; no schema_version bump.

const baseAc = () => ({
  id: 'ac-1',
  statement: 'Some observable behavior',
  verdict: 'unverified' as const,
  evidence: [],
});

describe('acceptanceCriterion.oracle (ADR-0024 §3)', () => {
  test('valid: forward dynamic_test oracle mapping to an AC', () => {
    const ac = {
      ...baseAc(),
      oracle: {
        verification_method: 'dynamic_test' as const,
        maps_to: 'ac-1',
        direction: 'forward' as const,
      },
    };
    expect(acceptanceCriterion.safeParse(ac).success).toBe(true);
  });

  test('valid: forward static_scan oracle mapping to an intent ref', () => {
    const ac = {
      ...baseAc(),
      oracle: {
        verification_method: 'static_scan' as const,
        maps_to: 'intent: scope-guard rule',
        direction: 'forward' as const,
      },
    };
    expect(acceptanceCriterion.safeParse(ac).success).toBe(true);
  });

  test('valid: soft_judgment oracle mapping to a doc', () => {
    const ac = {
      ...baseAc(),
      oracle: {
        verification_method: 'soft_judgment' as const,
        maps_to: 'doc: design review note',
        direction: 'forward' as const,
      },
    };
    expect(acceptanceCriterion.safeParse(ac).success).toBe(true);
  });

  test('valid: backward oracle WITH a file:line maps_to (current-code finding)', () => {
    const ac = {
      ...baseAc(),
      oracle: {
        verification_method: 'static_scan' as const,
        maps_to: 'src/core/gates.ts:42',
        direction: 'backward' as const,
      },
    };
    expect(acceptanceCriterion.safeParse(ac).success).toBe(true);
  });

  test('invalid: forward oracle with a file:line maps_to is rejected (drifts on change)', () => {
    const ac = {
      ...baseAc(),
      oracle: {
        verification_method: 'static_scan' as const,
        maps_to: 'src/core/gates.ts:42',
        direction: 'forward' as const,
      },
    };
    expect(acceptanceCriterion.safeParse(ac).success).toBe(false);
  });

  test('invalid: forward oracle with a bare symbol code-pointer maps_to is rejected', () => {
    const ac = {
      ...baseAc(),
      oracle: {
        verification_method: 'soft_judgment' as const,
        maps_to: 'src/core/gates.ts:isUnitOnlyClosure',
        direction: 'forward' as const,
      },
    };
    expect(acceptanceCriterion.safeParse(ac).success).toBe(false);
  });

  test('invalid: unknown verification_method enum value is rejected', () => {
    const ac = {
      ...baseAc(),
      oracle: {
        verification_method: 'manual_test',
        maps_to: 'ac-1',
        direction: 'forward',
      },
    };
    expect(acceptanceCriterion.safeParse(ac).success).toBe(false);
  });
});

describe('acceptanceCriterion.oracle — legacy round-trip (additive/optional)', () => {
  test('constructed legacy AC without oracle still parses', () => {
    expect(acceptanceCriterion.safeParse(baseAc()).success).toBe(true);
  });

  // A legacy intent.json authored before the `oracle` field existed: its ACs carry
  // no `oracle`, and the intent omits the later-added optional fields
  // (`follow_up_materialization`, `source_digest`). This shape is byte-for-byte what
  // pre-oracle intents hold on disk. Kept as an inline fixture (not a live disk scan
  // of `.ditto/local/work-items`, which is a gitignored per-developer tier — ADR-0012
  // ③ — absent in a fresh worktree/CI checkout; same class as issue #42).
  const legacyIntentFixture = {
    schema_version: '0.1.0',
    work_item_id: 'wi_260703moy',
    source_request: 'original verbatim request',
    goal: 'a verifiable goal stated in project terms',
    in_scope: ['some in-scope item'],
    out_of_scope: ['some out-of-scope item'],
    acceptance_criteria: [
      {
        id: 'ac-1',
        statement: 'observable behavior with no oracle field',
        verdict: 'unverified',
        evidence: [],
      },
    ],
    unknowns: [],
    follow_up_candidates: [],
    question_policy: 'ask_only_if_user_only_can_answer',
  };

  test('legacy intent (no oracle field) still parses under the new schema', () => {
    const result = intentContract.safeParse(legacyIntentFixture);
    if (!result.success) {
      throw new Error(`legacy intent failed to parse:\n${result.error}`);
    }
    expect(result.success).toBe(true);
    // The oracle field is additive + optional: a legacy AC round-trips without one.
    expect(result.success && result.data.acceptance_criteria[0].oracle).toBeUndefined();
  });
});
