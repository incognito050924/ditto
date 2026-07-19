# codeql — CodeQL을 DITTO의 유일 정적분석 엔진으로 통일하고, 그 결정론적 사실을 거버넌스 게이트에 먹인다

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋: `c2d2e16` (2026-07-19).

## 1. 이 기능이 실현하려는 설계 의도 (개념)

DITTO의 거버넌스 게이트(impact/boundary/fitness/security)는 **결정론적 정적 사실**을 입력으로 받아야 한다. LLM 구조 추론은 코드베이스 규모에 비례해 호출관계·데이터흐름 정확도가 떨어져 게이트 입력으로 부적합하다(ADR-0006 컨텍스트, 대안 기각). 그래서 코드 구조·관계·데이터흐름을 추출하는 1차 엔진을 **CodeQL 하나로 통일**하고, 언어별 컴파일러에 직접 결합한 분석기(TS 컴파일러 등)는 제거했다(ADR-0006 D1·D2).

이 커맨드가 존재하는 이유는 두 갈래다:
- **보안/데이터흐름 축**: `ditto codeql review`가 target repo를 CodeQL로 분석해 SARIF finding을 추출하고, 그것을 Stop 게이트가 읽는 위험 원장(`acg-review.json`)으로 투영한다. 고위험 finding이 증거 없이 남으면 완료를 막는다(`review-to-ledger.ts:1-19`).
- **구조/관계 축**: 같은 엔진(관계추출 경로)이 impact(call graph)·boundary(import edge)·semantic(signature diff)이 쓰는 사실을 뽑아낸다(`relations.ts:1-12`, ADR-0006 D3).

DITTO 4축 중 **거버넌스/오케스트레이션**을 떠받치는 기층 도구다. CodeQL 자체는 축이 아니라 축을 실현하는 결정론적 provider다(ADR-0018 D4: "도구는 축을 떠받치는 기층"). 도구 부재는 의도 실현을 막지 못하고 우아하게 강등된다(ADR-0018).

## 2. 코드 위치와 진입점

핵심 파일:

| 경로 | 역할 |
| --- | --- |
| `src/cli/commands/codeql.ts` | `ditto codeql review` CLI 진입 — 실제(Bun-backed) deps 조립 + 출력 |
| `src/cli/commands/doctor.ts:374-439` | `ditto doctor codeql [--install]` — 적합성 사전판정·설치 (형제 표면) |
| `src/core/codeql/doctor.ts` | fail-closed 사전판정: 언어감지·CLI가용성·컴파일언어 build 입증 |
| `src/core/codeql/install.ts` | opt-in CodeQL CLI 설치 (자동흐름 아님, `--install`시만) |
| `src/core/codeql/runner.ts` | 순수부(build-mode·인자·캐시키) + 실행부(spawn) — DB create→analyze→SARIF |
| `src/core/codeql/sarif.ts` | SARIF v2.1.0 파싱 → `CodeqlFinding[]` (dataflow codeFlow 평탄화) |
| `src/core/codeql/sarif-adapter.ts` | `CodeqlFinding` → `reviewer-output` 조립 (기존 스키마 재사용) |
| `src/core/codeql/review.ts` | SARIF를 evidence-store에 artifact로 기록 |
| `src/core/codeql/review-to-ledger.ts` | doctor→runner→adapter→acg-review 원장까지 end-to-end 오케스트레이션 |
| `src/core/codeql/dataflow-dod.ts` | taint finding → 검증가능한 Dataflow Definition-of-Done 명제 |
| `src/core/codeql/relations.ts` | 관계추출 경로(BQRS decode) — impact/boundary/semantic용 언어별 쿼리 |
| `src/core/codeql/host-deps.ts` | relations 실행용 실제 deps factory + 캐시 디렉터리 |

CLI 서브커맨드/인자:

`ditto codeql` 자체는 `review` 서브커맨드 하나만 노출한다(`codeql.ts:210-216`). 적합성 판정·설치는 `ditto doctor codeql`에 있다(별도 표면).

`ditto codeql review` 인자(`codeql.ts:112-133`):

| 인자 | 기본값 | 역할 |
| --- | --- | --- |
| `--work-item` (required) | — | 원장을 기록할 work item id |
| `--source-root` | `<repo>/src` | 분석 소스 루트 |
| `--language` | `javascript` | CodeQL 언어 |
| `--suite` | `<lang>-security-extended` | 쿼리 suite 스펙 |
| `--build-command` | — | 컴파일 언어 manual build-mode 빌드 명령 |
| `--build-verified` | `false` | clean build 재현 주장(컴파일 언어 unblock) |
| `--binary` | `codeql` (PATH) | CodeQL 바이너리 |
| `--download` | `true` | query pack 자동 다운로드 |
| `--output` | `human` | `human` \| `json` |

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

