import { describe, expect, test } from 'bun:test';

import {
  type ArchitectureSpec,
  type ArchitectureSpecSource,
  architectureSpec,
  buildCandidateSpec,
  isAuthoritative,
  loadAuthoritativeSpec,
  ratifyCandidateSpec,
} from './architecture-spec';

const PRODUCED_AT = '2026-07-24T00:00:00.000Z';

function userSpec(overrides: Partial<ArchitectureSpec> = {}): ArchitectureSpec {
  return architectureSpec.parse({
    produced_by: 'user',
    produced_at: PRODUCED_AT,
    layers: { core: { can_call: ['util'] }, util: { can_call: [] } },
    public_surfaces: ['core/index'],
    forbidden_dependencies: [
      { from: 'util', to: 'core', reason: 'util must not depend on core' },
    ],
    ...overrides,
  });
}

describe('ArchitectureSpec authority (ADR-0004 Q3: user-authority default)', () => {
  test('produced_by=user is authoritative; produced_by=agent is not', () => {
    expect(isAuthoritative(userSpec())).toBe(true);
    expect(
      isAuthoritative(buildCandidateSpec({ layers: [], publicSurfaces: [] }, PRODUCED_AT)),
    ).toBe(false);
  });
});

describe('ArchitectureSpec source is DEFERRED/pluggable (ADR-0004 Q3)', () => {
  test('the core never hardcodes where the spec comes from — an injected source supplies it', async () => {
    const spec = userSpec();
    const fromSource: ArchitectureSpecSource = { load: async () => spec };
    expect(await loadAuthoritativeSpec(fromSource)).toEqual(spec);
  });

  test('an absent source yields undefined (no spec provisioned yet — never a fabricated one)', async () => {
    const empty: ArchitectureSpecSource = { load: async () => undefined };
    expect(await loadAuthoritativeSpec(empty)).toBeUndefined();
  });

  test('a NON-authoritative (agent candidate) source is refused as the authoritative spec', async () => {
    const candidate = buildCandidateSpec(
      { layers: ['core'], publicSurfaces: ['core/index'] },
      PRODUCED_AT,
    );
    const candidateSource: ArchitectureSpecSource = { load: async () => candidate };
    // The candidate is loadable but not authoritative → not returned as the spec.
    expect(await loadAuthoritativeSpec(candidateSource)).toBeUndefined();
  });
});

describe('agent candidate NEVER auto-fossilizes rules (ADR-0004 Q3)', () => {
  test('buildCandidateSpec is produced_by=agent with EMPTY forbidden_dependencies always', () => {
    const candidate = buildCandidateSpec(
      { layers: ['core', 'util'], publicSurfaces: ['core/index'] },
      PRODUCED_AT,
    );
    expect(candidate.produced_by).toBe('agent');
    expect(candidate.forbidden_dependencies).toEqual([]);
    // layers carry names only — can_call empty (observed structure, not rules).
    expect(candidate.layers.core?.can_call).toEqual([]);
    expect(candidate.public_surfaces).toEqual(['core/index']);
  });
});

describe('ratification promotes candidate to authoritative (ADR-0004 Q3)', () => {
  test('ratify sets produced_by=user and fills forbidden_dependencies ONLY from the human', () => {
    const candidate = buildCandidateSpec(
      { layers: ['core', 'util'], publicSurfaces: [] },
      PRODUCED_AT,
    );
    const ratified = ratifyCandidateSpec(candidate, {
      forbidden: [{ from: 'util', to: 'core', reason: 'human-declared' }],
      ratifiedAt: PRODUCED_AT,
    });
    expect(ratified.produced_by).toBe('user');
    expect(isAuthoritative(ratified)).toBe(true);
    expect(ratified.forbidden_dependencies).toEqual([
      { from: 'util', to: 'core', reason: 'human-declared' },
    ]);
    // layers carried through verbatim.
    expect(Object.keys(ratified.layers).sort()).toEqual(['core', 'util']);
  });

  test('ratify with no human forbidden leaves forbidden empty (never auto-derived)', () => {
    const candidate = buildCandidateSpec({ layers: ['core'], publicSurfaces: [] }, PRODUCED_AT);
    const ratified = ratifyCandidateSpec(candidate, { forbidden: [], ratifiedAt: PRODUCED_AT });
    expect(ratified.forbidden_dependencies).toEqual([]);
  });

  test('re-ratifying an already-authoritative spec is refused (never clobber a human spec)', () => {
    expect(() =>
      ratifyCandidateSpec(userSpec(), { forbidden: [], ratifiedAt: PRODUCED_AT }),
    ).toThrow();
  });
});
