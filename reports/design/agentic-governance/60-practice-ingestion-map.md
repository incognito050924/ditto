---
title: "ACG Practice Ingestion Map"
kind: mapping
last_updated: 2026-06-04 KST
status: draft
scope: "mattpocock/skills 문서군에서 ACG에 흡수할 만한 engineering practice를 선별하고, 각각을 ACG의 계약·게이트·증거 모델로 어떻게 번역할지 기록한다. 이 문서는 core spec이 아니라 흡수 후보 지도다. 2026-06-04 개정: DeepWiki 색인이 아니라 GitHub 원천 마크다운 45개 파일을 전수 정독해 67개 practice를 재번역했다."
parent: 00-framework.md
---

# ACG Practice Ingestion Map

> **이 문서의 위치.** [00~50](00-framework.md)은 ACG의 core spec이다. 이 문서는 core spec이 아니라 **외부 engineering practice를 ACG로 가져오기 전의 번역 지도**다. 좋은 개발 조언을 그대로 복사하지 않는다. ACG에 들어오려면 반드시 `ChangeContract`, `ArchitectureSpec`, `ImpactGraph`, `ReviewGraph`, `FitnessFunction`, `SemanticCompatibility`, `AssuranceSnapshot`, `CompletionContract` 같은 산출물이나 게이트로 내려와야 한다.

