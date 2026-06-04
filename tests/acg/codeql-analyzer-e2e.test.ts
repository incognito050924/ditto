import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeqlEdgeAnalyzer } from '~/acg/boundary/codeql-edges';
import { CodeqlImpactAnalyzer } from '~/acg/impact/codeql-analyzer';
import { makeRelationDeps } from '~/core/codeql/host-deps';

/**
 * CodeQL 분석기 e2e (ADR-0006, wi_260604cqe ac-5) — opt-in.
 *
 * 단위 테스트(codeql-relations.test.ts)는 분류·순수부만 검증한다. 추출 정확성, 특히
 * ts-analyzer의 핵심 속성 "symbol resolution, not text search"(동명이인 decoy 구분)는
 * 실제 CodeQL이 있어야 검증된다. 기본 skip; 실행하려면:
 *   CODEQL_E2E=1 CODEQL_BIN=~/.local/bin/codeql bun test tests/acg/codeql-analyzer-e2e.test.ts
 */
const CODEQL_BIN = process.env.CODEQL_BIN ?? `${process.env.HOME}/.local/bin/codeql`;
const enabled = process.env.CODEQL_E2E === '1' && existsSync(CODEQL_BIN);
const d = enabled ? describe : describe.skip;

d('CodeqlImpactAnalyzer — symbol resolution (real CodeQL)', () => {
  test('finds real caller + test ref, marks exported surface, excludes same-named decoy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-cqe2e-'));
    try {
      await writeFile(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { module: 'esnext', target: 'esnext' },
          include: ['*.ts'],
        }),
      );
      await writeFile(
        join(dir, 'lib.ts'),
        'export function charge(u: string): number {\n  return u.length;\n}\n',
      );
      await writeFile(
        join(dir, 'app.ts'),
        "import { charge } from './lib';\nexport function run(): number {\n  return charge('u1');\n}\n",
      );
      // decoy: a DIFFERENT local symbol also named `charge` (text search would false-match)
      await writeFile(
        join(dir, 'decoy.ts'),
        'function charge(): string {\n  return "x";\n}\nexport const v = charge();\n',
      );
      await writeFile(
        join(dir, 'lib.test.ts'),
        "import { charge } from './lib';\nconst _ = charge('t');\n",
      );

      const cacheDir = await mkdtemp(join(tmpdir(), 'ditto-cqe2e-cache-'));
      const analyzer = new CodeqlImpactAnalyzer(
        {
          symbol: 'charge',
          declFile: 'lib.ts',
          language: 'javascript',
          repoRoot: dir,
          cacheDir,
          binary: CODEQL_BIN,
        },
        makeRelationDeps(),
      );
      const res = await analyzer.analyze({ changeTarget: 'charge', sourceRoot: dir });
      const has = (kind: string, path: string) =>
        res.affected.some((n) => n.kind === kind && n.path === path);

      expect(has('direct_caller', 'app.ts')).toBe(true); // real caller
      expect(has('test', 'lib.test.ts')).toBe(true); // test reference
      expect(has('external_surface', 'lib.ts')).toBe(true); // exported surface
      // the decoy's local `charge` must NOT be matched (symbol resolution, not text search)
      expect(res.affected.some((n) => n.path === 'decoy.ts')).toBe(false);

      await rm(cacheDir, { recursive: true, force: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

d('CodeqlEdgeAnalyzer — import edge + alias (real CodeQL)', () => {
  test('relative import resolves to repo-path; package stays verbatim', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-cqe2e-edge-'));
    try {
      await writeFile(
        join(dir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { module: 'esnext' }, include: ['src/**/*.ts'] }),
      );
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'b.ts'), 'export const x = 1;\n');
      await writeFile(join(dir, 'src', 'a.ts'), "import { x } from './b';\nexport const y = x;\n");

      const cacheDir = await mkdtemp(join(tmpdir(), 'ditto-cqe2e-edge-cache-'));
      const analyzer = new CodeqlEdgeAnalyzer(
        { language: 'javascript', repoRoot: dir, cacheDir, binary: CODEQL_BIN },
        makeRelationDeps(),
      );
      const edges = await analyzer.edges({ changedFiles: ['src/a.ts'], sourceRoot: dir });
      expect(edges.some((e) => e.from === 'src/a.ts' && e.to === 'src/b')).toBe(true);

      await rm(cacheDir, { recursive: true, force: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
