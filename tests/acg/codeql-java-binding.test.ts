import { describe, expect, test } from 'bun:test';
import { CodeqlEdgeAnalyzer } from '~/acg/boundary/codeql-edges';
import { CodeqlImpactAnalyzer } from '~/acg/impact/codeql-analyzer';
import {
  IMPACT_QUERY_JAVA,
  type RelationDeps,
  relationQueries,
  renderEdgeQuery,
  renderQuery,
} from '~/core/codeql/relations';
import type { HostRunProcess } from '~/core/hosts/types';

// leak#1 정식 바인딩: Java 관계쿼리 템플릿 + 언어별 후처리.

describe('relationQueries — 언어별 템플릿 선택', () => {
  test('java는 java 템플릿(import java)을 돌려준다', () => {
    const q = relationQueries('java');
    expect(q.impact).toContain('import java');
    expect(q.edge).toContain('import java');
    expect(q.symbolDecl).toContain('import java');
    expect(q.impact).toContain('getMethod()'); // resolved-callee 정밀도
  });
  test('javascript는 여전히 js 템플릿', () => {
    expect(relationQueries('javascript').impact).toContain('import javascript');
  });
  test('미등록 언어(ruby)는 명시적 throw', () => {
    expect(() => relationQueries('ruby')).toThrow(/not bound for language 'ruby'/);
  });
});

describe('renderEdgeQuery — 언어별 edge 템플릿', () => {
  test('java edge는 import java + fromPath 필터', () => {
    const q = renderEdgeQuery(['src/main/java/A.java'], 'java');
    expect(q).toContain('import java');
    expect(q).toContain('fromPath = "src/main/java/A.java"');
  });
  test('빈 목록 ⇒ any()', () => {
    expect(renderEdgeQuery([], 'java')).toContain('any()');
  });
});

describe('renderQuery — Java impact 템플릿 치환', () => {
  test('{{SYMBOL}}·{{FILE}} 치환', () => {
    const q = renderQuery(
      IMPACT_QUERY_JAVA,
      'extractRequesterName',
      'BoxwoodHistoryEventHandler.java',
    );
    expect(q).toContain('m.getName() = "extractRequesterName"');
    expect(q).toContain('"%/BoxwoodHistoryEventHandler.java"');
    expect(q).not.toContain('{{SYMBOL}}');
    expect(q).not.toContain('{{FILE}}');
  });
});

/** spawn은 빈 출력 + exit 0, readText(csvOut)만 주입 CSV를 돌려주는 mock deps. */
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

describe('CodeqlImpactAnalyzer(java) — 테스트 파일 판정', () => {
  test('src/test/java 와 *Test.java 는 test, 그 외 value는 direct_caller; decl→external_surface', async () => {
    const csv =
      '"p","ln","k"\n' +
      '"src/main/java/A.java",10,"type"\n' +
      '"src/test/java/AReqTest.java",5,"value"\n' +
      '"src/main/java/Caller.java",3,"value"\n' +
      '"src/main/java/A.java",1,"decl"';
    const analyzer = new CodeqlImpactAnalyzer(
      {
        symbol: 'foo',
        declFile: 'A.java',
        language: 'java',
        repoRoot: '/r',
        cacheDir: '/r/.cache',
        buildMode: 'none',
      },
      mockDeps(csv),
    );
    const res = await analyzer.analyze({ changeTarget: 'foo', sourceRoot: '/boxwood' });
    const byKind = (k: string) => res.affected.filter((n) => n.kind === k).map((n) => n.path);
    expect(byKind('type_contract')).toEqual(['src/main/java/A.java']);
    expect(byKind('test')).toEqual(['src/test/java/AReqTest.java']);
    expect(byKind('direct_caller')).toEqual(['src/main/java/Caller.java']);
    expect(byKind('external_surface')).toEqual(['src/main/java/A.java']);
  });
});

describe('CodeqlEdgeAnalyzer(java) — .java 정규화', () => {
  test('.java 벗김, 패키지 specifier verbatim, dedup', async () => {
    const csv =
      '"from","to"\n' +
      '"src/main/java/A.java","src/main/java/B.java"\n' +
      '"src/main/java/A.java","org.springframework.Foo"\n' +
      '"src/main/java/A.java","src/main/java/B.java"';
    const analyzer = new CodeqlEdgeAnalyzer(
      { language: 'java', repoRoot: '/r', cacheDir: '/r/.cache', buildMode: 'none' },
      mockDeps(csv),
    );
    const edges = await analyzer.edges({
      changedFiles: ['src/main/java/A.java'],
      sourceRoot: '/boxwood',
    });
    expect(edges).toEqual([
      { from: 'src/main/java/A.java', to: 'src/main/java/B' },
      { from: 'src/main/java/A.java', to: 'org.springframework.Foo' },
    ]);
  });
});
