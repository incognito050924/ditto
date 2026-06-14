---
title: "DITTO 통합 설계 — 사용자 요청이 코드베이스·프로젝트가 되기까지 (의도 · 효과 · AX × ACG 변경 거버넌스)"
kind: design
last_updated: 2026-06-08 KST
status: draft
audience: 기여자 · 후속 에이전트 · DITTO 전체 그림을 한 번에 보려는 사람
work_item: wi_260607kxr
scope: "DITTO를 한 문서로 설명한다 — 왜 만들었나(설계 의도), 무엇을 보장하나(효과), 어떻게 사람×에이전트 협업 경험(AX)을 개선하나, 그리고 그 실행 도중 각 변경이 어떻게 통제되나(ACG 변경 거버넌스). 이전의 세 문서(ditto-design-effects-ax=AX 설계, acg-research-report=ACG 방법론, ditto-integrated-flow=통합 흐름)를 중심 개념 누락 없이 단일 문서로 합친 통합본이며 그 셋을 대체한다. 새 설계를 결정하지 않고 권위 자료와 실행 증거로 재구성한다."
inputs:
  - PURPOSE.md                                                    # 설계 의도(중점 가치) 1차 자료
  - README.md                                                     # 설계 태도(design posture)
  - .ditto/knowledge/CONTEXT.md                                   # ubiquitous language · 핵심 계약 용어
  - .ditto/knowledge/adr/ADR-0010-ditto-functional-four-axes.md  # 기능 4축 canonical 정의 + 두 층위 모델
  - reports/design/ditto-four-axis-reassessment.md               # 4축 실증 커버리지 · 기층 substrate · gap
  - reports/design/agentic-governance/00-framework.md            # ACG 프레임워크(토대·다섯 그래프·두 기여)
  - reports/design/agentic-governance/10-methodology.md          # 변경 lifecycle 8단계
  - .ditto/knowledge/adr/ADR-0004-q3-q4-architecture-fitness.md  # ArchitectureSpec 출처·fitness 비용
  - .ditto/knowledge/adr/ADR-0006-static-analysis-engine-codeql.md
  - reports/codeql/codeql-ditto-integration-plan.md              # CodeQL 통합 진척
supersedes:
  - reports/design/ditto-design-effects-ax.md
  - reports/design/acg-research-report.md
  - reports/design/ditto-integrated-flow.md
canonical_note: "canonical 정의가 본문과 충돌하면 ADR(특히 ADR-0010)과 ACG 스펙 문서군(agentic-governance/00~50)이 우선한다."
---

# DITTO 통합 설계

> **이 문서의 위치.** DITTO를 두 해상도로 같이 본다.
> - **거시 (의도·효과·AX)** — DITTO가 *무엇을 하는가*(기능 4축)와 *무엇으로 배달되는가*(기층 4축), 그리고 그것이 사람·에이전트 협업 경험을 어떻게 개선하는가.
> - **미시 (ACG 변경 거버넌스)** — 그 실행 도중 *각 변경이 어떻게 통제되는가*(변경의 1급화 + 지속 적합성).
>
> 한 줄 관계: **4축은 "요청 한 건의 여정"을 그리고, ACG는 "그 여정 중 일어나는 각 변경의 생애"를 그린다.** 둘은 경쟁하지 않는다 — ACG의 8단계 변경 lifecycle은 4축 파이프라인 위에 정확히 겹쳐진다(§4).

---

## 0. 한 문단 요약

DITTO는 LLM 코딩 에이전트의 작업을 **사용자 의도 위에, 증거로만 완료되게, 컨텍스트가 썩지 않게** 끌고 가는 하네스다. 설계 의도는 7개 중점 가치(인지 비용 최소화·할루시네이션 방지·의도 이탈의 구조적 차단·자기 확신 깨기·Context Rot 해결·장기 작업 완수·토큰 절약)이고, 이를 **두 층위**(기능 4축=목적 기둥, 기층 4축=배달 substrate)로 번역한다. 기능 4축은 순차 파이프라인 **의도 동기화 → 자율 실행 → E2E → 지식 베이스**다. 그 실행(축2) 안에서 일어나는 각 변경은 **ACG(Agentic Change Governance)** 가 통제한다 — agent가 코드 변경의 저자가 되며 무너진 품질 보장 전제를 "변경 자체를 1급 객체로 끌어올리고(ChangeContract) 적합성을 지속 평가(FitnessFunction)"함으로써 복원하는 공학 방법론이다. 핵심은 효과가 *문서상 권고*가 아니라 **런타임 게이트(PreToolUse·Stop hook)** 로 강제된다는 것이며, ACG 6패턴 중 5개가 동작 코드+테스트로 구현돼 있다(ACG 테스트 188 pass / 6 skip / 0 fail, 2026-06-07). DITTO의 거의 모든 설계 요소는 *하나의 메커니즘이 사람의 신뢰·인지 비용과 에이전트의 작업 환경을 동시에* 개선하도록 짜여 있다 — 이것이 "AX를 통합으로 개선한다"의 구체적 의미다(§5).

---

## 1. DITTO가 푸는 문제 — 설계 의도

### 1.1 AX(Agentic Experience)를 어떻게 정의하는가

**AX** 는 한쪽이 아니라 **사람과 에이전트가 한 작업을 같이 끌고 가는 협업 경험 전체**를 가리킨다. 두 면으로 본다.

- **사람 면 (Human-in-AX)** — 사용자가 에이전트와 일할 때 치르는 인지 비용. 무엇을 물어봐야 하는지, 출력을 믿어도 되는지, 의도가 보존됐는지를 매번 검증하는 부담.
- **에이전트 면 (Agent-in-AX)** — 에이전트가 작업을 수행할 때의 작업 환경. 컨텍스트가 썩지 않는지, 단계 간 상태를 신뢰할 수 있는지, 완료를 무엇으로 증명해야 하는지, 장기 작업에서 본래 목적을 유지할 구조가 있는지.

