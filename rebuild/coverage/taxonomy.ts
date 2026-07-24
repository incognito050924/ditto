/**
 * Far-field pre-mortem taxonomy — the category FLOOR the coverage sweep answers
 * (ADR-0023 · ADR-20260625). Each category is a probing QUESTION (a lens the
 * sweep must answer for the change's scope), NOT a bare noun. The floor is the
 * code default and the single source of the category set; breadth-completeness
 * (ADR-0023) and the binary relevance gate (ADR-20260625) are both measured
 * against it.
 *
 * The floor is cross-validated against established taxonomies (STRIDE / OWASP /
 * CWE / FMEA / SRE) and is NOT a closed list — a caller may pass a resolved
 * taxonomy (project overrides, discovery additions) anywhere a taxonomy is taken.
 */

/** One far-field category: a stable id + the probing-question lens handed to the sweep. */
export interface FarFieldCategory {
  /** Stable kebab id — used for the seeded node id and for skip records. */
  id: string;
  /** The probing question the sweep answers for the change's scope. */
  lens: string;
}

/** Coverage-node id prefix for a seeded far-field category. */
export const CATEGORY_NODE_PREFIX = 'cov-cat-';

/**
 * The floor categories. Lens text is the probing question the sweep answers.
 * Clear bundles are atomized into independently-groundable facets so the binary
 * relevance gate can include/skip each facet on its own grounding
 * (security-privacy → injection / secret-exposure / pii-leak / regulatory;
 * resource-abuse → resource-exhaustion / abuse-vector; authorization →
 * authorization enforcement + authorization-model).
 */
export const FAR_FIELD_TAXONOMY_FLOOR: readonly FarFieldCategory[] = [
  {
    id: 'authentication',
    lens: '이 기능에 도달하는 인증 경로·방식은? (API 토큰·웹 세션·서버간 OAuth·서비스 토큰 등) 경로별 인증이 이 변경에서 일관·정확한가? 한 방식만 가정하고 다른 진입 경로를 빠뜨리지 않나?',
  },
  {
    id: 'authorization',
    lens: '이 변경이 요구·부여·검사하는 권한을 코드가 실제로 강제하나 — 검사가 누락된 경로(우회 진입·간접 호출·배치/내부 API)는 없나? 한 인가 방식만 가정하고 다른 인가 경로를 빠뜨리지 않나? (인가 모델 자체가 맞는지는 #authorization-model의 몫)',
  },
  {
    id: 'authorization-model',
    lens: '이 제품의 인가 모델은 무엇인가? (RBAC·ABAC·ReBAC·ACL·소유권·테넌트 경계·OAuth 스코프·정책엔진 등 — RBAC가 기본값이 아니다) 이 변경 범위에서 누가 접근 가능/불가해야 하나 — 그 권한 모델 자체가 의도에 맞나?',
  },
  {
    id: 'auditing',
    lens: '이 동작에 감사 로그·추적이 필요한가? 누가·언제·무엇을 했는지 남나? 행위자가 행위를 부인할 수 있나, 기록은 변조내성·귀속가능한가?',
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
    id: 'resource-exhaustion',
    lens: '한도·고갈·타임아웃·메모리·N+1·스케일 문제가 있나? 정상 부하가 늘 때 자원이 고갈되거나 성능이 붕괴되나? (용량 한계 — 의도적 오남용은 #abuse-vector)',
  },
  {
    id: 'abuse-vector',
    lens: '이 흐름을 한도/쿼터보다 빠르게 악용할 수 있나(대량·replay·스크래핑·credential stuffing)? 레이트리미터가 공유라 우회·고갈시킬 수 있나? (의도적 오남용 벡터 — 정상 부하의 용량 한계는 #resource-exhaustion)',
  },
  {
    id: 'compat-version',
    lens: '하위/상위 호환·스키마/API 진화·파괴적 변경이 있나?',
  },
  {
    id: 'injection',
    lens: '신뢰할 수 없는 입력이 코드·쿼리·명령으로 해석되는 인젝션 경로가 있나? (SQL·NoSQL·OS 명령·LDAP·XPath·템플릿·역직렬화 싱크 — CWE-89/78/94, OWASP A03) 입력이 위험한 인터프리터에 도달하나?',
  },
  {
    id: 'secret-exposure',
    lens: '시크릿·자격증명·토큰·키가 코드·로그·에러·설정·URL에 노출되나? 저장·전송 시 적절히 보호되나? (CWE-200/532, OWASP A02)',
  },
  {
    id: 'pii-leak',
    lens: '개인식별정보(PII)·민감 데이터가 수집·로깅·전송·노출되나? 최소수집·마스킹·암호화·접근통제가 적용되나?',
  },
  {
    id: 'regulatory',
    lens: '규제·컴플라이언스 의무가 이 변경에 걸리나? (GDPR·개인정보보호법·데이터 보존/삭제·국외이전·동의·감사요건 — 위반 시 법적/계약 위험)',
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
    lens: '적용/배포 타이밍·순서가 중요한가? 의존 타 기능보다 먼저/나중 배포돼야 하나? git·릴리스 정책과 맞나? 부분 롤아웃 중 혼재 버전이 깨지나? 마이그레이션-코드 배포 순서는?',
  },
  {
    id: 'reuse-build-vs-buy',
    lens: '신규 구현 전에 reuse→adopt→build 순으로 따졌나? 코드베이스에 이미 있는 재사용 가능한 패턴·컴포넌트를 채택했나, 재발명했나? 검증된 OSS·SDK가 있나 — 라이선스·비용·CVE·유지보수 활성도·공급망 위험은?',
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
];

/**
 * The lenses injected as the sweep's cross-cutting constraints — the probing
 * questions a fresh judge sees so it faces every far-field domain instead of
 * only what it happens to recall. Defaults to the code floor; pass a resolved
 * taxonomy (project overrides + discovery additions) to inject that instead.
 */
export function farFieldLenses(
  taxonomy: readonly FarFieldCategory[] = FAR_FIELD_TAXONOMY_FLOOR,
): string[] {
  return taxonomy.map((c) => c.lens);
}
