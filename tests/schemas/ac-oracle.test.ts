import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  test('on-disk intent.json fixtures still parse under the new schema', () => {
    const repoRoot = join(import.meta.dir, '..', '..');
    const wiDir = join(repoRoot, '.ditto', 'local', 'work-items');
    const glob = new Bun.Glob('*/intent.json');
    const files = [...glob.scanSync({ cwd: wiDir, absolute: true })];
    // There are on-disk intents authored before the oracle field existed.
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const json = JSON.parse(readFileSync(file, 'utf8'));
      const result = intentContract.safeParse(json);
      if (!result.success) {
        throw new Error(`legacy intent failed to parse: ${file}\n${result.error}`);
      }
      expect(result.success).toBe(true);
    }
  });
});
