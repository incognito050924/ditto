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

import { type CoverageTaxonomyConfig, coverageTaxonomyConfig } from '~/schemas/coverage';
import type { CoverageDisposition, CoverageMap, CoverageNode } from '~/schemas/coverage';
import { MINIMAL_INCREMENT_SELF_CHECK } from './charter';
import { dittoDir } from './ditto-paths';

export interface FarFieldCategory {
  /** Stable id (kebab) — used for tier-② config enable/disable and skip records. */
  id: string;
  /** The probing question handed to the sweep as a cross-cutting lens (ac-1). */
  lens: string;
  /**
   * Static disposition route — WHO answers this category, WHEN (wi_260706n4w
   * ac-2): code-verify = oracle claim vs current code, now (stays in the sweep);
   * user-intent = a user-intent question (deep-interview routes it, fail-OPEN —
   * without an interview it stays in the sweep, ac-4); runtime-post-impl = only
   * observable at runtime after the change lands. Additive + optional (custom
   * taxonomies without it keep working); absent = DEFAULT_COVERAGE_DISPOSITION.
   */
  disposition?: CoverageDisposition;
}

/**
 * The 23 floor categories (design §6-floor + §6-1 granularity hybrid). The count
 * lives HERE (not a hardcoded number in prose) so the taxonomy is the single source
 * of the category set. Lens text is the probing question the sweep answers for the
 * change's scope. Clear bundles are statically atomized into independently-groundable
 * facets (§6-1, wi_260625l0v): security-privacy → injection/secret-exposure/pii-leak/
 * regulatory, resource-abuse → resource-exhaustion/abuse-vector, so the binary
 * relevance gate (§3) can include/skip each facet on its own grounding rather than
 * over-covering a whole bundle for one relevant facet.
 *
 * Disposition routing (wi_260706n4w ac-2): every floor category declares a static
 * `disposition`. Dual-personality categories are facet-split so each facet routes
 * whole: authorization → authorization (enforcement, code-verify) +
 * authorization-model (model/who-should-access, user-intent). regulatory routes
 * user-intent whole (which obligations apply is user domain knowledge; their
 * enforcement materializes in pii-leak/auditing/data-integrity). No floor category
 * is runtime-post-impl — every floor lens has a pre-impl-answerable core; that
 * route exists for tier-② overrides/additions (e.g. post-deploy canary tracking).
 * minimal-increment left the floor entirely — design-META quality, not a far
 * risk — to the charter self-check; the removal stays ledgered in
 * FAR_FIELD_ROUTED_OUT below (ac-3, no silent narrowing).
 */
