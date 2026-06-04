# ADR-0006: 정적 분석 엔진 통일 — CodeQL 단일, 바인딩별 언어-컴파일러 분석기 제거

- 상태: accepted (슬라이스 1 실증으로 핵심 가정 해소 — 아래 "검증" 참조)
- 결정 일자: 2026-06-04
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: ADR-0001 (런타임 스택), ADR-0004 (Q3·Q4 architecture/fitness), 핸드오프 `wi_260604ql9` §4·§5, `src/acg/impact/*`, `src/acg/boundary/*`, `src/core/codeql/*`

## 컨텍스트

ACG는 스펙(저장소 중립) / 바인딩(저장소별) 2계층으로 설계됐다. 거버넌스 코어 — `buildImpactGraph`(impact-graph.ts), `checkBoundary`(boundary.ts), fitness delta(fitness-runner.ts) — 는 분석기가 무엇이든 모르도록 인터페이스 뒤에 있다:

- `ImpactAnalyzer.analyze(...) → AnalyzerResult` (impact-graph.ts:28). 주석이 명시: *"the analyzer is the BINDING's job"*.
- `EdgeAnalyzer.edges(...) → DependencyEdge[]` (boundary.ts:112).

그러나 **구현체가 TS 컴파일러 API에 직접 결합돼 있다**:

- `TsImpactAnalyzer` (impact/ts-analyzer.ts) — `typescript` 컴파일러의 type checker로 symbol→caller/type/export 그래프를 푼다.
- `TsEdgeAnalyzer` (boundary/ts-edges.ts) — import/export 모듈 그래프 + tsconfig alias.

이는 핸드오프 §4가 경고한 leak이다: **스펙이 저장소 중립이라 주장하지만, 분석 바인딩이 TS 하나뿐이라 TS 저장소에서만 동작한다.** boxwood(Java/Camunda 코어 + JS/TS 모델러 혼재 모노레포)처럼 다언어/비-TS 저장소에는 거버넌스를 걸 수 없다.

추가 동기:

