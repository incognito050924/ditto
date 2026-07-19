# impact — 변경된 exported 심볼의 영향집합을 CodeQL 정적 사실로 산출하는 ImpactGraph producer

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋 `c2d2e16`, 작성일 2026-07-19.

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto impact`는 "이 심볼 하나를 바꾸면 무엇이 영향을 받는가"를 **결정론적 정적 사실**로 뽑는 커맨드다. 한 exported 심볼(함수/클래스/인터페이스)을 입력받아, 그것을 참조하는 호출·타입·import·테스트·선언 위치를 CodeQL로 추출하고, 정적으로 못 잡는 영향은 `unresolved`로 **드러내어** ImpactGraph(JSON)로 쓴다.

이 기능은 DITTO 4축(의도/오케스트레이션/E2E/지식)이 아니라 **ACG(Agentic Change Governance) 거버넌스 계층**에 속한다. ACG는 스펙(저장소 중립)/바인딩(저장소별) 2계층으로 설계됐고, impact는 그 "단계3(ImpactGraph)" 산출물이다(codeql-analyzer.ts:1, impact.ts:22). 두 가지 개념이 핵심이다.

- **결정론적 사실 우선**: 거버넌스 게이트의 입력은 LLM 추론이 아니라 정적 사실이어야 한다. LLM 구조 추론은 규모에 비례해 부정확하므로 CodeQL로 통일했다(ADR-0006 컨텍스트/대안).
- **침묵 손실 금지(default-deny)**: 못 잡는 영향(동적 디스패치·reflection·cross_repo·미매핑 user journey)을 조용히 빠뜨리지 않고 `unresolved`에 남긴다(impact-graph.ts:14-19, acg-impact-graph.ts:5-7).

## 2. 코드 위치와 진입점

| 경로 | 역할 |
| --- | --- |
| `src/cli/commands/impact.ts` | CLI 진입. 인자 파싱 → guard → analyzer 구성 → producer 호출 → JSON 파일 쓰기 |
| `src/acg/impact/impact-graph.ts` | 거버넌스 코어. analyzer 결과에 envelope + default-deny journey 불변식을 입혀 스키마-검증된 ImpactGraph 조립(순수) |
| `src/acg/impact/codeql-analyzer.ts` | 언어별 CodeQL 분석기. 관계 쿼리 결과(row) → affected 노드 분류 + cross_repo unresolved 수집 |
| `src/core/codeql/relations.ts` | 관계 쿼리 실행부. DB create → query run → bqrs decode → CSV row. 언어별 `.ql` 쿼리 상수 |
| `src/acg/internal-packages.ts` | cross_repo 형제모듈 선언 로드 + JVM fail-loud 가드 |
| `src/schemas/acg-impact-graph.ts` | ImpactGraph zod 스키마(SoT, ADR-0002) |
| `src/core/codeql/runner.ts` | build-mode 선택·`database create` 인자 구성 |
| `src/core/codeql/host-deps.ts` | 실제(Bun) spawn/IO deps 팩토리 + 커밋-sha 캐시 디렉터리 |

서브커맨드는 없다(단일 커맨드). CLI 인자(impact.ts:34-64):

| 인자 | 필수 | 기본 | 의미 |
| --- | --- | --- | --- |
| `--work-item` | 예 | — | work item id. 출력 경로·envelope에 쓰임 |
| `--file` | 예 | — | 변경된 심볼이 선언된 파일. 동명이인 배제용 선언 제한 |
| `--symbol` | 예 | — | 변경된 exported 심볼 이름 |
| `--change-type` | 아니오 | `signature` | `rename\|signature\|behavior\|delete\|add\|move` |
| `--source-root` | 아니오 | `<repo>/src` | CodeQL 분석 소스 루트 |
| `--language` | 아니오 | `javascript` | `javascript\|java\|kotlin\|python` |
| `--build-command` | 아니오 | — | 컴파일 언어 manual build-mode 빌드 명령 |
| `--user-exposed` | 아니오 | `false` | 사용자-표면 변경 여부(default-deny journey 체크 유발) |
| `--journey-id` | 아니오 | — | 매핑된 JourneySpec.id |
| `--spec` | 아니오 | `.ditto/architecture-spec.json` | internal_packages로 cross_repo 판정 |
| `--output` | 아니오 | `human` | `human\|json` |

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

입력은 **심볼 좌표**(`--file`, `--symbol`, `--language`)와 **거버넌스 플래그**(`--user-exposed`, `--journey-id`, `--spec`)다. 출력은 work item 로컬 디렉터리의 ImpactGraph JSON 하나다.

```
CLI 인자
  │
  ├─ resolveRepoRootForCreate() → repoRoot                         (impact.ts:76)
  ├─ loadInternalPackages(repoRoot, --spec) → internalPackages     (impact.ts:87)
  ├─ runInternalPackagesGuard(...) → ok|warn|block                 (impact.ts:91)
  │       └─ block이면 exit 64(USAGE_ERROR)                         (impact.ts:96-100)
  │
  ├─ new CodeqlImpactAnalyzer(target, makeRelationDeps())          (impact.ts:104)
  │
  └─ produceImpactGraph(input, analyzer, sourceRoot)               (impact.ts:117)
          │
          ├─ analyzer.analyze()                                    (codeql-analyzer.ts:85)
          │     ├─ runRelationQuery(IMPACT_QUERY)                  (relations.ts:473)
          │     │     DB create(캐시미스) → query run → bqrs decode → CSV rows
          │     │     rows = [path, line, raw_kind]
          │     ├─ raw_kind → affected.kind 분류                    (codeql-analyzer.ts:110-113)
          │     └─ crossRepoUnresolved(sourceRoot)                 (codeql-analyzer.ts:134)
          │           NOT-fromSource 참조 중 internal glob 매칭 → unresolved{cross_repo}
          │
          └─ buildImpactGraph(input, analysis)                     (impact-graph.ts:49)
                default-deny journey 불변식 적용 → acgImpactGraph.parse()
                │
                └─ writeJson → .ditto/local/work-items/<wi>/impact-graph.json   (impact.ts:129-131)
