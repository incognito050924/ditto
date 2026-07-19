# boundary — 변경이 ArchitectureSpec의 의존 규칙(Dependency Rule)을 어기는지 검사하는 ACG 경계 게이트

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋: `c2d2e16`, 날짜: 2026-07-19.

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto boundary check`는 Clean Architecture의 **Dependency Rule을 기계 검사(machine-check)**하는 게이트다. 한 변경이 도입한 모듈 간 의존 edge를 뽑아, 저장소별 `ArchitectureSpec` 선언에 비추어 금지된 의존을 찾아낸다 (`src/acg/boundary/boundary.ts:3-18` 헤더 주석).

- 푸는 문제: 사람이 리뷰로 놓치기 쉬운 계층 위반(예: 도메인 로직이 컨트롤러를 호출, 상위 계층이 하위 계층을 우회)을 결정론적 정적 사실로 잡는다.
- 위반을 "즉시 실패"로만 처리하지 않고, **각 위반을 HIGH-risk·무증거(un-evidenced) 항목으로 acg-review 원장(ledger)에 투영**해 이미 존재하는 Stop 게이트(`acgReviewForcesContinuation`)가 완료를 막게 한다. 새 배선을 만들지 않고 기존 완료 차단 경로를 재사용한다는 것이 핵심 설계 결정이다 (`src/cli/commands/boundary.ts:21-29`).

DITTO 4축(의도/오케스트레이션/E2E/지식) 중 어디에도 직접 속하지 않고, **거버넌스(ACG, Architecture-Conformant Governance)** 계열이다. ArchitectureSpec에 선언된 아키텍처 계약을 코드 변경에 강제하는 게이트다. 코드 주석은 이를 "단계6 boundary gate (DITTO/TS binding)"라 부른다 (`src/cli/commands/boundary.ts:22`).

## 2. 코드 위치와 진입점

| 파일 | 역할 |
| --- | --- |
| `src/cli/commands/boundary.ts` | CLI 진입점(`boundary check` 서브커맨드). 스펙 로드 → 가드 → edge 추출 → 규칙 검사 → 원장 기록/출력 오케스트레이션 |
| `src/acg/boundary/boundary.ts` | 순수 규칙 검사 코어(`checkBoundary`/`checkEdge`), glob 매칭, 계층 판정. edge "추출"은 하지 않음 |
| `src/acg/boundary/codeql-edges.ts` | `EdgeAnalyzer`의 CodeQL 구현. 변경 파일의 import edge를 CodeQL 관계 추출로 뽑음 |
| `src/acg/internal-packages.ts` | JVM(java/kotlin) 형제모듈 cross_repo 침묵 손실을 막는 fail-loud 가드 |
| `src/core/acg-review-store.ts` | 위반을 `.ditto/local/work-items/<wi>/acg-review.json`으로 원자적·스키마 검증 기록 |
| `src/schemas/acg-architecture-spec.ts` | 입력 계약(zod SoT) — layers·forbidden_dependencies·internal_packages |
| `src/schemas/acg-review-graph.ts` | 출력 원장 계약(zod SoT) — Stop 게이트가 읽는 형태 |
| `src/hooks/stop.ts` | `acgReviewForcesContinuation`(:318) — 원장을 읽어 완료를 차단하는 소비자 |

### 서브커맨드·CLI 인자

서브커맨드는 `check` 하나뿐이다 (`src/cli/commands/boundary.ts:49-50`).

| 인자 | 타입 | 필수 | 의미 |
| --- | --- | --- | --- |
| `--work-item` | string | 예 | 위반 원장을 기록할 work item id (`:56`) |
| `--spec` | string | 예 | ArchitectureSpec 경로(`.yaml/.yml` 또는 `.json`) (`:57-61`) |
| `--file` | string | 예 | 변경 파일(콤마 구분으로 반복) (`:62-66`) |
| `--no-ledger` | boolean(기본 false) | 아니오 | 보고만 하고 `acg-review.json`은 안 씀 (`:67-71`) |
| `--language` | string | 아니오 | CodeQL 언어: javascript(기본)/java/kotlin/python (`:72-76`) |
| `--source-root` | string | 아니오 | 분석 소스 루트(기본 `<repo>/src`) (`:77`) |
| `--build-command` | string | 아니오 | 컴파일 언어 manual build-mode용 빌드 명령 (`:78-81`) |
| `--output` | string(기본 human) | 아니오 | 출력 형식: human/json (`:82`) |

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

```
--spec(ArchitectureSpec)  --file(변경 파일들)  --language
        │                        │                 │
        ▼                        │                 │
 readArchitectureSpec            │                 │
 (zod acgArchitectureSpec) ──────┼── internal_packages ──▶ runInternalPackagesGuard
        │                        │                          (JVM만; block/warn/ok)
        │                        ▼                                 │block→exit 65
        │                CodeqlEdgeAnalyzer.edges()  ◀── sourceRoot│
        │                (CodeQL DB → import edge)                 │
        │                        │ DependencyEdge[]                │
        ▼                        ▼                                 │
   checkBoundary(spec, edges) ──▶ BoundaryViolation[]             │
        │                                                          │
        ├─ 위반>0 && !--no-ledger ─▶ AcgReviewStore.write(wi, graph)
        │                            → .ditto/local/work-items/<wi>/acg-review.json
        │                              (Stop 게이트가 읽어 완료 차단)
        ▼
   출력: human(줄별 VIOLATION) 또는 json / 위반>0이면 exit 70