> **출처 사용 원칙.** DeepWiki는 탐색용 색인이다. 문서에 근거로 남길 때는 DeepWiki가 가리키는 GitHub 원천 파일을 우선한다. 이번 개정은 [`mattpocock/skills`](https://github.com/mattpocock/skills)의 원천 마크다운 45개(`skills/engineering/tdd/*`, `improve-codebase-architecture/*`, `grill-with-docs/*`, `diagnose`, `prototype/*`, `to-prd`/`to-issues`/`zoom-out`, `triage/*`, `productivity/*`, `misc/*`, `deprecated/*`, `in-progress/*`, 루트 `CLAUDE.md`/`README.md`/`CONTEXT.md`)를 직접 읽고 67개 practice를 추출·번역했다. 아래 링크는 원천 파일을 가리킨다.

## 0. 흡수 원칙

외부 practice는 다음 조건을 **모두** 만족할 때만 ACG core에 반영한다.

| 조건 | 의미 |
|---|---|
| ACG 산출물로 번역 가능 | 조언이 아니라 `schema field`, `gate predicate`, `ReviewGraph risk_reason`, `FitnessFunction`으로 표현 가능해야 한다 |
| 검증 증거가 있다 | 테스트·타입체크·정적 분석·diff·실행 로그·명시적 human review 중 하나로 닫혀야 한다 |
| 실패 처리가 있다 | 위반 시 block/warn/track/escalate 중 무엇인지 정해져야 한다 |
| 범위가 좁다 | ACG를 일반 개발 방법론 모음으로 만들지 않는다. agentic 변경 품질에 직접 연결되는 것만 흡수한다 |
| 기존 ACG 원칙과 충돌하지 않는다 | 변경은 작고, 의도 축소를 숨기지 않고, 증거 없는 완료를 금지해야 한다 |

> **enforcement 등급 규율(이 개정의 일관 기준).** 판정이 **결정론적**(grep, 카운트, 테스트 통과/실패, 정적 쿼리)이면 `block`까지 갈 수 있다. 판정이 **구조적/의미적 휴리스틱**(모듈이 얕은가, 의미가 보존됐는가, 용어가 충돌하는가)이면 기본 `warn`이고, 결정론적 metric으로 환원되는 부분만 `track`으로 시계열화한다. 레거시 부채가 많은 영역(boxwood 커버리지 2.7%/11%)에서 휴리스틱을 `block`으로 걸면 코드베이스가 멈춘다 — 그래서 신규 산출물에만 강제하고 기존 것은 `track`한다.

## 1. 흡수 결과 요약

전수 번역 결과: **core_ingest 31, binding 8, reject 28**.

핵심은 정직하게 말하면 이렇다. **core_ingest 31개 중 다수는 "신규 흡수"가 아니라 이미 ACG에 있는 게이트의 출처 확인·정밀화(confirmatory grounding)다.** Evidence Quality 등급, Deep Module Gate, `decision_ref`, `forbidden_scope` minItems, `acceptance` minItems은 이미 스펙에 있다 — 이번 정독은 그것들이 어떤 원천 규칙에서 왔는지를 확정하고 표현을 날카롭게 했다.

**진짜로 새로 흡수 가능한 표면은 네 곳에 집중된다.**

1. **표준 `risk_reason` 어휘**(§2). 지금까지 자유 텍스트였던 ReviewGraph 위험 사유를 ~20개 토큰으로 표준화한다. 단일 변경으로 가장 큰 효과.
2. **Apply 이전 characterization 점검**(§3.4, §3.1). "고친 뒤 테스트 없음"이 아니라 "고치기 전에 보존 증거가 있는지"를 단계 4/5에서 본다.
3. **버그픽스·진단 게이트**(§3.4). 재현 우선, 증상 기준선, correct-seam 품질, 그리고 ACG에서 드물게 정당한 결정론적 `block` — debug 계측 잔존 검사.
4. **system boundary의 조작적 정의**(§3.1). mock이 boundary인지 internal인지를 dependency 4분류로 판정 → Evidence Quality 등급의 누락 고리를 채운다.

## 2. ReviewGraph `risk_reason` 표준 어휘 (이 개정의 중심)

[20](20-contracts.md) §5 `ReviewGraph.files[].risk_reason`는 현재 자유 문자열이다("비면 분류 무효"만 강제). 자유 텍스트면 추세 분석도, 게이트 배선도 불가능하다. 아래 어휘는 67개 practice에서 반복 추출된 위험 사유를 토큰화한 것이다.

> **staging(중요).** 이 어휘는 **먼저 문서 vocabulary로만** 둔다. core schema enum으로 동결하면 stack-agnostic이 약해진다([§8](#8-열린-질문) Q3). 두 번째 바인딩(boxwood)에서 공통성이 확인되면 그때 `risk_reason_code` enum으로 승격한다.

| 토큰 | 의미 | 출처 practice | 판정 성격 | 기본 enforcement | 대응 ACG 표면 |
|---|---|---|---|---|---|
| `shallow_module` | 인터페이스가 구현만큼 복잡(얕은 모듈) | deep-modules, design-an-interface, improve-arch | 휴리스틱 | warn | [40](40-refactoring-criteria.md) §3 Deep Module Gate |
| `pass_through_layer` | 로직 없이 호출만 전달하는 계층 | improve-arch (deletion test) | 휴리스틱 | warn | 40 §3 안티패턴 |
| `leaky_interface` | 내부 순서·상태·프로토콜·IO가 public surface로 누출 | interface-design, prototype LOGIC | 휴리스틱 | warn | 40 §3.1 정보 은닉 질문 |
| `speculative_seam` | adapter 1개뿐인 seam/port(불필요한 indirection) | improve-arch DEEPENING | 휴리스틱 | warn | 40 §3 speculative generality |
| `generic_fetcher` | 외부 연산을 일반 `fetch(endpoint,opts)`로 뭉갬 | mocking | 휴리스틱 | warn | 40 §3.1, Evidence Quality |
| `internal_collaborator_mocked` | 내가 소유한 협력자를 mock(boundary 아님) | mocking | 휴리스틱 | warn | Evidence Quality 등급 |
| `implementation_coupled_test` | 내부 상태·private·call count 검증, refactor에 깨짐 | tdd/tests, interface-design, improve-arch | 휴리스틱 | warn | Evidence Quality 등급 |
| `primitive_obsession` | 도메인 개념을 원시 타입으로 흩뿌림 | refactoring | 휴리스틱 | warn | 40 §3, FitnessFunction |
| `long_method` | 한 메서드에 책임 과다 | refactoring | 일부 결정론 | track | FitnessFunction(complexity) |
| `feature_envy` | 로직이 데이터와 다른 곳에 있음 | refactoring | 휴리스틱 | warn | 40 §3 |
| `unverified_refactor` | 보존 증거(characterization) 없는 리팩토링 | tdd (refactor while GREEN) | 결정론(테스트 통과) | **block** | 40 §2 G-R1 |
| `refactor_step_not_working_state` | 리팩토링 step이 working state를 안 남김 | request-refactor-plan | 휴리스틱 | warn | 40 §2 G-R2 |
| `unreproduced_fix` | 결정론적 재현 신호 없이 "고쳤다" 주장 | diagnose P1 | 휴리스틱 | warn | 단계 6, SemanticCompatibility.characterization |
| `symptom_mismatch` | acceptance가 사용자 증상이 아닌 인접 실패에 묶임 | diagnose P2 | 휴리스틱 | warn | 단계 1 acceptance 형태 |
| `no_correct_seam` | 진짜 호출 지점을 못 거는 얕은 seam(거짓 확신) | diagnose P5 | 휴리스틱 | warn | Evidence Quality, unresolved marker |
| `leftover_debug_instrumentation` | `[DEBUG-...]` 계측·throwaway 잔존, repro 미해소 | diagnose P6 | **결정론(grep/재실행)** | **block** | 단계 6 / CompletionContract |
| `domain_drift` | 새 용어/이름이 glossary canonical과 충돌 | grill-with-docs, ubiquitous-language | 휴리스틱(llm) | warn | §3.5 Domain Gate |
| `adr_conflict` | 변경이 기존 ADR 결정과 충돌 | grill-with-docs ADR, planning | 휴리스틱(llm) | warn | `ChangeContract.decision_ref` |
| `spec_drift` | diff가 issue/PRD 요구를 미충족 또는 범위 초과 | review (Spec axis) | 휴리스틱(llm) | warn | `acceptance`, `forbidden_scope` |
| `convention_violation` | 문서화된 표준(tooling 미강제분) 위반 | review (Standards axis) | 일부 결정론 | warn | `ArchitectureSpec.conventions` |
| `vague_acceptance` | acceptance가 독립 검증 불가(테스트 불가) | triage agent-brief | 휴리스틱 | warn | 단계 1/2 게이트 |

> **결정론은 block, 휴리스틱은 warn.** 위 표에서 `block`은 정확히 두 개 — `unverified_refactor`(테스트가 전후 동일 통과하는가, 기계 판정)와 `leftover_debug_instrumentation`(`grep '[DEBUG-'` 0건 + repro 재실행이 green인가, 기계 판정)뿐이다. 나머지는 전부 휴리스틱이라 warn/track이다. 이 비대칭이 의도다.

## 3. 우선 흡수 후보 (정밀화)

### 3.1 Evidence Quality Gate

| 외부 practice | 원천 | ACG 번역 |
|---|---|---|
| Writing Good Tests / 행위 검증 | [`tests.md`](https://github.com/mattpocock/skills/blob/main/skills/engineering/tdd/tests.md), [`tdd/SKILL.md`](https://github.com/mattpocock/skills/blob/main/skills/engineering/tdd/SKILL.md) | public interface로 observable behavior를 검증하는가 |
| Mocking at System Boundaries | [`mocking.md`](https://github.com/mattpocock/skills/blob/main/skills/engineering/tdd/mocking.md) | mock은 system boundary에 한정 |
| Interface Design for Testability | [`interface-design.md`](https://github.com/mattpocock/skills/blob/main/skills/engineering/tdd/interface-design.md) | DI·반환값 검증·작은 표면 |
| Dependency 분류 | [`improve.../DEEPENING.md`](https://github.com/mattpocock/skills/blob/main/skills/engineering/improve-codebase-architecture/DEEPENING.md) | "boundary"의 조작적 정의 |

**증거 품질 3등급(이미 초안, 출처 확정).**

- `behavior_public`: public API/사용자 observable behavior 검증. 강한 증거.
- `boundary_mocked`: 외부 API·시간·랜덤·파일시스템 등 system boundary만 mock. 허용.
- `implementation_coupled`: private method, 내부 collaborator, call count/order, 내부 DB table 직접 검증. 약한 증거. → ReviewGraph `implementation_coupled_test`.

**(신규) survives-refactor oracle.** 원천이 제시하는 기계적 판별 기준: *"내부 함수 이름만 바꿔 테스트가 깨지면, 그것은 구현을 검증한 것이다."* 이 "동작 보존 refactor에 살아남는가"가 `behavior_public`과 `implementation_coupled`를 가르는 술어다. [40](40-refactoring-criteria.md) §3.1의 "테스트가 내부 단계를 과하게 알아야 하면 인터페이스가 얕거나 새고 있다"와 같은 신호다.

**(신규) "system boundary"의 조작적 정의 — dependency 4분류.** 지금까지 §1.1이 "boundary만 mock"이라 했지만 *무엇이 boundary인지*를 정의하지 못했다. `DEEPENING.md`가 그 정의를 준다.

| 분류 | 예 | mock 정책 | 증거 등급 |
|---|---|---|---|
| In-process (순수 계산, 인메모리) | 순수 함수, reducer | mock 금지, 인터페이스로 직접 검증 | mock 시 `implementation_coupled` |
| Local-substitutable (로컬 대역 존재) | PGLite, in-memory fs | 대역을 suite에서 실행 | mock 시 `implementation_coupled` |
| Remote-but-owned (내 서비스, 네트워크 너머) | 내부 microservice/API | port 정의, transport는 adapter 주입 | `boundary_mocked` 허용 |
| True-external (제3자) | Stripe, Twilio | port로 주입, 테스트는 mock adapter | `boundary_mocked` 허용 |

즉 분류 3·4를 mock하면 `boundary_mocked`(허용), 분류 1·2를 mock하면 `implementation_coupled`(약한 증거 → `internal_collaborator_mocked`). **boundary "정의"는 stack-agnostic이라 core, mock 대상이 internal인지 자동 "탐지"하는 도구는 binding**(Jest/Vitest mock API 의존, [§8](#8-열린-질문) Q2).

**(신규 주의) "replace, don't layer"는 무방비로 흡수하지 않는다.** `DEEPENING.md`는 deepened 인터페이스 테스트가 생기면 옛 unit test를 *삭제*하라고 한다. 이는 ACG의 증거 보존(40 §G-R1)과 충돌한다 — 테스트 삭제는 characterization 증거 삭제다. ACG 형태: **새 인터페이스 테스트가 옛 테스트의 동작을 증명 가능하게 포섭(subsume)한 뒤에만** allowed_scope 안에서 옛 테스트를 제거한다. 테스트 삭제는 무료 위생이 아니라 동작 증거 변경이다.

**반영 대상.** [10](10-methodology.md) 단계 6, [20](20-contracts.md) `SemanticCompatibility.characterization`·`ReviewGraph.files[].evidence`. DITTO 바인딩에서는 evidence quality sidecar.

**주의.** 레거시 테스트는 구현 결합이 많다. 초기에는 `warn`/`track`, 신규 테스트부터 강제.

### 3.2 Deep Module / Interface Design Gate

| 외부 practice | 원천 | ACG 번역 |
|---|---|---|
| Designing Deep Modules | [`deep-modules.md`](https://github.com/mattpocock/skills/blob/main/skills/engineering/tdd/deep-modules.md) | 작은 인터페이스 + 깊은 구현 |
| Design It Twice | [`design-an-interface`](https://github.com/mattpocock/skills/blob/main/skills/deprecated/design-an-interface/SKILL.md) | depth·misuse 평가 기준 |
| Improving Codebase Architecture | [`improve-codebase-architecture`](https://github.com/mattpocock/skills/tree/main/skills/engineering/improve-codebase-architecture) | shallow 탐지·deletion test·seam 규율 |

**현재 반영 상태.** [40](40-refactoring-criteria.md) §3 Deep Module Gate로 이미 반영. 아래는 원천 정독으로 추가된 정밀화다.

- **세 질문의 1:1 매핑.** `deep-modules.md`의 (1)메서드 수 줄이기 (2)파라미터 단순화 (3)복잡도 은닉 → 40 §3.1 표의 세 행과 1:1. 출처 확정.
- **(신규) "인터페이스"의 엄격한 정의.** `improve.../LANGUAGE.md`: 인터페이스는 타입 시그니처만이 아니라 *불변식·순서 제약·에러 모드·필수 설정·성능 특성* 전부다. 이 정의를 40 §3.1 "호출자가 보는 표면" 질문에 넣는다.
- **(신규) deletion test.** "이 모듈을 지우면 복잡도가 사라지나, 아니면 N개 호출자로 재출현하나?" 재출현하면 제 몫을 한 deep 모듈, 그냥 사라지면 `pass_through_layer`. 40 §3의 "pass-through layer → 거부" 판정의 **명시적 절차**다.
- **(신규) two-adapter seam 규칙.** "adapter 하나면 가설적 seam, 둘이면 진짜 seam." port/seam은 실제로 둘 이상의 adapter(보통 production + test)가 정당화될 때만 도입한다. 40 §3가 이미 `caller≥2`를 1차 조건에서 내렸으므로, 이 규칙은 *seam/port에 한정*해 speculative generality를 잡는다(`speculative_seam`) — 단일 호출 deep 모듈을 다시 막지 않는다. internal seam(모듈 자기 테스트용)은 인터페이스로 노출하지 않는다.
- **(신규) interface-design 세 질문.** DI로 의존을 받는가 / 부수효과 대신 결과를 반환하는가 / 표면(메서드+파라미터)이 최소인가 → 40 §3.1 선행 설계 질문에 추가. 단 "표면 최소"는 *깊은 구현 위의 최소 표면*이지 "더 잘게 쪼개라"가 아니다(minimum-viable과 충돌 주의).
- **(신규) ease-of-misuse.** `design-an-interface`의 "올바른 사용 vs 오용의 용이성"을 설계 질문에 추가. "Design It Twice" 자체(N개 설계안 생성)는 *평가 기준만* 흡수하고 "항상 N개 만들라"는 의무는 흡수하지 않는다(Charter §4-3).

**추가 후보.** 반복되는 "좋은 인터페이스" 패턴은 `ArchitectureSpec.conventions.approved_patterns`로, shallow-module score는 `FitnessFunction.kind=complexity`로 `track`.

### 3.3 Refactoring Candidate Signals

| 외부 practice | 원천 | ACG 번역 |
|---|---|---|
| Identifying Refactoring Candidates | [`refactoring.md`](https://github.com/mattpocock/skills/blob/main/skills/engineering/tdd/refactoring.md) | smell → risk_reason / FitnessFunction |
| Refactor only while GREEN | [`tdd/SKILL.md`](https://github.com/mattpocock/skills/blob/main/skills/engineering/tdd/SKILL.md) | Tidy First의 시간적 형태 |
| Planning Code Refactors | [`request-refactor-plan`](https://github.com/mattpocock/skills/tree/main/skills/deprecated/request-refactor-plan) | tiny step·working state·scope·선행 커버리지 |

- **smell → 표면 분할.** 결정론 측정 가능(duplication, complexity, primitive assertion count)은 `FitnessFunction.kind ∈ {duplication, complexity}` + `baseline.delta_only`로 `track`(레거시 부채를 신규 위반으로 오독 방지). 구조 판단 필요(feature_envy, primitive_obsession, shallow_module)는 ReviewGraph risk_reason `warn`. **block 없음.**
- **(신규) "never refactor while RED" = G-R2의 시간적 형태.** RED는 동작 변경이 진행 중이라는 뜻 → 거기서 리팩토링하면 구조+동작이 섞인다. 40 §2 G-R2에 한 줄 명료화. "After all tests pass"에서만 리팩토링 = `unverified_refactor`를 막는 결정론 `block`(40 §G-R1).
- **(신규) Apply 이전 커버리지 점검.** `request-refactor-plan` step 6: "리팩토링 영역의 테스트 커버리지를 먼저 확인하고, 부족하면 사용자에게 테스트 계획을 묻는다." ACG 형태: 단계 4 Plan에서 `SemanticCompatibility.characterization.exists`를 **Apply 전에** 평가해, 보존 테스트 없는 리팩토링이 침묵으로 통과하지 못하고 characterization 후보를 먼저 낳게 한다. "keep tests on public interface"는 `behavior_public`과 동일.

**주의.** smell 탐지는 휴리스틱이다. deterministic metric만 `track`, 구조 판단은 `warn`.

### 3.4 Bugfix / Diagnose Gate (신규 절)

원천 [`diagnose/SKILL.md`](https://github.com/mattpocock/skills/blob/main/skills/engineering/diagnose/SKILL.md). 6단계 중 ACG에 들어오는 것은 *증거 규율*뿐이고, 가설 생성·계측 기법(Phase 3·4)은 craft라 reject다.

- **재현 우선(`unreproduced_fix`).** "빠르고 결정론적인 agent-runnable pass/fail 신호를 만드는 것 — 이것이 전부다." 버그픽스 ChangeContract(`evidence_kind: test|log`)는 *고치기 전에* 재현 신호를 가져야 한다. 없으면 `SemanticCompatibility.characterization{exists:false, candidate}` + `verdict.semantic_safe='unverified'`로 남긴다. 단계 6, `warn`(저커버리지 영역은 loop 구성 불가가 흔함 — 40 §G-R1과 같은 입장).
- **증상 기준선(`symptom_mismatch`).** "잘못된 버그 = 잘못된 수정." acceptance criterion은 *사용자가 본 증상*을 가리켜야 하고, 단계 6은 그 포착된 증상이 뒤집힐 때만 닫힌다. 단계 1 의도-우선(Charter §4-1)의 버그픽스 특화. 새 필드 없이 acceptance 형태 규칙.
- **correct-seam 품질(`no_correct_seam`).** 회귀 테스트는 *올바른 seam*(실제 호출 지점에서 진짜 버그 패턴을 재현)에 쓴다. 단일 호출 unit이 다중 호출 버그를 흉내 내면 거짓 확신 → `implementation_coupled`. correct seam이 없다는 사실 자체가 보고할 finding(아키텍처가 버그를 못 가둠)이지 증거 생략 핑계가 아니다 → 명시적 unresolved marker.
- **(신규 — 드문 결정론 block) 정리 게이트(`leftover_debug_instrumentation`).** Phase 6 완료 체크리스트 중 두 항목은 기계 판정이라 정당하게 `block`이다: ① `grep '[DEBUG-'` 0건(계측 잔존 없음), ② 원래 repro 재실행이 green. ACG §4-4("내 변경이 만든 고아 코드는 정리한다")·증거-완료 원칙과 정확히 일치. 단계 6/CompletionContract done 술어.
- **post-mortem → 단계 8.** "무엇이 이 버그를 막았을까"의 답이 구조적(seam 부재, 숨은 결합)이면 일반화 가능한 불변식으로 `FitnessFunction` 승격(`ChangeContract.invariants[promotable=true]`). 단 *수정 후에* 권고하고 *수정 diff에 섞지 않는다*(Tidy First, 40 §G-R2) — handoff/escalate로 분리.

### 3.5 Domain / Decision Alignment Gate

| 외부 practice | 원천 | ACG 번역 |
|---|---|---|
| Grill-with-Docs | [`grill-with-docs`](https://github.com/mattpocock/skills/tree/main/skills/engineering/grill-with-docs) | 계획↔glossary/ADR/코드 충돌 검증 |
| ADR 3부 테스트 | [`ADR-FORMAT.md`](https://github.com/mattpocock/skills/blob/main/skills/engineering/grill-with-docs/ADR-FORMAT.md) | 언제 decision_ref가 필수인가 |
| Planning glossary/ADR 정합 | [`to-prd`](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-prd/SKILL.md)·[`to-issues`](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-issues/SKILL.md)·[`zoom-out`](https://github.com/mattpocock/skills/blob/main/skills/engineering/zoom-out/SKILL.md) | plan 어휘가 glossary와 일치 |

- **code-first 규율.** grill-with-docs 핵심 규칙: *"코드베이스로 답할 수 있는 질문은 코드베이스를 탐색하라."* 이는 Charter §4-1과 동일. 새 용어/경계/public surface가 glossary canonical과 충돌하면 `domain_drift`. 코드가 한 말과 코드 실제가 모순이면 단계 3 ImpactGraph(서술이 아니라 심볼 그래프)에서 드러난다.
- **(신규) ADR 3부 테스트 — *언제* decision_ref가 필수인가.** ADR은 세 조건이 *모두* 참일 때만 만든다: ①되돌리기 어렵다 ②맥락 없으면 의외다 ③진짜 trade-off다. 이 기준이 "risk medium+ → decision_ref 필수"(20 §1)에 *분류 기준*을 준다. 기존 ADR과 모순되면 `adr_conflict`(차단 아닌 "재검토" 신호 — 원천도 warning callout). ADR 파일 포맷·번호는 binding(`.ditto/knowledge/adr/`).
- **반영.** medium 이상 변경에서 `decision_ref`뿐 아니라 "기존 ADR 충돌 없음"을 단계 4/7에서 확인.

**주의.** 이 게이트가 사용자 인터뷰로 흐르면 비용이 커진다(Charter §4-8). 코드/문서로 확인 가능한 것은 먼저 확인하고, 사람에게는 도메인 의미·trade-off만 묻는다. 차단 게이트로 쓰려면 glossary/ADR 참조를 구조화해야 한다([§8](#8-열린-질문) Q4) — 그래서 `warn`.

### 3.6 Two-Axis Review (신규 — Standards vs Spec)

원천 [`in-progress/review/SKILL.md`](https://github.com/mattpocock/skills/blob/main/skills/in-progress/review/SKILL.md). 변경을 *독립적인 두 축*으로 본다: **Standards**(diff가 문서화된 코딩 표준을 따르는가)와 **Spec**(diff가 원래 issue/PRD를 충실히 구현하는가). 한 축이 다른 축을 가리지 못하게 분리한다.

- ACG 번역: 자유 텍스트 risk_reason를 두 토큰으로 분리 — `spec_drift`(acceptance/요구 미충족 또는 범위 초과)와 `convention_violation`(문서 표준 위반). Spec 축 = `ChangeContract.acceptance[]` + `ImpactGraph` 범위 초과(단계 6/7), Standards 축 = `ArchitectureSpec.conventions`(단계 6).
- **"tooling이 강제하는 것은 건너뛴다"는 경계가 유용하다.** formatter/linter/tsconfig가 잡는 표준은 `conventions.on_violation: block`(결정론)으로 보내고, 판단이 필요한 잔여 표준만 `convention_violation` `warn`으로 남긴다. 즉 이 규칙은 "어떤 표준이 결정론 게이트이고 어떤 것이 LLM 리뷰 사유인가"를 가르는 선이다.
- Spec 축의 "요청 안 한 동작(scope creep)" 탐지는 Charter §4-4·`forbidden_scope`를 직접 지지한다. LLM 판정이라 `warn`, auto-block 금지.

### 3.7 Acceptance Quality Bar (신규)

원천 [`triage/AGENT-BRIEF.md`](https://github.com/mattpocock/skills/blob/main/skills/engineering/triage/AGENT-BRIEF.md). agent brief = AFK agent가 일하는 권위 있는 명세.

- **이미 있는 것(confirmatory).** "완전한 acceptance criteria" = 단계 1 게이트 + `ChangeContract.acceptance`(minItems:1). "명시적 out-of-scope" = `forbidden_scope`(minItems:1, 빈 배열 금지). 둘 다 이미 `block`. 중복 집계하지 않는다.
- **(신규) 품질 술어.** 원천이 더하는 것은 *"각 criterion이 독립적으로 검증 가능한가"*와 *"behavioral하게(파일경로·라인 번호 의존 없이) 기술됐는가"*다. acceptance가 검증 불가면 `vague_acceptance`. 휴리스틱이라 `warn` — 휴리스틱에 차단 게이트를 볼트로 박지 않는다(minimum-viable).

### 3.8 Vertical-Slice Independence (신규)

원천 [`to-issues/SKILL.md`](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-issues/SKILL.md). 계획을 *얇은 수직 슬라이스*(모든 통합 계층을 관통, 각자 독립 데모/검증 가능)로 쪼갠다.

- 흡수 가능한 부분은 **슬라이스 독립 검증성**뿐이다: 모든 슬라이스가 자기 acceptance(+evidence_kind)를 갖는다 → 단계 4 Plan "검증 가능한 목표 목록" 강화 + minimum-viable 공리와 정합("얇은 다수 > 두꺼운 소수"=가장 작은 검증 가능 변경). 새 필드 불요, ChangeContract 집합의 형태 제약.
- issue-tracker 발행·`ready-for-agent` 라벨·"사용자 승인까지 반복" 루프는 reject(도구 workflow + 절차 위임, Charter §4-8).

## 4. 바인딩 또는 낮은 우선순위

| 외부 practice | 판단 | ACG 위치 / 근거 |
|---|---|---|
| handoff | binding | 이미 [10](10-methodology.md) §5가 DITTO `handoff` 재사용으로 흡수. reference-not-duplicate·secret redact·temp-dir는 skill 정책 |
| grill-me / grill-with-docs 인터뷰 루프 | binding | 단계 1 실패 처리 → DITTO `deep-interview`. "code-first, 한 번에 하나" 규칙만 인용 |
| HITL/AFK 라우팅 | binding(track) | `ReviewGraph.human_review_set` + `risk_default`의 계획시점 투영. autopilot이 이미 구현. enum 신설하면 risk enum 중복([§8](#8-열린-질문) Q3) |
| Shoehorn 타입 안전 | binding | DITTO/TS `FitnessFunction(kind=type-safety)`: test 파일 unsafe `as` 카운트, `baseline.delta_only=true`. Java엔 `as` 없음 → stack 결합 |
| ubiquitous-language / CONTEXT.md | binding | glossary는 `.ditto/knowledge/glossary.json` + `ditto:knowledge-update`. core 잔여물은 `domain_drift` 토큰 + "용어 점검됨" 증거뿐 |
| prototype 검증 결과 capture | binding | **아래 정정 참조** — 새 artifact가 아니라 `decision_ref` + ADR/knowledge로 |
| CONTEXT.md / ADR 파일 포맷 | binding | 문서 작성 규약(§5). DITTO는 glossary.json + adr/로 동일 정보 바인딩 |

> **정정 — `EvidenceContract`를 신설하지 않는다.** 이전 초안 §2는 Prototyping을 위해 새 `EvidenceContract` artifact를 후보로 뒀다. 정독 결과 이는 과하다(단일 사용 추상화, Charter §4-3). prototype이 만드는 것은 *"질문 + 답"*이고, ACG는 비자명 변경에 이미 `decision_ref`(ADR)를 요구한다. 따라서 prototype 검증 결과는 **`decision_ref` + 기존 ADR/`ditto:knowledge-update`**로 착지시키고 새 스키마를 만들지 않는다. (prototype은 CompletionContract의 acceptance 증거가 아니다 — 질문에 답할 뿐 실제 변경의 완료를 증명하지 않으므로 `acceptance[].evidence_kind`에 넣지 않는다.)

## 5. 채택하지 않는 것 (reject 28건)

좋은 practice여도 ACG core에 넣지 않는다. 일반 범주와 이번 정독의 구체 reject:

- **도구/제품 workflow.** issue-tracker 상태머신·발행(`triage`, `to-issues` 발행부), out-of-scope KB, `setup-matt-pocock-skills` per-repo config, git guardrails, pre-commit 설치, scaffold-exercises, PR/issue 템플릿 포맷.
- **craft 기법(게이트 아님).** diagnose Phase 3(가설 3~5개 생성)·Phase 4(변수 하나씩 계측), review의 "고정 비교 지점 핀", zoom-out 모듈 맵, to-prd 전체 PRD 합성, to-prd test seam 선택(이미 §3.1이 덮음).
- **문서/지식 편집 workflow.** CONTEXT.md 작성 절차, write-a-skill, teach(다세션 학습 워크스페이스), edit-article, obsidian-vault.
- **개인 생산성/모드.** caveman, qa(deprecated).
- **프레임워크 메타.** README 4대 실패 모드(서사일 뿐), CLAUDE.md skill repo 조직, ADR-0001(setup pointer 정책).
- **tracer-bullet "수평 금지" 루프.** 슬라이스 *독립 검증성*은 §3.8로 흡수하되, 발행/라벨/승인 루프는 제외.

이들은 바인딩, skill, 운영 정책에는 들어갈 수 있지만 ACG 스펙 계층에는 넣지 않는다.

## 6. 즉시 반영하면 좋은 순서

1. **`risk_reason` 표준 어휘(§2)** — *문서 vocabulary로 먼저.* 이유: ReviewGraph 사유가 자유 텍스트면 추세·게이트 배선이 불가능. 목표: [20](20-contracts.md) §5에 어휘 표 주석으로 추가, core enum 동결은 보류.
2. **Evidence Quality의 boundary 정의(§3.1 4분류)** — 이유: "boundary만 mock"이 이제껏 정의 없이 떠 있었다. 목표: [10](10-methodology.md) 단계 6 + [20](20-contracts.md) `SemanticCompatibility`.
3. **Apply 이전 characterization 점검(§3.3)** — 이유: 보존 증거 없는 리팩토링이 침묵 통과하지 못하게. 목표: 단계 4 Plan이 `characterization.exists`를 선평가.
4. **버그픽스 정리 block 게이트(§3.4 `leftover_debug_instrumentation`)** — 이유: 드물게 정당한 결정론 차단. 목표: 단계 6/CompletionContract done 술어에 `grep '[DEBUG-'` 0건 + repro green.
5. **Domain/ADR 정합(§3.5)** — 이유: `decision_ref`는 있으나 ADR 충돌 점검이 약함. 목표: medium+ 변경에서 "ADR 충돌 없음" 증거.

## 7. 핵심 설계 결정 (이번 개정에서 확정)

- **confirmatory vs new를 구분한다.** core_ingest 31 중 다수는 이미 있는 게이트의 출처 확정이다(Evidence 등급, Deep Module Gate, `decision_ref`, `forbidden_scope`/`acceptance` minItems). 이것들은 "신규 커버리지"로 이중 집계하지 않는다.
- **`EvidenceContract` 폐기**(§4 정정).
- **block은 결정론에만.** 전체 흡수에서 `block`은 `unverified_refactor`·`leftover_debug_instrumentation`·빈 `forbidden_scope`·`acceptance` 부재뿐 — 전부 기계 판정. 휴리스틱은 예외 없이 `warn`/`track`.
- **risk_reason는 vocabulary 먼저, enum은 나중.** boxwood 검증 전 core enum 동결 금지.

## 8. 열린 질문

1. Evidence quality를 `ChangeContract.acceptance`에 직접 넣을지, DITTO 바인딩 evidence sidecar에 둘지.
2. Internal mock 탐지의 결정론 수준. Jest/Vitest mock call은 잡지만 모든 언어로 일반화되진 않는다 — boundary "정의"는 core, "탐지기"는 binding.
3. `risk_reason` 어휘를 core enum으로 동결하면 stack-agnostic이 약해진다. vocabulary 문서로 두고 boxwood에서 공통성 확인 후 schema 승격.
4. Domain/ADR alignment는 LLM 판단 의존이 크다. 차단 게이트로 쓰려면 glossary/ADR 참조와 diff evidence를 구조화해야 한다.
5. (신규) "correct seam" 판정은 본질적으로 휴리스틱이다. `no_correct_seam`을 unresolved marker로 남기는 것 외에 결정론 근사가 가능한가.
6. (신규) "replace, don't layer"의 subsumption 증명(새 테스트가 옛 테스트 동작을 덮음)을 어떻게 기계 검증할 것인가 — 못 하면 테스트 삭제는 `warn`으로 남는다.

## 9. 부록 — 커버리지 표 (저장소 대조용)

원천 67 practice → 판단 → 착지. core_ingest 다수가 confirmatory임을 명시한다.

### core_ingest (31)

| 출처 | practice | enforcement | risk_reason | 비고 |
|---|---|---|---|---|
| tdd/tests, SKILL | public interface 행위 검증 | warn | implementation_coupled_test | Evidence 등급 출처 |
| tdd/SKILL | refactor only while GREEN | **block** | unverified_refactor | 40 §G-R1 시간형 |
| tdd/SKILL | planning gate(interface+behaviors+glossary) | warn | adr_conflict | 단계1/4 |
| deep-modules | Deep Module 세 질문 | warn | shallow_module | 40 §3 출처 |
| refactoring | smell → token/fitness | track | primitive_obsession | 분할 enforcement |
| mocking | system boundary만 mock | warn | internal_collaborator_mocked | boundary 정의 |
| interface-design | DI·반환값·작은 표면 | warn | leaky_interface | 40 §3.1 선행질문 |
| improve-arch (SKILL/LANGUAGE) | shallow 모듈 탐지 | warn | shallow_module | 인터페이스 엄격 정의 |
| improve-arch (deletion test) | pass-through 판정 절차 | warn | pass_through_layer | 신규 |
| improve-arch (DEEPENING seam) | two-adapter 규칙 | warn | speculative_seam | 신규 |
| improve-arch (DEEPENING 4분류) | mock boundary 조작적 정의 | warn | implementation_coupled_test | 신규(핵심) |
| improve-arch (interface=test surface) | survives-refactor | warn | implementation_coupled_test | 삭제 주의 |
| improve-arch (glossary/ADR) | 정합 점검 | warn | adr_conflict | §3.5 |
| design-an-interface | depth·misuse 기준 | warn | shallow_module | 40 §3 보강 |
| request-refactor-plan | tiny step·선행 커버리지 | warn | refactor_step_not_working_state | Apply 전 characterization |
| diagnose P1 | 결정론 재현 신호 | warn | unreproduced_fix | 신규 §3.4 |
| diagnose P2 | 증상 기준선 | warn | symptom_mismatch | 신규 §3.4 |
| diagnose P5 | correct seam 품질 | warn | no_correct_seam | 신규 §3.4 |
| diagnose P6 | 정리+post-mortem | **block** | leftover_debug_instrumentation | 결정론 차단 |
| grill-with-docs ×3 | code-first 정합 | warn | domain_drift | §3.5 |
| grill-with-docs ADR | ADR 3부 테스트 | warn | adr_conflict | decision_ref 분류 |
| to-prd/to-issues/zoom-out | glossary/ADR 정합 | warn | adr_conflict | §3.5 |
| to-prd | out-of-scope 선언 | **block** | — | confirmatory(forbidden_scope) |
| to-prd | external-behavior 테스트 결정 | warn | implementation_coupled_test | Evidence 등급 계획측 |
| to-issues | 수직 슬라이스 독립성 | warn | — | §3.8 |
| to-issues | per-issue acceptance | **block** | — | confirmatory(acceptance) |
| review | Standards vs Spec 2축 | warn | spec_drift / convention_violation | 신규 §3.6 |
| triage/agent-brief | acceptance 품질 술어 | warn | vague_acceptance | 신규 §3.7 |
| prototype/LOGIC | 순수 인터페이스 누출 | warn | leaky_interface | Deep Module Gate |

### binding (8)

| 출처 | practice | 착지 |
|---|---|---|
| handoff | 세션 인계 | DITTO `handoff` (10 §5) |
| grill-me | 인터뷰 루프 | `deep-interview` |
| ubiquitous-language | glossary 추출 | `glossary.json` + `knowledge-update` |
| CONTEXT.md(framework) | 공유 언어 | `glossary.json` + `domain_drift` 토큰 |
| CONTEXT-FORMAT | glossary 위생 | knowledge-curator 정책 |
| to-issues HITL/AFK | 라우팅 라벨 | autopilot risk 라우팅(track) |
| migrate-to-shoehorn | 타입 안전 | DITTO/TS `FitnessFunction(type-safety)` |
| prototype | 검증결과 capture | `decision_ref` + ADR(EvidenceContract 아님) |

### reject (28)

qa, diagnose P3·P4, grill-with-docs(인터뷰 UX), improve-arch(HTML report·explore walk·recommendation badge), prototype(throwaway shell·UI variants·NOTES 외 다수 4건), to-prd(전체 합성·test seam 선택), zoom-out(모듈 맵), to-issues(발행), tdd(수평 금지 루프), triage(상태머신·out-of-scope KB), setup-matt-pocock-skills, review(고정 비교 핀), teach, git-guardrails, setup-pre-commit, scaffold-exercises, caveman, write-a-skill, README(4대 실패 서사), CLAUDE.md(skill repo 조직), ADR-0001.

## 10. 닫는 말

이 문서의 목적은 외부 practice를 ACG로 빠르게 흡수하는 것이 아니라, **흡수 가능한 형태로 작게 번역하는 것**이다. 이번 정독이 확인한 가장 중요한 사실은 — ACG가 이미 대부분의 좋은 조언을 게이트로 갖고 있고, 외부 practice의 진짜 기여는 **그 게이트들이 공유할 표준 어휘**(§2)와 **boundary·재현·증상 같은 그동안 정의가 비어 있던 술어**라는 것이다. ACG에 들어오는 순간 모든 practice는 "좋은 조언"이 아니라 "어떤 산출물이 어떤 증거로 어떤 게이트를 통과하는가"로 다시 쓰여야 한다. 그리고 그 게이트는 결정론일 때만 차단하고, 휴리스틱일 때는 드러내고 추세를 본다.