```

- **읽는 상태 파일**: `.ditto/architecture-spec.json`(또는 `--spec` 경로) — `acgArchitectureSpec` 스키마. `internal_packages` 필드만 소비(internal-packages.ts:146-162).
- **CodeQL 작업물**: `.ditto/local/cache/codeql/<sha>-<lang>/` 아래 DB·쿼리·bqrs·csv(host-deps.ts:63-67). 커밋-sha로 키됨.
- **쓰는 상태 파일**: `.ditto/local/work-items/<wi>/impact-graph.json` — `acgImpactGraph` 스키마(impact.ts:129, `localDir` = `<repoRoot>/.ditto/local/...`, ditto-paths.ts:24).
- **stdout**: `--output json`이면 요약(affected/unresolved/journey_unknown/cross_repo 개수), 아니면 human 한 줄(impact.ts:133-145).

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### 4-1. CodeQL 단일 엔진 · 언어별 컴파일러 분석기 제거 (ADR-0006)

analyzer 인터페이스(`ImpactAnalyzer.analyze → AnalyzerResult`, impact-graph.ts:28-30)는 거버넌스 코어가 언어를 모르도록 추상화되어 있고, 구현체만 CodeQL 기반이다. 과거엔 `TsImpactAnalyzer`(TS 컴파일러 type checker)였으나 ADR-0006 D2로 삭제하고 `CodeqlImpactAnalyzer`로 교체했다. 이유:

- TS 컴파일러에 묶이면 스펙이 "저장소 중립"이라 주장해도 TS 저장소에서만 동작한다(§4 leak). 다언어 저장소에 거버넌스를 못 건다.
- "TS는 빠른 컴파일러, 그 외 CodeQL" 2-tier fast-path는 **두지 않는다**(ADR-0006 D2) — 두 경로 영구 동등성 보증 부담 + leak 재발 통로.

트레이드오프: DB 빌드가 TS 컴파일러보다 무겁다(캐시미스 9.5초~3분). 이를 **커밋-sha DB 캐시**로 억제하고, 정확도·저장소 독립성을 속도보다 우선했다(ADR-0006 비용·위험).

### 4-2. 관계 추출은 SARIF alert이 아니라 "사실 추출" 경로 (ADR-0006 D3)

impact가 필요로 하는 건 alert이 아니라 **관계**(caller 집합)다. 그래서 custom `.ql`로 관계를 `select`하고 `bqrs decode --format=csv`로 디코드한다(relations.ts:1-11). 보안/데이터흐름의 기존 SARIF 경로와 별개다.

### 4-3. 이름이 아니라 선언 동일성으로 해소 (decoy 배제)

impact 쿼리는 이름 텍스트 매칭이 아니라 **선언 동일성**으로 참조를 해소한다: 선언을 target 파일로 제한하고(`inTargetFile`), 값 참조는 `getResolvedCallee()`가 그 선언으로 해소되는 호출만 잡는다(relations.ts:63-65). 이는 "symbol resolution, not text search"로, ADR-0006 검증에서 초기 이름기반 쿼리가 동명이인을 과검출한 회귀를 잡아 정밀화한 결과다(ADR-0006 ac-5).

### 4-4. cross_repo는 명시 선언 + JVM fail-loud 가드 (ADR-0007)

단일모듈 CodeQL DB로 JVM을 분석하면 형제모듈 JAR 타입 의존이 `fromSource()` 필터에서 빠져 **침묵 손실**된다. 그래서 형제모듈을 자동 추론하지 않고 `ArchitectureSpec.internal_packages`에 명시 선언한다(ADR-0007 D1). 타입드 엔트리: `glob`=cross_repo 분류 대상 패키지, `path`=로컬 JAR 위치(가드용). glob 미선언이면 형제/써드파티 구분 신호가 없어 분류를 skip한다(노이즈보다 미수집을 택하고 가드로 드러냄, ADR-0007 D2). 로컬 JAR이 있는데 선언 누락이면 **차단**한다(D3, exit 64).

### 4-5. default-deny journey 불변식

user-exposed 변경은 JourneySpec에 매핑되거나 `journey_unknown`으로 드러나야 한다. 둘 다 아니면 그래프가 통과할 수 없다(impact-graph.ts:14-19). under-recording을 침묵으로 통과시키지 않으려는 거버넌스 불변식이다(acg-impact-graph.ts:30 `OBJ-31`).

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### 5-1. `impactCommand.run` (impact.ts:65-150) — 오케스트레이션

- **build-mode 결정**(impact.ts:82-83): `!buildCommand && language === 'java'`이면 `'none'` 강제, 아니면 `undefined`(하위 `selectBuildMode`가 자동). 주석(impact.ts:80-81)이 근거를 남긴다 — 관계 추출은 컴파일 언어도 buildless로 충분(probe 실증). 단 **Kotlin은 이 자동 강제에서 빠진다**: `language === 'java'`만 매칭하므로 Kotlin은 `buildMode: undefined` → `selectBuildMode`가 buildCommand 없으면 `autobuild`를 고른다(runner.ts:56-58). CLI 인자 설명도 "kotlin needs --build-command or autobuild"라 명시(impact.ts:46). 이는 Kotlin buildless가 false-clean(빈 추출)을 내기 때문(runner.ts:35-36).
- **internal_packages 로드**(impact.ts:87): `--spec` 있으면 그 경로(못 읽으면 throw), 없으면 기본 스펙 optional 로드(부재면 빈 목록 → cross_repo 비활성, 기존 동작 보존, internal-packages.ts:146-162).
- **가드**(impact.ts:91-103): block이면 exit 64로 중단, warn이면 에러 스트림에 경고만 내고 진행.
- **analyzer 구성 + producer 호출 + 파일 쓰기**(impact.ts:104-131). 전체가 try/catch로 감싸여, 실패는 `impact failed: ...` + exit 70(RUNTIME_ERROR)로 드러난다(impact.ts:146-149). CodeQL 빈 결과를 '깨끗함'으로 오판하지 않도록 실행 실패는 throw로 표면화된다(codeql-analyzer.ts:14).

### 5-2. `CodeqlImpactAnalyzer.analyze` (codeql-analyzer.ts:85-126) — row → 분류

- `runRelationQuery`로 impact 쿼리를 돌려 `[path, line, raw_kind]` row를 받는다(codeql-analyzer.ts:86-103).
- 분류(codeql-analyzer.ts:110-113): `raw === 'type'` → `type_contract`, `raw === 'decl'` → `external_surface`, 그 외(import|value) → 테스트 파일이면 `test`, 아니면 `direct_caller`. `path`나 `raw`가 비면 skip(codeql-analyzer.ts:108).
- `isTestFile`(codeql-analyzer.ts:32-43): 언어별 테스트 판정. JS는 `.test/.spec`, Java/Kotlin은 `/test/` 경로 또는 `*Test/*Tests/*IT`, Python은 `test_*`/`*_test`/`/tests/`.
- external_surface reason은 "exported symbol — public surface (단계3 gate: exported must be surfaced)"로 고정(codeql-analyzer.ts:119-121).

### 5-3. `crossRepoUnresolved` (codeql-analyzer.ts:134-169) — 형제모듈 표면화

- glob 엔트리가 하나도 없으면 쿼리 자체를 skip하고 빈 배열 반환(codeql-analyzer.ts:137). path 전용 엔트리는 가드용이라 분류에 못 쓴다.
- unresolved 쿼리로 `[path, pkg]` row를 받아, `matchesInternalGlob(pkg, entries)`(codeql-analyzer.ts:51-53, `globToRegExp` 앵커 매칭)에 걸리는 것만 `kind: cross_repo`로 기록. 써드파티(org.springframework 등)는 비매칭이라 무시된다.
- `seen` Set으로 `path pkg` 중복 제거(codeql-analyzer.ts:154-161).
- **주의**: JS의 `UNRESOLVED_QUERY_JS`는 해소 실패한 import specifier(예: 워크스페이스 패키지)를 후보로 낸다(relations.ts:260-271). 즉 cross_repo 수집은 JVM 전용이 아니라, glob이 선언되면 JS에서도 동작한다. 다만 §4-4 침묵 손실 문제와 JVM 가드는 JVM(java/kotlin)에만 적용된다(internal-packages.ts:24-28).

### 5-4. `buildImpactGraph` (impact-graph.ts:49-87) — 순수 조립 + default-deny

- analyzer affected에 `handled: false` 기본값을 채운다(impact-graph.ts:53).
- default-deny(impact-graph.ts:56-74): `userExposed === true`일 때, `journeyId`가 있으면 `user_journey` affected 노드를 push, 없고 journey 노드도 없으면 `unresolved: journey_unknown`을 push. `journeyKinds = {ui_surface, user_journey}`이고 journey_id가 있는 노드가 이미 있으면 journey_unknown을 넣지 않는다(impact-graph.ts:57).
- 최종적으로 `acgImpactGraph.parse(...)`로 스키마 검증(impact-graph.ts:76-86). `produced_by: 'agent'`, `schema_version: '0.1.0'` 고정.

### 5-5. `runRelationQuery` (relations.ts:473-549) — CodeQL 실행부

- DB 캐시 미스면 `database create`(host-deps.ts spawn). **stdout·stderr를 동시에 drain**하는 이유(relations.ts:497-499): `database create`가 stdout에 추출 로그를 대량으로 쏟아, 순차로 읽으면 stdout 파이프가 가득 차 codeql이 교착한다.
- `bqrs decode`는 결과를 stdout이 아니라 `--output` 파일(csv)로 받는다(relations.ts:408-410, 531-548) — 파이프 교착을 원천 차단(stdout은 로그 전용).
- 각 단계 exit_code ≠ 0이면 throw(relations.ts:501-505, 525-529, 542-546) — fail-loud.

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위: 위 8개 파일의 정적 읽기 + ADR-0006/0007. CodeQL을 실제 실행하지는 않았다(코드 읽기만).

- **default-deny 불변식**: 코드가 의도대로 3-분기(mapped/unknown/이미 있음)를 구현하고 스키마 superRefine이 journey_id 필수를 강제(acg-impact-graph.ts:34-49). 의도 일치.
- **cross_repo glob 미선언 skip**: codeql-analyzer.ts:137이 정확히 구현. ADR-0007 D2 일치.
- **JVM 가드 fail-loud**: internal-packages.ts:62-79가 block/warn/ok 3-상태를 ADR-0007 D3대로 구현. impact.ts:96-103이 block→exit, warn→경고로 연결. 일치.
- **Kotlin build-mode 갭(설계 의도대로의 gap, 결함 아님)**: impact.ts:82-83의 `language === 'java'` 강제는 Kotlin을 포함하지 않는다. 이는 의도된 것이다 — Kotlin buildless는 false-clean이라 autobuild/manual이 필요(runner.ts:35-36). 다만 `--build-command`도 autobuild도 없이 Kotlin을 돌리면 autobuild가 실패하거나 빈 추출로 이어질 수 있다. 이 경로는 미검증(코드상으로는 autobuild 시도).
- **미확인**: 실제 CodeQL 쿼리 결과의 정확도(동등성 14/14·25/25)는 ADR-0006 검증 기록에 근거하며, 이 문서 작성 중 재실행하지 않았다 — ADR 기록에 의존(미검증).

확인 범위에서 죽은 경로·명백한 불일치는 발견하지 못했다.

## 7. 잠재 위험·부작용·재설계 시 고려점

- **캐시 stale 위험**: `codeqlCacheDir`는 커밋-sha로 키된다(host-deps.ts:63-67). working tree가 커밋과 다르면 DB가 stale일 수 있다(host-deps.ts 주석이 명시한 알려진 한계). 커밋 안 한 변경에 대한 impact 분석은 이전 커밋 상태를 반영할 수 있다. 재설계 시 dirty-tree 감지 또는 working-tree 기반 캐시 무효화를 고려.
- **DB 캐시 재사용과 build-mode**: DB가 이미 있으면 `runRelationQuery`는 create를 skip한다(relations.ts:481). 즉 다른 build-mode/build-command로 다시 돌려도 기존 DB를 재사용한다. 언어를 바꾸면 캐시 키가 달라지지만(sha-lang), 같은 언어에서 build-command만 바꾼 경우 이전 DB가 쓰인다. 재설계 시 유의.
- **cross_repo가 JS에서도 동작**: §5-3대로 glob 선언 시 JS unresolved도 cross_repo로 잡히지만, JVM 가드는 JS에 안 걸린다. JS 모노레포에서 워크스페이스 패키지를 cross_repo로 쓰려면 가드 없이 glob만으로 동작 — 선언 누락을 잡아줄 안전망이 JVM보다 약하다.
- **동적 영향은 구조적으로 unresolved**: 동적 디스패치·reflection·config-driven·string dispatch는 스키마상 unresolved kind로 존재하지만(acg-impact-graph.ts:55-64), 현재 analyzer는 cross_repo와 journey_unknown만 채운다. 나머지 kind(dynamic_call 등)를 채우는 producer는 확인 범위에 없다 — 이들 영향은 현재 그래프에 나타나지 않는다(침묵 손실 가능성). 재설계 시 반드시 재검토할 갭.
- **재설계 시 보존해야 할 불변식**: (1) analyzer 인터페이스 추상화(코어가 언어를 모름), (2) default-deny journey, (3) fail-loud(빈 결과 ≠ 깨끗함), (4) 선언 동일성 해소(decoy 배제), (5) cross_repo 명시 선언 + JVM 가드. 이들은 ADR-0006/0007이 실증으로 정당화한 결정이라 가볍게 바꾸면 침묵 손실이 재발한다.
- **재고 가능한 결정**: 2-tier fast-path 금지(ADR-0006 D2)는 "DB 빌드 비용이 캐시로도 게이트 UX를 해치면 한정 완화"를 철회 조건으로 명시(ADR-0006 변경조건). 커밋-sha 캐시 방식도 dirty-tree 정합성 관점에서 재고 여지가 있다.
