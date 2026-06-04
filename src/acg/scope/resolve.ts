/**
 * ScopeRef 해소 — ADR(§5 공백): ChangeContract의 추상 scope(layer/public_surface)를
 * 구체 경로 매칭으로 편다. forbidden_scope 집행(PreToolUse)이 "이 파일을 건드려도 되는가"를
 * 결정하는 데 쓴다.
 *
 * 비용 경계: PreToolUse는 매 도구 호출마다 도므로 경로기반 4종(path/glob/layer/
 * public_surface)만 즉시 해소한다. `symbol`은 호출그래프(CodeQL DB 빌드 ~9초)가 필요해
 * 매 호출 부적합 → 여기서는 매칭하지 않는다(후속: 계약 저장 시점 1회 해소해 path로 변환).
 *
 * 보수성: ArchitectureSpec이 없으면 layer/public_surface는 해소할 수 없으므로 매칭하지
 * 않는다 — 잘못된 차단(false block)보다 미집행을 택한다. fail-open 정신과 일치.
 */
import { globToRegExp, pathToLayer } from '~/acg/boundary/boundary';
import type { AcgArchitectureSpec } from '~/schemas/acg-architecture-spec';
import type { AcgScopeRef } from '~/schemas/acg-change-contract';

/** 모듈 경로의 확장자를 벗긴다(public_surface는 확장자 없는 모듈 경로). */
function stripModuleExt(p: string): string {
  return p.replace(/\.[cm]?[jt]sx?$/, '');
}

/**
 * 한 scopeRef가 repo-relative 경로를 포함하는가.
 *   path           — 정확 일치 또는 디렉터리 접두
 *   glob           — globToRegExp 매칭
 *   layer          — pathToLayer(경로 세그먼트)가 ref와 일치 (archSpec 필요)
 *   public_surface — archSpec.public_surfaces에 등재된 ref와 모듈 경로 일치/접두 (archSpec 필요)
 *   symbol         — 범위 밖(CodeQL impact 필요), 매칭하지 않음
 */
export function scopeRefMatches(
  ref: AcgScopeRef,
  repoRelPath: string,
  archSpec?: AcgArchitectureSpec,
): boolean {
  switch (ref.kind) {
    case 'path': {
      const base = ref.ref.replace(/\/$/, '');
      return repoRelPath === base || repoRelPath.startsWith(`${base}/`);
    }
    case 'glob':
      return globToRegExp(ref.ref).test(repoRelPath);
    case 'layer':
      return archSpec !== undefined && pathToLayer(repoRelPath, archSpec.layers) === ref.ref;
    case 'public_surface': {
      if (archSpec === undefined || !archSpec.public_surfaces.includes(ref.ref)) return false;
      const mod = stripModuleExt(repoRelPath);
      return mod === ref.ref || mod.startsWith(`${ref.ref}/`);
    }
    default:
      return false; // symbol — 후속
  }
}

/** forbidden_scope 중 repoRelPath를 포함하는 첫 ref(없으면 undefined). */
export function matchForbiddenScope(
  refs: readonly AcgScopeRef[],
  repoRelPath: string,
  archSpec?: AcgArchitectureSpec,
): AcgScopeRef | undefined {
  return refs.find((r) => scopeRefMatches(r, repoRelPath, archSpec));
}
