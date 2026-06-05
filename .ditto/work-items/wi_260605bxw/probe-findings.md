# boxwood 2번째 바인딩 — automation-engine(Java) probe 결과

> 목적: ACG 스펙의 분석기 파이프라인(현재 JS QL 전용)이 두 번째 저장소(boxwood automation-engine, Java17/Camunda)로 이식되는지 실증.
> 대상: `/Users/ecoletree/dev/project/boxwood-workspace/automation-engine` (read-only 관측, **커밋/푸시/수정 없음**).
> 산출: CodeQL DB는 `/tmp/boxwood-cq-db`(휘발), 쿼리는 `probe/*.ql`. ditto src 무변경.

## 한 줄 결론
JS 관계쿼리의 **개념·정밀도 기법은 Java로 그대로 이식된다**(impact 7/7 정확, decoy 배제). 바인딩에 필요한 실제 변경은 **얕다** — `relations.ts`의 하드코딩된 JS QL 본문을 언어별 템플릿으로 분리하는 것뿐. 단일모듈 DB의 JAR 의존은 스펙이 이미 예견한 `unresolved: cross_repo`로 떨어진다.

## ac-1 — CodeQL Java DB 빌드 (build-mode=none, buildless)
- `codeql database create --language=java --build-mode=none` 성공(~50s). relations 10.44 MiB.
- 추출 밀도: **source method 5012 · method call 14429 · boxwood class 462**. buildless인데도 호출/멤버를 충분히 잡음 → 관계 추출에 사용 가능.
- 의의: Java는 컴파일언어지만 **Maven 빌드 없이** 추출됨. ditto runner의 `NO_BUILD_LANGUAGES`는 java를 빼서 autobuild를 고르는데(무거움), CodeQL 2.25는 java buildless 지원하므로 바인딩에서 java를 buildless-가능 집합에 넣는 선택지 있음.

## ac-2 / ac-3 — 관계쿼리 산출 + ground truth 대조
대상 심볼: `BoxwoodHistoryEventHandler.extractRequesterName` (distinctive, decoy 인접).

### impact (callers + decl) — `probe/impact-java.ql`
JS `IMPACT_QUERY_JS` 미러: **resolved-callee(`mc.getMethod() = target`) + 선언파일 핀**.
- DB 산출: caller 468·498·528·559·590·621 (6) + decl 928 = **7행**.
- ground truth(grep): 호출 6곳 동일 + 선언 928 동일. **위치 7/7 정확 일치, 차이 0.**
- **decoy 배제 검증**: 같은 파일 line 947 `extractRequesterNameFromHistory(...)`(다른 메서드)·954(그 선언)를 정밀쿼리가 **제외**. 순진한 부분문자열/이름매칭이면 오검출됐을 것 — §7-1이 JS에서 지목한 동명이인 문제의 해법(resolved-callee)이 Java QL에서도 동일하게 동작.