DITTO의 설계 명제는 **이 둘이 같은 메커니즘으로 동시에 개선된다**는 것이다. "증거 없는 완료 선언 금지"는 사람에게는 *신뢰 비용 절감*이고 에이전트에게는 *완료의 객관적 정의*다 — 하나의 게이트가 양쪽 경험을 같이 끌어올린다(§5에 매핑).

### 1.2 원래 설계 의도 — 중점 가치 7개

`PURPOSE.md`가 박아둔 중점 가치는 모든 설계 결정의 상위 기준이다.

1. **사용자 인지 비용 최소화** — 사용자가 이전 대화나 소스를 다시 뒤지지 않고, 지금 출력만으로 판단할 수 있어야 한다.
2. **할루시네이션 방지** — 모든 출력·추론에는 확실한 근거가 있어야 한다. 없으면 "모른다 / 근거 부족"이라고 사실대로 답한다.
3. **의도 이탈의 구조적 차단** — LLM이 사용자 의도를 벗어나 멋대로 추론·작업하는 것을 *규칙이 아니라 구조로* 막는다.
4. **자기 확신 깨기** — LLM의 잘못된 기존 가설을 적대적으로 깨고, 때로 창의적 대안을 도출하게 한다.
5. **Context Rot 해결** — 장기 컨텍스트가 썩는 LLM 고질병을 다룬다.
6. **장기 작업 완수** — 대규모·장시간 작업에서도 최초 의도를 잃지 않고 끝까지 간다.
7. **토큰 비용 절약** — 낭비하지 않는다.

README의 **설계 태도(design posture)** 가 이를 보완한다: *가능한 한 지루하게, 중요한 곳은 명시적으로, 영리하기 전에 조합 가능하게, 실패 후 복구 가능하게, 인상적이기 전에 유용하게.* 그리고 **중요한 상태를 분위기(vibes) 뒤에 숨기지 않는다** — 이것이 "증거 게이트"의 정신적 뿌리다.

### 1.3 진화 단계에서의 위치 + agent 저자의 인지적 한계

agentic coding의 진화는 4세대로 본다(`agentic-engineering-change-governance.md` §2): ① Code Generation → ② Code Editing → ③ Impact-aware Editing → ④ **Intent-aware Engineering**. 대부분의 coding agent는 2세대에 머물고, 사용자 피로는 3·4세대의 부재에서 온다. DITTO/ACG는 명시적으로 **4세대**(의도·금지범위·도메인 의미·설계 경계를 보존하는 변경)를 겨냥한다.

그 밑에 **생성형 모델 자체의 결함 셋**이 있고, 기존 품질 기법은 이 층을 아예 가정하지 않았다(`00-framework.md` §1.1) — 이것이 ACG가 진짜 겨냥하는 표적이다.

1. **코드에 당위성(justification)이 없다.** 모델은 확률적으로 그럴듯한 토큰을 낼 뿐, "왜 이 형태여야 하는가"를 보장하지 못한다. 컴파일되고 테스트를 통과해도 *왜 이 형태인가*는 비어 있다. → ACG는 변경의 "왜"를 `ChangeContract`(purpose·invariants)와 `decision_ref`(ADR)로 산출물에 강제 고정한다.
2. **agent는 코드를 보지만 프로그램을 보지 못한다.** agent가 읽는 것은 텍스트로서의 코드다. 실행됐을 때의 동작·화면·사용자 여정 — 즉 *제품*은 보지 못한 채 코드를 쓴다. "코드는 맞지만 제품이 틀린" 변경이 나온다. → ACG는 사용자 여정을 1급 명세(`JourneySpec`)로 두고, 변경이 그 표면에 닿으면 **실행 증거**(`JourneyRun`/e2e)로 닫게 한다. (단 이것은 *결과 우회*다 — agent가 여정을 *이해*하게 만들지는 못한다. §9 한계.)
3. **SLOP은 쌓이고 증식한다.** 근거 없는 코드는 한 번 머지되면 다음 agent가 그것을 *맥락*으로 읽고 모방해 기하급수로 증식한다. → ACG의 *지속적 적합성*(§2.4)이 이를 시계열로 추적하고, 얕은 wrapper·누출 추상화 같은 SLOP 패턴을 Deep Module Gate에서 입구부터 차단한다.

---

## 2. 설계의 뼈대 — 두 층위 + 다섯 그래프

### 2.1 기능 4축 — DITTO가 사용자를 위해 무엇을 하는가

`ADR-0010`이 박은 canonical 구조. 완전 순차 파이프라인 **1 → 2 → 3 → 4** 로 동작한다.

| 축 | 이름 | 하는 일 | 노출 skill |
|---|---|---|---|
| 축1 | 사용자 의도 파악·동기화 | 모든 방향·관점의 변증론적·경계 질문을 반복해, 사용자도 놓친 부분까지 드러내고 이해가 완전히 일치할 때까지 인터뷰해 산출물을 만든다 | `deep-interview` |
| 축2 | 자율 실행 오케스트레이션 | 확정된 의도를 스스로 구체화해 실제 코드베이스를 만든다 — 의도 왜곡 없이, 대규모·장시간이라도 끝까지 | `autopilot` |
| 축3 | E2E 테스트 | 사용자 의도대로·최초 계획대로 구현됐는지 진짜 브라우저 저니로 확인한다 | `e2e` |
| 축4 | 지식 베이스 | 매 변경의 코드·컨텍스트를 문서화해 단편적 사고를 영속적 프로젝트 메모리로 전환한다 | `knowledge-update` |

**확정된 경계 4개**(`ADR-0010` D2):
- **(a)** 축3은 진짜 브라우저 E2E만. 웹 UI 없는 프로젝트(라이브러리·CLI)는 축3 N/A이며 다른 축이 커버.
- **(b)** 축4는 가치 있는 durable 변경만 기록(에이전트 판단). 매 변경 자동 강제 아님.
- **(c)** 축1 종료 = 시스템 readiness 게이트(1차) **AND** 사용자 확인(2차). 한쪽만으로 종료 불가.
- **(d)** 4축은 완전 순차 파이프라인.

### 2.2 기층 4축 — 그 기능을 타겟에서 살아있게 배달하는 substrate