export const FAR_FIELD_TAXONOMY_FLOOR: readonly FarFieldCategory[] = [
  {
    id: 'authentication',
    lens: '이 기능에 도달하는 인증 경로·방식은? (API 토큰·웹 세션·서버간 OAuth·서비스 토큰 등) 경로별 인증이 이 변경에서 일관·정확한가? 한 방식만 가정하고 다른 진입 경로를 빠뜨리지 않나?',
    disposition: 'code-verify',
  },
  {
    id: 'authorization',
    lens: '이 변경이 요구·부여·검사하는 권한을 코드가 실제로 강제하나 — 검사가 누락된 경로(우회 진입·간접 호출·배치/내부 API)는 없나? 한 인가 방식만 가정하고 다른 인가 경로를 빠뜨리지 않나? (인가 모델 자체가 맞는지·누가 접근해야 하는지는 #authorization-model의 몫)',
    disposition: 'code-verify',
  },
  {
    id: 'authorization-model',
    lens: '이 제품의 인가(authorization) 모델은 무엇인가? (역할기반 RBAC·속성기반 ABAC·관계기반 ReBAC·ACL·소유권·테넌트 경계·OAuth 스코프·정책엔진 등 — 제품마다 다르며 RBAC가 기본값이 아니다) 이 변경 범위에서 누가 접근 가능/불가해야 하나 — 그 권한 모델 자체가 의도에 맞나? (코드가 그 모델을 강제하는지는 #authorization의 몫)',
    disposition: 'user-intent',
  },
  {
    id: 'auditing',
    lens: '이 동작에 감사 로그·추적이 필요한가? 누가·언제·무엇을 했는지 남나? 행위자가 행위를 부인할 수 있나, 기록은 변조내성·귀속가능(tamper-evident)한가?',
    disposition: 'code-verify',
  },
  {
    id: 'data-integrity',
    lens: '데이터 손실·손상·부분쓰기·멱등·마이그레이션 영향이 있나?',
    disposition: 'code-verify',
  },
  {
    id: 'boundary-edge',
    lens: '경계값/극단 입력이 있나? (0·최대·빈값·오버플로·경계 전환)',
    disposition: 'code-verify',
  },
  {
    id: 'concurrency-ordering',
    lens: '레이스·락·중복·이벤트 순서 문제가 있나?',
    disposition: 'code-verify',
  },
  {
    id: 'external-env',
    lens: '외부 환경(env/배포/3rd-party)으로 깨질 우려가 있나? 이 변경의 side-effect는 무엇인가(외부 API 호출·메시지 발행 등)?',
    disposition: 'code-verify',
  },
  {
    id: 'failure-recovery',
    lens: '실패 지점에서 부분 recovery가 필요한가, 전체 롤백인가? 무성 실패·연쇄 실패·fallback 정확성은?',
    disposition: 'code-verify',
  },
  {
    id: 'resource-exhaustion',
    lens: '한도·고갈·타임아웃·메모리·N+1·스케일 문제가 있나? 정상 부하가 늘 때 자원이 고갈되거나 성능이 붕괴되나? (용량 한계 — 의도적 오남용은 #abuse-vector)',
    disposition: 'code-verify',
  },
  {
    id: 'abuse-vector',
    lens: '이 흐름을 한도/쿼터보다 빠르게 악용할 수 있나(대량·replay·스크래핑·credential stuffing)? 레이트리미터가 공유라 우회·고갈시킬 수 있나? (의도적 오남용 벡터 — 정상 부하의 용량 한계는 #resource-exhaustion)',
    disposition: 'code-verify',
  },
  {
    id: 'compat-version',
    lens: '하위/상위 호환·스키마/API 진화·파괴적 변경이 있나?',
    disposition: 'code-verify',
  },
  {
    id: 'injection',
    lens: '신뢰할 수 없는 입력이 코드·쿼리·명령으로 해석되는 인젝션 경로가 있나? (SQL·NoSQL·OS 명령·LDAP·XPath·템플릿·역직렬화 싱크 — CWE-89/78/94, OWASP A03) 입력이 위험한 인터프리터에 도달하나? (입력 검증 게이트 자체는 #input-validation)',
    disposition: 'code-verify',
  },
  {
    id: 'secret-exposure',
    lens: '시크릿·자격증명·토큰·키가 코드·로그·에러·설정·URL에 노출되나? 저장·전송 시 적절히 보호되나? (CWE-200/532, OWASP A02)',
    disposition: 'code-verify',
  },
  {
    id: 'pii-leak',
    lens: '개인식별정보(PII)·민감 데이터가 수집·로깅·전송·노출되나? 최소수집·마스킹·암호화·접근통제가 적용되나?',
    disposition: 'code-verify',
  },
  {
    id: 'regulatory',
    lens: '규제·컴플라이언스 의무가 이 변경에 걸리나? (GDPR·개인정보보호법·데이터 보존/삭제·국외이전·동의·감사요건 — 위반 시 법적/계약 위험)',
    disposition: 'user-intent',
  },
  {
    id: 'cross-feature',
    lens: '기능적으로 먼 feature와 공유 자원/상태를 건드리나? (memory graph entanglement가 주로 채움)',
    disposition: 'code-verify',
  },
  {
    id: 'observability',
    lens: '로깅 공백·알림 부재·디버깅성 문제가 있나? 무성/부분 실패를 어떤 signal이 잡고, 인지까지 얼마나 걸리나?',
    disposition: 'code-verify',
  },
  {
    id: 'deployment-rollout',
    lens: '적용/배포 타이밍·순서가 중요한가? 의존(받는/하는) 타 기능보다 먼저/나중 배포돼야 하나? git·릴리스 정책(브랜치 전략·feature flag·릴리스 트레인·핫픽스)과 맞나? 부분 롤아웃 중 혼재 버전이 깨지나? 마이그레이션-코드 배포 순서는?',
    disposition: 'code-verify',
  },
  {
    id: 'reuse-build-vs-buy',
    lens: '신규 구현 전에 reuse→adopt→build 순으로 따졌나? (내부) 코드베이스에 이미 있는 재사용 가능한 패턴·컴포넌트를 채택했나, 아니면 재발명했나? (외부) 검증된 OSS·SDK가 있나 — 라이선스(copyleft)·비용·CVE·유지보수 활성도·공급망 위험은? 신규 구현이면 reinvent 비용·품질 리스크는? (이 렌즈는 기존 자산 채택 vs 재발명 결정 — 만들기로 한 뒤 이 변경 자체의 추상화 적정선·과잉/과소는 charter의 minimal-increment self-check 몫, wi_260706n4w에서 far-field 밖으로 이관)',
    disposition: 'code-verify',
  },
  {
    id: 'input-validation',
    lens: '신뢰할 수 없는 입력의 형태·타입·의미가 사용 전에 검증되나? (malformed payload·type confusion·역직렬화 — CWE-20/502, OWASP A03/A08)',
    disposition: 'code-verify',
  },
  {
    id: 'configuration',
    lens: '코드가 아닌 설정·플래그·기본값·env 값이 실패를 부르나? 새 설정이 라이브 전에 검증되나? (OWASP A05 misconfiguration)',
    disposition: 'code-verify',
  },
  {
    id: 'time-clock',
    lens: '정확성이 시간 자체에 의존하나 — 만료(토큰·TTL·인증서)·타임존/DST·monotonic vs wall clock·노드 간 시계 일치?',
    disposition: 'code-verify',
  },
];