`ditto codeql review`의 흐름(`review-to-ledger.ts:67-129`):

```
work item id + source-root + language
  │
  ├─(1) doctor 先行(fail-closed): inspectCodeqlTarget
  │       └─ HIGH finding 있으면 → gated=true, 분석 안 함, 원장 안 씀 (return)
  │
  ├─(2) runCodeqlReview → runCodeqlAnalysis
  │       ├─ cacheKey(commitSha, language)로 캐시 확인 (SARIF 있으면 재사용)
  │       ├─ codeql database create (--build-mode 언어별 자동선택, LGTM_INDEX_FILTERS unset)
  │       ├─ codeql database analyze --format=sarif-latest → SARIF 파일
  │       ├─ parseSarif → CodeqlFinding[]
  │       └─ EvidenceStore.appendRecord(kind:'artifact') — SARIF를 증거 원장에 기록
  │
  ├─(3) assembleReviewerOutput → reviewerOutput.parse (검증)
  │       └─ persistReviewerOutput → work-items/<wi>/reviewer-output.json
  │
  ├─(4) projectReviewerOutputToAcgReview → persistLedger
  │       └─ work-items/<wi>/acg-review.json  ← Stop 게이트가 읽음
  │
  └─(5) toDataflowDoDs (taint finding만) → persistDataflowDoDs
          └─ work-items/<wi>/dataflow-dod.json  (명제, 게이트 아님)
```

읽고 쓰는 상태 파일(모두 `.ditto/local/` 하위, gitignored):
- **DB 캐시**: `.ditto/local/cache/codeql/<sha12>-<lang>/db` (`codeql.ts:148-149`)
- **SARIF 증거**: `.ditto/local/work-items/<wi>/evidence/codeql-<key>.sarif` (`codeql.ts:150-156`)
- **reviewer-output**: `work-items/<wi>/reviewer-output.json`, 스키마 `src/schemas/reviewer-output.ts`
- **acg-review 원장**: `work-items/<wi>/acg-review.json`, 스키마 `src/schemas/acg-review-graph.ts` (`kind: acg.review-graph.v1`)
- **dataflow DoD**: `work-items/<wi>/dataflow-dod.json` — 게이트 대상 스키마 아님, plain JSON(`codeql.ts:78-86`)

원장→게이트 연결: Stop hook이 `acg-review.json`을 읽어 `acgReviewForcesContinuation(graph)`를 돈다(`stop.ts:1001`). `risk === 'high' && evidence === undefined`인 파일이 있으면 완료를 막는 continuation reason을 낸다(`stop.ts:318-329`).

관계추출 경로는 별개다(`relations.ts:473-549`): DB create(캐시 미스 시) → 임시 workDir에 qlpack.yml + 렌더된 `.ql` 작성 → `codeql query run` → `codeql bqrs decode --format=csv --output=파일` → `parseCsvRows` → 행 배열. 소비처는 impact.ts·boundary.ts·semantic.ts·architecture.ts·symbol-expand.ts(§5 참조).

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

**단일 엔진 통일 (ADR-0006 D1·D2).** ACG는 스펙(저장소 중립)/바인딩(저장소별) 2계층인데, 바인딩 구현체가 TS 컴파일러에 직접 결합돼 있어 "스펙은 중립이지만 TS 저장소에서만 동작"하는 leak이 있었다(ADR-0006:15-20). CodeQL 단일로 통일해 multi-language를 얻고, "TS는 빠른 컴파일러, 그 외 CodeQL"식 2-tier fast-path는 두 경로 동등성 영구 보증 부담과 leak 재발 통로 때문에 **금지**했다(D2). 속도 비용은 commit-sha DB 캐시 + 변경파일 한정으로 완화하되, 정확도·저장소독립성을 속도보다 우선(사용자 결정, ADR-0006:42).

**관계는 alert이 아니라 "사실 추출" (ADR-0006 D3).** impact/boundary가 필요한 것은 취약점 alert이 아니라 caller 집합·import edge 같은 관계다. 그래서 custom `.ql`로 관계를 `select`하고 SARIF가 아닌 **BQRS decode(CSV) 경로**로 뽑는다(`relations.ts:1-12`). 기존 `sarif.ts`(alert 파서)와 별개다.