`Hooks / Skills / Agents / State`. 이것은 목적 기둥이 *아니라* 그 아래 구현 레이어다(`ADR-0010` D3).

- **Hooks** — 기능 축의 트리거·집행(예: PreToolUse scope-out이 repo 밖 쓰기 차단, Stop이 증거 없는 완료 차단).
- **Skills** — 기능 축의 노출면(4개 skill이 각각 축1~4를 연다).
- **Agents** — 기능 축의 실행 owner(implementer/reviewer/verifier 등 subagent).
- **State** — 기능 축의 메모리·기록면(`.ditto/` — work item, run manifest, 증거, 지식 베이스).

매핑: **각 기능 축은 (Skill+Agent)로 노출되고, (CLI+State)로 동작하며, (Hook)으로 트리거·집행된다.** 기층은 substrate-agnostic이라 다른 하네스로 갈아끼워도 기능 4축은 영향받지 않는다.

### 2.3 ACG 핵심 모델 — 다섯 그래프

ACG는 agentic engineering을 다섯 그래프의 조합으로 모델링한다(`00-framework.md` §4). 앞의 넷은 **하나의 변경**에 대한 통제면이고, 다섯째가 "지속"을 담당한다.

| 그래프 | 통제 대상 | 묻는 질문 |
|---|---|---|
| **Intent Graph** | 목적·acceptance·in/out-of-scope·금지 범위 | 의도를 위반하지 않았는가? |
| **Architecture Graph** | 레이어·모듈·public surface·허용 의존 방향·ownership | 경계를 넘지 않았는가? |
| **Impact Graph** | 변경에서 출발한 호출·타입·테스트·문서·외부 소비자 영향 | affected node가 처리됐는가? |
| **Review Graph** | 변경 파일·위험도·근거·검증 상태·exception | 고위험 변경을 숨기지 않았는가? |
| **Assurance Graph** | 코드베이스 전역 적합성 함수의 평가 시계열 | 적합성 추세를 악화시키지 않았는가? |

앞의 네 그래프는 변경 시점에 만들어지고 그 변경과 함께 닫힌다. **Assurance Graph는 변경을 가로질러 살아남아 추세를 축적한다** — 이것이 단발 거버넌스와 ACG를 가르는 선이다.

### 2.4 ACG의 두 창조적 기여

ACG의 새로움은 새 알고리즘이 아니라 **두 개의 관점 전환**이다(`00-framework.md` §2).

1. **변경(Change)의 1급화** — 기존 공학은 코드·타입·모듈·함수를 1급 객체로 다뤘고 변경(diff)은 임시 이벤트였다. ACG는 변경 그 자체를 1급 객체로 끌어올린다: 이름·명세를 갖고(`ChangeContract`=목적·허용범위·금지범위·불변식·acceptance), 검증 가능하며(diff↔계약 대조), 시각화 가능하고(`Change Map`), 컴파일 가능하다(하나의 ICL DSL 선언에서 agent 제약·자동 게이트·사람용 지도가 일관 파생). 변경이 1급이 되면 "이 변경이 의도를 위반했는가"는 취향 논쟁이 아니라 **계약 위반 검사**가 된다.
2. **지속적 적합성(Continuous Fitness)** — 품질은 한 번 통과가 아니라 *유지*다. Evolutionary Architecture의 fitness function을 agentic 맥락에 이식해, "코드베이스가 지켜야 할 성질"을 실행 가능한 술어로 표현하고 **변경마다 + 주기적으로** 평가한다(변경 시점: 이 변경이 적합성을 깨뜨리는가 / 주기적: 누적 변경이 추세를 악화시키는가). **모든 변경은 계약을 갖고, 모든 계약은 적합성 함수로 지속 검증된다.**

---

## 3. 공학적 토대 — 검증된 기법의 차용과 변형

ACG는 새 이론을 발명하지 않는다. 검증된 SW 공학 기법을 가져와 agentic 맥락에 변형한다. "이름만 빌려 권위를 빌리는 것"을 막기 위해 각 기법은 원전과 *agentic에서 무엇이 달라지는가*를 함께 명시한다(`00-framework.md` §3).

| 검증된 기법 | 원전 | ACG의 변형 | 산출물 |
|---|---|---|---|
| **Design by Contract** | B. Meyer (Eiffel) | 함수의 pre/post가 아니라 *변경*의 pre(허용 범위)/post(불변식 보존)/invariant(out-of-scope 불변) | `ChangeContract` |
| **Fitness Function** | Ford·Parsons·Kua | 아키텍처 적합성을 변경마다 + 주기적으로 지속 실행, 추세까지 본다 | `FitnessFunction`, Assurance Graph |
| **Characterization Test** | M. Feathers | 의미를 바꾸기 전 기존 행동을 고정해 "의미 보존"을 증명 가능하게 | `SemanticCompatibility` |
| **Deep Module / Information Hiding** | Parnas / Ousterhout | 작은 인터페이스 뒤에 복잡도 은닉, 얕은 wrapper·누출 추상화 금지 | 모듈·리팩토링 기준 |
| **Dependency Rule** | R. Martin | 레이어 의존 방향 명시, 위반을 적합성 함수로 검사 | `ArchitectureSpec` |
| **Architecture Decision Record** | M. Nygard | 결정과 변경을 연결, 결정의 가정이 깨지면 재검토 트리거 | `ChangeContract.decision_ref` |
| **Semantic Versioning** | semver | public surface 변경에 호환성 등급(compatible/additive/breaking) 부여 | `SemanticCompatibility` |

**deterministic evaluator의 레퍼런스 — CodeQL.** ACG는 적합성·영향·의미를 LLM 추측이 아니라 **결정론적 사실**로 판정하라고 요구한다(`evaluator.mode: deterministic`). 그 자리의 구체 후보가 CodeQL(ADR-0006)이다 — *"결정론 사실 생성기는 CodeQL, 판단은 LLM, 그 사이를 SARIF로 잇는다"*. 단 ACG는 stack-agnostic을 유지하므로 CodeQL을 *필수 의존*으로 삼지 않는다(linter·타입검사·의존성 lint도 같은 칸). **정직한 경계**: CodeQL의 "동작 보존"은 `SemanticCompatibility`의 *부분집합*이다(taint 경로 보존만 결정론). 도메인 의미 전체(`User|null → User` 류)는 여전히 characterization test/llm_judged의 몫이다.

