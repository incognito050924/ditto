import { describe, expect, test } from 'bun:test';
import { applySemanticVerdict, buildSemanticSeed } from '~/acg/semantic/semantic-produce';
import {
  SEMANTIC_UNVERIFIED_SENTINEL,
  acgSemanticCompatibility,
} from '~/schemas/acg-semantic-compatibility';

// OBJ-43 (wi_260605sv1) — producer pipeline core.
//   buildSemanticSeed: static layer, deterministic, meaning left unverified.
//   applySemanticVerdict: resolver layer, injects an agent's meaning judgment so
//   the unverified seed can clear the stop gate (dialectic-1 O3 deadlock).

const seedInput = {
  workItemId: 'wi_seedtst01',
  file: 'src/user.ts',
  symbol: 'getUser',
  before: 'getUser(id: string): User | null',
  after: 'getUser(id: string): User',
  producedAt: '2026-06-05T00:00:00Z',
};

describe('buildSemanticSeed — static unverified seed', () => {
  test('seeds an unverified, schema-valid artifact with sentinel meaning', () => {
    const seed = buildSemanticSeed(seedInput);
    expect(acgSemanticCompatibility.safeParse(seed).success).toBe(true);
    expect(seed.verdict.semantic_safe).toBe('unverified');
    expect(seed.old_meaning).toBe(SEMANTIC_UNVERIFIED_SENTINEL);
    expect(seed.change).toEqual({ before: seedInput.before, after: seedInput.after });
  });

  test('seeds conservatively as breaking (fail-closed compatibility)', () => {
    expect(buildSemanticSeed(seedInput).compatibility).toBe('breaking');
  });

  test('deterministic — same input yields the same seed', () => {
    expect(buildSemanticSeed(seedInput)).toEqual(buildSemanticSeed(seedInput));
  });
});

describe('applySemanticVerdict — resolver injects agent judgment', () => {
  const seed = buildSemanticSeed(seedInput);

  test('yes verdict with real meaning + model_version + characterization clears (schema-valid)', () => {
    const resolved = applySemanticVerdict(seed, {
      semanticSafe: 'yes',
      oldMeaning: 'null = 사용자 미존재',
      compatibility: 'additive',
      modelVersion: 'claude-opus-4-8',
      characterizationTestRef: 'tests/user.test.ts::getUser keeps null-absence',
    });
    expect(acgSemanticCompatibility.safeParse(resolved).success).toBe(true);
    expect(resolved.verdict.semantic_safe).toBe('yes');
    expect(resolved.verdict.reproducibility?.model_version).toBe('claude-opus-4-8');
    expect(resolved.characterization?.test_ref).toBe(
      'tests/user.test.ts::getUser keeps null-absence',
    );
    expect(resolved.old_meaning).toBe('null = 사용자 미존재');
  });

  test('yes verdict WITHOUT model_version is schema-rejected (fail-closed)', () => {
    const resolved = applySemanticVerdict(seed, {
      semanticSafe: 'yes',
      oldMeaning: 'null = 미존재',
      characterizationTestRef: 'tests/user.test.ts::x',
    });
    expect(acgSemanticCompatibility.safeParse(resolved).success).toBe(false);
  });

  // B (wi_260605ch1) — an agent yes without a cited behavior test fails closed.
  test('yes verdict WITHOUT characterization is schema-rejected (LLM judgment alone insufficient)', () => {
    const resolved = applySemanticVerdict(seed, {
      semanticSafe: 'yes',
      oldMeaning: 'null = 미존재',
      modelVersion: 'claude-opus-4-8',
    });
    expect(acgSemanticCompatibility.safeParse(resolved).success).toBe(false);
  });

  test('declared intended break (no ∧ intended_breaking) with real meaning clears', () => {
    const resolved = applySemanticVerdict(seed, {
      semanticSafe: 'no',
      intendedBreaking: true,
      oldMeaning: 'null = 미존재',
    });
    expect(acgSemanticCompatibility.safeParse(resolved).success).toBe(true);
    expect(resolved.verdict.intended_breaking).toBe(true);
  });

  test('preserves the seed change pair and envelope', () => {
    const resolved = applySemanticVerdict(seed, {
      semanticSafe: 'no',
      oldMeaning: 'null = 미존재',
    });
    expect(resolved.change).toEqual(seed.change);
    expect(resolved.work_item_id).toBe(seed.work_item_id);
  });
});
