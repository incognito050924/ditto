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

const base = () => ({
  ...env,
  change: { before: 'getUser(id): User|null', after: 'getUser(id): User' },
  old_meaning: 'null = 사용자 미존재',
  compatibility: 'breaking' as const,
  verdict: { type_safe: true, semantic_safe: 'no' as const },
});

describe('acgSemanticCompatibility — OBJ-43 producer rules', () => {
  test('unverified seed with sentinel old_meaning parses (detect output)', () => {
    const seed = {
      ...env,
      change: { before: 'getUser(id): User|null', after: 'getUser(id): User' },
      old_meaning: SEMANTIC_UNVERIFIED_SENTINEL,
      compatibility: 'breaking' as const,
      verdict: { type_safe: true, semantic_safe: 'unverified' as const },
    };
    expect(acgSemanticCompatibility.safeParse(seed).success).toBe(true);
  });

  test("semantic_safe='yes' WITHOUT reproducibility rejected (no unsubstantiated yes)", () => {
    const r = acgSemanticCompatibility.safeParse({
      ...base(),
      old_meaning: 'null = 미존재',
      verdict: { type_safe: true, semantic_safe: 'yes' as const },
    });
    expect(r.success).toBe(false);
  });

  test("semantic_safe='yes' WITH reproducibility(model_version) parses", () => {
    const r = acgSemanticCompatibility.safeParse({
      ...base(),
      old_meaning: 'null = 미존재',
      verdict: {
        type_safe: true,
        semantic_safe: 'yes' as const,
        reproducibility: { model_version: 'claude-opus-4-8' },
      },
    });
    expect(r.success).toBe(true);
  });

  test("sentinel old_meaning with non-unverified verdict ('no') rejected", () => {
    const r = acgSemanticCompatibility.safeParse({
      ...base(),
      old_meaning: SEMANTIC_UNVERIFIED_SENTINEL,
      verdict: { type_safe: true, semantic_safe: 'no' as const },
    });
    expect(r.success).toBe(false);
  });

  test("sentinel old_meaning with 'yes' verdict rejected (real meaning required)", () => {
    const r = acgSemanticCompatibility.safeParse({
      ...base(),
      old_meaning: SEMANTIC_UNVERIFIED_SENTINEL,
      verdict: {
        type_safe: true,
        semantic_safe: 'yes' as const,
        reproducibility: { model_version: 'claude-opus-4-8' },
      },
    });
    expect(r.success).toBe(false);
  });

  test("declared intended break ('no' ∧ intended_breaking) with real meaning parses (no reproducibility required)", () => {
    const r = acgSemanticCompatibility.safeParse({
      ...base(),
      verdict: { type_safe: true, semantic_safe: 'no' as const, intended_breaking: true },
    });
    expect(r.success).toBe(true);
  });
});