---

## 4. End-to-end 흐름 — 요청 한 건의 생애 (4축 × ACG 8단계)

ACG의 8단계 변경 lifecycle은 4축 파이프라인 위에 정확히 겹쳐진다(`00-framework.md` §5, `10-methodology.md`). 1~7은 한 변경 안에서 닫히고, **8단계가 그 변경의 불변식을 영속 적합성 함수로 승격**시켜 이후 모든 변경에서 지속 평가되게 한다.

```
축1 ┃ 1. Intake     요청 → work item + Intent          (Intent Graph 출발)
    ┃ 2. Contract   ChangeContract 확정 (허용/금지/불변식/acceptance)  [ICL DSL 컴파일]
────╂──────────────────────────────────────────────────────────
축2 ┃ 3. Graph      Architecture·Impact 그래프 구축
    ┃ 4. Plan       영향·경계에 따른 migration plan
    ┃ 5. Apply      변경 수행, 계약·그래프 계속 참조       (PreToolUse 차단 작동)
    ┃ 6. Validate   테스트·타입·boundary·semantic 검증    ← 일부는 축3로
────╂──────────────────────────────────────────────────────────
축3 ┃ 6. Validate(계속)  사용자 여정은 JourneyRun(실행 증거)으로 닫는다
    ┃ 7. Review     risk-ranked Review Graph → 사람은 exception만   (Stop 차단)
────╂──────────────────────────────────────────────────────────
축4 ┃ 8. Assure     불변식을 영속 적합성 함수로 승격, Assurance Graph 갱신
```

### 4.0 요청 인입 — 흐름에 들어가기 전 판단

사용자 요청이 들어오면, 그것이 *산출물을 만들거나 되돌리기 어려운 변경*인지 1차 판단한다(prime directive). 그렇다면 work item(`wi_*`)으로 정규화된다 — 이후 모든 단계가 매달리는 추적 단위다. 이 판단은 UserPromptSubmit 훅(기층=Hooks)이 띄우고, 결정은 agent가 한다. **원래 요청을 키우지도 줄이지도 않는다**(IntentContract 보존).

### 4.1 축1 — 의도 파악·동기화 (ACG 단계1·2)

`deep-interview` skill이 요청을 **모든 방향·관점의 변증론적·경계 질문**으로 두드린다. 목적은 사용자도 놓친 면까지 드러내 이해를 완전히 일치시키는 것 — 인지 비용 최소화(의도①)와 의도 동기화가 함께 일어난다. 대화에 쓰인 어휘는 **ubiquitous language**(CONTEXT.md/glossary의 합의된 용어)로만 오간다.

종료 조건은 **둘 다**여야 한다(경계(c)): readiness 게이트(1차) AND 사용자 확인(2차). 산출된 의도가 `IntentContract`이고, 그 *변경 시점 투영*이 `ChangeContract`다(단계2) — 목적·허용/금지 범위·불변식·acceptance가 고정된다. **변경의 "왜"가 휘발되는 응답이 아니라 산출물로 박히는 것**(당위성 외부화)이 이 지점이다. 금지 범위는 ICL DSL로 컴파일되어 forbidden_scope로 저장된다.

### 4.2 축2 — 자율 실행 오케스트레이션 (ACG 단계3~5)

`autopilot` skill이 확정된 의도를 스스로 구체화해 코드베이스를 만든다. 시작 전 **Architecture·Impact 그래프를 구축**한다:
- **Impact Graph** — 변경 대상에서 출발한 호출·타입·테스트·문서·외부 소비자 영향. 텍스트 검색이 아니라 call/type graph로 산출(CodeQL 결정론 입력). 미해소(unresolved)는 숨기지 않는다.
- **Architecture Graph** — 레이어·public surface·허용 의존 방향. `ArchitectureSpec`(사람이 비준한 권위 spec, ADR-0004)이 경계를 정의한다.

그 위에서 migration plan을 세우고(단계4), 변경을 수행한다(단계5). owner subagent(implementer 등, 기층=Agents)가 노드별로 위임되어 **컨텍스트 격리**로 메인 컨텍스트가 썩지 않는다(의도⑤ Context Rot, ⑥ 장기 완수). 이 구간의 집행은 **PreToolUse 훅**이다: agent가 ChangeContract의 금지 범위 파일을 쓰려 하면 도구 호출 *전에* 차단된다 = "변경은 외과적으로"의 런타임 강제.

### 4.3 검증 (ACG 단계6·7)

변경이 만들어지면 네 갈래가 동시에 검증한다:
- **Impact** — affected node가 처리됐는가. unresolved 남으면 완료 차단.
- **Boundary** — 계층 경계를 넘었는가. violation은 high-risk로 분류.
- **SemanticCompatibility** — *타입은 맞지만 의미가 깨졌는가*. `User|null → User` 류를 잡는다. 의미 미검증은 `unverified`로 남겨 완료를 막는다(의도② 할루시네이션 방지의 변경 버전 — 모름을 모름으로).
- **JourneyRun (축3)** — 사용자 여정에 닿는 변경은 **진짜 브라우저 실행 증거**로 닫는다. 누락은 default-deny(`journey_unknown`).

그다음 **Review by Exception**(단계7): agent가 변경을 위험도로 먼저 분류해 `Review Graph`를 만들고, 사람은 전체 diff가 아니라 exception만 본다("사람 리뷰의 붕괴" 해소).

이 구간의 집행은 **Stop 훅**이다: agent가 작업을 끝내려는 순간 ledger들을 읽어 impact unresolved / boundary violation / semantic unverified·unintended break / 미해소 high-risk review / fitness fail 중 하나라도 있으면 **continuation을 강제**한다. 완료는 주장이 아니라 acceptance별 **evidence**로 계산된다(`CompletionContract`). 과거 **"node-pass + evidence-present ≠ AC-substantively-met"** false-green 위험은 `ac_verdicts` 관통 + `worst()` fold + 스키마 backstop으로 해소됐다(커밋 51ca564, §6·§9).

