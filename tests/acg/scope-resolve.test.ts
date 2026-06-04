import { describe, expect, test } from 'bun:test';
import { matchForbiddenScope, scopeRefMatches } from '~/acg/scope/resolve';
import { acgArchitectureSpec } from '~/schemas/acg-architecture-spec';
import type { AcgScopeRef } from '~/schemas/acg-change-contract';

const archSpec = acgArchitectureSpec.parse({
  schema_version: '0.1.0',
  kind: 'acg.architecture-spec.v1',
  produced_by: 'user',
  produced_at: '2026-06-05T00:00:00Z',
  layers: { core: { can_call: [] }, cli: { can_call: ['core'] } },
  public_surfaces: ['api/external'],
});
const ref = (kind: AcgScopeRef['kind'], r: string): AcgScopeRef => ({ kind, ref: r });

describe('scopeRefMatches', () => {
  test('path: 정확 일치 또는 디렉터리 접두', () => {
    expect(scopeRefMatches(ref('path', 'src/core/x.ts'), 'src/core/x.ts')).toBe(true);
    expect(scopeRefMatches(ref('path', 'src/core'), 'src/core/x.ts')).toBe(true);
    expect(scopeRefMatches(ref('path', 'src/core'), 'src/corex.ts')).toBe(false); // 접두 경계
    expect(scopeRefMatches(ref('path', 'src/core/x.ts'), 'src/core/y.ts')).toBe(false);
  });

  test('glob: globToRegExp 매칭', () => {
    expect(scopeRefMatches(ref('glob', 'src/**/*.ts'), 'src/a/b.ts')).toBe(true);
    expect(scopeRefMatches(ref('glob', 'src/*.ts'), 'src/a/b.ts')).toBe(false); // * 는 세그먼트 안 넘음
  });

  test('layer: archSpec 있어야 해소(경로 세그먼트)', () => {
    expect(scopeRefMatches(ref('layer', 'core'), 'src/core/x.ts', archSpec)).toBe(true);
    expect(scopeRefMatches(ref('layer', 'core'), 'src/cli/x.ts', archSpec)).toBe(false);
    expect(scopeRefMatches(ref('layer', 'core'), 'src/core/x.ts')).toBe(false); // archSpec 부재 → 보수적
  });

  test('public_surface: archSpec 등재 + 모듈 경로 일치/접두', () => {
    expect(
      scopeRefMatches(ref('public_surface', 'api/external'), 'api/external.ts', archSpec),
    ).toBe(true);
    expect(
      scopeRefMatches(ref('public_surface', 'api/external'), 'api/external/sub.ts', archSpec),
    ).toBe(true);
    expect(
      scopeRefMatches(ref('public_surface', 'api/external'), 'api/internal.ts', archSpec),
    ).toBe(false);
    expect(scopeRefMatches(ref('public_surface', 'api/other'), 'api/other.ts', archSpec)).toBe(
      false,
    ); // 미등재 surface
    expect(scopeRefMatches(ref('public_surface', 'api/external'), 'api/external.ts')).toBe(false); // archSpec 부재
  });

  test('symbol: 범위 밖 — 매칭하지 않음', () => {
    expect(scopeRefMatches(ref('symbol', 'foo'), 'src/foo.ts', archSpec)).toBe(false);
  });
});

describe('matchForbiddenScope', () => {
  test('첫 매칭 ref 반환, 없으면 undefined', () => {
    const refs = [ref('glob', 'tests/**'), ref('path', 'src/core/locked.ts')];
    expect(matchForbiddenScope(refs, 'src/core/locked.ts')?.ref).toBe('src/core/locked.ts');
    expect(matchForbiddenScope(refs, 'tests/a.test.ts')?.kind).toBe('glob');
    expect(matchForbiddenScope(refs, 'src/core/free.ts')).toBeUndefined();
  });
});