/**
 * One category routed OUT of the far-field floor entirely — the completeness
 * ledger record of the removal (wi_260706n4w ac-3, no silent narrowing). A
 * category may only leave the floor WITH this record: id + the question it
 * carried (verbatim, single SoT with the receiving gate) + where it went +
 * why + what risk survives if the receiving route is not consumed. Mirrors
 * the justified-skip vocabulary (close_reason/residual_risk) so 'complete'
 * never quietly means "fewer categories than before".
 */
export interface RoutedOutCategory {
  /** The floor id the category had (kebab). */
  id: string;
  /** The probing question, verbatim — identical to the receiving gate's copy. */
  lens: string;
  /** Where the category now lives (the receiving enforcement gate). */
  route: 'charter-self-check';
  /** WHY it left the far-field floor (mirrors close_reason). */
  reason: string;
  /** WHAT RISK survives when the receiving route is not consumed (mirrors residual_risk). */
  residual_risk: string;
}

/**
 * Categories removed from the floor with their routing record (ac-3). Surfaced on
 * every {@link farFieldCoverageReport} so each completeness claim self-describes
 * what was routed out — a reader of 'complete' sees the narrowing and its reason,
 * never a silently smaller universe.
 */
export const FAR_FIELD_ROUTED_OUT: readonly RoutedOutCategory[] = [
  {
    id: 'minimal-increment',
    lens: MINIMAL_INCREMENT_SELF_CHECK.question,
    route: 'charter-self-check',
    reason:
      'minimal-increment는 먼 위험(far-field)이 아니라 설계-메타 품질 — 매 턴 재주입되는 charter self-check(MINIMAL_INCREMENT_SELF_CHECK)가 집행한다 (wi_260706n4w ac-2)',
    residual_risk:
      'charter projection을 소비하지 않는 경로(비 hook 진입·직접 엔진 호출)에서는 이 self-check가 주입되지 않아 과잉/과소 증분이 사전 점검 없이 지나갈 수 있다',
  },
];

/**
 * The lenses injected into `cross_cutting_constraints` (design §8-1). Defaults to
 * the code floor (ac-7); pass a resolved taxonomy (floor + tier-② project config,
 * ac-10) to inject the project's effective category set. Discovery-critic
 * additions (ac-6) flow through the same `taxonomy` argument.
 */
export function farFieldLenses(
  taxonomy: readonly FarFieldCategory[] = FAR_FIELD_TAXONOMY_FLOOR,
): string[] {
  return taxonomy.map((c) => c.lens);
}

/**
 * Resolve the effective taxonomy from the code floor + a project's tier-② config
 * (ac-10): drop `disabled` floor ids, append `added` categories, and let an added
 * id that collides with a floor id OVERRIDE that floor lens (no duplicate id).
 * Pure — the caller supplies floor + config so this stays trivially testable.
 *
 * Disposition resolution (wi_260706n4w ac-2) is a PARTIAL override, deliberately
 * not the whole-object replacement the `added` collision rule uses: the tier-②
 * `dispositions` record re-routes a kept floor category without touching its
 * lens, and an added entry that collides with a floor id but declares no
 * disposition INHERITS the floor's — replacing a lens can never silently drop a
 * routing decision. Precedence per id: added.disposition (explicit on the entry)
 * > config.dispositions[id] > the floor's static disposition > absent
 * (= DEFAULT_COVERAGE_DISPOSITION downstream).
 */
