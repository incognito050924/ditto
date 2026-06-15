import { describe, expect, test } from 'bun:test';
import { parseUnitScope, resolveUnitScope } from '~/acg/scope/unit-resolve';
import { acgArchitectureSpec } from '~/schemas/acg-architecture-spec';

// WU-4 ac-8 — the SHARED unit scope resolver (also imported by WU-5/N11). It maps
// an architecture UNIT to a STANDING-code file set (baseline = HEAD), reusing the
// ArchitectureSpec layers + boundary path conventions (no diff/merge-base here).

const archSpec = acgArchitectureSpec.parse({
  schema_version: '0.1.0',
  kind: 'acg.architecture-spec.v1',
  produced_by: 'user',
  produced_at: '2026-06-05T00:00:00Z',
  layers: { core: { can_call: [] }, cli: { can_call: ['core'] }, controller: { can_call: [] } },
  public_surfaces: ['api/external'],
});

// A controlled standing-code file layout (repo-relative paths).
const files = [
  'src/core/fs.ts',
  'src/core/charter.ts',
  'src/cli/index.ts',
  'src/cli/commands/refactor.ts',
  'src/controller/user-controller.ts',
  'src/routes/health.ts',
  'src/acg/scope/unit-resolve.ts',
];

describe('parseUnitScope — unit string → structured scope', () => {
  test('all / api / layer:<name> / component:<name> / <glob>', () => {
    expect(parseUnitScope('all')).toEqual({ kind: 'all' });
    expect(parseUnitScope('api')).toEqual({ kind: 'api' });
    expect(parseUnitScope('layer:core')).toEqual({ kind: 'layer', name: 'core' });
    expect(parseUnitScope('component:scope')).toEqual({ kind: 'component', name: 'scope' });
    expect(parseUnitScope('src/**/*.ts')).toEqual({ kind: 'glob', glob: 'src/**/*.ts' });
  });

  test('layer:/component: with empty name is rejected', () => {
    expect(() => parseUnitScope('layer:')).toThrow();
    expect(() => parseUnitScope('component:')).toThrow();
  });
});

describe('resolveUnitScope — unit → standing-code file set (ac-8)', () => {
  test('all → the whole standing file set', () => {
    expect(resolveUnitScope(parseUnitScope('all'), files, archSpec).sort()).toEqual(
      [...files].sort(),
    );
  });

  test('layer:<name> → files whose path segment is that layer', () => {
    expect(resolveUnitScope(parseUnitScope('layer:cli'), files, archSpec).sort()).toEqual(
      ['src/cli/commands/refactor.ts', 'src/cli/index.ts'].sort(),
    );
    expect(resolveUnitScope(parseUnitScope('layer:core'), files, archSpec).sort()).toEqual(
      ['src/core/charter.ts', 'src/core/fs.ts'].sort(),
    );
  });

  test('component:<name> → files under src/<name>/ (top-level src component dir)', () => {
    expect(resolveUnitScope(parseUnitScope('component:scope'), files, archSpec)).toEqual([]);
    // component maps to the top-level src dir segment, e.g. `acg`
    expect(resolveUnitScope(parseUnitScope('component:acg'), files, archSpec).sort()).toEqual(
      ['src/acg/scope/unit-resolve.ts'].sort(),
    );
  });

  test('api → controllers/routes layer files (REST API surface)', () => {
    expect(resolveUnitScope(parseUnitScope('api'), files, archSpec).sort()).toEqual(
      ['src/controller/user-controller.ts', 'src/routes/health.ts'].sort(),
    );
  });

  test('<glob> → glob match against repo-relative paths', () => {
    expect(resolveUnitScope(parseUnitScope('src/cli/**'), files, archSpec).sort()).toEqual(
      ['src/cli/commands/refactor.ts', 'src/cli/index.ts'].sort(),
    );
  });

  test('layer:<name> without archSpec resolves nothing (conservative — false-block 회피)', () => {
    expect(resolveUnitScope(parseUnitScope('layer:core'), files, undefined)).toEqual([]);
  });
});