**doctor 先行 = fail-closed (ADR-0006 비용·위험, `doctor.ts:1-11`).** 컴파일 언어를 build 없이 추출하면 빈 결과가 '깨끗함'으로 오판된다(부록4: Kotlin build 없이 666 중 6클래스만 잡혀 alert 0). 빈 분석이 BLOCKING 게이트를 통과시키면 최악이므로, 분석 *전에* (a)언어지원 (b)CLI가용성 (c)build재현성을 판정해 HIGH가 있으면 분석 자체를 막는다(`review-to-ledger.ts:71-90`).

**우아한 강등 (ADR-0018).** CodeQL은 OPTIONAL 도구다. 부재·실패는 집행을 깨뜨리지 않고 우회(강등 또는 skip-continue)하며, 도구가 유일한 AC 충족수단일 때만 정직하게 unverified로 표면화한다(D1·D2). ADR-0006의 "폴백 없음"과 ADR-0018의 "강등"은 직교한다: 전자는 *두 번째 동등 분석기를 유지하지 않는다*, 후자는 *도구가 아예 없을 때 게이트를 inert로 만든다*(ADR-0018 "공개" 절). 설치는 분석 흐름 도중 몰래 하지 않고 `--install` opt-in으로만(`install.ts:1-18`).

**producer-CLI 종료코드는 범위 밖 (ADR-0018 D4).** `ditto codeql review`의 exit code는 단일 목적 도구의 계약이지 의도-실현 표면이 아니다. 그래서 doctor-gated는 precondition 실패로 non-zero exit(`codeql.ts:200-202`), 원장이 써졌으면 성공으로 취급한다(차단은 나중에 게이트의 몫).

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### runner.ts — 순수부/실행부 분리

**build-mode 선택** (`runner.ts:56-59`): `NO_BUILD_LANGUAGES`(javascript/python/ruby/actions)는 `none`, 컴파일 언어는 buildCommand 있으면 `manual` 아니면 `autobuild`. 컴파일 언어의 `none`은 빈 추출을 내므로 금지 — 이 한 줄이 false-clean 방지의 기점이다.

**Kotlin 라벨 분리** (`runner.ts:38-40`): `codeqlExtractorLanguage`가 kotlin→java로 매핑한다(전용 추출기 없음). 라벨을 kotlin으로 남기는 이유는 buildless 시 빈 추출을 내므로 `NO_BUILD_LANGUAGES`에서 빠져 반드시 빌드돼야 하기 때문(주석 명시).

**env unset** (`runner.ts:184`): `LGTM_INDEX_FILTERS`는 JS autobuild를 깨뜨려(부록4) 항상 unset. 실행부 전체에서 이 env가 강제된다.

**캐시** (`runner.ts:172-181`): 같은 커밋·언어의 SARIF가 있으면 spawn 없이 재사용 → DB 생성비용 회피. `fromCache: true`로 표시.

**파이프 교착 방지**: create/analyze 모두 stderr·stdout을 `drain`으로 끝까지 소비한 뒤 completion을 기다린다(`runner.ts:200-201`). relations는 한발 더 나가 `Promise.all([drain(stderr), drain(stdout)])`로 동시 비우고(대량 로그로 stdout이 차면 codeql이 블록됨, `relations.ts:497-499`), bqrs 결과를 stdout이 아닌 `--output` 파일로 받아 교착을 원천 차단한다(`relations.ts:531-532`).

### doctor.ts — fail-closed 판정 (순수)

**분류** (`classifyCodeqlTarget:93-143`): CLI 없으면 HIGH `cli-unavailable`. 지원언어 0이면 HIGH(unsupported만 감지 시 `language-unsupported`, 아니면 `no-source-detected`)로 즉시 return. 컴파일 언어가 감지됐는데 `buildVerified !== true`면 HIGH `compiled-language-build-unverified`. 미지원 혼재는 MEDIUM(차단 안 함). `doctorBlocks`는 severity==='high'만 게이트로 본다(`review-to-ledger.ts:63-65`).

**확장자→언어** (`LANG_BY_EXT:17-39`, `KNOWN_UNSUPPORTED_EXT:42`): `.kt`/`.kts`→java, php/scala/dart 등은 명시적 미지원. 목록에 없는 확장자(.md/.json)는 조용히 무시(소스 아님).

### sarif.ts — passthrough 파싱

우리 소유 포맷이 아닌 외부 표준(OASIS SARIF)이라 전체 검증 없이 **읽는 필드만** 방어적으로 추출한다(`.passthrough()` 다수, `sarif.ts:1-9`). `parseSarif`가 스키마에 안 맞으면 throw — 호출부가 CLI 산출물 손상을 감지하게 한다(`sarif.ts:95-97`). codeFlow의 threadFlow를 평탄화해 source→sink `dataflow[]`를 채운다(path-problem 쿼리에서만, `sarif.ts:99-121`).