export function resolveTaxonomy(
  floor: readonly FarFieldCategory[],
  config: CoverageTaxonomyConfig,
): FarFieldCategory[] {
  const disabled = new Set(config.disabled ?? []);
  const added = config.added ?? [];
  const routes = config.dispositions ?? {};
  const floorById = new Map(floor.map((c) => [c.id, c]));
  const overridden = new Set(added.map((c) => c.id));
  const kept = floor
    .filter((c) => !disabled.has(c.id) && !overridden.has(c.id))
    .map((c) => {
      const route = routes[c.id];
      return route ? { ...c, disposition: route } : c;
    });
  const resolvedAdded = added.map((a) => {
    const disposition = a.disposition ?? routes[a.id] ?? floorById.get(a.id)?.disposition;
    return {
      id: a.id,
      lens: a.lens,
      ...(disposition ? { disposition } : {}),
    };
  });
  return [...kept, ...resolvedAdded];
}

/**
 * Read the project's tier-② far-field taxonomy config (`.ditto/coverage-taxonomy.json`,
 * git-tracked) and resolve it against the code floor (ac-10). Absent or malformed
 * → the floor (fail-open; `onMalformed` lets the caller surface a warning so a bad
 * config doesn't look like it silently "did nothing"). The single I/O entry point;
 * `resolveTaxonomy` does the pure merge.
 */
export async function loadFarFieldTaxonomy(
  repoRoot: string,
  onMalformed?: () => void,
): Promise<FarFieldCategory[]> {
  const file = Bun.file(`${dittoDir(repoRoot)}/coverage-taxonomy.json`);
  if (!(await file.exists())) return [...FAR_FIELD_TAXONOMY_FLOOR];
  try {
    const parsed = coverageTaxonomyConfig.safeParse(JSON.parse(await file.text()));
    if (!parsed.success) {
      onMalformed?.();
      return [...FAR_FIELD_TAXONOMY_FLOOR];
    }
    return resolveTaxonomy(FAR_FIELD_TAXONOMY_FLOOR, parsed.data);
  } catch {
    onMalformed?.();
    return [...FAR_FIELD_TAXONOMY_FLOOR];
  }
}

/** Coverage-node id prefix for a seeded far-field category (§8-2). */
export const CATEGORY_NODE_PREFIX = 'cov-cat-';

/**
 * A per-category relevance verdict feeding the relevance gate (design §3·§5,
 * wi_260625l0v). PRODUCED upstream (grounded judgment + adversarial refute); this
 * module only CONSUMES it. A category is skipped ONLY by a well-formed not-relevant
 * verdict (`relevant:false` ∧ `reason` ∧ `residual_risk`) — the conservative default
 * keeps everything else open (애매하면 포함). `reason` → `close_reason` (WHY skipped),
 * `residual_risk` → WHAT survives the skip; both are required by the schema for a
 * non-resolved close, so a justification-less skip can never pass.
 */
