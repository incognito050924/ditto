# ADR-0007: cross_repo 처리 정책 — 명시 선언(internal_packages) + JVM 가드

- 상태: accepted (실 boxwood automation-engine 실증으로 해소 — 아래 "검증" 참조)
- 결정 일자: 2026-06-05
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: ADR-0006 (분석 엔진 CodeQL 통일)의 직접 후속, `src/acg/internal-packages.ts`, `src/acg/impact/codeql-analyzer.ts`, `src/core/codeql/relations.ts`(UNRESOLVED_QUERY_*), `src/cli/commands/{impact,boundary,architecture}.ts`, `src/hooks/pre-tool-use.ts`, wi_260605cr1·wi_260605cr2, 선행 실증 wi_260605bxg·wi_260605mm1

## 컨텍스트

단일모듈 CodeQL DB로 JVM(Java/Kotlin)을 분석하면 형제모듈 JAR 타입 의존이 edge/impact 쿼리의 `fromSource()` 필터에서 빠져 ImpactGraph에서 **침묵 손실**된다(wi_260605cr1). 예: automation-engine이 `libs/boxwood-domain-model-*.jar`의 `kr.co.ecoletree.boxwood.domain.runtime.processing.StructuredErrorInfo`를 쓰지만, 단일모듈 DB엔 그 타입이 fromSource가 아니라 사라진다.

멀티모듈 reactor DB(source-root를 모듈 상위로)면 형제모듈이 source로 해소돼 손실 0이다(wi_260605bxg 실증). 그러나 형제모듈과 써드파티(Spring/JDK)를 구분할 신호가 필요하다 — 어떤 NOT-fromSource 참조가 "우리 형제모듈"이고 어떤 것이 "외부 의존"인지 정적으로 알 길이 없으면, cross_repo 분류는 노이즈가 되거나 침묵 손실을 그대로 둔다.

## 결정

### D1 — cross_repo 형제모듈은 명시 선언한다 (자동 추론 비의존)

source-root를 늘 상위로 올려 전체 reactor를 빌드하는 자동 추론에 의존하지 않고, 형제모듈을 `ArchitectureSpec.internal_packages`에 **명시 선언**한다. 타입드 엔트리 `{type:'glob'|'path', value}`:

- `glob` = cross_repo 분류 대상 패키지 글로브(`globToRegExp`, `^…$` 앵커).
- `path` = 로컬 sibling JAR 위치 글로브(가드 입력용).

### D2 — 분류는 선언된 glob에 매칭되는 NOT-fromSource 참조만 기록한다

NOT-fromSource인 type/import 참조를 `(fromPath, package)`로 뽑아(UNRESOLVED_QUERY_*) glob에 매칭되는 것만 `ImpactGraph.unresolved{kind:cross_repo}`로 기록한다. glob 미선언이면 분류 자체를 skip한다 — 형제/써드파티를 구분할 수 없으므로, 잘못된 cross_repo 노이즈보다 미수집을 택하고 그 사실을 가드로 드러낸다. 써드파티(Spring/JDK)는 무시한다.

### D3 — fail-loud 가드를 CLI 내장 + PreToolUse 훅 둘 다에 둔다

JVM에서 로컬 JAR이 있는데 선언에 누락(glob 미선언 OR path로 안 덮인 JAR)이면 **차단**한다(CLI exit 65 / 훅 exit 2). JVM이고 glob 미선언이며 로컬 JAR이 없으면 **경고**한다(CLI만). 선언 완비 또는 비JVM이면 ok. warn은 CLI에서만 낸다(훅 중복 경고 방지). 훅은 `.ditto/architecture-spec.json`만 읽고 `ditto … impact|boundary --language java|kotlin` 텍스트를 매칭한다(별칭/변형 호출은 CLI 가드가 받친다).

## 검증 (실증, 2026-06-05 — proposed→accepted 근거)

실 boxwood automation-engine DB(`mvn -o compile` 추적)에서:

- **UNRESOLVED_QUERY_JAVA**가 NOT-fromSource **188 패키지** 산출 → glob `kr.co.ecoletree.boxwood.domain.**`가 9개 domain-model 패키지 매칭(StructuredErrorInfo 소속 `...domain.runtime.processing` 포함), `org.springframework`/`java.*` 무매칭. 형제/써드파티 분리 성립.
- **scanLocalJars**가 `libs/boxwood-*.jar` 10개 탐지 → 미선언 시 block, glob + path(`libs/*.jar`) 선언 시 ok. 가드 3-상태(block/warn/ok) 통제.
- **합성 Java probe**로 단일모듈 → cross_repo 기록·멀티모듈 → 손실 0을 통제 실증.
- 전체 `bun test` green.

**판정**: D1~D3 성립 — 명시 glob 선언으로 형제모듈만 cross_repo 분류, 써드파티는 무시, 선언 누락은 JVM 가드가 JAR 존재로 fail-loud하게 드러냄.

## 대안 (기각)

- **source-root 항상 모듈 상위**(reactor 전체 빌드): reactor 전체 빌드 비용 + 스펙 glob을 모듈 접두로 작성해야 함(wi_260605mm1 §2). 기각.
- **prefix 문자열 매칭**: glob보다 표현력 약함 — 앵커·세그먼트 제어 불가. 기각.
- **JAR을 unzip해 패키지 단위 커버리지 검증**: unzip 비용 회피, glob 선언만 신뢰(누락은 가드가 JAR 존재로 잡음). 기각.

## 변경 조건 (이 ADR을 다시 열 때)

- 멀티모듈 reactor 빌드가 기본 워크플로가 되면 형제모듈이 source로 해소돼 가드가 무의미해진다 → 재검토.
- JAR 내부 패키지 단위 정밀 커버리지가 필요해지면 unzip 도입 검토.
- 훅 텍스트 매칭이 새는 호출 형태가 늘면 CLI 가드 의존도를 명문화.
