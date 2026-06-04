---
title: "ACG — Agentic Change Governance"
subtitle: "Continuous Assurance for Agentic Change"
kind: framework
last_updated: 2026-06-04 KST
status: draft
scope: "대규모 코드베이스에서 agent가 만드는 변경의 품질을 시간에 걸쳐 지속 보장하기 위한 공학적 프레임워크의 상위 문서."
supersedes_idea_base: reports/design/agentic-engineering-change-governance.md
documents:
  - 00-framework.md          # 이 문서 — 토대와 모델
  - 10-methodology.md        # 변경 lifecycle 방법론
  - 20-contracts.md          # 스키마 명세 9종
  - 30-intent-change-dsl.md  # 의도→해석기→산출물 DSL
  - 40-refactoring-criteria.md
  - 50-change-map.md         # UML 대체 의사소통 표기
  - 60-practice-ingestion-map.md # 외부 engineering practice 흡수 후보 지도(non-normative)
---

# ACG — Agentic Change Governance

> **이 문서의 위치.** ACG는 `reports/design/agentic-engineering-change-governance.md`(아이디어 베이스)를 공학적 프레임워크로 승격한 것이다. 아이디어 베이스가 "무엇이 문제인가"를 6개 패턴으로 정리했다면, ACG는 "어떤 검증된 공학 기법 위에, 어떤 스키마와 문법과 표기법으로 그것을 지속 가능하게 만드는가"를 정의한다. 이 문서는 토대와 모델을 담고, 10~50의 다섯 core 문서가 각 축을 명세한다. 60은 core spec이 아니라 외부 engineering practice를 ACG 게이트/증거 모델로 번역하기 위한 흡수 후보 지도다.

> **stack-agnostic — 스펙 계층과 바인딩 계층의 분리.** ACG의 목적은 특정 제품·저장소가 아니라 **모든 코드베이스의 agentic 변경 거버넌스**를 다루는 것이다. 그래서 ACG는 두 계층으로 나뉜다.
>
> - **스펙 계층(이 문서군 00~50)** — 저장소 중립. 각 산출물이 실어야 할 *정보*와 게이트가 검사할 *성질*만 정의한다. 구체적 칸 이름·파일 형식·분석 도구는 정하지 않는다. `acg.<name>.v1`은 wire format이 아니라 **추상 스펙 식별자**다.
> - **바인딩 계층(저장소별)** — 스펙이 요구한 정보를 그 저장소의 실제 스키마·머리표(envelope)·분석 도구에 끼워 맞춘다. DITTO가 첫 번째 바인딩이고(§6), `boxwood-workspace`(235K LOC Java/Kotlin + 94K LOC TS/Svelte 모노레포)가 두 번째 실제 바인딩이다 — 단순 예시 인용이 아니라 스펙의 저장소 독립성을 검증하는 두 번째 적용처다.
>
> 범용성은 스펙을 문서로 중립화해 *지금* 확보한다. 다중 저장소용 런타임 추상(provider 교체 기계)은 **두 번째 바인딩(boxwood)을 만들 때 그 이음매로 검증**한다 — 실제 바인딩 2개가 상상 속 추상화 1개보다 낫고, 존재하지 않는 호스트를 위한 추상을 미리 짓지 않는다(Charter §4-3). 영향 분석기·경계 분석기·deterministic evaluator(§3.1)는 스펙이 *자리*만 정하고 바인딩이 그 자리에 도구를 꽂는다 — 언어마다 도구가 다르므로(DITTO=TS, boxwood=Java/Kotlin) 이 provider 슬롯 구조가 stack-agnostic의 기계적 정의다.

## 0. 한 문장

> 기존 소프트웨어 공학은 **인간이 변경의 저자**라는 전제 위에 품질 보장 기법을 쌓았다. agent가 저자가 되면 그 전제가 무너진다. ACG는 **변경 자체를 1급 객체로** 끌어올리고, **적합성(fitness)을 지속적으로** 평가함으로써 그 전제를 복원한다.

## 1. 왜 기존 기법으로는 부족한가

대규모 코드베이스의 품질은 이미 검증된 기법으로 지켜져 왔다: 타입 시스템, 자동화 테스트, 코드 리뷰, 정적 분석, CI 게이트, 아키텍처 가이드라인. 이 기법들은 강력하지만 한 가지 공통 전제를 공유한다 — **변경을 만드는 주체가 인간**이라는 것.

인간 저자는 느리고, 좁게 바꾸고, 변경 이유를 머리에 담고 있으며, 리뷰어와 같은 멘탈 모델을 공유한다. 이 전제 위에서:

- **코드 리뷰**는 "사람이 diff를 읽고 의도를 재구성할 수 있다"에 의존한다.
- **테스트 통과**는 "통과했으면 저자가 의도한 동작이 보존됐다"의 근사로 받아들여진다.
- **아키텍처 가이드라인**은 "시니어가 경계를 알고 지킨다"에 의존한다.

agent가 저자가 되면 세 전제가 동시에 흔들린다.

| 전제 | 인간 저자 | agent 저자 | 무너지는 지점 |
|---|---|---|---|
| 변경 속도/폭 | 느림·좁음 | 빠름·넓음 | 사람이 모든 diff를 읽는 리뷰가 스케일하지 않는다 |
| 의도의 소재 | 저자 머릿속·PR 설명 | 휘발되는 응답 텍스트 | 변경의 "왜"가 산출물로 고정되지 않는다 |
| 완료의 근거 | 팀 acceptance | agent 자기보고 | "테스트 통과 = 완료"가 의미 보존을 보장하지 않는다 |

### 1.1 더 근본적인 층 — agent 저자의 인지적 한계

위 세 전제는 *프로세스* 차원의 붕괴다. 그러나 그 밑에는 생성형 모델 자체에서 오는 더 근본적인 결함이 있다. 거버넌스가 어려운 진짜 이유는 여기에 있고, 기존 기법은 이 층을 아예 가정하지 않았다.

**(1) 코드에 당위성(justification)이 없다.** 생성형 모델은 코드를 *생성*할 뿐이다. 사람 장인은 "왜 이 코드가 이래야 하는가"를 일관된 스타일·품질 기준 위에서 판단하지만, 모델은 확률적으로 그럴듯한 토큰을 내놓을 뿐 그 선택의 당위성을 보장하지 못한다. 같은 요청에 매번 다른 스타일·다른 구조가 나오고, 어느 것도 "이래야만 한다"는 근거를 갖지 않는다. 컴파일되고 테스트를 통과해도, *왜 이 형태인가*는 비어 있다.
→ **ACG의 응답**: 변경의 "왜"를 `ChangeContract`(purpose·invariants)와 `decision_ref`(ADR)로 **산출물에 강제 고정**한다. 당위성을 모델의 순간 판단에 맡기지 않고 계약으로 외부화한다. 스타일·품질·모듈 설계의 일관성은 `ArchitectureSpec`·모듈 설계/리팩토링 기준([40](40-refactoring-criteria.md))·적합성 함수로 코드베이스가 강제한다 — 모델이 매번 일관되길 기대하지 않는다.

**(2) agent는 코드를 보지만 프로그램을 보지 못한다.** agent가 읽는 것은 텍스트로서의 코드다. 그 코드가 실제로 실행됐을 때의 동작, 화면, UI/UX, 사용자 여정 — 즉 *제품*은 보지 못한 채 코드를 쓴다. 그래서 "코드는 맞지만 제품이 틀린" 변경이 나온다. 타입 체크와 단위 테스트를 통과해도 사용자가 겪는 흐름은 깨질 수 있다.
→ **ACG의 응답**: 사용자 여정을 1급 명세(`JourneySpec`, [20](20-contracts.md) §2.5)로 두고, 변경이 그 표면에 닿으면 코드 증거가 아니라 **실행 증거**(`JourneyRun`/e2e)로 닫게 한다. 누락은 침묵으로 통과하지 못하게 default-deny(`journey_unknown`)로 막는다. 단 이것은 *결과 우회*다 — 증거는 여정이 깨지지 않았음을 검증할 뿐, agent가 여정을 실제로 *이해*하게 만들지는 못한다(§9 열린질문 8).

**(3) SLOP은 쌓이고 증식한다.** 위 두 결함의 산물(근거 없는 코드, 제품을 모르는 코드)은 한 번 머지되면 사라지지 않는다. 다음 agent는 그 저품질 코드를 *맥락*으로 읽고 모방해, SLOP이 기하급수로 증식한다. 사람 리뷰가 걸러내던 것이 agent 속도에서는 걸러지지 않고 누적된다 — 결국 감당 불가능한 수준이 된다. boxwood의 Spring Boot 버전 3종 분기·로컬 JAR 수동 동기화가 바로 이 누적의 흔적이다.
→ **ACG의 응답**: 이것이 §2.2 **지속적 적합성**의 존재 이유다. 개별 변경의 정당성이 아니라 *누적·증식*을 시계열(Assurance Graph)로 추적하고, 얕은 wrapper·누출 추상화·근거 없는 단일 사용 추상화 같은 SLOP 패턴을 Deep Module Gate([40](40-refactoring-criteria.md))에서 입구부터 차단한다. SLOP은 "한 번 막는" 것이 아니라 "계속 막아야" 하는 것이기 때문이다.