```

읽는 상태:
- ArchitectureSpec: `--spec` 경로. 스키마 `acgArchitectureSpec` (`src/schemas/acg-architecture-spec.ts:42`). `readArchitectureSpec`가 yaml/json을 읽어 zod 검증 (`src/cli/commands/boundary.ts:97`).
- (JVM일 때) `--source-root` 아래 로컬 `*.jar` 스캔 (`src/acg/internal-packages.ts:119`).
- CodeQL DB: commit-sha + 언어로 키된 캐시 디렉터리 `codeqlCacheDir(repoRoot, language)` (`src/cli/commands/boundary.ts:135`).

쓰는 상태:
- 위반 원장: `.ditto/local/work-items/<wi>/acg-review.json`, 스키마 `acgReviewGraph` (`src/core/acg-review-store.ts:17`, `src/schemas/acg-review-graph.ts:70`). `--no-ledger`면 기록 생략.

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### (1) 두 종류의 위반: forbidden_dependency + layer

`checkEdge`는 각 edge를 두 규칙에 건다 (`src/acg/boundary/boundary.ts:72-101`):

- **forbidden_dependency**: `from`/`to` path 글로브 쌍이 spec의 `forbidden_dependencies`에 선언된 금지 쌍과 매칭되면 위반. 완전히 spec-grounded (`:75-84`).
- **layer** (Dependency Rule): 파일의 계층은 "layers 키가 경로 세그먼트로 등장하는지"로 판정한다 — boxwood 관례로 `…/controller/…` ⇒ `controller` (`:59-69`, `pathToLayer`). from-계층이 to-계층을 `can_call`에 포함하지 않으면 위반. **양 끝이 모두 알려진 계층에 매핑될 때만** 규칙 적용 (`:88`, `fromLayer && toLayer && fromLayer !== toLayer`). 한쪽이라도 계층 미상이면 layer 규칙은 침묵(forbidden_dependency만 적용).

### (2) edge "추출"과 "규칙 검사"의 분리

`boundary.ts` 헤더가 명시: edge 추출(모듈 그래프 파싱)은 바인딩의 analyzer 몫이고, 이 모듈은 순수 규칙 검사만 소유한다 (`src/acg/boundary/boundary.ts:16-17`). `EdgeAnalyzer` 인터페이스(`:112-114`) 뒤로 구현체를 갈아끼울 수 있게 한 것. 이 추상화 덕에 코어 변경 없이 TS 컴파일러 분석기 → CodeQL 분석기로 교체했다.

**채택 근거 — ADR-0006** (정적 분석 엔진 CodeQL 통일): LLM 구조 추론은 규모 비례로 부정확해 거버넌스 게이트 입력으로 부적합, 언어별 네이티브 분석기(TS 컴파일러 등)는 N개 언어 = N개 분석기 유지 + spec 결합(leak) 표면 N배. CodeQL 단일로 통일하고 `TsEdgeAnalyzer`는 삭제(fast-path 폴백 없음). boundary import-edge 동등성은 `sarif-adapter.ts` alias 3 + 상대 + 패키지 zod에 대해 TS 분석기와 diff 0으로 실증(ADR-0006 검증 ac-4).

### (3) 위반 → 기존 Stop 게이트로 완료 차단 (새 배선 없음)

위반을 별도 exit 코드나 새 차단 경로로 처리하지 않고, `risk:'high'` + `unresolved:true` + 증거 없음으로 acg-review 원장에 투영한다 (`src/cli/commands/boundary.ts:30-42`). Stop 게이트 `acgReviewForcesContinuation`는 "risk=high AND evidence 없음"인 파일마다 완료 차단 사유를 낸다 (`src/hooks/stop.ts:318-329`). 즉 boundary 위반 = 사람이 해소해야 하는 고위험 변경으로 자동 취급된다. 채택 이유: 리뷰-예외(Review by Exception) 원장이 이미 존재하므로 재사용이 최소 변경.

### (4) JVM cross_repo 가드 — ADR-0007

단일모듈 CodeQL DB로 JVM을 분석하면 형제모듈 JAR 타입 의존이 `fromSource()` 필터에서 빠져 침묵 손실된다. `internal_packages`에 형제모듈을 명시 선언(`glob`=cross_repo 분류 대상 패키지, `path`=로컬 JAR 위치)하게 하고, 로컬 JAR이 있는데 선언에 누락이 있으면 **차단**한다 (`src/acg/internal-packages.ts:45-80`, ADR-0007 D1/D3). 기각된 대안: source-root를 항상 reactor 상위로(빌드 비용), prefix 문자열 매칭(표현력 약함), JAR unzip 정밀 커버리지(비용).

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### `boundaryCommand.run` — 오케스트레이션 (`src/cli/commands/boundary.ts:84-169`)

순서 의존적 파이프라인:

1. **출력 형식 파싱** (`:85-92`): `parseOutputFormat` 실패 시 즉시 `USAGE_ERROR_EXIT`(65). 나머지와 분리된 try — 잘못된 `--output`은 사용 오류.
2. **스펙 로드** (`:95-106`): `readArchitectureSpec`가 실패하면 `USAGE_ERROR_EXIT`(65) + 원본 에러 메시지 래핑. zod 검증 실패도 여기서 사용 오류로 처리.
3. **변경 파일 파싱** (`:107-110`): 콤마 split → trim → 빈 문자열 제거. 빈 리스트 가능(그러면 edge 필터가 `any()` — §edge 아래).
4. **JVM 가드** (`:113-127`): `runInternalPackagesGuard`. `block`이면 `USAGE_ERROR_EXIT`(65)로 중단, `warn`이면 stderr 경고 후 진행. 이 가드가 edge 추출보다 **먼저** 돌아 형제모듈 손실 위험을 선차단한다.
5. **buildMode 결정** (`:128-130`): `--build-command`가 없고 `language === 'java'`면 `buildMode='none'`(buildless). 그 외는 언어 기본에 위임. (주의: kotlin은 여기서 자동 none이 아니다 — `--language` 설명이 kotlin은 build-command나 autobuild 필요라 명시, `:75`.)
6. **edge 추출** (`:131-141`): `CodeqlEdgeAnalyzer.edges({changedFiles, sourceRoot})`.
7. **규칙 검사** (`:142`): `checkBoundary(spec, edges)`.
8. **원장 기록** (`:144-149`): 위반>0 && !`--no-ledger`면 `AcgReviewStore.write`.
9. **출력·종료** (`:151-164`): json이면 edge 수·위반 목록·`ledger_written`, human이면 위반 0은 ok 한 줄, 위반은 줄별 `VIOLATION`. 위반>0이면 `RUNTIME_ERROR_EXIT`(70)로 종료 (`:164`).
10. **최상위 catch** (`:165-168`): 그 외 예외는 `RUNTIME_ERROR_EXIT`(70).

숨은 결정: exit 코드가 두 갈래다 — 사용 오류(스펙/가드/출력형식)는 65, edge 추출 실패·위반 검출은 70. 위반 검출은 "런타임 실패"로 신호되어 CI/훅이 비-0으로 감지한다.

### `checkEdge` / `checkBoundary` — 순수 규칙 (`src/acg/boundary/boundary.ts:72-109`)

- `checkEdge`는 edge당 0~2개 위반 반환(forbidden + layer 동시 가능). `checkBoundary`는 `edges.flatMap`으로 전체 위반 평탄화 (`:108`). 게이트 통과 = 반환 리스트가 비었을 때("boundary 위반 0").
- `globToRegExp` (`:35-53`): `**`=`.*`(슬래시 포함), `*`=`[^/]*`(슬래시 제외), regex 특수문자 이스케이프, `^…$` 앵커. 이 정규화가 spec의 path 글로브와 edge 경로 매칭 의미를 고정한다. **주의: `internal-packages.ts:14`가 이 함수를 재사용**해 JVM 가드의 패키지/JAR 글로브도 같은 의미로 매칭한다(호출자 2곳).
- `pathToLayer` (`:60-69`): 경로를 `/`로 나눠 layers 키가 세그먼트로 있으면 그 계층. 첫 매칭 반환(선언 순서 의존). 세그먼트 정확 일치라 부분 문자열은 매칭 안 됨.

### `CodeqlEdgeAnalyzer.edges` — 추출 + 정규화 (`src/acg/boundary/codeql-edges.ts:44-72`)

- `renderEdgeQuery(changedFiles, language)`로 변경 파일 필터를 박은 관계 쿼리를 만들어 `runRelationQuery` 실행 (`:45-58`). 변경 파일이 비면 필터가 `any()`가 되어 **전체 소스**를 훑는다 (`src/core/codeql/relations.ts:107-110`) — CLI가 `--file` 필수라 이 경로는 CLI에선 안 열리나, 라이브러리 직접 호출 시 열림(추론).
- **`stripModuleExt`** (`:19-24`): import 대상의 확장자를 벗겨 ArchitectureSpec의 repo-path 형태로 정규화. CodeQL extractor가 tsconfig alias를 이미 해소하므로 `~/schemas/x` → `src/schemas/x.ts`로 나오고, 여기서 `.ts` 등을 벗겨 `src/schemas/x`로 맞춘다 (`:1-9` 헤더). 해소 실패한 외부 패키지는 raw specifier 그대로(글로브 매칭 유지).
- **중복 제거** (`:60-70`): `from␠to` 키로 `seen` Set을 써 동일 edge 중복 제거. `from`/`to` 빈 행은 skip.

### `evaluateInternalPackages` — JVM 가드 판정(순수) (`src/acg/internal-packages.ts:45-80`)

3-상태 결정:
- 비JVM → `ok` (형제 JAR 개념 없음, `:50-55`).
- 로컬 JAR 존재 && (glob 미선언 OR path로 안 덮인 JAR) → `block` (`:62-70`). 이유 문자열에 미커버 JAR 목록과 선언 방법을 담아 fail-loud.
- glob 미선언 + 로컬 JAR 없음 → `warn` (cross_repo 기록 비활성, `:71-78`).
- glob 선언 + JAR 모두 커버 → `ok` (`:79`).

`scanLocalJars` (`:119-140`)는 source-root 아래 `*.jar`을 깊이 6 바운드로 스캔하되 `node_modules/.git/.ditto/target/build/dist/.gradle/out`은 제외 — 빌드 산출물 JAR은 형제모듈 선언 대상이 아니므로 (`:103-113`).

### `violationsToReviewGraph` — 원장 투영 (`src/cli/commands/boundary.ts:30-42`)

각 위반을 `role:'service_logic'`, `risk:'high'`, `unresolved:true`, `risk_reason`에 규칙·from·to·reason을 담은 파일 항목으로 만들고, `human_review_set`은 `from` 경로의 중복 제거 집합. `acgReviewGraph.parse`로 스키마 검증(부적합 시 throw). evidence 필드는 없음 → Stop 게이트가 "고위험·무증거"로 차단.

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위: 위 6개 소스 파일 + 두 ADR + Stop 게이트 소비자 함수. 실행 테스트는 돌리지 않음(정적 독해).

- **위반 → 완료 차단 배선**: `violationsToReviewGraph`가 만든 항목은 `risk:'high'` + `evidence` 없음이고, `acgReviewForcesContinuation`가 정확히 이 조건("high AND evidence undefined")에 차단 사유를 낸다 (`src/hooks/stop.ts:321`). 의도대로 연결됨.
- **`unresolved` 플래그의 역할**: `violationsToReviewGraph`는 `unresolved:true`를 세팅하지만, Stop 게이트는 `unresolved`가 아니라 `evidence === undefined`로 차단을 판정한다 (`src/hooks/stop.ts:312-316` 주석이 이 선택을 명시: `high ∧ unresolved`는 다른 경로에서 생성되지 않아 그 키로는 게이트가 무력해짐). 즉 boundary가 세팅한 `unresolved:true`는 **차단 판정에는 직접 쓰이지 않는다** — evidence 부재가 실제 트리거. 기능상 불일치는 아니나(evidence도 비어 있으므로 차단은 발생), `unresolved:true`는 이 경로에서 사실상 무효과 필드다(미묘한 잉여).
- **layer 규칙의 적용 조건**: 양 끝이 알려진 계층일 때만 적용(`boundary.ts:88`). ArchitectureSpec의 `layers`가 비어 있으면(스키마 기본 `{}`, `src/schemas/acg-architecture-spec.ts:47`) layer 위반은 절대 안 난다 — forbidden_dependencies만 유효. 설계 의도(계층 매핑 안 되면 규칙 미적용)와 일치.
- **kotlin buildMode**: java만 자동 `buildMode='none'`(`:129-130`). kotlin은 `--build-command` 없으면 언어 기본 build-mode에 위임되며, ADR-0006 비용·위험이 경고한 "빈 추출 = 거짓 깨끗함" 위험이 kotlin buildless에서 열릴 수 있다(추론 — 코드가 kotlin buildless를 자동 차단하지 않음). `--language` 설명이 kotlin은 build-command/autobuild 필요라 안내하나 강제 검증은 없음(미확인: doctor codeql fail-closed가 이 경로를 실제로 받치는지 실행 확인 안 함).

확인 범위에서 명백한 죽은 경로·기능 불일치는 없음. 단, 위 `unresolved:true` 잉여와 kotlin buildless 안내-무강제 두 지점은 재설계 시 정리 후보.

## 7. 잠재 위험·부작용·재설계 시 고려점

- **계층 판정의 취약성**: `pathToLayer`가 "layers 키 == 경로 세그먼트"로만 계층을 정한다 (`boundary.ts:60-69`). 저장소가 boxwood식 디렉터리 관례(`…/controller/…`)를 안 따르면 계층이 전부 미상 → layer 규칙 전부 침묵. 이 관례가 spec으로 표현되지 않아(암묵), 다른 저장소에 걸 때 "게이트가 아무것도 안 잡는데 통과처럼 보이는" 거짓 깨끗함이 생길 수 있다. 재설계 시 계층 매핑 규칙을 명시적 계약으로 올리는 것을 고려.
- **CodeQL 빈 추출 = 거짓 깨끗함**: ADR-0006이 명시한 핵심 위험. 컴파일 언어를 build 없이 추출하면 빈 edge 집합이 "위반 0"으로 오판된다. `doctor codeql` fail-closed 선행이 전제이나, `boundary check` 자체는 edge 수가 0이어도 그냥 ok를 낸다(`:158-159`). edge=0이 "정말 의존이 없음"인지 "추출 실패"인지 이 명령만으론 구별 못 함 — 재설계 시 edge=0 + 비-빈 변경일 때 경고/차단을 넣을지 고려.
- **JVM 가드의 한계 (ADR-0007)**: 훅 텍스트 매칭(`parseJvmCodeqlCommand`, `:188-194`)은 `ditto … impact|boundary --language java|kotlin` 리터럴만 잡아 별칭/변형 호출은 CLI 내장 가드에 의존. 멀티모듈 reactor 빌드가 기본이 되면 가드 자체가 무의미해짐(ADR-0007 변경 조건).
- **원장 덮어쓰기**: `AcgReviewStore.write`는 work item당 파일 하나를 통째로 쓴다(`src/core/acg-review-store.ts:29-31`). 같은 work item에 boundary와 다른 리뷰 생산자(reviewer-output 어댑터 등)가 둘 다 `acg-review.json`에 쓰면 후자가 전자를 덮을 수 있다(추론 — 병합 로직 없음). 재설계 시 boundary 위반과 일반 리뷰 원장의 소유권 경계를 확인 필요.
- **재설계 시 보존해야 할 불변식**:
  1. edge 추출(바인딩)과 규칙 검사(코어)의 분리 — `EdgeAnalyzer` 인터페이스 경계 (ADR-0006).
  2. 위반은 실패-exit뿐 아니라 완료 차단 원장으로 투영되어야 함(리뷰-예외 재사용, 새 배선 금지).
  3. JVM 형제모듈 침묵 손실 fail-loud 가드 — 로컬 JAR 존재 + 선언 누락 = block (ADR-0007 D1/D3).
  4. glob 정규화(`globToRegExp`)의 `^…$` 앵커·세그먼트 의미 — boundary와 internal-packages 두 소비자가 공유하므로 바꾸면 양쪽에 영향.
- **재고 가능한 결정**: `unresolved:true` 잉여 필드(§6), edge=0 무경고, kotlin buildless 안내-무강제.
