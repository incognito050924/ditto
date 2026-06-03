import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBoundary, globToRegExp, pathToLayer } from '~/acg/boundary/boundary';
import { TsEdgeAnalyzer } from '~/acg/boundary/ts-edges';
import { acgArchitectureSpec } from '~/schemas/acg-architecture-spec';

const spec = (o: Record<string, unknown> = {}) =>
  acgArchitectureSpec.parse({
    schema_version: '0.1.0',
    kind: 'acg.architecture-spec.v1',
    produced_by: 'user',
    produced_at: '2026-06-04T00:00:00Z',
    layers: {
      controller: { can_call: ['service'] },
      service: { can_call: ['repository'] },
      repository: { can_call: [] },
    },
    forbidden_dependencies: [
      {
        from: 'automation-engine/**',
        to: 'portal-backend/**',
        reason: '엔진은 포털을 REST로만 호출',
      },
    ],
    ...o,
  });

describe('globToRegExp', () => {
  test('** spans path segments, * does not', () => {
    expect(globToRegExp('automation-engine/**').test('automation-engine/a/b.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
  });
});

describe('pathToLayer', () => {
  test('layer = layers-key appearing as a path segment', () => {
    const layers = spec().layers;
    expect(pathToLayer('app/controller/UserController.ts', layers)).toBe('controller');
    expect(pathToLayer('app/repository/UserRepo.ts', layers)).toBe('repository');
    expect(pathToLayer('app/util/x.ts', layers)).toBeUndefined();
  });
});

describe('checkBoundary', () => {
  test('forbidden_dependency edge → violation', () => {
    const v = checkBoundary(spec(), [
      { from: 'automation-engine/run.ts', to: 'portal-backend/api.ts' },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('forbidden_dependency');
  });

  test('allowed edge → no violation', () => {
    const v = checkBoundary(spec(), [{ from: 'automation-engine/run.ts', to: 'commons/util.ts' }]);
    expect(v).toHaveLength(0);
  });

  test('layer rule: controller→repository is forbidden (can_call only service)', () => {
    const v = checkBoundary(spec(), [{ from: 'app/controller/U.ts', to: 'app/repository/R.ts' }]);
    expect(v.some((x) => x.rule === 'layer')).toBe(true);
  });

  test('layer rule: controller→service is allowed', () => {
    const v = checkBoundary(spec(), [{ from: 'app/controller/U.ts', to: 'app/service/S.ts' }]);
    expect(v.some((x) => x.rule === 'layer')).toBe(false);
  });
});

describe('TsEdgeAnalyzer — reads the import graph', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ditto-boundary-'));
    await mkdir(join(dir, 'app', 'controller'), { recursive: true });
    await mkdir(join(dir, 'app', 'repository'), { recursive: true });
    await writeFile(join(dir, 'app', 'repository', 'R.ts'), 'export const r = 1;\n');
    await writeFile(
      join(dir, 'app', 'controller', 'U.ts'),
      "import { r } from '../repository/R';\nexport const u = r;\n",
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('extracts a relative import as a repo-relative edge', async () => {
    const edges = await new TsEdgeAnalyzer(dir).edges({
      changedFiles: ['app/controller/U.ts'],
      sourceRoot: dir,
    });
    expect(edges).toHaveLength(1);
    expect(edges[0].from).toBe('app/controller/U.ts');
    expect(edges[0].to).toBe('app/repository/R');
  });

  test('extracted edge feeds the layer rule (controller→repository violation)', async () => {
    const edges = await new TsEdgeAnalyzer(dir).edges({
      changedFiles: ['app/controller/U.ts'],
      sourceRoot: dir,
    });
    const v = checkBoundary(spec(), edges);
    expect(v.some((x) => x.rule === 'layer')).toBe(true);
  });
});

describe('TsEdgeAnalyzer — tsconfig path-alias resolution (no false-clean)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ditto-alias-'));
    await writeFile(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '~/*': ['./src/*'] } },
        include: ['src/**/*'],
      }),
    );
    await mkdir(join(dir, 'src', 'schemas'), { recursive: true });
    await mkdir(join(dir, 'src', 'cli'), { recursive: true });
    await writeFile(join(dir, 'src', 'schemas', 'x.ts'), 'export const x = 1;\n');
    // imports via the ~ path alias, NOT a relative path
    await writeFile(
      join(dir, 'src', 'cli', 'run.ts'),
      "import { x } from '~/schemas/x';\nexport const y = x;\n",
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('~/ alias resolves to a repo-relative src/ path', async () => {
    const edges = await new TsEdgeAnalyzer(dir).edges({
      changedFiles: ['src/cli/run.ts'],
      sourceRoot: join(dir, 'src'),
    });
    expect(edges).toHaveLength(1);
    expect(edges[0].to).toBe('src/schemas/x'); // resolved, not the raw `~/schemas/x`
  });

  test('REGRESSION: a src-form forbidden rule now catches an alias import (was false-clean)', async () => {
    const archSpec = acgArchitectureSpec.parse({
      schema_version: '0.1.0',
      kind: 'acg.architecture-spec.v1',
      produced_by: 'user',
      produced_at: '2026-06-04T00:00:00Z',
      forbidden_dependencies: [
        {
          from: 'src/cli/**',
          to: 'src/schemas/**',
          reason: 'CLI must not import schemas directly',
        },
      ],
    });
    const edges = await new TsEdgeAnalyzer(dir).edges({
      changedFiles: ['src/cli/run.ts'],
      sourceRoot: join(dir, 'src'),
    });
    const v = checkBoundary(archSpec, edges);
    expect(v.some((x) => x.rule === 'forbidden_dependency')).toBe(true);
  });
});