이 세 결함이 ACG의 두 창조적 기여(§2)가 겨냥하는 표적이다. (1)은 변경의 1급화로 당위성을 산출물화하고, (3)은 지속 적합성으로 증식을 억제하며, (2)는 부분적으로만 닫히는 — 그래서 정직하게 열린질문으로 남기는 — 한계다.

---

그래서 ACG가 다루는 질문은 "어떻게 더 많은 코드를 생성할 것인가"가 아니다.

- 무엇이 사용자의 원래 의도이고, 어디까지가 변경 가능 범위인가?
- 특정 변경이 어디까지 전파되며, 타입은 맞지만 도메인 의미가 깨진 변경을 어떻게 잡는가?
- 사람이 모든 diff를 보지 않고도 고위험 변경만 판단하게 할 수 있는가?
- 한 번 통과한 품질을, 수천 번의 후속 agent 변경에 걸쳐 어떻게 **계속** 유지하는가?

마지막 질문이 ACG를 단발 거버넌스와 구분 짓는다.

## 2. 두 개의 창조적 기여

ACG의 새로움은 새 알고리즘이 아니라 **두 개의 관점 전환**에 있다.

### 2.1 변경(Change)의 1급화

기존 공학은 *코드·타입·모듈·함수*를 1급 객체로 다뤘다 — 이름이 있고, 명세가 있고, 검증할 수 있는 것. 변경(diff)은 그 1급 객체들 사이의 임시 이벤트였고, PR 설명이라는 비형식 텍스트로만 기술됐다.

ACG는 **변경 그 자체**를 1급 객체로 끌어올린다. 모든 변경은:

- **이름과 명세를 갖는다** — `ChangeContract` (목적·허용범위·금지범위·불변식·acceptance).
- **검증 가능하다** — diff를 계약과 대조하고, 위반을 게이트로 막는다.
- **시각화 가능하다** — `Change Map`으로 한 장에 그린다.
- **컴파일 가능하다** — 하나의 의도 선언에서 agent 제약·자동 게이트·사람용 지도가 일관 파생된다.

변경이 1급이 되면, "이 변경이 의도를 위반했는가"는 취향 논쟁이 아니라 계약 위반 검사가 된다.

### 2.2 지속적 적합성(Continuous Fitness)

대규모 코드베이스에서 품질은 한 번 통과시키는 것이 아니라 **유지**하는 것이다. agent는 매일 수십~수백 개의 변경을 만든다. 각 변경이 개별적으로 정당해도, 누적되면 아키텍처는 침식한다(boxwood의 Spring Boot 버전 3종 분기, 로컬 JAR 수동 동기화가 그 흔적이다).

ACG는 Evolutionary Architecture의 **fitness function**을 agentic 맥락에 이식한다. 적합성 함수는 "이 코드베이스가 지켜야 할 성질"을 실행 가능한 술어로 표현하고, **변경마다 + 주기적으로 계속** 평가된다. 일회성 lint가 아니라, 코드베이스의 건강을 시간 축에서 측정하는 센서다.

- 변경 시점: 이 변경이 적합성을 깨뜨리는가?
- 주기적: 누적된 변경들이 적합성 추세를 악화시키고 있는가?

이 두 관점이 만나는 지점이 ACG의 핵심이다 — **모든 변경은 계약을 갖고, 모든 계약은 적합성 함수로 지속 검증된다.**

## 3. 공학적 토대 (차용과 변형)

ACG는 새 이론을 발명하지 않는다. 검증된 SW 공학 기법을 가져와 agentic 맥락에 맞게 변형한다. 각 기법은 "원전"과 "agentic에서 무엇이 달라지는가"를 함께 명시한다 — 이름만 빌리는 것을 금지하기 위해서다.