### boundary edge (cross-file 타입 의존) — `probe/edge-java.ql`
JS `EDGE_QUERY_JS` 미러(단, **usage 기반**: TypeAccess→declaring file).
- DB 산출: BoxwoodHistoryEventHandler → **10개 cross-file SOURCE 타입 엣지**(domain.execution / portal.service / runtime.* / common 등).
- ground truth(파일의 `import kr.co.ecoletree.*` 13개) 대조:
  - 2개(`Requester`, `StructuredErrorInfo`)는 **boxwood-domain-model JAR**(libs/) → source 아님 → 엣지 제외(정상, 아래 leak#3).
  - 11개 source import 중 `ActivityType`(line 35)는 **본문 미사용 import** → usage 기반 쿼리가 올바르게 제외.
  - 나머지 10개 = 산출 10개와 일치. **usage 기반이 import-문 기반보다 정밀**(미사용 import 제외).

## ac-4 — 스펙/파이프라인 leak·발견 (바인딩에 필요한 변경)
1. **[얕은 leak, 핵심] 관계쿼리 본문이 JS 하드코딩.** `src/core/codeql/relations.ts`의 `IMPACT_QUERY_JS`·`EDGE_QUERY_JS`·`SYMBOL_DECL_QUERY_JS`가 전부 `import javascript`. runner는 `CodeqlLanguage`로 매개변수화돼 있고 `qlpackYml(language)`는 `codeql/${language}-all`을 쓰지만, **쿼리 문자열만 JS 전용**. → 바인딩 작업 = 쿼리 본문을 `언어→템플릿` 맵으로 올리고(`IMPACT_QUERY_JAVA` 등) 언어로 선택. 추상화(runRelationQuery/BQRS decode/캐시)는 언어무관이라 그대로 재사용. **이게 "바인딩이 분석기를 꽂는다"의 구체 지점.**
2. **[good news] buildless 추출이 Java에서 충분.** 관계 추출엔 Maven 빌드 불필요(ac-1). dataflow/taint(보안 fitness)는 빌드 필요할 수 있으나 impact/boundary는 buildless로 족함.
3. **[스펙이 예견한 한계, leak 아님] 단일모듈 DB의 형제모듈 의존은 JAR로 빠짐.** import 13개 중 2개가 `boxwood-domain-model-2.2.51.jar`(libs/) 타입 → `fromSource()` false → source 엣지 없음. 이는 20-contracts §2가 `libs/boxwood-domain-model JAR`를 cross-repo 대표사례로 들고 `ImpactGraph.unresolved: cross_repo`로 받게 한 바로 그 케이스. 바인딩은 (a) 멀티모듈 reactor DB로 빌드하거나 (b) JAR 의존을 `unresolved`로 기록. **스키마가 이미 자리를 마련해둠 → 스펙 저장소독립성의 긍정 증거.**
4. **[바인딩 결정거리] 엣지 의미.** JS는 import-문 기반(ImportDeclaration), 이 probe는 usage 기반(TypeAccess). usage가 더 정밀(미사용 import 제외). 바인딩별 선택 가능하나 결정은 명시할 것.
5. **[정밀도 기법 이식 확인] resolved-callee + 선언파일 핀**이 Java QL에서 동일하게 decoy를 배제(ac-3). 분석기의 정밀도 접근이 언어무관임을 실증.

## 저장소 독립성 판정
- 스펙(9 스키마·불변식·결과형식)과 분석기 추상화는 **Java에 이식 가능**. DITTO/TS 고유 가정이 깊게 박힌 leak은 발견되지 않음.
- 유일한 실질 결합점은 **쿼리 본문 하드코딩(leak#1)** — 얕고 국소적, `relations.ts` 한 곳을 언어별 템플릿으로 바꾸면 해소.
- cross-module JAR(leak#3)은 스펙이 이미 `unresolved`로 설계 → 독립성을 **확인**해주는 사례.

## 재현 (새 PC, CodeQL 설치 후)
```bash
codeql database create /tmp/boxwood-cq-db --language=java --build-mode=none \
  --source-root=/Users/ecoletree/dev/project/boxwood-workspace/automation-engine --overwrite
# probe/*.ql 를 qlpack(codeql/java-all 의존)에 넣고:
codeql query run --database=/tmp/boxwood-cq-db probe/impact-java.ql
codeql query run --database=/tmp/boxwood-cq-db probe/edge-java.ql
```

## 다음 (후속, 이 work item 범위 밖)
- 정식 바인딩: `relations.ts` 쿼리를 언어별 템플릿화 + Java용 `CodeqlImpact/EdgeAnalyzer` 배선 + 테스트(handoff §7-1 ts→codeql 마이그레이션과 동형).
- 멀티모듈 reactor DB(또는 JAR→unresolved 기록)로 cross-module 의존 처리.
- portal-backend(Kotlin)·frontend(TS)로 polyglot 확장 시 동일 패턴.
