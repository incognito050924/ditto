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
// G4 (wi_260614gd9) — the artifact carries changes[] so every detected pair gates.

const PAIR = {
  before: 'getUser(id: string): User | null',
  after: 'getUser(id: string): User',
};
const PAIR2 = {
  before: 'listUsers(): User[] | null',
  after: 'listUsers(): User[]',
};

const seedInput = {
  workItemId: 'wi_seedtst01',
  changes: [PAIR],
  producedAt: '2026-06-05T00:00:00Z',
};

describe('buildSemanticSeed — static unverified seed', () => {
  test('seeds an unverified, schema-valid artifact with sentinel meaning', () => {
    const seed = buildSemanticSeed(seedInput);
    expect(acgSemanticCompatibility.safeParse(seed).success).toBe(true);
    expect(seed.changes).toHaveLength(1);
    expect(seed.changes[0]?.verdict.semantic_safe).toBe('unverified');
    expect(seed.changes[0]?.old_meaning).toBe(SEMANTIC_UNVERIFIED_SENTINEL);
    expect({ before: seed.changes[0]?.before, after: seed.changes[0]?.after }).toEqual(PAIR);
  });

  test('seeds conservatively as breaking (fail-closed compatibility)', () => {
    expect(buildSemanticSeed(seedInput).changes[0]?.compatibility).toBe('breaking');
  });

  test('deterministic — same input yields the same seed', () => {
    expect(buildSemanticSeed(seedInput)).toEqual(buildSemanticSeed(seedInput));
  });

  // G4: multiple detected pairs are all seeded into changes[].
  test('seeds every detected pair (multi-change)', () => {
    const seed = buildSemanticSeed({ ...seedInput, changes: [PAIR, PAIR2] });
    expect(acgSemanticCompatibility.safeParse(seed).success).toBe(true);
    expect(seed.changes).toHaveLength(2);
    expect(seed.changes.every((c) => c.verdict.semantic_safe === 'unverified')).toBe(true);
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
      characterizationAdequacy: 'l1_met',
    });
    expect(acgSemanticCompatibility.safeParse(resolved).success).toBe(true);
    expect(resolved.changes[0]?.verdict.semantic_safe).toBe('yes');
    expect(resolved.changes[0]?.verdict.reproducibility?.model_version).toBe('claude-opus-4-8');
    expect(resolved.changes[0]?.characterization?.test_ref).toBe(
      'tests/user.test.ts::getUser keeps null-absence',
    );
    expect(resolved.changes[0]?.old_meaning).toBe('null = 사용자 미존재');
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
    expect(resolved.changes[0]?.verdict.intended_breaking).toBe(true);
  });

  test('preserves the seed change pair and envelope', () => {
    const resolved = applySemanticVerdict(seed, {
      semanticSafe: 'no',
      oldMeaning: 'null = 미존재',
    });
    expect(resolved.changes[0]?.before).toBe(seed.changes[0]?.before);
    expect(resolved.changes[0]?.after).toBe(seed.changes[0]?.after);
    expect(resolved.work_item_id).toBe(seed.work_item_id);
  });

  // G4 resolver semantics — verdict targets ONE pair; others stay untouched.
  describe('multi-change targeting', () => {
    const multi = buildSemanticSeed({ ...seedInput, changes: [PAIR, PAIR2] });

    test('no target with >1 pair throws (cannot guess which pair)', () => {
      expect(() => applySemanticVerdict(multi, { semanticSafe: 'no' })).toThrow();
    });

    test('targeting one pair leaves the other unverified', () => {
      const resolved = applySemanticVerdict(multi, {
        semanticSafe: 'no',
        intendedBreaking: true,
        oldMeaning: 'null = 미존재',
        target: PAIR,
      });
      const resolvedPair = resolved.changes.find((c) => c.before === PAIR.before);
      const otherPair = resolved.changes.find((c) => c.before === PAIR2.before);
      expect(resolvedPair?.verdict.semantic_safe).toBe('no');
      expect(resolvedPair?.verdict.intended_breaking).toBe(true);
      expect(otherPair?.verdict.semantic_safe).toBe('unverified');
    });

    test('unmatched target throws (no silent landing on the wrong pair)', () => {
      expect(() =>
        applySemanticVerdict(multi, {
          semanticSafe: 'no',
          target: { before: 'nope', after: 'nope2' },
        }),
      ).toThrow();
    });
  });
});

// WU-2(b) / OBJ-11 — an agent semantic_safe=yes needs an ADEQUACY tag (L1 충족 or
// L2 통과), not merely an existing characterization ref. A user yes stays exempt.
describe('semantic_safe=yes adequacy tag (WU-2(b), OBJ-11)', () => {
  const seed = buildSemanticSeed(seedInput);
  const agentYes = (adequacy?: 'l1_met' | 'l2_passed' | 'none') =>
    applySemanticVerdict(seed, {
      semanticSafe: 'yes',
      oldMeaning: 'null = 미존재',
      compatibility: 'additive',
      modelVersion: 'claude-opus-4-8',
      characterizationTestRef: 'tests/user.test.ts::x',
      ...(adequacy ? { characterizationAdequacy: adequacy as 'l1_met' | 'l2_passed' } : {}),
    });

  test('agent yes with characterization but adequacy=none is rejected (ref existence insufficient)', () => {
    expect(acgSemanticCompatibility.safeParse(agentYes()).success).toBe(false);
    expect(acgSemanticCompatibility.safeParse(agentYes('none')).success).toBe(false);
  });

  test('agent yes with adequacy=l1_met or l2_passed clears', () => {
    expect(acgSemanticCompatibility.safeParse(agentYes('l1_met')).success).toBe(true);
    expect(acgSemanticCompatibility.safeParse(agentYes('l2_passed')).success).toBe(true);
  });

  test('user-produced yes is accepted without an adequacy tag (human attestation exempt)', () => {
    const userArtifact = {
      schema_version: '0.1.0',
      kind: 'acg.semantic-compatibility.v1',
      work_item_id: 'wi_seedtst01',
      produced_by: 'user',
      produced_at: '2026-06-05T00:00:00Z',
      changes: [
        {
          before: PAIR.before,
          after: PAIR.after,
          old_meaning: 'null = 미존재',
          compatibility: 'additive',
          verdict: { type_safe: true, semantic_safe: 'yes' },
        },
      ],
    };
    expect(acgSemanticCompatibility.safeParse(userArtifact).success).toBe(true);
  });
});
