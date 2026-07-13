import { describe, expect, test } from 'bun:test';
import { CodeqlEdgeAnalyzer } from '~/acg/boundary/codeql-edges';
import { CodeqlImpactAnalyzer } from '~/acg/impact/codeql-analyzer';
import { matchesInternalGlob } from '~/acg/impact/codeql-analyzer';
import {
  type RelationDeps,
  buildBqrsDecodeArgs,
  buildQueryRunArgs,
  parseCsvLine,
  parseCsvRows,
  relationQueries,
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
      {
        symbol: 'foo',
        declFile: 'src/a.ts',
        language: 'javascript',
        repoRoot: '/r',
        cacheDir: '/r/.cache',
      },
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

describe('matchesInternalGlob — glob 엔트리 매칭(path 엔트리는 무시)', () => {
  test('glob `domain.**`는 하위 패키지 매칭, 정확 glob은 그 패키지만, 써드파티 비매칭', () => {
    const entries = [
      { type: 'glob' as const, value: 'kr.co.ecoletree.boxwood.domain.**' },
      { type: 'glob' as const, value: 'kr.co.ecoletree.boxwood.domain' },
      { type: 'path' as const, value: '**/libs/*.jar' }, // 분류에 영향 없어야 함
    ];
    expect(matchesInternalGlob('kr.co.ecoletree.boxwood.domain', entries)).toBe(true); // 정확
    expect(matchesInternalGlob('kr.co.ecoletree.boxwood.domain.runtime.processing', entries)).toBe(
      true,
    ); // **
    expect(matchesInternalGlob('kr.co.ecoletree.boxwoodX', entries)).toBe(false); // 앵커 — 비매칭
    expect(matchesInternalGlob('org.springframework.stereotype', entries)).toBe(false); // 써드파티
  });
  test('glob 엔트리 없으면(빈 목록·path만) 항상 false', () => {
    expect(matchesInternalGlob('anything.at.all', [])).toBe(false);
    expect(matchesInternalGlob('x.y', [{ type: 'path', value: 'libs/*.jar' }])).toBe(false);
  });
});

describe('relationQueries.unresolved — 언어별 cross_repo 후보 쿼리', () => {
  test('java/kotlin은 NOT fromSource RefType 패키지, python은 import python, js는 import javascript', () => {
    expect(relationQueries('java').unresolved).toContain('not used.fromSource()');
    expect(relationQueries('kotlin').unresolved).toContain('not used.fromSource()');
    expect(relationQueries('python').unresolved).toContain('import python');
    expect(relationQueries('javascript').unresolved).toContain(
      'not exists(imp.getImportedModule())',
    );
  });
});

describe('CodeqlImpactAnalyzer — cross_repo unresolved (internal_packages prefix)', () => {
  /** impact 쿼리(q-impact*)와 unresolved 쿼리(q-xrepo)에 서로 다른 CSV를 주입하는 mock. */
  function twoQueryDeps(impactCsv: string, unresolvedCsv: string): RelationDeps {
    return {
      ...mockDeps(''),
      readText: async (p) => {
        if (!p.endsWith('.csv')) return '';
        return p.includes('q-xrepo') ? unresolvedCsv : impactCsv;
      },
    };
  }

  test('internal_packages 매칭 후보만 cross_repo로, 써드파티는 무시·(path,pkg) 중복 제거', async () => {
    const impactCsv = '"p","ln","k"\n"src/A.java",10,"value"';
    const unresolvedCsv =
      '"from","pkg"\n' +
      '"src/A.java","kr.co.ecoletree.boxwood.domain"\n' + // 형제모듈 → cross_repo
      '"src/A.java","kr.co.ecoletree.boxwood.domain"\n' + // 중복 → 1개
      '"src/B.java","kr.co.ecoletree.boxwood.error"\n' + // 형제모듈 → cross_repo
      '"src/A.java","org.springframework.stereotype"\n' + // 써드파티 → 무시
      '"src/A.java","java.lang"'; // JDK → 무시
    const analyzer = new CodeqlImpactAnalyzer(
      {
        symbol: 'foo',
        declFile: 'src/A.java',
        language: 'java',
        repoRoot: '/r',
        cacheDir: '/r/.cache',
        internalPackages: [{ type: 'glob', value: 'kr.co.ecoletree.boxwood.**' }],
      },
      twoQueryDeps(impactCsv, unresolvedCsv),
    );
    const res = await analyzer.analyze({ changeTarget: 'foo', sourceRoot: '/r' });
    expect(res.unresolved.every((u) => u.kind === 'cross_repo')).toBe(true);
    expect(res.unresolved.map((u) => u.path).sort()).toEqual(['src/A.java', 'src/B.java']);
    expect(res.unresolved.find((u) => u.path === 'src/A.java')?.reason).toContain(
      'kr.co.ecoletree.boxwood.domain',
    );
  });

  test('internal_packages 미지정이면 unresolved 쿼리를 건너뛰고 빈 배열(기존 동작 보존)', async () => {
    const analyzer = new CodeqlImpactAnalyzer(
      {
        symbol: 'foo',
        declFile: 'src/A.java',
        language: 'java',
        repoRoot: '/r',
        cacheDir: '/r/.cache',
      },
      twoQueryDeps(
        '"p","ln","k"\n"src/A.java",10,"value"',
        '"from","pkg"\n"src/A.java","kr.co.ecoletree.boxwood.x"',
      ),
    );
    const res = await analyzer.analyze({ changeTarget: 'foo', sourceRoot: '/r' });
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