export interface CategoryRelevanceVerdict {
  id: string;
  relevant: boolean;
  reason?: string;
  residual_risk?: string;
}

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
export function farFieldCoverageNodes(
  intent: string,
  rootId = 'cov-root',
  taxonomy: readonly FarFieldCategory[] = FAR_FIELD_TAXONOMY_FLOOR,
  verdicts: readonly CategoryRelevanceVerdict[] = [],
): CoverageNode[] {
  // Relevance gate (§3·§5): a category is pre-closed only by a WELL-FORMED not-relevant
  // verdict — conservative default keeps every other category open. The skip lands as
  // an out_of_scope node carrying close_reason+residual_risk so the ledger stays
  // complete and auditable (no silent drop), and a pre-closed node is never swept.
  const skips = new Map(
    verdicts
      .filter((v) => v.relevant === false && v.reason && v.residual_risk)
      .map((v) => [v.id, v]),
  );
  const categoryIds = taxonomy.map((c) => `${CATEGORY_NODE_PREFIX}${c.id}`);
  const root: CoverageNode = {
    id: rootId,
    parent_id: null,
    label: intent,
    origin: 'seed',
    depth_weight: 1,
    state: 'open',
    children: categoryIds,
  };
  const categories: CoverageNode[] = taxonomy.map((c, i) => {
    const base = {
      id: categoryIds[i] as string,
      parent_id: rootId,
      label: c.lens,
      origin: 'seed' as const,
      depth_weight: 1,
      children: [],
      // wi_260706n4w ac-2/ac-3: the seeded node carries its category's disposition
      // so the routing decision rides the ledger (a later routed close stays
      // diagnosable). Metadata only at seed — a routed category still seeds OPEN
      // (fail-open, ac-4): the deep-interview/runtime wiring closes it downstream,
      // never the seed itself.
      ...(c.disposition ? { disposition: c.disposition } : {}),
    };
    const skip = skips.get(c.id);
    return skip
      ? {
          ...base,
          state: 'out_of_scope' as const,
          close_reason: skip.reason,
          residual_risk: skip.residual_risk,
        }
      : { ...base, state: 'open' as const };
  });
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
  const v = process.env.DITTO_FARFIELD_CATEGORIES?.trim().toLowerCase();
  return v !== '0' && v !== 'off' && v !== 'false';
}

/** One skipped/deferred category with its recorded justification (ac-2 — never silent). */
export interface FarFieldSkip {
  id: string;
  state: 'out_of_scope' | 'user_owned';
  /** The recorded close_reason; null only for a legacy node missing one (the close gate forbids this going forward). */
  reason: string | null;
  /** The node's disposition route, when it carries one — a routed skip stays diagnosable (wi_260706n4w ac-3, additive). */
  disposition?: CoverageDisposition;
}

/** Process-coverage summary of one work item's far-field sweep (ac-11a, deterministic). */
export interface FarFieldCoverageReport {
  /** Far-field category nodes seeded in the map (cov-cat-*); 0 when seeding was off (ac-7). */
  seeded: number;
  /** Categories swept and settled (resolved). */
  resolved: number;
  /** Categories still open (not yet swept). */
  open: number;
  /** Categories skipped/deferred with their recorded reason. */
  skipped: FarFieldSkip[];
  /** Breadth complete — at least one category seeded AND none still open (ac-2). */
  complete: boolean;
  /**
   * Categories removed from the floor, with route + reason (wi_260706n4w ac-3):
   * every completeness claim self-describes the narrowing — 'complete' can never
   * quietly mean "fewer categories than before". Additive; sourced from the
   * static FAR_FIELD_ROUTED_OUT ledger, so it is present on every report.
   */
  routed_out: RoutedOutCategory[];
}

/**
 * Deterministic process-coverage measurement (ac-11a, design §8-6): read a work
 * item's coverage map and report how the far-field breadth was handled — how many
 * categories were swept (resolved), skipped (with the justification the close gate
 * forced, ac-2), or are still open, and whether the breadth is complete. Pure over
 * the map (no I/O); the CLI reads coverage.json and prints this. The depth/stakes
 * dimension is the tier (ac-4), surfaced by coverage-next, not stored per-category.
 */
export function farFieldCoverageReport(map: CoverageMap): FarFieldCoverageReport {
  const cats = map.nodes.filter((n) => n.id.startsWith(CATEGORY_NODE_PREFIX));
  const open = cats.filter((n) => n.state === 'open').length;
  const skipped: FarFieldSkip[] = cats
    .filter((n) => n.state === 'out_of_scope' || n.state === 'user_owned')
    .map((n) => ({
      id: n.id,
      state: n.state as 'out_of_scope' | 'user_owned',
      reason: n.close_reason ?? null,
      ...(n.disposition ? { disposition: n.disposition } : {}),
    }));
  return {
    seeded: cats.length,
    resolved: cats.filter((n) => n.state === 'resolved').length,
    open,
    skipped,
    routed_out: [...FAR_FIELD_ROUTED_OUT],
    // Structural completeness must agree with isCoverageTerminated's `allClosed`
    // (every node, incl. derived sub-scopes that are NOT cov-cat-*), not just the
    // categories — else a closed-category report reads complete while a derived
    // scope is still open. K-dry termination stays with coverage-next's {action:'dry'}.
    complete: cats.length > 0 && map.nodes.every((n) => n.state !== 'open'),
  };
}
