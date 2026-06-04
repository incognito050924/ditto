import { describe, expect, test } from 'bun:test';
import { type AnalyzerResult, buildImpactGraph } from '~/acg/impact/impact-graph';
import { acgImpactGraph } from '~/schemas/acg-impact-graph';

const baseInput = {
  workItemId: 'wi_impacttst1',
  changeTarget: 'src/x.ts: foo signature change',
  changeType: 'signature' as const,
  producedAt: '2026-06-04T00:00:00Z',
};

const emptyAnalysis: AnalyzerResult = { affected: [], unresolved: [] };

describe('buildImpactGraph — governance core (default-deny journey)', () => {
  test('user-exposed change with journeyId → user_journey affected node', () => {
    const g = buildImpactGraph(
      { ...baseInput, userExposed: true, journeyId: 'jrn-checkout' },
      emptyAnalysis,
    );
    expect(acgImpactGraph.safeParse(g).success).toBe(true);
    expect(
      g.affected_nodes.some((n) => n.kind === 'user_journey' && n.journey_id === 'jrn-checkout'),
    ).toBe(true);
    expect(g.unresolved.some((u) => u.kind === 'journey_unknown')).toBe(false);
  });

  test('user-exposed change with NO journeyId and no journey node → journey_unknown unresolved (default-deny)', () => {
    const g = buildImpactGraph({ ...baseInput, userExposed: true }, emptyAnalysis);
    expect(g.unresolved.some((u) => u.kind === 'journey_unknown')).toBe(true);
  });

  test('user-exposed change already carrying a journey affected node → no journey_unknown', () => {
    const analysis: AnalyzerResult = {
      affected: [{ kind: 'user_journey', journey_id: 'jrn-x', reason: 'analyzer found' }],
      unresolved: [],
    };
    const g = buildImpactGraph({ ...baseInput, userExposed: true }, analysis);
    expect(g.unresolved.some((u) => u.kind === 'journey_unknown')).toBe(false);
  });

  test('non-user-exposed change → no journey_unknown forced', () => {
    const g = buildImpactGraph({ ...baseInput, userExposed: false }, emptyAnalysis);
    expect(g.unresolved.some((u) => u.kind === 'journey_unknown')).toBe(false);
  });

  test('analyzer unresolved entries are preserved (never hidden)', () => {
    const analysis: AnalyzerResult = {
      affected: [],
      unresolved: [{ kind: 'dynamic_call', path: 'src/dispatch.ts', reason: 'reflection' }],
    };
    const g = buildImpactGraph(baseInput, analysis);
    expect(g.unresolved.some((u) => u.kind === 'dynamic_call')).toBe(true);
  });
});
