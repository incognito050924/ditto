/**
 * forbidden_scope의 symbol kind를 선언 파일 path로 펴기 — ADR-0006 / forbidden_scope 집행.
 *
 * PreToolUse는 매 도구 호출마다 돌아 CodeQL(DB 빌드 ~9초)을 쓸 수 없다. 그래서 symbol→path
 * 해소는 ChangeContract 저장 시점(change-contract CLI, 1회)에 한다. symbol이 없으면 CodeQL을
 * 부르지 않는다(비용 0). 동명이인의 선언이 여럿이면 모두 path로 편다(forbidden=보호이므로
 * 과보호가 안전). 못 찾은 symbol은 원본 scopeRef를 유지한다(집행은 안 되나 forbidden min 1
 * 불변과 추적성 보존).
 */
import { join, relative } from 'node:path';
import { type RelationDeps, resolveSymbolDeclFiles } from '~/core/codeql/relations';
import type { CodeqlLanguage } from '~/core/codeql/runner';
import type { AcgChangeContract, AcgScopeRef } from '~/schemas/acg-change-contract';

export interface SymbolExpandCtx {
  repoRoot: string;
  sourceRoot: string;
  language: CodeqlLanguage;
  /** commit-sha 캐시 디렉터리(impact와 DB 공유). */
  cacheDir: string;
  binary?: string;
  deps: RelationDeps;
}

export interface SymbolExpandResult {
  contract: AcgChangeContract;
  /** symbol에서 생성된 path scopeRef 수. */
  resolved: number;
  /** 선언을 못 찾아 원본 유지된 symbol 이름들. */
  unresolved: string[];
}

/** forbidden_scope의 symbol kind를 선언 파일 path로 치환한 새 계약을 돌려준다. */
export async function expandForbiddenSymbols(
  contract: AcgChangeContract,
  ctx: SymbolExpandCtx,
): Promise<SymbolExpandResult> {
  if (!contract.forbidden_scope.some((r) => r.kind === 'symbol')) {
    return { contract, resolved: 0, unresolved: [] };
  }

  const out: AcgScopeRef[] = [];
  let resolved = 0;
  const unresolved: string[] = [];

  for (const ref of contract.forbidden_scope) {
    if (ref.kind !== 'symbol') {
      out.push(ref);
      continue;
    }
    const declFiles = await resolveSymbolDeclFiles(
      {
        symbol: ref.ref,
        repoRoot: ctx.repoRoot,
        sourceRoot: ctx.sourceRoot,
        language: ctx.language,
        dbPath: join(ctx.cacheDir, 'db'),
        workDir: join(ctx.cacheDir, `q-symdecl-${ref.ref}`),
        ...(ctx.binary ? { binary: ctx.binary } : {}),
      },
      ctx.deps,
    );
    // CodeQL getRelativePath는 source-root 기준이다. PreToolUse는 repo-relative로 매칭하므로
    // repo 기준으로 환산한다(source-root=repoRoot면 no-op).
    const files = declFiles.map((f) => relative(ctx.repoRoot, join(ctx.sourceRoot, f)));
    if (files.length === 0) {
      out.push(ref); // 원본 유지(추적 + forbidden min 1)
      unresolved.push(ref.ref);
      continue;
    }
    for (const f of files) {
      out.push({ kind: 'path', ref: f, note: `resolved from symbol ${ref.ref}` });
      resolved++;
    }
  }

  return { contract: { ...contract, forbidden_scope: out }, resolved, unresolved };
}
