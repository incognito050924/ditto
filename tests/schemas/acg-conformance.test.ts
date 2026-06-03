import { describe, expect, test } from 'bun:test';
import { acgScopeRef } from '~/schemas/acg-change-contract';
import { acgEvidenceKind } from '~/schemas/acg-common';
import { acgFitnessKind } from '~/schemas/acg-fitness-function';
import { acgImpactGraph } from '~/schemas/acg-impact-graph';
import { acgReviewGraph } from '~/schemas/acg-review-graph';

// ACG cross-ref CONFORMANCE (dialectic-4 verification_gaps). These are the
// COMPLEMENTARY checks acg-schemas.test.ts does not cover: exact spec enum-set
// alignment, journey_id reference integrity, and journey path-optionality at the
// schema level (OBJ-31/52). No schema is modified by this file.

const setOf = (values: readonly string[]) => new Set(values);

describe('ACG cross-ref enum alignment (spec ↔ Zod constants)', () => {
  test('acgEvidenceKind = exactly the 7 spec members', () => {
    expect(setOf(acgEvidenceKind.options)).toEqual(
      setOf(['test', 'build', 'log', 'diff', 'screen', 'manual', 'e2e']),
    );
    expect(acgEvidenceKind.options.length).toBe(7);
  });

  test('acgFitnessKind = exactly the 9 spec members', () => {
    expect(setOf(acgFitnessKind.options)).toEqual(
      setOf([
        'architectural',
        'dependency',
        'semantic',
        'coverage',
        'consistency',
        'performance',
        'duplication',
        'complexity',
        'user_journey',
      ]),
    );
    expect(acgFitnessKind.options.length).toBe(9);
  });

  test('acgScopeRef.kind binds surface→public_surface (no bare "surface")', () => {
    const kinds = acgScopeRef.shape.kind.options;
    expect(kinds).toContain('public_surface');
    expect(kinds).not.toContain('surface');
  });
});

const WI = 'wi_abcd1234';
const AT = '2026-06-03T00:00:00Z';
const impactBase = (nodes: unknown[]) => ({
  schema_version: '0.1.0' as const,
  kind: 'acg.impact-graph.v1' as const,
  work_item_id: WI,
  produced_by: 'agent' as const,
  produced_at: AT,
  change_target: 'foo()',
  change_type: 'rename' as const,
  affected_nodes: nodes,
});
const reviewBase = (files: unknown[]) => ({
  kind: 'acg.review-graph.v1' as const,
  files,
});

describe('ACG journey_id reference integrity (id-shaped ref, not a path)', () => {
  test('ImpactGraph journey kinds carry journey_id rather than path', () => {
    const parsed = acgImpactGraph.parse(
      impactBase([
        { kind: 'user_journey', journey_id: 'jrn-x' },
        { kind: 'ui_surface', journey_id: 'jrn-y' },
      ]),
    );
    for (const node of parsed.affected_nodes) {
      expect(node.journey_id).toBeDefined();
      expect(node.path).toBeUndefined();
    }
  });

  test('ReviewGraph journey roles carry journey_id rather than path', () => {
    const parsed = acgReviewGraph.parse(
      reviewBase([
        { role: 'user_journey', journey_id: 'jrn-x', risk: 'high', risk_reason: '여정 영향' },
        { role: 'ui', journey_id: 'jrn-y', risk: 'medium', risk_reason: 'UI 영향' },
      ]),
    );
    for (const file of parsed.files) {
      expect(file.journey_id).toBeDefined();
      expect(file.path).toBeUndefined();
    }
  });
});

describe('ACG journey path-optionality (OBJ-31/52 conformance)', () => {
  test('ImpactGraph user_journey: valid with journey_id+no path, invalid with neither', () => {
    expect(
      acgImpactGraph.safeParse(impactBase([{ kind: 'user_journey', journey_id: 'jrn-x' }])).success,
    ).toBe(true);
    expect(acgImpactGraph.safeParse(impactBase([{ kind: 'user_journey' }])).success).toBe(false);
  });

  test('ReviewGraph user_journey: valid with journey_id+no path, invalid with neither', () => {
    expect(
      acgReviewGraph.safeParse(
        reviewBase([{ role: 'user_journey', journey_id: 'jrn-x', risk: 'high', risk_reason: 'x' }]),
      ).success,
    ).toBe(true);
    expect(
      acgReviewGraph.safeParse(
        reviewBase([{ role: 'user_journey', risk: 'high', risk_reason: 'x' }]),
      ).success,
    ).toBe(false);
  });
});
