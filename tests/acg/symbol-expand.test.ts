import { describe, expect, test } from 'bun:test';
import { expandForbiddenSymbols } from '~/acg/scope/symbol-expand';
import type { RelationDeps } from '~/core/codeql/relations';
import type { HostRunProcess } from '~/core/hosts/types';
import { type AcgChangeContract, acgChangeContract } from '~/schemas/acg-change-contract';

/** SYMBOL_DECL 쿼리 결과 CSV를 readText로 주입하는 mock deps(spawn은 빈 출력 exit 0). */
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

function contract(forbidden: AcgChangeContract['forbidden_scope']): AcgChangeContract {
  return acgChangeContract.parse({
    schema_version: '0.1.0',
    kind: 'acg.change-contract.v1',
    work_item_id: 'wi_symexpand1',
    produced_by: 'agent',
    produced_at: '2026-06-05T00:00:00Z',
    purpose: 'symbol expand 테스트',
    allowed_scope: [],
    forbidden_scope: forbidden,
    invariants: [],
    acceptance: [{ criterion: 'g', evidence_kind: 'test' }],
    risk_default: 'low',
    decision_ref: null,
  });
}

const ctx = (deps: RelationDeps) => ({
  repoRoot: '/r',
  sourceRoot: '/r', // repoRoot = source-root → repo-relative 환산 no-op
  language: 'javascript' as const,
  cacheDir: '/r/.cache',
  deps,
});

describe('expandForbiddenSymbols', () => {
  test('symbol kind → 선언 파일 path들로 치환(원본 symbol을 note에)', async () => {
    const csv = '"p"\n"src/core/sarif.ts"\n"src/core/sarif2.ts"'; // 동명 2곳
    const r = await expandForbiddenSymbols(
      contract([
        { kind: 'glob', ref: 'tests/**' },
        { kind: 'symbol', ref: 'parseSarif' },
      ]),
      ctx(mockDeps(csv)),
    );
    expect(r.resolved).toBe(2);
    expect(r.unresolved).toEqual([]);
    expect(r.contract.forbidden_scope).toEqual([
      { kind: 'glob', ref: 'tests/**' },
      { kind: 'path', ref: 'src/core/sarif.ts', note: 'resolved from symbol parseSarif' },
      { kind: 'path', ref: 'src/core/sarif2.ts', note: 'resolved from symbol parseSarif' },
    ]);
  });

  test('symbol 없으면 그대로(CodeQL 미호출)', async () => {
    const c = contract([{ kind: 'path', ref: 'src/x.ts' }]);
    const r = await expandForbiddenSymbols(c, ctx(mockDeps('')));
    expect(r).toEqual({ contract: c, resolved: 0, unresolved: [] });
  });

  test('선언 못 찾으면 원본 symbol 유지(forbidden min 1 보존)', async () => {
    const csv = '"p"'; // 헤더만 = 0건
    const r = await expandForbiddenSymbols(
      contract([{ kind: 'symbol', ref: 'NoSuchSym' }]),
      ctx(mockDeps(csv)),
    );
    expect(r.resolved).toBe(0);
    expect(r.unresolved).toEqual(['NoSuchSym']);
    expect(r.contract.forbidden_scope).toEqual([{ kind: 'symbol', ref: 'NoSuchSym' }]);
  });
});