### 4.4 축4 — 지식 영속 + 지속 적합성 (ACG 단계8)

변경이 닫혀도 끝이 아니다. `knowledge-update` skill이 가치 있는 durable 변경(ADR감 결정·용어·반복 패턴; 경계(b))을 영속화한다:
- **decision_ref / ADR** — 변경과 결정을 묶는다. CLAUDE.md projection으로 매 세션 자동 로드되는 프로젝트 메모리가 된다(단편적 사고 → 프로젝트 메모리).
- **FitnessFunction 승격 (Assurance Graph)** — 이 변경이 지켜야 할 불변식을 **영속 적합성 함수로 승격**한다. 이후 *모든* 변경이 이 성질을 깨면 잡힌다.

이것이 "한 요청의 처리"와 "프로젝트를 가꾸어감"이 갈라지는 지점이다(§7).

---

## 5. 효과 → AX 개선 매핑 (이 문서의 핵심 주장)

각 설계 요소가 §1의 어떤 의도를 실현하고, 그것이 **사람 면**과 **에이전트 면** 경험을 각각 어떻게 개선하는가.

| 설계 요소 | 실현하는 의도 | 사람 면 AX 개선 | 에이전트 면 AX 개선 |
|---|---|---|---|
| **증거 게이트 / completion contract** (`final_verdict=pass`는 모든 acceptance가 evidence로 pass여야 허용) | 할루시네이션 방지, 의도 이탈 차단 | "됐다" 대신 테스트·diff·로그를 보고 신뢰 — 재검증 부담 제거 | 완료의 객관적 정의. 자기평가 대신 fresh evidence를 만든다 |
| **축1 deep-interview + readiness(1차)+사용자 확인(2차)** | 인지 비용 최소화, 의도 동기화 | 사용자도 놓친 면까지 질문이 드러냄. 모호한 채 구현 시작 안 함 | 명확한 acceptance를 입력으로 받아 추측으로 출발 안 함 |
| **자기점검 self-check** (응답 전 자기점검 *지침* — 미합의 용어·약어·추측 단정·미검증 완료·근거 없는 답을 스스로 거름; 에이전트 자율이며 *결정적 lint가 아니다*, 정의 원본 `CONTEXT.md`/`glossary.json`) | 인지 비용 최소화, 할루시네이션 방지 | 정제된 출력만 받음 | 출력 품질의 자기 가드레일(지침 기반) |
| **ubiquitous language** (CONTEXT.md/glossary 권위, 합의 용어만) | 인지 비용 최소화 | 합의 안 된 용어 해석 비용 제거 | 단계·에이전트 간 의미 충돌 없는 계약 어휘 |
| **축2 autopilot + owner subagent 위임** | Context Rot 해결, 장기 완수 | 대규모 작업을 한 호흡에 맡김 | 노드별 컨텍스트 격리로 메인 컨텍스트가 안 썩음. wave 병렬·증거 게이트로 수렴 |
| **단계별 정규화 계약** (각 단계 입출력은 정규화 interface, 산출물은 다른 단계 수정 불가) | 의도 이탈 차단, 복구 가능성 | 어느 단계에서 무엇이 정해졌는지 추적 | 앞 단계 산출을 안전한 입력으로 소비 |
| **dialectic** (정·반·합 적대 검토, 멀티모델 Opponent) | 자기 확신 깨기, 창의적 대안 | 한 모델의 확신에 휘둘리지 않는 검토 | 자기 가설을 적대적으로 깨고 교정 |
| **축3 e2e** (진짜 브라우저 저니) | 의도대로 구현됐는지 확인 | "테스트 통과"가 아니라 실제 저니가 동작함을 봄 | 단위 테스트 너머 의도-수준 검증 산출물(스크린샷·trace) |
| **축4 knowledge-update + CLAUDE.md projection** | 진짜 지능으로 재탄생, 토큰 절약 | durable 결정이 매 세션 자동 로드 — 같은 설명 반복 불필요 | 단편 산출물이 영속 메모리로 전환 |
| **handoff + run manifest** (감사 기록 누적) | 세션 관리, 장기 완수 | 새 세션·다른 PC에서 끊김 없이 이어받음 | 후속 에이전트가 무엇이 끝났/남았/건드리지 말지 읽고 이어받음 |
| **Deep Module 패턴** (좁은 interface 위 깊은 구현) | 토큰 절약, 유용성 | 관리하는 면(interface)이 좁아 리뷰 부담↓ | 명확한 계약면 위에서 구현 |
| **PreToolUse scope-out + 3계층 격리** (`.ditto/local` 개인구획, repo 밖 쓰기 차단) | 안전, 의도 이탈 차단 | 작업공간이 의도치 않게 오염 안 됨 | repo 경계 안에서만 mutate |

**ACG 효과를 측정 가능한 ground truth로 (정직).** 효과는 "얼마나 막았나"가 아니라 측정 가능한 형태로 정의돼야 의미가 있다(`00-framework.md` §8):

| 메커니즘 | 닫는 문제 | 측정 지표(ground truth) |
|---|---|---|
| ChangeContract + PreToolUse 차단 | 의도하지 않은 out-of-scope 편집 | unintended-edit rate = out-of-scope 건드린 파일 / 전체 변경 파일 |
| ImpactGraph + unresolved 게이트 | API 영향 범위 판단 실패 | missed-impact count = 사후 발견 affected node 중 그래프에 없던 것 |
| SemanticCompatibility + characterization | 타입은 맞지만 의미가 깨진 변경 | semantic-regression count |
| ArchitectureSpec + boundary 검사 | 계층 경계 우회 침식 | architecture violation count |
| ReviewGraph + Review by Exception | 사람 리뷰의 붕괴(diff 폭주) | review-surface reduction = exception 수 / 전체 변경 파일; high-risk precision |
| FitnessFunction + Assurance Graph | SLOP 누적·증식 | fitness drift = 함수별 통과율 기울기 |
| Evidence-backed Completion | agent 자기보고 완료 | completion-evidence coverage = 증거로 닫힌 acceptance / 전체 |