- **LLM 구조 추론은 규모 비례로 부정확하다(사용자 관찰).** 코드베이스가 조금만 커져도 호출 관계·데이터 흐름을 정확히 못 잡는다. 거버넌스 게이트의 입력은 결정론적 정적 사실이어야 한다.
- **CodeQL은 이미 절반 배선돼 있다.** `src/core/codeql/*`가 multi-language(javascript/python/ruby/java/csharp/go/cpp/rust) DB 생성 → `analyze --format=sarif` → finding + dataflow codeFlow(source→sink)를 추출하고, fitness deterministic provider(핸드오프 #3)·reviewer finding·dialectic objection에 연결돼 있다. 즉 **데이터 흐름/취약점은 이미 CodeQL**로 가고, **impact(call graph)/boundary(import graph)만 아직 TS**다.

## 결정

### D1 — 코드 구조·관계·데이터흐름의 결정론 추출 엔진은 CodeQL로 통일한다

ACG가 정적 사실을 추출하는 모든 지점 — call graph(impact), import/dependency graph(boundary), dataflow·taint(fitness/security) — 의 1차 엔진을 CodeQL로 통일한다. analyzer 인터페이스(`ImpactAnalyzer`/`EdgeAnalyzer`)는 그대로 두고 **구현체를 CodeQL 기반으로 교체**한다(이미 바인딩 추상화가 있으므로 코어 변경 없음).

LLM 추론은 구조/관계 파악의 1차 수단으로 쓰지 않는다(아래 대안 참조).

### D2 — 바인딩별 언어-컴파일러 직접의존 분석기는 제거한다 (fast-path 폴백 없음)

`TsImpactAnalyzer`/`TsEdgeAnalyzer`(typescript 컴파일러 API 직접 사용)는 `CodeqlImpactAnalyzer`/`CodeqlEdgeAnalyzer`로 대체한 뒤 **삭제**한다. "TS 저장소는 빠른 TS 컴파일러, 그 외는 CodeQL"식 2-tier fast-path를 두지 **않는다**:

- 두 경로를 영구히 동등하게 유지하는 보증 부담이 생긴다.
- 한 언어 컴파일러에 묶인 경로가 남으면 그 자체가 §4 leak의 재발 통로다.

속도 비용은 commit-sha DB 캐시(이미 runner.ts에 있음) + 변경 파일 한정 분석으로 완화한다. 정확도·저장소 독립성을 속도보다 우선한다(사용자 결정).

### D3 — 관계 추출은 SARIF alert 모델이 아니라 "사실 추출" 경로로 한다

impact/boundary가 필요로 하는 것은 alert이 아니라 **관계**(어떤 symbol의 caller 집합, 모듈 간 의존 edge)다. 따라서:

- custom `.ql`로 관계를 `select`하고, `codeql database analyze`/`codeql query run` → BQRS → `codeql bqrs decode --format=json`(또는 관계를 finding 행으로 포장)으로 디코드한다.
- 기존 `sarif.ts`(alert 파서)와 **별개의 decode 경로**를 추가한다. 보안/데이터흐름은 기존 SARIF 경로 유지.

CodeQL 표준 QL 라이브러리(call graph: `Call`/`Callable`/`getACallee`, 모듈: `Import`/`Module` 등)를 재사용한다. 실제 동작·표현력은 마이그레이션 슬라이스 1에서 실증으로 닫는다(현재는 미실증 — 본 ADR은 그 검증을 done 조건으로 못박는다).

### D4 — 통일의 검증 단위 = boxwood 2번째 바인딩

CodeQL 통일이 "스펙을 TS에서 떼어냈는가"를 입증하는 방법은 **boxwood에 같은 스펙 + CodeQL analyzer를 돌리는 것**이다(§4 '가장 큰 수확'). 제약:

- boxwood는 **read-only 관측**. 실제 커밋/푸시 금지(사용자 명시).
- 산출물은 DITTO `.ditto/` 또는 `/tmp` 스크래치. boxwood 트리·git 절대 미변경. CodeQL DB도 `.ditto/cache` 또는 `/tmp`.
- boxwood는 **Java/Camunda 코어 + JS/TS 모델러 혼재** — multi-language라 단일 CodeQL 엔진의 가치가 직접 드러난다(TS 컴파일러로는 Java 코어를 못 본다).
- **현 PC에 boxwood 미클론**(새 PC). 착수 시 클론 선행. 대상 확정 후보: `boxwood-automation-engine`(Java/Camunda), `boxwood-portal-backend`, `boxwood-packages`(JS/TS).

## 비용·위험

- **DB build 비용**: 캐시미스 시 13.8초~3분(연구 부록2~4 실측). impact/boundary가 매 게이트마다 돌면 누적 비용 큼 → commit-sha 캐시 + 변경 파일 한정으로 억제. 그래도 TS 컴파일러보다 무겁다(수용된 트레이드오프).
- **빈 추출 = 거짓 깨끗함**: 컴파일 언어를 build 없이 추출하면 빈 결과가 '통과'로 오판된다(부록4: Kotlin none → 666 중 6클래스). `doctor codeql` fail-closed 선행이 필수(이미 doctor.ts에 존재) — 관계 추출 경로에도 동일 전제를 적용한다.
- **custom .ql 유지 부담**: 언어별 쿼리 작성·유지. 표준 QL 라이브러리 재사용으로 완화하고, impact/boundary 두 종류로 한정한다(범위 확장 금지).
- **TS 분석기 제거 = 회귀 위험**: JS 자기검증에서 CodeQL 결과가 기존 TS 분석기와 **동등한 caller/edge 집합**을 내는지 동등성 테스트로 닫은 뒤에만 제거한다(슬라이스 4 전제).

## 마이그레이션 (검증 가능한 슬라이스)

1. **CodeQL 관계추출 경로(D3)** — JS call graph custom .ql → BQRS decode → `AnalyzerResult` 동형 변환. 검증: 픽스처 저장소에서 알려진 caller 집합 재현.
2. **CodeqlImpactAnalyzer (JS)** → 기존 `TsImpactAnalyzer`와 **동등성 테스트**(같은 입력 → 같은 분류 집합).
3. **CodeqlEdgeAnalyzer (JS)** → `TsEdgeAnalyzer`와 동등성(alias 해소 포함).
4. **TS 분석기 제거** — 1~3 동등성 green 후 `ts-analyzer.ts`/`ts-edges.ts` 삭제 + 호출처 교체. 검증: 기존 ACG 회귀 스위트 green.
5. **java/kotlin 쿼리** → boxwood read-only 관측으로 다언어 동작 실증(D4). 검증: boxwood에서 unresolved/edge 산출이 비어 있지 않음 + doctor fail-closed 통과.

각 슬라이스는 독립 커밋·롤백 단위. 1~3이 깨지면 4(제거)로 진행하지 않는다.

## 대안 (기각)

- **LLM 구조 추론을 1차 수단으로**: 코드베이스 규모에 비례해 호출 관계·데이터 흐름 정확도가 떨어진다(사용자 직접 관찰). 거버넌스 게이트의 입력으로 부적합. 기각.
- **언어별 네이티브 분석기 유지**(TS 컴파일러 + JavaParser + …): N개 언어 = N개 분석기 유지 + 각 분석기가 스펙에 결합. 유지비·leak 표면이 N배. CodeQL 단일이 총비용 낮음. 기각.
- **CodeQL 기본 + TS fast-path 2-tier**: 두 경로 동등성 영구 보증 부담 + TS-only leak 재발 여지. 사용자 결정으로 기각(D2).

## 검증 (실증, 2026-06-04 — proposed→accepted 근거)

핵심 미실증 가정 — *"CodeQL이 impact 관계를 type checker 동등 정밀도로, 실용적 비용에 추출하는가"* — 를 DITTO 자기 저장소에서 실측해 해소했다. (사용자 결정: 사용자가 accept하기보다 실증 데이터로 판정.)

- **환경**: CodeQL 2.25.6 (osx64 universal), DITTO `src` 전체를 javascript DB로 빌드.
- **비용**: DB 빌드 `real 9.51s`(1회 — commit-sha 캐시로 재실행 절감), 쿼리 첫 실행 5.6s(쿼리 컴파일 포함)·이후 ~200ms.
- **타겟**: `parseSarif` (`src/core/codeql/sarif.ts:95`, exported function).
- **정답지(TS type checker, `ditto impact`)**: 14 affected nodes — direct_caller 5·test 8·external_surface 1.
- **CodeQL 관계추출**(custom `.ql` → `bqrs decode --format=csv`): import specifier(3) + var access(10) + 선언(1) = 14.
- **결과**: 위치(path:line) **14/14 완전 일치, TS-only/CodeQL-only 차이 0**. CodeQL은 import/call/decl을 분리 추출해 TS(전부 direct_caller로 뭉갬)보다 분류가 세밀하다.

**판정**: D1·D3 성립 — call graph를 SARIF alert이 아닌 BQRS 사실 추출 경로로, type checker 동등 정밀도·실용 비용에 추출. D2(TS 분석기 제거)의 회귀 위험은 함수 심볼에서 라인단위 동등성으로 해소.

**추가 실증 (동일 세션, 전부 위치단위 동등 — wi_260604cqe ac-3/4/6):**

- **type_contract(타입 참조) — ac-3**: 타겟 `CodeqlFinding`(interface). TS `ditto impact` 25노드(type_contract 18·import 3·test 3·decl 1) vs CodeQL(`LocalTypeAccess` 18 + `ImportSpecifier` 6 + `InterfaceDefinition` 1) → **위치 25/25 일치, 차이 0**. CodeQL JS 타입 모델이 type checker와 동등 — JS 타입 정밀도 우려 해소.
- **boundary import-edge — ac-4**: 타겟 `sarif-adapter.ts`(alias `~/schemas/*` 3 + 상대 `./sarif` + 패키지 `zod`). `TsEdgeAnalyzer.edges()` vs CodeQL `Import.getImportedModule()` → **diff 0**. CodeQL이 tsconfig alias를 `src/schemas/common.ts`로 동일 해소 — false-clean 위험 없음.
- **다언어(Java) — ac-6**: boxwood-engine(95 java, read-only, `--build-mode=none`, DB 23.38s)에 동일 `Call`/`Callable` 패턴 쿼리 → call graph 추출 성공·비어있지 않음(`MapBuilder.createBuilder` 23 callers 등). 거버넌스 개념의 저장소독립성 입증. **한계**: build-mode=none이라 외부 의존(Camunda) 호출은 unresolved 가능 — 동작 증명엔 충분, 완전성은 실제 바인딩에서 autobuild.

**판정 종합**: impact(call)·type_contract(type)·boundary(import-edge)가 JS에서 type checker와 위치단위 동등, Java에서 동일 쿼리 패턴 동작. D1~D4 성립.

**D2 마이그레이션 완료 (ac-5)**: `CodeqlImpactAnalyzer`/`CodeqlEdgeAnalyzer`를 구현(`src/acg/{impact,boundary}/codeql-*.ts` + 실행부 `src/core/codeql/relations.ts`·`host-deps.ts`)하고 호출처(impact.ts·boundary.ts·architecture.ts) 교체 후 `ts-analyzer.ts`·`ts-edges.ts` 삭제(참조 0). 전체 회귀 1011 pass / 0 fail, biome clean. **회귀 하나를 실측으로 잡음**: 초기 이름기반 쿼리(`VarAccess.getName()`)가 동명이인(decoy)을 과검출 → `getResolvedCallee()` + 선언 target-file 제한으로 정밀화해 "symbol resolution, not text search" 동등성까지 확보(e2e decoy 배제 통과, 동등성 14/25/5 재검증 유지). 구현 교훈: CodeQL은 라이브러리 API가 없어 CLI subprocess가 유일 표면 — 결과는 stdout 캡처가 아니라 `--output` 파일로 받아 파이프 교착을 원천 차단한다.

증거 산출물: `/tmp/cq-proof/`(DB·쿼리·bqrs, gitignored 스크래치 — 재부팅 시 소멸). JS 쿼리: `callers/all-refs/imports/decl/types/timports/tdecl/edges.ql`; Java 쿼리: `jqueries/j-top.ql`. 재현: §0-1 설치 후 `codeql database create --language={javascript|java}` + 해당 쿼리.

## 변경 조건 (이 ADR을 다시 열 때)

- 슬라이스 1에서 CodeQL이 impact/boundary 관계를 실용적 비용으로 추출하지 못함이 드러나면 D1/D3 재검토.
- DB build 비용이 캐시로도 게이트 UX를 해치는 수준이면 D2(폴백 금지)를 한정 완화 검토.
