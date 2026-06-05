import { describe, expect, test } from 'bun:test';
import { CodeqlEdgeAnalyzer } from '~/acg/boundary/codeql-edges';
import { CodeqlImpactAnalyzer } from '~/acg/impact/codeql-analyzer';
import {
  IMPACT_QUERY_PY,
  type RelationDeps,
  relationQueries,
  renderEdgeQuery,
  renderQuery,
} from '~/core/codeql/relations';
import type { HostRunProcess } from '~/core/hosts/types';

// codeql 트리오 1/3: Python 바인딩. 쿼리 본문은 wi_260605py1 probe에서 합성 DB로 검증됨.

describe('relationQueries — python 템플릿', () => {
  test('python은 import python 쿼리 3종', () => {
    const q = relationQueries('python');
    expect(q.impact).toContain('import python');
    expect(q.edge).toContain('import python');
    expect(q.symbolDecl).toContain('import python');
    expect(q.impact).toContain('Call'); // 이름기반 호출 참조
  });
  test('renderEdgeQuery(python)은 import python + fromPath 필터', () => {
    const e = renderEdgeQuery(['app/handler.py'], 'python');
    expect(e).toContain('import python');
    expect(e).toContain('fromPath = "app/handler.py"');
  });
  test('renderQuery로 python impact 치환', () => {
    const r = renderQuery(IMPACT_QUERY_PY, 'extract_requester', 'app/service.py');
    expect(r).toContain('extract_requester');
    expect(r).toContain('%/app/service.py');
    expect(r).not.toContain('{{SYMBOL}}');
    expect(r).not.toContain('{{FILE}}');
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

describe('CodeqlImpactAnalyzer(python) — 테스트 파일 판정', () => {
  test('test_*.py / *_test.py / tests/ 는 test, 그 외 value는 direct_caller; decl→external_surface', async () => {
    const csv =
      '"p","ln","k"\n' +
      '"app/handler.py",4,"value"\n' +
      '"app/test_handler.py",2,"value"\n' +
      '"app/handler_test.py",2,"value"\n' +
      '"app/service.py",1,"decl"';
    const analyzer = new CodeqlImpactAnalyzer(
      {
        symbol: 'extract_requester',
        declFile: 'app/service.py',
        language: 'python',
        repoRoot: '/r',
        cacheDir: '/r/.cache',
      },
      mockDeps(csv),
    );
    const res = await analyzer.analyze({ changeTarget: 'x', sourceRoot: '/py' });
    const byKind = (k: string) => res.affected.filter((n) => n.kind === k).map((n) => n.path);
    expect(byKind('direct_caller')).toEqual(['app/handler.py']);
    expect(byKind('test').sort()).toEqual(['app/handler_test.py', 'app/test_handler.py']);
    expect(byKind('external_surface')).toEqual(['app/service.py']);
  });
});

describe('CodeqlEdgeAnalyzer(python) — .py 정규화', () => {
  test('.py 벗김, dedup', async () => {
    const csv =
      '"from","to"\n' + '"app/handler.py","app/service.py"\n' + '"app/handler.py","app/service.py"';
    const analyzer = new CodeqlEdgeAnalyzer(
      { language: 'python', repoRoot: '/r', cacheDir: '/r/.cache' },
      mockDeps(csv),
    );
    const edges = await analyzer.edges({ changedFiles: ['app/handler.py'], sourceRoot: '/py' });
    expect(edges).toEqual([{ from: 'app/handler.py', to: 'app/service' }]);
  });
});