정성 지표: 사용자가 "내가 원하지 않은 방향으로 갔다"고 느끼는 빈도↓, 리뷰어가 전체 diff 없이 판단 가능한 정도↑, 새 추상화 이유의 납득 가능성↑, 실패 시 다음 agent의 인수 가능성↑. **단 이 지표들의 실제 수집·대시보드화는 아직 구현되지 않았다(§9).**

**한 줄 요약:** DITTO의 거의 모든 설계 요소는 *하나의 메커니즘이 사람의 신뢰·인지 비용과 에이전트의 작업 환경을 동시에* 개선하도록 짜여 있다. ACG의 거버넌스 게이트는 *에이전트를 제약하는 동시에 사람의 신뢰 비용을 줄이는* 양면 장치다.

---

## 6. 게이트가 흐름을 강제하는 방식 + DITTO 바인딩 구현 현황

### 6.1 거버넌스가 흐름의 분기점에 박혀 있다 — 권고가 아니라 런타임

| 게이트 | 어느 구간 | 무엇을 막나 | 성격 |
|---|---|---|---|
| **self-check** (지침, hook 아님) | 모든 응답 직전 | 미합의 용어·약어·추측 단정·미검증 완료·근거 없는 답 | 에이전트 자기점검(런타임 집행 아님) |
| **UserPromptSubmit 훅** | 요청 인입 | 의도 무판단 진입 (work item 판단) | hook |
| **PreToolUse 훅** | 축2 Apply | ChangeContract 금지 범위 편집·repo 밖 쓰기·secret·파괴적 Bash·lease 밖 편집 | hook (exit 2 deny) |
| **Stop 훅** | 축2→축3 검증 | impact/boundary/semantic/review/fitness 미해소·증거 없는 완료·malformed ledger | hook (exit 2 continuation) |

PreToolUse는 매 도구 호출에서, Stop은 매 완료 시도에서 hook으로 작동한다(self-check는 같은 정신이되 런타임 hook이 아니라 응답 전 자기점검 지침이다 — 집행 계층이 다르다). 이 배선이 효과를 *문서상 권고*가 아니라 *런타임 강제*로 만든다.

### 6.2 ACG 6패턴 — DITTO 바인딩 구현 현황 (증거 기반)

ACG 스펙은 저장소 중립이고, DITTO는 그 **첫 번째 바인딩**이다. 스펙 산출물의 상당수가 DITTO 기존 자산(IntentContract·CompletionContract·Reviewer/Verifier·e2eJourney·knowledge)의 *확장/투영*으로 실현되고, 정말 비어 있던 자리(`ImpactGraph`·`SemanticCompatibility`·`FitnessFunction`)만 신설된다. "동작구현" 판정은 **ACG 테스트 188 pass / 6 skip / 0 fail**(2026-06-07, 27파일 194테스트)로 뒷받침된다.

| 패턴 (단계) | 상태 | DITTO 실현체 | 집행 게이트 |
|---|---|---|---|
| **① Intent Preservation / ChangeContract** (1·2) | 동작구현 | ICL DSL 컴파일러 `src/acg/icl/`, `ditto change-contract`, `change-contract-store.ts` | **PreToolUse** — forbidden_scope를 도구 호출 전 차단 |
| **② Impact / ImpactGraph** (3) | 동작구현 | `ditto impact`, `src/acg/impact/`, CodeQL 분석기(TS/Java/Kotlin/Python) | **Stop** — unresolved 시 차단 |
| **③ Semantic Compatibility** (6) | 동작구현 | `ditto semantic scan/detect/verdict/observe`, `src/acg/semantic/`, CodeQL signature diff | **Stop** — `unverified`·의도치 않은 break 차단 |
| **④ Architectural Boundary** (6) | 동작구현 | `ditto boundary check`, `src/acg/boundary/`, CodeQL import edge | violation → Review(high-risk) → Stop 차단 |
| **⑤ Review by Exception** (5·7) | 동작구현 | `ditto acg-review`, `src/acg/review/`, `acg-review-store.ts` | **Stop** — 미해소 high-risk(증거 부재) 차단 |
| **⑥ Senior Pattern Repository** | 부분(스키마+propose) | `ditto architecture propose`(비권위 후보), `src/acg/architecture/` | — (ratification 자동화 미구현 ~30%) |
| **횡단: Continuous Fitness** (8) | 동작구현 | `ditto fitness run/drift`, runner+provider(command/codeql/executed/injected) `src/acg/fitness/` | **Stop** — fail 시 차단 |
| **횡단: Evidence-backed Completion** | 동작구현(재사용) | `CompletionContract` + `acg_governance` 슬롯, `EvidenceRecord` | Stop이 거버넌스 ledger를 직접 읽어 집행 |

**CodeQL 통합 진척** (deterministic evaluator를 실제로 채운 것): WI-1 Runner 완료(`src/core/codeql/runner.ts`), WI-2 Doctor 완료(`doctor codeql`, fail-closed), WI-3 SARIF→Evidence 완료(`sarif-adapter.ts`), WI-4 Dialectic Opponent 미착수(무한루프 방지 advisory-first 대기), WI-5 Dataflow DoD 미착수(PoC만). CodeQL이 *없어도* ACG는 성립하지만(stack-agnostic), 있으면 LLM 추측 대신 결정론으로 판정한다.

**stack-agnostic의 기계적 정의 — 스펙/바인딩 2계층.** 스펙 계층(00~50)은 저장소 중립으로 *정보·성질*만 정의하고, 바인딩 계층이 그것을 저장소의 실제 스키마·도구에 끼운다. **DITTO=첫 바인딩(TS, CodeQL-TS), boxwood-workspace(235K LOC Java/Kotlin + 94K LOC TS/Svelte)=두 번째 바인딩(CodeQL-JVM).** 이 **provider 슬롯 구조가 stack-agnostic의 기계적 정의**다 — 범용성은 "존재하지 않는 호스트용 추상을 미리 짓는" 게 아니라 "실제 바인딩 2개로 스펙의 저장소 독립성을 검증하는" 방식으로 확보한다.

