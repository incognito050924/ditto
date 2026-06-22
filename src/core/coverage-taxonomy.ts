/**
 * Far-field pre-mortem taxonomy — the always-on category FLOOR (design §6-floor,
 * wi_260622vjo). Each category is a probing QUESTION (a lens the sweep must answer
 * for the change's scope), NOT a bare noun (ac-1). The floor is the code default;
 * a project enables/disables/adds categories via tier-② (git-tracked) config
 * (ac-10) — wired in a later slice. These lenses seed `cross_cutting_constraints`
 * (coverage-loop.ts) so the fresh judge sees every far-field domain instead of
 * only what it happens to recall — closing the `cross_cutting_constraints:[]` gap
 * (design §2/§3, §8-1).
 *
 * The floor is cross-validated against established taxonomies (STRIDE / OWASP /
 * CWE / FMEA / SRE — design §6-floor note). It is NOT a closed list: a
 * completeness/discovery critic may seed new categories and a graph gap forces
 * "go look" (ac-6) — handled by the engine, not by hardcoding here.
 */

import type { CoverageNode } from '~/schemas/coverage';

export interface FarFieldCategory {
  /** Stable id (kebab) — used for tier-② config enable/disable and skip records. */
  id: string;
  /** The probing question handed to the sweep as a cross-cutting lens (ac-1). */
  lens: string;
}

/**
 * The 18 floor categories (design §6-floor). Numbering follows the spec list; the
 * count lives HERE (not a hardcoded "14"/"15" in prose) so the taxonomy is the
 * single source of the category set. Lens text is the probing question the sweep
 * answers for the change's scope.
 */
export const FAR_FIELD_TAXONOMY_FLOOR: readonly FarFieldCategory[] = [
  {
    id: 'authentication',
    lens: '이 기능에 도달하는 인증 경로·방식은? (API 토큰·웹 세션·서버간 OAuth·서비스 토큰 등) 경로별 인증이 이 변경에서 일관·정확한가? 한 방식만 가정하고 다른 진입 경로를 빠뜨리지 않나?',
  },
  {
    id: 'authorization',
    lens: '이 제품의 인가(authorization) 모델은 무엇인가? (역할기반 RBAC·속성기반 ABAC·관계기반 ReBAC·ACL·소유권·테넌트 경계·OAuth 스코프·정책엔진 등 — 제품마다 다르며 RBAC가 기본값이 아니다) 이 변경이 요구·부여하는 권한이 그 모델과 일관·정확한가? 한 모델만 가정하고 다른 인가 경로를 빠뜨리지 않나? 누가 접근 가능/불가해야 하나?',
  },
  {
    id: 'auditing',
    lens: '이 동작에 감사 로그·추적이 필요한가? 누가·언제·무엇을 했는지 남나? 행위자가 행위를 부인할 수 있나, 기록은 변조내성·귀속가능(tamper-evident)한가?',
  },
  {
    id: 'data-integrity',
    lens: '데이터 손실·손상·부분쓰기·멱등·마이그레이션 영향이 있나?',
  },
  {
    id: 'boundary-edge',
    lens: '경계값/극단 입력이 있나? (0·최대·빈값·오버플로·경계 전환)',
  },
  {
    id: 'concurrency-ordering',
    lens: '레이스·락·중복·이벤트 순서 문제가 있나?',
  },
  {
    id: 'external-env',
    lens: '외부 환경(env/배포/3rd-party)으로 깨질 우려가 있나? 이 변경의 side-effect는 무엇인가(외부 API 호출·메시지 발행 등)?',
  },
  {
    id: 'failure-recovery',
    lens: '실패 지점에서 부분 recovery가 필요한가, 전체 롤백인가? 무성 실패·연쇄 실패·fallback 정확성은?',
  },
  {
    id: 'resource-abuse',
    lens: '한도·고갈·타임아웃·공유 레이트리미터·메모리·N+1·스케일 문제가 있나? 오남용 벡터: 이 흐름을 한도/쿼터보다 빠르게 악용(대량·replay·스크래핑·credential stuffing)할 수 있나, 리미터는 공유인가?',
  },
  {
    id: 'compat-version',
    lens: '하위/상위 호환·스키마/API 진화·파괴적 변경이 있나?',
  },
  {
    id: 'security-privacy',
    lens: '인젝션·시크릿 노출·PII/데이터 유출·규제 위험이 있나?',
  },
  {
    id: 'cross-feature',
    lens: '기능적으로 먼 feature와 공유 자원/상태를 건드리나? (memory graph entanglement가 주로 채움)',
  },
  {
    id: 'observability',
    lens: '로깅 공백·알림 부재·디버깅성 문제가 있나? 무성/부분 실패를 어떤 signal이 잡고, 인지까지 얼마나 걸리나?',
  },
  {
    id: 'deployment-rollout',
    lens: '적용/배포 타이밍·순서가 중요한가? 의존(받는/하는) 타 기능보다 먼저/나중 배포돼야 하나? git·릴리스 정책(브랜치 전략·feature flag·릴리스 트레인·핫픽스)과 맞나? 부분 롤아웃 중 혼재 버전이 깨지나? 마이그레이션-코드 배포 순서는?',
  },
  {
    id: 'reuse-build-vs-buy',
    lens: '신규 구현 전에 reuse→adopt→build 순으로 따졌나? (내부) 코드베이스에 이미 있는 재사용 가능한 패턴·컴포넌트를 채택했나, 아니면 재발명했나? (외부) 검증된 OSS·SDK가 있나 — 라이선스(copyleft)·비용·CVE·유지보수 활성도·공급망 위험은? 신규 구현이면 reinvent 비용·품질 리스크는? (이 렌즈는 기존 자산 채택 vs 재발명 결정 — 만들기로 한 뒤 이 변경 자체의 추상화 적정선·과잉/과소는 #minimal-increment의 몫)',
  },
  {
    id: 'input-validation',
    lens: '신뢰할 수 없는 입력의 형태·타입·의미가 사용 전에 검증되나? (malformed payload·type confusion·역직렬화 — CWE-20/502, OWASP A03/A08)',
  },
  {
    id: 'configuration',
    lens: '코드가 아닌 설정·플래그·기본값·env 값이 실패를 부르나? 새 설정이 라이브 전에 검증되나? (OWASP A05 misconfiguration)',
  },
  {
    id: 'time-clock',
    lens: '정확성이 시간 자체에 의존하나 — 만료(토큰·TTL·인증서)·타임존/DST·monotonic vs wall clock·노드 간 시계 일치?',
  },
  {
    id: 'minimal-increment',
    lens: '이게 의도를 달성하는 가장 명료하고 작은 증분인가? 추상화가 지금의 실제 복잡도에 비례하나 — 요청되지 않은 기능·설정가능성·확장성, 미래 대비/단일 사용/얕은 추상화로 과하지 않나(과잉이 흔한 실패)? 거꾸로, 이 변경이 새로 들이는 중복·반복을 마땅히 묶지 않아 모자라지 않나(중복은 버그·드리프트의 원천)? 변경한 모든 줄에 요청과 연결된 이유가 있고, 관련 없는 리팩터·포맷 정리가 섞이지 않았나? (목표는 추상화 회피가 아니라 적정 — 실제 복잡도를 줄일 때만 추상화한다. 기존 재사용 가능 자산을 채택했는지는 #reuse-build-vs-buy의 몫)',
  },
];

