import { describe, expect, test } from 'bun:test';
import { CodeqlEdgeAnalyzer } from '~/acg/boundary/codeql-edges';
import { CodeqlImpactAnalyzer } from '~/acg/impact/codeql-analyzer';
import {
  type RelationDeps,
  buildBqrsDecodeArgs,
  buildQueryRunArgs,
  parseCsvLine,
  parseCsvRows,
  renderEdgeQuery,
  renderQuery,
} from '~/core/codeql/relations';
import type { HostRunProcess } from '~/core/hosts/types';

// ── 순수부 ────────────────────────────────────────────────────────────────

describe('renderQuery — symbol 치환 + 주입 방지', () => {
  test('식별자는 치환된다', () => {
    expect(renderQuery('x {{SYMBOL}} y {{SYMBOL}}', 'parseSarif')).toBe(
      'x parseSarif y parseSarif',
    );
  });
  test('식별자 아닌 입력은 throw (쿼리 주입 차단)', () => {
    for (const bad of ['"; foo', 'a b', 'a-b', 'a()', '', '1abc']) {
      expect(() => renderQuery('{{SYMBOL}}', bad)).toThrow();
    }
  });
  test('file 인자는 {{FILE}}을 치환(따옴표 제거)하고, 없으면 그대로', () => {
    expect(renderQuery('{{SYMBOL}} in {{FILE}}', 'foo', 'core/x.ts')).toBe('foo in core/x.ts');
    expect(renderQuery('{{SYMBOL}} in {{FILE}}', 'foo', 'a"b.ts')).toBe('foo in ab.ts');
    expect(renderQuery('{{SYMBOL}}', 'foo')).toBe('foo');
  });
});

describe('renderEdgeQuery — 파일 필터', () => {
  test('빈 목록 → any() (전체)', () => {
    expect(renderEdgeQuery([])).toContain('any()');
  });
  test('파일 목록 → fromPath OR 필터', () => {
    const q = renderEdgeQuery(['src/a.ts', 'src/b.ts']);
    expect(q).toContain('fromPath = "src/a.ts" or fromPath = "src/b.ts"');
    expect(q).not.toContain('any()');
  });
  test('공백/빈 항목은 제거', () => {
    expect(renderEdgeQuery([' ', ''])).toContain('any()');
  });
});

describe('CSV 파싱', () => {
  test('parseCsvLine — 따옴표·쉼표·이스케이프', () => {
    expect(parseCsvLine('"a,b",10,"c"')).toEqual(['a,b', '10', 'c']);
    expect(parseCsvLine('"he said ""hi""",1,"x"')).toEqual(['he said "hi"', '1', 'x']);
  });
  test('parseCsvRows — 헤더 1줄 제거, 빈/헤더만 → []', () => {
    expect(parseCsvRows('"p","l","k"\n"a",1,"type"')).toEqual([['a', '1', 'type']]);
    expect(parseCsvRows('"p","l","k"')).toEqual([]);
    expect(parseCsvRows('')).toEqual([]);
  });
});

describe('명령 인자 구성', () => {
  test('buildQueryRunArgs', () => {
    expect(buildQueryRunArgs({ dbPath: '/db', queryPath: '/q.ql', bqrsOut: '/o.bqrs' })).toEqual([
      'query',
      'run',
      '--database=/db',
      '--output=/o.bqrs',
      '/q.ql',
    ]);
  });
  test('buildBqrsDecodeArgs — 결과를 stdout 아닌 --output 파일로', () => {
    expect(buildBqrsDecodeArgs('/o.bqrs', '/o.csv')).toEqual([
      'bqrs',
      'decode',
      '--format=csv',
      '--output=/o.csv',
      '/o.bqrs',
    ]);
  });
});

// ── 분석기 분류 (mock deps로 CodeQL CSV 주입) ───────────────────────────────

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
    dirExists: async () => true, // DB 존재로 간주 → create spawn 생략
  };
}

describe('CodeqlImpactAnalyzer — CSV raw_kind → AcgAffectedNode 분류', () => {
  test('type→type_contract, import/value→(test파일?test:direct_caller), decl→external_surface', async () => {
    const csv =
      '"p","ln","k"\n' +
      '"src/a.ts",10,"type"\n' +
      '"src/a.test.ts",5,"value"\n' +
      '"src/b.ts",3,"import"\n' +
      '"src/b.spec.ts",7,"import"\n' +
      '"src/lib.ts",1,"decl"';
    const analyzer = new CodeqlImpactAnalyzer(
      { symbol: 'foo', language: 'javascript', repoRoot: '/r', cacheDir: '/r/.cache' },
      mockDeps(csv),
    );
    const res = await analyzer.analyze({ changeTarget: 'foo', sourceRoot: '/r' });
    const byKind = (k: string) => res.affected.filter((n) => n.kind === k).map((n) => n.path);
    expect(byKind('type_contract')).toEqual(['src/a.ts']);
    expect(byKind('test').sort()).toEqual(['src/a.test.ts', 'src/b.spec.ts']);
    expect(byKind('direct_caller')).toEqual(['src/b.ts']);
    expect(byKind('external_surface')).toEqual(['src/lib.ts']);
    expect(res.unresolved).toEqual([]);
  });
});

describe('CodeqlEdgeAnalyzer — 확장자 정규화 + 중복 제거', () => {
  test('.ts 벗김, 패키지 verbatim, 동일 edge dedup', async () => {
    const csv =
      '"from","to"\n' + '"src/a.ts","src/b.ts"\n' + '"src/a.ts","zod"\n' + '"src/a.ts","src/b.ts"'; // 중복
    const analyzer = new CodeqlEdgeAnalyzer(
      { language: 'javascript', repoRoot: '/r', cacheDir: '/r/.cache' },
      mockDeps(csv),
    );
    const edges = await analyzer.edges({ changedFiles: ['src/a.ts'], sourceRoot: '/r' });
    expect(edges).toEqual([
      { from: 'src/a.ts', to: 'src/b' },
      { from: 'src/a.ts', to: 'zod' },
    ]);
  });
});
