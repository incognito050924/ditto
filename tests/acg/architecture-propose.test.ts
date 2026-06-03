import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCandidateSpec, layerOf, observeArchitecture } from '~/acg/architecture/propose';
import { acgArchitectureSpec } from '~/schemas/acg-architecture-spec';

describe('buildCandidateSpec — non-authoritative candidate invariants', () => {
  test('produced_by=agent, NEVER forbidden_dependencies, layer can_call empty', () => {
    const spec = buildCandidateSpec(
      { layers: ['core', 'cli', 'core'], publicSurfaces: ['src/core/fs', 'src/core/fs'] },
      '2026-06-04T00:00:00Z',
    );
    expect(acgArchitectureSpec.safeParse(spec).success).toBe(true);
    expect(spec.produced_by).toBe('agent');
    // INVARIANT: rules are never auto-declared.
    expect(spec.forbidden_dependencies).toEqual([]);
    expect(Object.keys(spec.layers).sort()).toEqual(['cli', 'core']); // deduped + sorted
    for (const l of Object.values(spec.layers)) expect(l.can_call).toEqual([]);
    expect(spec.public_surfaces).toEqual(['src/core/fs']); // deduped
  });
});

describe('layerOf', () => {
  test('src/<layer>/file → layer; non-src → undefined', () => {
    expect(layerOf('src/core/fs.ts')).toBe('core');
    expect(layerOf('src/cli/commands/x.ts')).toBe('cli');
    expect(layerOf('tests/x.ts')).toBeUndefined();
    expect(layerOf('src/x.ts')).toBeUndefined(); // no layer dir
  });
});

describe('observeArchitecture — layers + cross-layer public surfaces from import graph', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ditto-arch-'));
    await mkdir(join(dir, 'src', 'core'), { recursive: true });
    await mkdir(join(dir, 'src', 'cli'), { recursive: true });
    await writeFile(join(dir, 'src', 'core', 'fs.ts'), 'export const read = () => 1;\n');
    // cli imports across the layer boundary → core/fs is a public surface
    await writeFile(
      join(dir, 'src', 'cli', 'run.ts'),
      "import { read } from '../core/fs';\nexport const go = () => read();\n",
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('detects both layers and the cross-layer surface', async () => {
    const obs = await observeArchitecture(dir, join(dir, 'src'));
    expect(obs.layers.sort()).toEqual(['cli', 'core']);
    expect(obs.publicSurfaces).toContain('src/core/fs');
  });

  test('the candidate built from observation still has no auto-rules', async () => {
    const obs = await observeArchitecture(dir, join(dir, 'src'));
    const spec = buildCandidateSpec(obs, '2026-06-04T00:00:00Z');
    expect(spec.forbidden_dependencies).toEqual([]);
    expect(spec.produced_by).toBe('agent');
  });
});