/**
 * The floor lenses injected into `cross_cutting_constraints` (design §8-1). Pure
 * over the floor for now; a later slice threads tier-② config (enable/disable/add,
 * ac-10) and discovery-critic additions (ac-6) through the same return shape.
 */
export function farFieldLenses(): string[] {
  return FAR_FIELD_TAXONOMY_FLOOR.map((c) => c.lens);
}

/** Coverage-node id prefix for a seeded far-field category (§8-2). */
export const CATEGORY_NODE_PREFIX = 'cov-cat-';

/**
 * Build the seeded coverage nodes for category-complete discovery (§8-2): the
 * root (original intent) plus one OPEN node per floor category. Because the
 * categories are real nodes, the existing termination predicate
 * (`isCoverageTerminated` = every node closed AND K dry) now requires every
 * category to be swept and closed — novelty-dry alone no longer terminates, and
 * an un-swept category cannot pass silently (ac-2). No new termination logic: the
 * node tree IS the per-category sweep ledger (§8-reuse). A category is skipped by
 * closing its node `out_of_scope` through the existing gated close — a recorded,
 * auditable decision, never a silent drop. The label is the probing-question lens.
 *
 * depth_weight is a neutral floor (1) here; the stakes-proportional depth dial
 * (§8-4) tunes it later. Returns root first so callers can keep `root_id`.
 */
export function farFieldCoverageNodes(intent: string, rootId = 'cov-root'): CoverageNode[] {
  const categoryIds = FAR_FIELD_TAXONOMY_FLOOR.map((c) => `${CATEGORY_NODE_PREFIX}${c.id}`);
  const root: CoverageNode = {
    id: rootId,
    parent_id: null,
    label: intent,
    origin: 'seed',
    depth_weight: 1,
    state: 'open',
    children: categoryIds,
  };
  const categories: CoverageNode[] = FAR_FIELD_TAXONOMY_FLOOR.map((c, i) => ({
    id: categoryIds[i] as string,
    parent_id: rootId,
    label: c.lens,
    origin: 'seed',
    depth_weight: 1,
    state: 'open',
    children: [],
  }));
  return [root, ...categories];
}

/**
 * Whether the far-field categories are seeded as coverage nodes (§8-2). ACTIVATED:
 * ON by default — the far-field engine is this work item's intent (exhaustive
 * coverage), and the depth dial (§8-4) keeps a low-stakes sweep shallow so the
 * full-breadth (all categories) stays affordable (ac-4/ac-8). Opt OUT with
 * DITTO_FARFIELD_CATEGORIES=0/off/false. Consumed only at the autopilot
 * `coverage-next` CLI seam (no test drives that CLI, so flipping the default is
 * test-neutral; the engine's `seedCategories` param still defaults false for direct
 * callers, ac-7). A later slice replaces this env toggle with an entry intensity
 * option (ac-4) + tier-② project config (ac-10).
 */
export function farFieldCategoriesEnabled(): boolean {
  const v = process.env.DITTO_FARFIELD_CATEGORIES?.toLowerCase();
  return v !== '0' && v !== 'off' && v !== 'false';
}