### sarif-adapter.ts — 신설 0 재사용

`codeqlSeverity`(`:19-32`): SARIF error→high, warning→medium, note→low, **누락→medium**(보수적, 차단은 안 하되 묻히지 않게). error→high 매핑이 taint 결과를 admissibility(critical|high만 차단)로 끌어올린다(`:1-10`). `assembleReviewerOutput`(`:84-111`): verdict를 severity에서 파생 — high 있으면 `fail`, finding 있고 high 없으면 `partial`, 0이면 `pass`. `unverified`는 여기서 안 만든다("could not analyze"는 doctor의 몫). `different_provider_than_generator: false` — CodeQL은 LLM provider가 아니므로 cross-provider 주장 부적용.

### review-to-ledger.ts — end-to-end 오케스트레이션

§3 흐름의 5단계를 배선. `highRiskWithoutEvidence`(`:108-110`)는 원장 중 `risk==='high' && evidence===undefined`인 파일 수 — Stop 게이트가 완료를 막을 개수의 미리보기. deps 주입 구조라 fixture SARIF로 CLI 없이 전 파이프라인 테스트 가능(`:10-11`).

### acg-review-adapter.ts — 원장 투영

`projectReviewerOutputToAcgReview`(`:46-88`, 순수·I/O 없음): finding.severity→risk(critical/high→high), finding.file→path, unverified[]→`unresolved: true` 파일(risk=low로 고정). `human_review_set`은 risk==='high' 또는 unresolved인 파일의 파생 뷰. 반환 전 `acgReviewGraph.parse`로 검증.

**게이트가 evidence-absence를 키로 잡는 이유** (`stop.ts:311-317`): unverified→unresolved는 adapter가 risk=low로 고정하므로 `high ∧ unresolved`는 절대 생기지 않는다. 그래서 게이트를 `high ∧ unresolved`에 걸면 영구 inert가 된다. "high-risk without evidence"에 걸어야 사람이 판단해야 할 예외집합에서 실제로 발화한다.

### relations.ts — 관계추출

**쿼리 주입 방지** (`renderQuery:30-37`): `{{SYMBOL}}`은 식별자 화이트리스트(`/^[A-Za-z_$][A-Za-z0-9_$]*$/`)로 검증 후 치환, 안 맞으면 throw. `{{FILE}}`은 경로라 따옴표만 제거. 이 가드가 심볼을 쿼리에 안전히 인라인한다.

**선언 동일성** (`IMPACT_QUERY_JS:50-74`): 이름 텍스트가 아니라 `getResolvedCallee()`로 실제 그 선언으로 해소되는 호출만 잡아 동명이인(decoy)을 배제한다. 초기 이름기반 쿼리가 decoy를 과검출한 회귀를 이 기법으로 잡았다(ADR-0006:106).

**언어별 바인딩** (`RELATION_QUERIES:343-369`): javascript/java/kotlin/python. kotlin은 java 쿼리 그대로 재사용. `relationQueries`(`:372-381`)는 미등록 언어에 throw — 빈 결과를 '깨끗함'으로 오판 금지(fail-loud). "새 언어 바인딩은 여기 한 항목만 추가"(주석).

**소비처** (grep 확인): impact.ts·boundary.ts·semantic.ts·architecture.ts·change-contract.ts·`acg/scope/symbol-expand.ts`·`acg/semantic/signature-codeql.ts`. 즉 impact/boundary/fitness(architecture)/semantic이 같은 relations 엔진을 공유한다 — ADR-0006 D1의 "모든 정적사실 추출을 CodeQL로"의 실현체.

### install.ts — opt-in 설치

`installCodeqlCli`(`:101-164`): 이미 있으면 no-op, 없으면 github/codeql-cli-binaries 번들 다운로드(curl)→압축해제(unzip 실패 시 tar 폴백)→`~/.local/bin/codeql` 심링크. 실패해도 throw 대신 `status:'failed'` + 수동명령 반환(graceful, `:97-100`). 탐지 순서: `CODEQL_BIN`→PATH→gh extension→ditto-managed(`:169-182`). 설치 정본은 `scripts/install-plugin.mjs` step 3b와 동일해야 하며 갈라지면 모순된 codeql 2개가 생긴다(`:8-14` 경고).

### dataflow-dod.ts — 검증가능한 완료명제