---

## 7. "프로젝트를 가꾸어간다"의 의미 — 단발이 아니라 지속

§4.0~4.3은 **요청 한 건**의 여정이다(앞의 네 그래프는 변경과 함께 닫힌다). §4.4가 그것을 **프로젝트 차원의 지속**으로 전환한다. 두 축으로 일어난다:

1. **지식의 지속 (축4)** — 결정·용어·패턴이 영속 메모리가 되어, 다음 요청·세션·에이전트가 그것을 컨텍스트로 읽는다. 같은 설명을 반복하지 않고, 단편 산출물이 "진짜 지능"으로 재탄생한다.
2. **적합성의 지속 (Assurance Graph)** — 한 변경의 불변식이 적합성 함수가 되어, 이후 모든 변경의 누적·증식을 시계열로 감시한다. **SLOP은 한 번 막는 게 아니라 계속 막아야 하는 것**이기 때문이다. 다섯 그래프 중 Assurance Graph만이 변경을 가로질러 살아남는다 — 이것이 "가꾸어간다"의 기계적 정의다.

두 축은 같은 방향을 가리킨다: **한 번의 통과가 아니라, 통과한 품질을 수천 번의 후속 변경에 걸쳐 유지하는 것.** "장기 작업 완수"(의도⑥)와 "지속적 적합성"이 여기서 만난다.

---

## 8. 효과를 떠받치는 횡단 계약

기능 4축이 작동하려면 substrate 레벨에서 보장돼야 하는 횡단 계약이 있다(재평가 정정판 §3.5).

- **Distribution (배포 계약)** — 기층 4축이 타겟에서 살아있으려면 self-contained 바이너리 빌드 + 플러그인 등록 + CLI의 PATH 배치 + 명시적 `ditto init`이 충족돼야 한다. `ditto doctor distribution`이 런타임에 재점검한다.
- **Session-rooting invariant** — 기층 4축은 Claude Code 세션이 타겟 레포에 루트되어 있을 때만 일관되게 동작한다. 한 세션이 *다른* 레포를 관리하는 cross-repo 운용은 비지원 모드다(ADR-0011). 버그가 아니라 scope-out의 설계 의도(repo 경계 보호)와 정합적인 경계다.

이 둘은 **"효과가 데모가 아니라 실제 타겟에서 재현된다"** 를 보장하는 계약이며, boxwood 실타겟 autopilot e2e가 `final_verdict: pass`로 이를 실증했다(재평가 정정판 §2).

---

## 9. 정직 — 알려진 한계와 미구현 gap

DITTO 제1원칙(증거 없는 완료 선언 금지)을 이 문서 자신에게도 적용한다.

**해소된 과거 위험 (이력으로 남김):**
- **완료 게이트 false-green — 해소됨.** verifier per-AC `partial`이 노드 `outcome=pass`에 흡수되어 AC를 over-close할 수 있던 위험은 `ac_verdicts` 관통 + `worst()` fold + completion-contract 스키마 superRefine backstop으로 막힌다(커밋 51ca564; `src/core/autopilot-complete.ts`, `src/schemas/completion-contract.ts`).
- **축3 N/A 자동 분기 — 해소됨.** `ditto e2e applicable`(`src/core/e2e/applicability.ts`)이 web-UI 신호로 축3 N/A를 자동 판정한다.
- **축3 어설션 평가 — 부분 해소.** 러너가 mechanically-checkable predicate는 평가하고, 평가 불가한 NL 어설션은 부당한 fail 대신 `result=unverified`로 분리한다(`src/core/e2e/assertion.mjs`). 남은 범위: 임의 NL 어설션을 실제 페이지 상태와 *직접 대조*하는 것.
- **CodeQL WI-4 (Opponent) — 해소됨.** CodeQL 결정론 사실이 Stop 종료를 차단하는 효과는 acg-review ledger 경로로 구현·배선됐다(`src/core/codeql/review-to-ledger.ts` → `src/hooks/stop.ts`의 high-risk-without-evidence continuation). 계획서가 적은 dialectic ledger 경로(`sarif-adapter.ts` `toObjection`)는 호출자 없는 죽은 코드. (이전 gap 서술 "WI-4 미착수"는 stale였다.)
- **`fitness` executed 실행 엔진·Assurance drift 집계 뷰 — 구현됨.** executed 실행 provider(`src/acg/fitness/executed-provider.ts`)와 drift 추세 뷰(`ditto fitness drift`, `src/acg/fitness/drift.ts`)가 동작한다. (이전 gap 서술은 stale였다.)

**2026-06-14 구현 (wi_260614gd9 — 본 조사 후속, 전체 테스트 1969 pass/0 fail):**
- **축4 게이트 hook 배선 — 구현됨.** `knowledgeUpdateGate`가 이제 Stop hook에서 강제된다(`src/hooks/stop.ts` `knowledgeForcesContinuation`). 작업아이템 dir의 carrier(`knowledge-gate.json`)에 trigger·delta를 영속하고, terminal knowledge 노드가 있을 때만 발화한다. 노드/carrier 부재면 inert — no-trigger 작업이 아무것도 안 기록하는 명시적 skip은 막지 않는다(ADR-0010 (b) 보존).
- **`architecture ratify` — 구현됨.** `ditto architecture ratify`(`src/acg/architecture/ratify.ts`)가 비권위 후보를 `produced_by=user`로 승격한다. `forbidden_dependencies`는 사람 인자로만 채워지고 관측 자동박제 0(ADR-0004 불변식). 관찰→비준→집행 고리가 닫혔다.
- **CodeQL WI-5 Dataflow DoD — 구현됨.** codeFlow(source→sink)를 검증가능 명제(GIVEN 신뢰불가 입력/WHEN sink 도달/THEN sanitizer 차단)로 변환한다(`src/core/codeql/dataflow-dod.ts`). `ditto codeql review` 출력 + `dataflow-dod.json`에 명세로 노출 — 게이트가 아닌 명세라 차단 의미는 안 바꾼다. dataflow 없는 finding엔 명제를 안 만든다(과적용 0).
- **Multi-Change Semantic 다중차단 — 구현됨.** `acg-semantic-compatibility` 스키마를 단수 `change`→`changes[]`로 확장하고, `semanticForcesContinuation`이 모든 breaking/unverified 쌍을 합산해 차단한다. detector는 원래대로 전수 감지(거짓 양성 무신설).
- **`fitness` clean-build fail-closed 가드 — 구현됨.** `acgExecution.requires_clean_build` 선언 시 executed spec의 non-zero exit를 errored로 처리해(`executed-provider.ts`), 빌드 실패가 "위반 0 = clean = pass"로 오판되던 위험을 막는다(fail-closed skip). stack-agnostic(toolchain 미내장).
- **평가지표 completion-coverage 집계 — 구현됨.** `ditto doctor completion-coverage`(`src/core/completion-coverage-doctor.ts`)가 이미 영속된 `completion.json`들에서 "evidence로 닫힌 AC / 전체 AC"를 집계한다(새 instrumentation 0). evidence 없는 pass는 닫힘으로 안 센다(claim≠proof).

