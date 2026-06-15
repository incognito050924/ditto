import { describe, expect, test } from 'bun:test';
import {
  SEMANTIC_UNVERIFIED_SENTINEL,
  acgSemanticCompatibility,
} from '~/schemas/acg-semantic-compatibility';

// OBJ-43 (wi_260605sv1) — producer pipeline schema rules. The split verdict's
// `semantic_safe` now carries two fail-closed obligations the consumer gate
// (stop.ts:239-249) cannot enforce on its own:
//   - reproducibility: a meaning-safe pass ('yes') must cite a pinned judge model
//     (no unsubstantiated yes — dialectic-1 O5), mirroring fitness verdicts.
//   - old_meaning sentinel: the static `semantic detect` seed cannot know the
//     domain meaning, so it writes the sentinel; that sentinel is valid ONLY
//     while still 'unverified'. yes/no must carry the real meaning (O4).

const env = {
  schema_version: '0.1.0' as const,
  kind: 'acg.semantic-compatibility.v1' as const,
  work_item_id: 'wi_semchk01',
  produced_by: 'agent' as const,
  produced_at: '2026-06-05T00:00:00Z',
};

// One change pair; per-test overrides merge into the single pair. The schema now
// holds changes[] (G4 multi-change), so the producer rules apply per pair.
const withChange = (override: Record<string, unknown>) => ({
  ...env,
  changes: [
    {
      before: 'getUser(id): User|null',
      after: 'getUser(id): User',
      old_meaning: 'null = 사용자 미존재',
      compatibility: 'breaking' as const,
      verdict: { type_safe: true, semantic_safe: 'no' as const },
      ...override,
    },
  ],
});

// A passing behavior test that witnesses the preserved meaning (B / sv1 O6).
const charz = {
  exists: true,
  test_ref: 'tests/user.test.ts::getUser keeps null-absence semantics',
  candidate: null,
  adequacy: 'l1_met' as const,
};

describe('acgSemanticCompatibility — OBJ-43 producer rules', () => {
  test('unverified seed with sentinel old_meaning parses (detect output)', () => {
    const seed = withChange({
      old_meaning: SEMANTIC_UNVERIFIED_SENTINEL,
      verdict: { type_safe: true, semantic_safe: 'unverified' as const },
    });
    expect(acgSemanticCompatibility.safeParse(seed).success).toBe(true);
  });

  test("agent semantic_safe='yes' WITHOUT reproducibility rejected (no unsubstantiated machine yes)", () => {
    const r = acgSemanticCompatibility.safeParse(
      withChange({
        old_meaning: 'null = 미존재',
        verdict: { type_safe: true, semantic_safe: 'yes' as const },
      }),
    );
    expect(r.success).toBe(false);
  });

  test("agent semantic_safe='yes' WITH reproducibility + characterization parses", () => {
    const r = acgSemanticCompatibility.safeParse(
      withChange({
        old_meaning: 'null = 미존재',
        characterization: charz,
        verdict: {
          type_safe: true,
          semantic_safe: 'yes' as const,
          reproducibility: { model_version: 'claude-opus-4-8' },
        },
      }),
    );
    expect(r.success).toBe(true);
  });

  // B (wi_260605ch1 / sv1 O6) — an agent `yes` must cite a passing behavior test;
  // a pinned judge model says "I think it holds", the test is the witness it does.
  test("agent semantic_safe='yes' WITHOUT characterization rejected (LLM judgment alone is not assurance)", () => {
    const r = acgSemanticCompatibility.safeParse(
      withChange({
        old_meaning: 'null = 미존재',
        verdict: {
          type_safe: true,
          semantic_safe: 'yes' as const,
          reproducibility: { model_version: 'claude-opus-4-8' },
        },
      }),
    );
    expect(r.success).toBe(false);
  });

  test("agent semantic_safe='yes' with characterization.exists but EMPTY test_ref rejected (candidate is not a passing test)", () => {
    const r = acgSemanticCompatibility.safeParse(
      withChange({
        old_meaning: 'null = 미존재',
        characterization: { exists: true, test_ref: null, candidate: 'def test_get_user(): ...' },
        verdict: {
          type_safe: true,
          semantic_safe: 'yes' as const,
          reproducibility: { model_version: 'claude-opus-4-8' },
        },
      }),
    );
    expect(r.success).toBe(false);
  });

  // wi_260605ur1 — a user `yes` is a full human attestation: exempt from BOTH
  // reproducibility AND characterization (mirrors intended_breaking). The agent
  // still owes both; only the produced_by axis differs.
  test("user-produced semantic_safe='yes' parses with NO reproducibility and NO characterization (human attestation)", () => {
    const r = acgSemanticCompatibility.safeParse({
      ...withChange({
        old_meaning: 'null = 미존재',
        verdict: { type_safe: true, semantic_safe: 'yes' as const },
      }),
      produced_by: 'user' as const,
    });
    expect(r.success).toBe(true);
  });

  test("sentinel old_meaning with non-unverified verdict ('no') rejected", () => {
    const r = acgSemanticCompatibility.safeParse(
      withChange({
        old_meaning: SEMANTIC_UNVERIFIED_SENTINEL,
        verdict: { type_safe: true, semantic_safe: 'no' as const },
      }),
    );
    expect(r.success).toBe(false);
  });

  test("sentinel old_meaning with 'yes' verdict rejected (real meaning required)", () => {
    // characterization present so the ONLY rejection reason is the sentinel meaning.
    const r = acgSemanticCompatibility.safeParse(
      withChange({
        old_meaning: SEMANTIC_UNVERIFIED_SENTINEL,
        characterization: charz,
        verdict: {
          type_safe: true,
          semantic_safe: 'yes' as const,
          reproducibility: { model_version: 'claude-opus-4-8' },
        },
      }),
    );
    expect(r.success).toBe(false);
  });

  test("declared intended break ('no' ∧ intended_breaking) with real meaning parses (no reproducibility required)", () => {
    const r = acgSemanticCompatibility.safeParse(
      withChange({
        verdict: { type_safe: true, semantic_safe: 'no' as const, intended_breaking: true },
      }),
    );
    expect(r.success).toBe(true);
  });

  // G4 multi-change: per-pair obligations — one valid pair does not exempt another.
  test('multiple pairs: an invalid agent yes pair fails even alongside a valid pair', () => {
    const r = acgSemanticCompatibility.safeParse({
      ...env,
      changes: [
        {
          before: 'a',
          after: 'b',
          old_meaning: 'm',
          compatibility: 'breaking' as const,
          verdict: { type_safe: true, semantic_safe: 'no' as const, intended_breaking: true },
        },
        {
          // agent yes without reproducibility/characterization → rejected
          before: 'c',
          after: 'd',
          old_meaning: 'n',
          compatibility: 'breaking' as const,
          verdict: { type_safe: true, semantic_safe: 'yes' as const },
        },
      ],
    });
    expect(r.success).toBe(false);
  });
});
