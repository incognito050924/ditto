import { describe, expect, test } from 'bun:test';
import { CodeqlEdgeAnalyzer } from '~/acg/boundary/codeql-edges';
import { CodeqlImpactAnalyzer } from '~/acg/impact/codeql-analyzer';
import { type RelationDeps, relationQueries } from '~/core/codeql/relations';
import { buildCreateArgs, codeqlExtractorLanguage, selectBuildMode } from '~/core/codeql/runner';
import type { HostRunProcess } from '~/core/hosts/types';

// codeql 트리오 2/3: Kotlin 바인딩. java(java-kotlin) 추출기 재사용 + buildless 금지(안전).

describe('Kotlin 추출기 매핑 + build-mode 안전', () => {
  test('codeqlExtractorLanguage: kotlin→java, 그 외 그대로', () => {
    expect(codeqlExtractorLanguage('kotlin')).toBe('java');
    expect(codeqlExtractorLanguage('java')).toBe('java');
    expect(codeqlExtractorLanguage('python')).toBe('python');
  });
  test('kotlin은 NO_BUILD가 아니라 빌드 강제(none 절대 안 됨) — false-clean 차단', () => {
    expect(selectBuildMode('kotlin')).toBe('autobuild');
    expect(selectBuildMode('kotlin', './gradlew compileKotlin')).toBe('manual');
  });
  test('buildCreateArgs는 codeql --language=java로 방출(kotlin 라벨이어도)', () => {
    const args = buildCreateArgs({
      dbPath: '/db',
      language: 'kotlin',
      sourceRoot: '/src',
      buildMode: 'autobuild',
    });
    expect(args).toContain('--language=java');
    expect(args).toContain('--build-mode=autobuild');
  });
  test('relationQueries(kotlin)은 java 템플릿 재사용(import java)', () => {
    expect(relationQueries('kotlin').impact).toContain('import java');
    expect(relationQueries('kotlin').impact).toBe(relationQueries('java').impact);
  });
});

function mockDeps(csv: string): RelationDeps {
  const proc = (): HostRunProcess => ({
    entrypoint: 'codeql',
    stdout: new Response('').body as ReadableStream<Uint8Array>,
    stderr: new Response('').body as ReadableStream<Uint8Array>,
    completion: Promise.resolve({ exit_code: 0, model_reported: null }),
  });
  return {
    spawn: proc,
    readText: async (p) => (p.endsWith('.csv') ? csv : ''),
    fileExists: async () => false,
    drain: (s) => new Response(s).text(),
    writeText: async () => {},
    ensureDir: async () => {},
    dirExists: async () => true,
  };
}

describe('CodeqlImpactAnalyzer(kotlin) — .kt 테스트 판정', () => {
  test('src/test/kotlin·*Test.kt는 test, 그 외 value는 direct_caller', async () => {
    const csv =
      '"p","ln","k"\n' +
      '"src/main/kotlin/app/Handler.kt",3,"value"\n' +
      '"src/test/kotlin/app/HandlerTest.kt",2,"value"\n' +
      '"src/main/kotlin/app/Service.kt",1,"decl"';
    const analyzer = new CodeqlImpactAnalyzer(
      {
        symbol: 'foo',
        declFile: 'Service.kt',
        language: 'kotlin',
        repoRoot: '/r',
        cacheDir: '/r/.c',
      },
      mockDeps(csv),
    );
    const res = await analyzer.analyze({ changeTarget: 'foo', sourceRoot: '/kt' });
    const byKind = (k: string) => res.affected.filter((n) => n.kind === k).map((n) => n.path);
    expect(byKind('direct_caller')).toEqual(['src/main/kotlin/app/Handler.kt']);
    expect(byKind('test')).toEqual(['src/test/kotlin/app/HandlerTest.kt']);
    expect(byKind('external_surface')).toEqual(['src/main/kotlin/app/Service.kt']);
  });
});

describe('CodeqlEdgeAnalyzer(kotlin) — .kt 정규화', () => {
  test('.kt 벗김, dedup', async () => {
    const csv =
      '"from","to"\n' +
      '"src/main/kotlin/app/Handler.kt","src/main/kotlin/app/Service.kt"\n' +
      '"src/main/kotlin/app/Handler.kt","src/main/kotlin/app/Service.kt"';
    const analyzer = new CodeqlEdgeAnalyzer(
      { language: 'kotlin', repoRoot: '/r', cacheDir: '/r/.c' },
      mockDeps(csv),
    );
    const edges = await analyzer.edges({
      changedFiles: ['src/main/kotlin/app/Handler.kt'],
      sourceRoot: '/kt',
    });
    expect(edges).toEqual([
      { from: 'src/main/kotlin/app/Handler.kt', to: 'src/main/kotlin/app/Service' },
    ]);
  });
});