| 검증된 기법 | 원전 | ACG의 변형 | 매핑되는 산출물 |
|---|---|---|---|
| **Design by Contract** | B. Meyer (Eiffel) | 함수의 pre/post가 아니라 *변경*의 pre(허용 범위)/post(불변식 보존)/invariant(out-of-scope 불변)를 명세한다. 위반 시 변경을 차단한다. | `ChangeContract` (20) |
| **Fitness Function** | Ford·Parsons·Kua, *Building Evolutionary Architectures* | 아키텍처 적합성을 변경마다 + 주기적으로 지속 실행. 통과/실패뿐 아니라 추세를 본다. | `FitnessFunction` (20), Assurance Graph |
| **Characterization Test** | M. Feathers, *Working Effectively with Legacy Code* | agent가 의미를 바꾸기 전에 기존 행동을 고정해, "의미 보존"을 증명 가능한 형태로 만든다. | `SemanticCompatibility` (20), 리팩토링 기준 (40) |
| **Information Hiding / Deep Module** | D. Parnas (1972) / J. Ousterhout, *A Philosophy of Software Design* | 리팩토링 허용/금지뿐 아니라 새 모듈·인터페이스 설계의 근거. 작은 인터페이스·단순 파라미터 뒤에 내부 복잡도를 숨기고, 얕은 wrapper·누출 추상화를 금지한다. | 모듈 설계·리팩토링 기준 (40) |
| **Dependency Rule** | R. Martin, *Clean Architecture* | 레이어 의존 방향을 명시하고 위반을 적합성 함수로 검사한다. | `ArchitectureSpec` (20) |
| **Architecture Decision Record** | M. Nygard | 결정과 변경을 연결한다. 모든 비자명한 변경은 참조하는 결정을 가지며, 결정의 가정이 깨지면 재검토 트리거가 된다. | `ChangeContract.decision_ref` (20) |
| **Semantic Versioning / contract compatibility** | semver | public surface 변경에 호환성 등급(compatible / additive / breaking)을 부여한다. | `SemanticCompatibility` (20) |

> 단순 차용 금지 원칙: 위 표의 각 행은 후속 문서에서 "원전이 풀던 문제 → agentic에서 새로 생긴 문제 → 그래서 무엇을 바꿨는가"를 1문단 이상으로 전개한다. 이름만 빌려 권위를 빌리는 서술은 허용하지 않는다.

### 3.1 deterministic evaluator의 레퍼런스 구현 — CodeQL

ACG는 `evaluator.mode: deterministic`([20](20-contracts.md) §6)을 반복해서 요구한다 — 적합성·영향·의미를 LLM 추측이 아니라 결정론적 사실로 판정하라는 것. 이것이 추상이 아님을 보이는 **PoC로 일부 검증된 예시 provider**가 이 저장소에 있다: [reports/codeql](../../codeql/codeql-research-ko.md)의 CodeQL 통합 연구·PoC다. CodeQL의 핵심 원칙 — *"결정론 사실 생성기는 CodeQL, 판단은 LLM, 그 사이를 SARIF/구조화 도구로 잇는다"* — 는 ACG의 `deterministic` vs `llm_judged` 구분과 동형이다.

ACG는 stack-agnostic을 유지하므로 CodeQL을 *필수 의존*으로 삼지 않는다. 그러나 deterministic 칸을 무엇으로 채울 수 있는지의 **구체 후보**로 인용한다. 칸마다 근거 수준이 다르므로 **일괄 "실증"이 아니라 칸별로 표기**한다(추론·draft를 실증으로 포장하지 않는다 — §1.1(1) 자기원칙):

| ACG deterministic 칸 | CodeQL 레퍼런스 | 근거 수준 |
|---|---|---|
| `SemanticCompatibility` 동작 보존 (40 §G-R1) | 리팩토링 전후 dataflow diff | **실증** (부록3 `67b27ccf` before/after) |
| `ImpactGraph` source→sink (20 §2) | dataflow/codeFlow를 결정론 생성 | **실증** (부록3 codeFlow 11건) |
| `ImpactGraph.unresolved: cross_repo` (20 §2) | cross-repo/언어 dataflow 자동 불가 → 계약 매칭 | **실증** (부록4 — 같은 한계) |
| `FitnessFunction` mode=deterministic (20 §6) | taint 쿼리 "새 source→sink path = 0" | **부분실증** (PoC-1; 게이트 배선은 통합계획 draft) |
| `FitnessFunction` baseline.delta_only (20 §6) | "절대 alert 아닌 delta(순증)" | **부분실증** (통합계획 §1 결론, 배선 미구현) |
| `ArchitectureSpec` boundary 검사 (20 §3, OBJ-22) | call/dataflow 기반 경계 lint | **추론** (C-1, 에이전트 사용 사례 미확인) |