`toDataflowDoD`(`:38-52`, 순수): dataflow 경로가 있는 taint finding만 GIVEN(source에 untrusted 입력)/WHEN(sink 도달)/THEN(sanitizer/barrier로 경로 차단)의 명제로 승격. `oracle`이 정확한 source→sink 위치를 지목. 경로 없는(구조적) finding은 null로 드롭 — dataflow 명제를 과적용하지 않는다(`:8-13`). **게이트 아님**, 무엇이 finding을 닫는지의 명세(`review-to-ledger.ts:112-113`).

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위: `src/core/codeql/*` 전체 + `codeql.ts` + `doctor.ts` codeql 서브커맨드 + adapter + stop 게이트 연결. 실제 CodeQL CLI를 돌린 e2e는 이 조사에서 실행하지 않음(미검증).

- **의도대로 동작(코드 정합)**: doctor 先행 fail-closed(`review-to-ledger.ts:71-90`), 캐시(`runner.ts:172`), evidence-absence 키 게이트(`stop.ts:318-328`), 관계추출 언어 바인딩 fail-loud(`relations.ts:372-381`), 우아한 강등 설치(`install.ts:126-130`)는 §4 의도와 일치한다. ADR-0006의 JS 동등성·Java 동작은 ADR 자체가 실증으로 닫았다고 기록(ADR-0006:85-104, 이 조사에서 재실행 안 함 — ADR 기록에 의존).

- **용어 drift(미미)**: doctor.ts 코어 주석은 build 입증을 "probe(`--probe`)"로 부르지만(`doctor.ts:10-11`, `:138`), CLI가 실제 노출하는 플래그는 `--build-verified`다(`doctor.ts:385-389`, `codeql.ts:125-129`). `--probe`라는 CLI 인자는 존재하지 않는다. 동작에는 영향 없으나 주석이 없는 플래그를 안내한다.

- **표면 분리**: `ditto codeql`은 `review`만, 적합성판정·설치는 `ditto doctor codeql`에 있다. 사용자 관점에서 "codeql 기능"이 두 최상위 명령에 나뉜다 — 의도된 분리(doctor는 진단, codeql은 분석)이나 재설계 시 발견성 고려점.

- **죽은 경로 미발견**: 확인 범위에서 도달 불가능한 경로는 못 찾음. relations의 소비처는 grep으로 7개 확인.

## 7. 잠재 위험·부작용·재설계 시 고려점

**보존해야 할 불변식:**
- **doctor 先行 fail-closed** — 빈 추출이 BLOCKING 게이트를 통과시키는 false-clean이 최악 시나리오(ADR-0006 비용·위험). 컴파일 언어 build 미입증 HIGH를 완화하면 이 방어가 뚫린다.
- **관계추출 미등록 언어 throw** — 빈 결과를 '깨끗함'으로 오판 금지(`relations.ts:374-380`). 언어 미지원을 조용한 빈 배열로 강등하면 게이트가 거짓 통과한다.
- **게이트 키 = high-risk without evidence** — `high ∧ unresolved`로 바꾸면 adapter의 risk=low 고정 때문에 영구 inert(`stop.ts:311-317`).
- **파이프 교착 방지 패턴** — stdout `--output` 파일 수신·동시 drain. 순차 read로 되돌리면 대량 로그에서 교착(`relations.ts:531`).

**약점·drift 위험:**
- **캐시가 commit-sha 키** — working tree가 커밋과 다르면 DB가 stale일 수 있다(알려진 한계, `host-deps.ts:59-66`). 커밋 안 한 변경을 분석하면 이전 상태를 볼 위험. 재설계 시 dirty tree 처리 명시 필요.
- **가변적 최상위 커맨드 2개** — codeql/doctor codeql. 설치·판정·분석 흐름이 흩어져 있어 신규 사용자 발견성이 낮다.
- **relations 실행이 매 게이트마다 DB create** — 캐시 미스 시 13.8초~3분(ADR-0006:64). impact/boundary가 자주 도는 경로에서 누적 비용. 캐시 키·변경파일 한정이 유일한 완화책이므로 이들이 약해지면 UX 회귀.
- **SARIF passthrough** — 외부 표준의 필드 이름이 바뀌면(CodeQL 버전 업) 조용히 빈 dataflow를 낼 수 있다. 파싱은 throw로 손상을 잡지만, 필드 optional화로 인해 "구조는 맞고 내용만 빈" 경우는 안 잡힌다.
- **producer-CLI exit code가 의도적으로 게이트와 분리**(ADR-0018 D4) — `codeql review`가 non-zero여도 원장이 써졌으면 성공. 이 규약을 모르는 상위 오케스트레이터가 exit code로 성공을 판단하면 오작동. 재설계 시 이 계약을 명시 유지해야 한다.
