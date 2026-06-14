import { describe, expect, test } from 'bun:test';
import { buildCandidateSpec } from '~/acg/architecture/propose';
import { ratifyCandidateSpec } from '~/acg/architecture/ratify';
import { acgArchitectureSpec } from '~/schemas/acg-architecture-spec';

/**
 * ratify는 "관찰→비준→집행" 고리의 마지막 칸: agent 후보 spec을 사람이 권위 spec으로
 * 승격한다. 불변식(ADR-0004): forbidden_dependencies는 오직 사람 인자로만, 관찰 자동박제 0.
 */
describe('ratifyCandidateSpec — agent candidate → authoritative (user) spec', () => {
  const candidate = buildCandidateSpec(
    { layers: ['cli', 'core'], publicSurfaces: ['src/core/fs'] },
    '2026-06-14T00:00:00Z',
  );

  test('(a) promotes produced_by agent → user, preserves observed layers/surfaces', () => {
    const out = ratifyCandidateSpec(candidate, {
      forbidden: [],
      ratifiedAt: '2026-06-14T01:00:00Z',
    });
    expect(acgArchitectureSpec.safeParse(out).success).toBe(true);
    expect(out.produced_by).toBe('user');
    expect(out.produced_at).toBe('2026-06-14T01:00:00Z');
    expect(Object.keys(out.layers).sort()).toEqual(['cli', 'core']);
    expect(out.public_surfaces).toEqual(['src/core/fs']);
    // can_call stays empty — never auto-derived from observation.
    for (const l of Object.values(out.layers)) expect(l.can_call).toEqual([]);
  });

  test('(b) forbidden_dependencies filled ONLY from human args; observation auto-fossilize = 0', () => {
    const out = ratifyCandidateSpec(candidate, {
      forbidden: [{ from: 'core', to: 'cli', reason: 'layering' }],
      ratifiedAt: '2026-06-14T01:00:00Z',
    });
    expect(out.forbidden_dependencies).toEqual([{ from: 'core', to: 'cli', reason: 'layering' }]);

    // No --forbid → empty, even though the candidate observed a cli→core surface.
    const none = ratifyCandidateSpec(candidate, {
      forbidden: [],
      ratifiedAt: '2026-06-14T01:00:00Z',
    });
    expect(none.forbidden_dependencies).toEqual([]);
  });

  test('(c) refuses to ratify a spec that is already authoritative (produced_by=user)', () => {
    const already = ratifyCandidateSpec(candidate, {
      forbidden: [],
      ratifiedAt: '2026-06-14T01:00:00Z',
    });
    expect(() =>
      ratifyCandidateSpec(already, { forbidden: [], ratifiedAt: '2026-06-14T02:00:00Z' }),
    ).toThrow();
  });
});