**경계(정직).** (1) CodeQL의 "동작 보존"은 ACG `SemanticCompatibility`의 *부분집합*이다 — taint 경로 보존만 결정론으로 본다(부록3도 "보안 dataflow 관점"). 도메인 의미 전체(`User|null→User` 류)는 여전히 characterization test/llm_judged 몫이다. (2) `mode: executed`의 비용(컴파일 언어 clean build 수 분, 부록4)이 [§9](#9-열린-질문) Q4 비용 문제의 실측 근거다. (3) 인용한 통합 계획은 `status: draft`이고 CodeQL 도구군은 변동이 빠르다("착수 전 재확인 필수") — ACG의 deterministic 추상은 CodeQL 없이도 성립하며, CodeQL은 그 추상을 *채울 수 있음을 보인 한 사례*일 뿐이다. linter·타입검사·의존성 lint·아키텍처 lint 같은 다른 deterministic provider도 추가 실증 없이 같은 칸에 들어간다.

## 4. 핵심 모델 — 다섯 그래프

ACG는 agentic engineering을 다섯 그래프의 조합으로 모델링한다. 앞의 넷은 아이디어 베이스의 모델을 잇고, 다섯째 **Assurance Graph**가 "지속적"을 담당한다.

```text
Intent Graph        사용자의 목적, acceptance, in-scope, out-of-scope, 금지 범위
Architecture Graph  레이어, 모듈, public surface, 허용된 의존 방향, ownership
Impact Graph        변경 대상에서 출발한 호출·타입·테스트·문서·외부 소비자 영향
Review Graph        변경 파일, 위험도, 근거, 검증 상태, 사람이 봐야 할 exception
Assurance Graph     코드베이스 전역 적합성 함수의 평가 이력을 시점·함수별로 집계한 시계열 — "품질의 지속 센서"
```

> Assurance Graph는 별도의 거대 구조가 아니라 **FitnessFunction 평가의 시계열 집계 뷰**다. 함수 자체는 `FitnessFunction` 스키마로, 그 평가 이력은 `AssuranceSnapshot` 시계열로 표현한다([20-contracts.md](20-contracts.md) §6). 드리프트(통과율 기울기)는 이 시계열 위에서 계산된다.

앞의 네 그래프는 **하나의 변경**에 대한 통제면이다(변경 시점에 만들어지고 그 변경과 함께 닫힌다). Assurance Graph는 **코드베이스 전체**에 대한 통제면이다(변경을 가로질러 살아남고, 추세를 축적한다).

변경은 다음 질문을 통과해야 한다:

1. Intent Graph를 위반하지 않았는가? (의도 보존)
2. Architecture Graph의 경계를 넘지 않았는가? (구조 보존)
3. Impact Graph의 affected node가 처리되었는가? (영향 완결)
4. Review Graph가 고위험 변경을 숨기지 않았는가? (리뷰 정직성)
5. Assurance Graph의 적합성 추세를 악화시키지 않았는가? (지속성)

5번이 단발 거버넌스와 ACG를 가르는 선이다.

## 5. Continuous Lifecycle

한 변경의 생애는 8단계를 지난다. 단계별 산출물과 게이트는 [10-methodology.md](10-methodology.md)에서 명세한다. 여기서는 흐름만 둔다.

```text
1. Intake     요청 → work item + Intent
2. Contract   ChangeContract 확정 (허용/금지/불변식/acceptance)  [DSL이 여기서 컴파일됨]
3. Graph      Architecture·Impact 그래프 구축
4. Plan       영향과 경계에 따른 migration plan
5. Apply      변경 수행, 계약·그래프를 계속 참조
6. Validate   테스트·타입·boundary·semantic 검증
7. Review     risk-ranked Review Graph → Change Map → 사람은 exception만
8. Assure     적합성 함수 등록·실행, Assurance Graph 갱신 (이후 모든 변경에서 지속 평가)
```

1~7은 한 변경 안에서 닫힌다. 8단계가 그 변경의 불변식을 **영속적인 적합성 함수로 승격**시켜, 이후의 모든 변경이 그 성질을 깨면 잡히게 한다. 이것이 "지속 보장"의 기계적 정의다.

## 6. DITTO 바인딩 (첫 번째 바인딩)

이 절은 스펙 계층을 DITTO에 끼워 맞추는 **첫 번째 바인딩**이다. 스펙(20-contracts)이 "각 산출물이 어떤 정보를 실어야 하는가"를 정의하면, 바인딩은 그 정보를 DITTO의 실제 스키마·머리표·도구로 **실현**한다. 그래서 ACG는 DITTO에 새 계약을 무더기로 추가하지 않는다 — 스펙 산출물의 상당수가 DITTO에 이미 있는 자산의 *확장*으로 실현되고, 정말 비어 있는 자리만 새 스키마가 된다.

> **"재사용/신설"이 아니라 "스펙 산출물 → DITTO 실현체".** 아래 표의 마지막 칸은 스펙의 한 산출물이 DITTO 바인딩에서 *무엇으로 실현되는가*다. **확장**=DITTO 기존 스키마에 필드를 더해 실현, **신설**=DITTO에 대응물이 없어 새 스키마, **투영**=기존 계약의 부분 뷰. 필드명·envelope·evidence 종류의 구체 매핑은 [20-contracts.md](20-contracts.md) §0의 *DITTO 바인딩 표*가 가진다. boxwood 바인딩에서는 같은 스펙 산출물이 boxwood의 자산으로 다르게 실현된다.

| ACG 스펙 산출물 | DITTO 자산 | DITTO 바인딩 (실현 방식) |
|---|---|---|
| Intent Graph | `IntentContract`, work item | **재사용**. `in_scope`/`out_of_scope`/`acceptance_criteria`를 ChangeContract의 원천으로 직접 사용 |
| `ChangeContract` | — | **신설(얇게)**. IntentContract의 *변경 시점 투영*. 별도 거대 계약이 아니라 work item sidecar |
| `ImpactGraph` | — | **신설**. DITTO에 없던 영향 추적 |
| `ArchitectureSpec` | `.ditto/knowledge` 보관 | **신설(저장소당 1회)**. 선언은 새것이나 저장소는 기존 knowledge |
| `SemanticCompatibility` | reviewer/verifier가 소비 | **신설**. 의미 호환성 판정 |
| Review Graph | `Reviewer`/`Verifier` 출력, reviewer output 스키마 | **재사용/확장**. risk 분류·exception 라우팅을 구조화 |
| `FitnessFunction` + Assurance Graph | — | **신설**. 지속 적합성. boxwood harness에도 없는 능력 |
| 완료 verdict | `CompletionContract`, `EvidenceContract` | **재사용**. change governance 실패를 completion gate에 연결 |
| premature closure 억제 | `ConvergenceContract` | **재사용**. 적합성 미검증을 unverified로 남김 |
| 패턴/결정 지식 | `KnowledgeContract`, ADR, `.ditto/knowledge` | **재사용**. 모듈 설계/리팩토링 기준·decision_ref의 저장소 |

> 결론: DITTO 바인딩에서 ACG가 **새 스키마로 신설하는 것**은 비어 있던 영역뿐이다: `ImpactGraph`·`SemanticCompatibility`·`FitnessFunction`(+`AssuranceSnapshot` 시계열·`JourneySpec`/`JourneyRun`). `ChangeContract`는 IntentContract의 얇은 투영, `ArchitectureSpec`은 저장소 1회성 선언(knowledge 보관), `ReviewGraph`는 reviewer output 확장, `JourneyRun`은 DITTO `e2eJourney`로 실현된다. 완료·수렴·지식 계약(CompletionContract/ConvergenceContract/KnowledgeContract)은 그대로 재사용한다. **거버넌스 실패가 완료를 막아야 한다는 것은 스펙이 요구하는 *성질*이고, 그 성질을 어느 산출물 슬롯으로 배선하는가는 바인딩 결정이다**(§9 Q6에서 DITTO 바인딩 결정값 확정). 각 스펙 산출물의 DITTO 실현체와 필드/envelope 매핑은 [20-contracts.md](20-contracts.md) §0의 *DITTO 바인딩 표*가 가진다.

## 7. boxwood를 통해 본 적용 (대표 예시)

ACG가 추상이 아님을 보이기 위해, boxwood의 실제 거버넌스 난점을 ACG 산출물로 옮긴다. boxwood 전용 자산에 의존하지 않으며, 같은 패턴이 임의의 대규모 모노레포에 적용된다.

| boxwood의 실제 난점 (조사 근거) | ACG 산출물 | 무엇이 달라지나 |
|---|---|---|
| Spring Boot 버전 3종 분기(3.3.13/3.5.7/3.5.5) | `FitnessFunction`: "모든 백엔드 모듈의 SB major.minor가 단일하다" | 분기가 *추세*로 감지됨. 새 분기를 만드는 변경이 게이트에서 잡힘 |
| 로컬 JAR 직접 의존(`libs/*.jar`, 버전관리 불가) | `ArchitectureSpec`: 금지 의존 + `FitnessFunction`: "선언된 의존만 존재" | 수동 동기화 누락이 변경 시점에 드러남 |
| automation-engine 테스트 커버리지 2.7% | `SemanticCompatibility`: 변경 대상에 behavior test 없으면 characterization test 후보 생성 | 의미 변경이 "미검증 영향"으로 명시됨 |
| Flyway 59개·repair 스크립트(과거 실패) | `ChangeContract`: 마이그레이션은 기본 high-risk, `ImpactGraph`: tenant/shared 2계층 전파 | 스키마 변경이 Change Map의 exception으로 사람에게 올라감 |
| CI 파이프라인 부재 | Assurance Graph는 CI 비종속 — 적합성 함수는 로컬·훅·CI 어디서든 실행 | "CI 없음"이 거버넌스 부재로 직결되지 않음 |

## 8. 평가 기준

ACG가 실제로 가치 있는지는 다음 지표로 본다. 정량 지표는 측정 방법을 함께 정의해야 의미가 있으므로, 가능한 ground truth를 괄호로 명시한다.

| 지표 | 의미 | ground truth |
|---|---|---|
| unintended-edit rate | 요청 밖 변경 비율 | ChangeContract out-of-scope를 건드린 파일 수 / 전체 변경 파일 수 |
| missed-impact count | 누락된 호출자/테스트/문서 | 사후 발견된 affected node 중 ImpactGraph에 없던 것 |
| semantic-regression count | 타입은 맞지만 의미가 깨진 변경 | characterization test 또는 사후 incident로 확인된 건수 |
| review-surface reduction | 사람이 봐야 할 파일 감소 | Change Map exception 수 / 전체 변경 파일 수 |
| high-risk precision | high-risk 표시의 적중률 | 실제로 사람 판단이 필요했던 비율 |
| fitness drift | 적합성 추세 악화 | Assurance Graph 시계열의 함수별 통과율 기울기 |
| completion-evidence coverage | acceptance별 증거 부착률 | 증거로 닫힌 acceptance / 전체 acceptance |

정성 지표: 사용자가 "내가 원하지 않은 방향"이라 느끼는 빈도, 리뷰어가 전체 diff 없이 판단 가능한 정도, agent가 새 추상화를 만들 때 이유의 납득 가능성, 실패 시 다음 agent의 인수 가능성.

## 9. 열린 질문

후속 구체화에서 닫을 질문이다. 일부는 아이디어 베이스에서 이어지고, 일부는 ACG가 새로 연 것이다.

1. **적합성 함수의 deterministic/LLM 경계.** ArchitectureSpec 위반 같은 것은 정적 분석으로 결정적이다. SemanticCompatibility는 LLM 판단이 필요하다. 어디까지 결정적으로 내리고 어디부터 LLM에 맡기며, LLM 판단의 재현성은 어떻게 보장하는가? → [20](20-contracts.md) §FitnessFunction에서 1차 답.
2. **DSL의 표현력 vs 단순성.** 의도를 형식 DSL로 표현하면 강제력이 생기지만, 표현 비용이 가치를 넘으면 아무도 안 쓴다. 어느 수준의 의도까지 DSL로 받고, 어디부터 자연어로 두는가? → [30](30-intent-change-dsl.md).
3. **Architecture Spec의 출처.** 저장소마다 수동 작성인가, 초기 그래프에서 제안인가? boxwood처럼 경계가 코드에 암묵적으로만 있는 경우 어떻게 부트스트랩하는가? **DITTO 바인딩 결정값(ADR-0004, 목표 상태)**: `produced_by=user` 권위 기본의 하이브리드 부트스트랩 — agent는 의존/import 그래프에서 관측 가능한 `layers`/`public_surfaces`만 **비권위 candidate**로 제안하고 사람이 비준해 권위화한다. `forbidden_dependencies`·`layers.can_call`는 관측에서 자동 박제 금지(현재 위반을 규칙으로 굳히는 것 방지). 활성 선결: layers 분류 PoC + 기계 판독 invariant 표현(주석 규약은 파싱 불가). **현재 상태(미구현)**: 소비처인 단계6 boundary 게이트가 v0 범위 밖이라 deferred — 결정은 미래 게이트가 지킬 출처/권위 정책을 고정할 뿐 도는 동작은 아니다. 스키마는 이미 `produced_by=agent|user`를 허용(변경 없음).
4. **적합성 함수의 비용.** 변경마다 전역 적합성을 다 돌리면 비싸다. 무엇을 변경 시점에, 무엇을 주기적으로 돌리는가? incremental 평가가 가능한가? **DITTO 바인딩 결정값(ADR-0004, 목표 상태)**: evaluator.mode별 차등 — deterministic 싼 가드=`per_change`(세션 시작 DB 1회 캐시 후 쿼리만 증분 ~3.9s), 전체 스위트(34s~1분)·executed(컴파일 build 수 분)=`risk_tiered/sampled`+`periodic/on_release`로 **매 변경 전수 금지**. **안전 불변식**: risk base는 `risk_default`(수동 enum)이며 ImpactGraph/boundary 입력 부재·`journey_unknown` 시 high-risk로 **escalate(fail-closed), sample down 금지**. incremental은 "쿼리=증분(캐시 DB)·추출=언어당 전역"으로 정직 한정(per-file 추출 미실증). delta_only는 정규화 `violation_identity` recipe가 생기기 전까지 조건부 유효(부재 시 보고 fail-closed). **현재 상태(미구현)**: fitness runner/scheduler·ICL emit·ImpactGraph 생산기는 별도 work item — 이 결정은 그것들이 구현할 비용 정책을 고정한다. 스키마는 이미 `execution.selection`·`baseline.delta_only`·`cadence`를 허용(변경 없음).
5. **Change Map의 표현 매체.** 텍스트(파싱·diff 가능) vs 다이어그램(사람 친화). 둘을 어떻게 단일 출처에서 생성하는가? → [50](50-change-map.md).
6. **completion gate 연결 방식 (스펙 성질 vs 바인딩 결정).** 스펙은 "거버넌스 실패(미해소 high-risk ReviewGraph·미검증 의미변경·적합성 위반)가 완료를 막아야 한다"는 *성질*만 요구한다. *어떻게* 막는가는 바인딩 결정이다. **DITTO 바인딩 결정값(목표 상태)**: 별도 gate를 신설하지 않고, `ReviewGraph`의 high-risk/unresolved 집계를 기존 `CompletionContract`가 직접 소비하는 슬롯으로 배선한다 — Stop 훅이 ReviewGraph ledger를 읽어 미해소 시 continuation을 강제하도록 한다. **현재 상태(미구현)**: Stop 훅은 completion/convergence/autopilot/dialectic ledger만 읽고 `CompletionContract`에 ReviewGraph 슬롯이 없다. 따라서 이 배선은 **v0 작업**이다(아직 도는 동작이 아니다). 방향은 §6의 "CompletionContract 재사용"과 모순되지 않는다 — 재사용하되 거버넌스 입력 슬롯을 더한다. boxwood 바인딩은 자기 완료 메커니즘에 같은 성질을 다르게 배선할 수 있다.
7. **추상화 깊이의 측정 가능한 정의.** [40](40-refactoring-criteria.md) §3은 "작은 인터페이스 + 단순 파라미터 + 내부 복잡도 은닉"을 새 모듈·인터페이스 설계 게이트로 쓴다. 다만 "인터페이스 폭"과 "내부 복잡도"의 구체 측정(공개 메서드 수·파라미터 수·분기 수·LOC·호출자 지식량 등)은 언어·저장소마다 다르다. caller≥2는 보조 증거일 뿐이며, 호출자가 하나라도 복잡도 은닉이 분명하면 valid한 deep abstraction일 수 있다 — 측정 지표와 예외 처리를 저장소별로 보정해야 한다.
8. **agent의 코드↔제품 이해 갭 (잔여).** 사용자 여정의 *명세*는 1급화됐다([20](20-contracts.md) §2.5 `JourneySpec`) — "가능한가"는 닫혔다. 영향·위험·적합성·증거가 `journey_id`로 그것을 참조하고, negative obligation이 누락을 default-deny로 막는다([20](20-contracts.md) §2, [10](10-methodology.md) 단계 3). 그러나 세 잔여 질문이 남는다: (a) `JourneyRun`(실행 증거)이 통과해도 "agent가 여정을 *이해*했다"는 보장은 아니다 — 증거는 결과를 검증할 뿐 이해를 만들지 않는다. 어디까지 실행 증거로 위임하고 어디부터 사람이 제품 판단을 쥐는가? (b) JourneySpec의 `surfaces`→코드 매핑을 누가 유지하는가 — 매핑이 낡으면(freshness 만료) negative obligation이 거짓 음성을 낸다. (c) `journey_unknown`을 사람이 해소하는 빈도가 과도하면 거버넌스가 병목이 된다 — surface→journey 자동 매핑 제안은 어디까지 가능한가?

## 10. 문서 안내

- [10-methodology.md](10-methodology.md) — 변경 lifecycle 8단계의 산출물과 게이트 (코딩 방법론 축).
- [20-contracts.md](20-contracts.md) — 9개 스키마 명세 (방법론/스키마 축).
- [30-intent-change-dsl.md](30-intent-change-dsl.md) — 의도→해석기→산출물 DSL (DSL 축).
- [40-refactoring-criteria.md](40-refactoring-criteria.md) — 모듈·인터페이스 설계와 리팩토링 허용/금지의 형식화 (설계/리팩토링 축).
- [50-change-map.md](50-change-map.md) — UML 대체 변경 지도 표기법 (의사소통 축).
- [60-practice-ingestion-map.md](60-practice-ingestion-map.md) — 외부 engineering practice를 ACG 산출물·게이트·증거 모델로 번역하기 위한 후보 지도(non-normative).
- 아이디어 베이스: [agentic-engineering-change-governance.md](../agentic-engineering-change-governance.md).
- deterministic evaluator 레퍼런스 구현(§3.1): [reports/codeql 연구·PoC](../../codeql/codeql-research-ko.md), [통합 계획](../../codeql/codeql-ditto-integration-plan.md).
