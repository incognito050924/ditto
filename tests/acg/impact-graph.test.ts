import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AnalyzerResult, buildImpactGraph } from '~/acg/impact/impact-graph';
import { TsImpactAnalyzer } from '~/acg/impact/ts-analyzer';
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

describe('TsImpactAnalyzer — symbol resolution (not text search)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ditto-impact-'));
    await writeFile(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, module: 'esnext', target: 'esnext' },
        include: ['*.ts'],
      }),
    );
    // target symbol
    await writeFile(
      join(dir, 'lib.ts'),
      'export function charge(userId: string): number {\n  return userId.length;\n}\n',
    );
    // a real caller
    await writeFile(
      join(dir, 'app.ts'),
      "import { charge } from './lib';\nexport function run(): number {\n  return charge('u1');\n}\n",
    );
    // a decoy: a DIFFERENT local symbol also named `charge` (text search would false-match)
    await writeFile(
      join(dir, 'decoy.ts'),
      'function charge(): string {\n  return "local";\n}\nexport const v = charge();\n',
    );
    // a test file referencing the target
    await writeFile(
      join(dir, 'lib.test.ts'),
      "import { charge } from './lib';\nconst _ = charge('t');\n",
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('finds the real caller + test reference, excludes the same-named decoy, marks exported surface', async () => {
    const analyzer = new TsImpactAnalyzer({
      file: 'lib.ts',
      symbol: 'charge',
      tsconfigPath: join(dir, 'tsconfig.json'),
    });
    const res = await analyzer.analyze({ changeTarget: 'charge', sourceRoot: dir });

    const paths = res.affected.map((n) => `${n.kind}:${n.path}`);
    // app.ts is a real caller of the imported `charge`
    expect(res.affected.some((n) => n.path === 'app.ts' && n.kind === 'direct_caller')).toBe(true);
    // the test-file reference is classified as `test`
    expect(res.affected.some((n) => n.path === 'lib.test.ts' && n.kind === 'test')).toBe(true);
    // exported → external_surface on the declaring file
    expect(res.affected.some((n) => n.kind === 'external_surface' && n.path === 'lib.ts')).toBe(
      true,
    );
    // the decoy's local `charge` must NOT be matched (symbol resolution, not text)
    expect(res.affected.some((n) => n.path === 'decoy.ts')).toBe(false);
    expect(paths.length).toBeGreaterThan(0);
  });

  test('unknown symbol → unresolved, not a false-clean empty graph', async () => {
    const analyzer = new TsImpactAnalyzer({
      file: 'lib.ts',
      symbol: 'nope',
      tsconfigPath: join(dir, 'tsconfig.json'),
    });
    const res = await analyzer.analyze({ changeTarget: 'nope', sourceRoot: dir });
    expect(res.affected).toHaveLength(0);
    expect(res.unresolved.length).toBeGreaterThan(0);
  });
});