**남은 구현 gap (2026-06-14 구현 후 잔여 — `reports/design/ditto-gap-resolution-analysis.md`):**
- **⑥ ADR 저장 자동화** — ratify(위)로 관찰→비준→집행 고리는 닫혔으나, 비준된 결정을 ADR 파일로 자동 저장하는 자동화는 여전히 수기다. (`module_invariants`→FitnessFunction 승격은 타입드 invariant 선결 필요 — ADR-0004 §23.)
- **평가지표 ①②③④⑤ 집계** — ⑦ coverage는 구현됨(위). ⑤ review-surface는 원천 데이터가 영속(`acg-review.json`)이라 같은 패턴으로 후속 집계 가능(미구현). **①②③④(unintended-edit·missed-impact·architecture-violation·semantic-regression)는 원천 데이터가 집계 가능한 형태로 영속되지 않아, 집계 뷰 이전에 instrumentation이 선결**이다 — 없는 데이터에 가짜 뷰를 만들지 않는다(증거 게이트 정신).
- **축4 trigger 판정의 정확성** — 게이트는 배선됐으나(위), 여전히 "신고 trigger ↔ 기록" 정합만 검사하고 "trigger 신고 자체가 옳은가"(놓침)는 못 잡는다(ADR-0010 (b)가 받아들인 self-declared 한계). carrier(`knowledge-gate.json`)를 skill이 실제로 쓰는 런타임 동작은 prose 갱신만 됐고 미검증.
- **WI-4 죽은 코드 정리** — `toObjection`/`toObjections`(dialectic 경로, `sarif-adapter.ts`)는 호출자 0인 죽은 코드로 남아 있다(구조적 정리 대상).

**개념적 한계 (스펙이 정직하게 열어둔 것, `00-framework.md` §9):**
- **agent의 코드↔제품 이해 갭** — `JourneyRun`(실행 증거)이 통과해도 "agent가 여정을 *이해*했다"는 보장은 아니다. 증거는 결과를 검증할 뿐 이해를 만들지 않는다.
- **적합성 함수 비용** — 변경마다 전역 적합성을 다 돌리면 비싸다. ADR-0004는 deterministic 싼 가드만 `per_change`, 전체 스위트·executed는 `risk_tiered/periodic`으로 분리하되, **안전 불변식**(입력 부재·`journey_unknown` 시 high-risk escalate, sample down 금지)을 fail-closed로 박았다.
- **ArchitectureSpec 출처** — 경계가 암묵적인 저장소(boxwood) 부트스트랩. ADR-0004: `produced_by=user` 권위 기본 하이브리드 — agent는 관측 가능한 layers/public_surfaces만 비권위 후보로 제안, 사람이 비준. `forbidden_dependencies`는 관측에서 자동 박제 금지(현재 위반을 규칙으로 굳히는 것 방지).

AX 관점: **축1·축2·축4가 실증됐고, 축3은 런타임에 더해 N/A 분기·predicate 평가까지 동작하나 NL 어설션 직접 대조는 미완**이다 — 전부 동등하게 성숙한 것은 아니다.

---

## 10. 근거 출처

- 설계 의도(중점 가치 7개): `PURPOSE.md` · 설계 태도: `README.md`
- 기능 4축 canonical 정의·경계·두 층위: `.ditto/knowledge/adr/ADR-0010-ditto-functional-four-axes.md`
- 핵심 계약 용어(completion contract·evidence·self-check·ubiquitous language 등): `.ditto/knowledge/CONTEXT.md`
- 4축 실증 커버리지·기층 substrate·gap·횡단 계약: `reports/design/ditto-four-axis-reassessment.md`
- ACG 프레임워크(토대·다섯 그래프·두 기여·DITTO 바인딩·열린 질문): `reports/design/agentic-governance/00-framework.md` (+ 10~50)
- 변경 lifecycle 8단계: `reports/design/agentic-governance/10-methodology.md` · 스키마 명세: `20-contracts.md` · ICL DSL: `30-intent-change-dsl.md` · 리팩토링 기준: `40-refactoring-criteria.md` · 변경 지도: `50-change-map.md`
- 아이디어 베이스(문제 정의·진화 4세대): `reports/design/agentic-engineering-change-governance.md`
- ADR: ADR-0004(ArchitectureSpec 출처·fitness 비용), ADR-0006(CodeQL), ADR-0007(cross_repo), ADR-0010(4축), ADR-0011(Distribution·session-rooting), ADR-0012(3계층 격리)
- CodeQL: `reports/codeql/codeql-research-ko.md`, `reports/codeql/codeql-ditto-integration-plan.md`
- 구현 코드: `src/acg/{icl,impact,semantic,boundary,review,fitness,architecture}/`, `src/core/codeql/`, `src/hooks/{pre-tool-use,stop}.ts`, `schemas/acg-*.schema.json`
- 실행 증거: `bun test tests/acg/` → 188 pass / 6 skip / 0 fail (2026-06-07)
