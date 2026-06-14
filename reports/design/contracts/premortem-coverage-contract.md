---
title: "DITTO Pre-mortem Coverage Engine Contract (상세 설계)"
kind: design-detail
last_updated: 2026-06-14 KST
status: draft
parent: reports/design/ditto-claude-code-harness-design.md
owns: "intent 단계(§6.3 Deep Interview)와 plan 단계(§6.6 Dialectic) 양쪽에 공통인 pre-mortem coverage 엔진의 'how' — 6축 품질(완전성·중립성·균형·발견·우선순위·시간정합) 강제, coverage map, Manager/fresh fan-out 분리, 사용자 질문 경로, dialog 산출, plan_brief, 구현 brief hard-gate"
inputs:
  - reports/design/contracts/deep-interview-contract.md   # §3 무편향, §4 차원·readiness 쌍대 게이트, §5 pre-mortem 승격
  - reports/design/contracts/dialectic-deliberation-contract.md  # §2 3역 분리, §3 opponent 라우팅, §6 admissibility
  - reports/design/contracts/autopilot-contract.md        # §2.2 design→review, §2.4 planner=그래프 생성기, §5 approval gate, §7.2 분리 제안
  - src/schemas/interview-state.ts                          # 재사용: dimensions·readiness·questions·assumptions (authoritative)
  - src/schemas/dialectic.ts                               # 재사용: 3역 출력·verdict (authoritative)
  - src/schemas/autopilot.ts                               # 재사용: nodes·approval_gate (authoritative)
  - src/core/opponent-router.ts                            # 재사용: host-aware opponent 라우팅
  - src/core/gates.ts                                      # 재사용: interviewReadinessGate·deterministicFloor
---

# DITTO Pre-mortem Coverage Engine Contract (상세 설계)

> **이 문서의 위치.** Deep Interview(§6.3)와 Dialectic(§6.6)은 각각 intent 모호성 축소와 plan 적대 검증을 소유한다. 그런데 둘은 같은 실패 양상을 공유한다 — **한 주제에 매몰되어 사용자 의도의 나머지 범위를 암묵 축소하는 것**. 이 문서는 그 공통 실패를 막는 **coverage 엔진**의 how를 소유한다: 두 단계 모두에서 (a) 사용자 최초 의도의 *모든* 범위를 정직하게 다루게 하고, (b) 매 변증법 단위를 fresh context로 분리해 자기확신·편향을 끊으며, (c) 사용자만 답할 수 있는 것은 사용자에게 묻고, (d) 주고받은 전 과정을 dialog로 남겨 사용자가 교정하게 한다. Deep Interview/Dialectic 계약은 자기 단계의 역할 정의를 유지하고, *coverage 보장 메커니즘*은 이 문서로 위임한다.

## 0. 권위 규칙 (메인 ↔ 상세 ↔ 스키마)

| 층위 | 소유 대상 | 충돌 시 |
|---|---|---|
| 실제 스키마 (`src/schemas/*.ts`) | 필드명, enum, validation | **최우선.** 본 문서 예시 JSON과 다르면 스키마가 이긴다. |
| 메인 §6.3 / §6.6 | "what" — Deep Interview·Dialectic의 목적·역할 | "what"이 충돌하면 메인이 이긴다. |
| deep-interview / dialectic 계약 | 각 단계의 역할·라우팅·산출 | 본 문서는 그 위에 *coverage 보장*만 얹는다. 역할 정의를 재정의하지 않는다. |
| 본 상세문서 | "how" — 6축 강제, coverage map, Manager, fan-out, dialog, plan_brief, brief gate | 이 메커니즘의 단일 출처. |

규칙: 본 문서가 신설하는 사이드카(`coverage.json`, `*-dialog.md`)와 필드(`plan_brief`)는 **additive**다. 기존 `interview-state.json`·`dialectic-<n>.json`·`autopilot.json`을 대체하지 않고 그 위에 얹는다. 신규 스키마는 구현 전 기존 Zod 스키마와 정합한다.

## 1. 목적과 경계

### 1.1 한 문장 정의

Pre-mortem Coverage Engine은 **intent·plan 양 단계의 변증법적 인터뷰에서, 사용자 최초 의도를 마인드맵형 범위 트리(coverage map)로 분해하고 — 이 트리는 고정된 1회 분해가 아니라 심문이 진행되며 하위 범위로 동적으로 자라난다 — 각 범위를 fresh-context 서브에이전트의 적대적 심문으로 다루되, 사용자만 답할 수 있는 것은 사용자에게 묻고, 트리의 모든 범위가 6축 품질(완전성·중립성·균형·발견·우선순위·시간정합)을 만족할 때까지 — 그러나 완벽이 아니라 수렴까지만 — 진행해, 매몰로 인한 암묵적 범위 축소를 구조적으로 차단하는 엔진**이다.

핵심 가설: **사람은 자기확신·편향 탓에 혼자서는 자신이 무엇을 놓쳤는지 볼 수 없다.** 그리고 한 컨텍스트가 길어지면 그 자체가 prior로 작동해 특정 주제로 매몰되고 나머지를 축소한다(context rot + 자기 서사, 메인 §4-9). 그래서 *분해는 한 곳에서 추적하되, 심문은 분산된 fresh context로 한다.*

### 1.2 인접 계약과의 경계

| 계약 | 다루는 것 | 본 엔진과의 관계 |
|---|---|---|
| §6.3 Deep Interview | intent 모호성 축소, `dimensions`·readiness 게이트 | 본 엔진은 Deep Interview의 `dimensions`를 **coverage map의 intent-단계 표현**으로 재사용하고, 그 위에 6축 강제·fan-out·dialog를 얹는다. readiness 쌍대 게이트(`gates.ts`)는 종료조건의 *깊이* 축으로 재사용한다. |
| §6.6 Dialectic | plan/decision/document 3역 적대 검증, 1라운드 | 본 엔진은 Dialectic 3역을 **범위 1개를 다루는 심문 단위**로 재사용한다(opponent-router 그대로). Dialectic 단독은 "산출물 1개·1라운드"지만, 본 엔진은 그것을 *범위마다* 돌리고 coverage로 묶는다. |
| §6.5 Autopilot | 그래프 진행 드라이버 | 본 엔진은 autopilot 루프의 `design`→`review` 사이(plan 단계)와, intent 게이트(autopilot 이전)에 배선된다. plan_brief는 `approval_gate`를 확장해 implement 진입의 hard 조건이 된다. |
| §6.2 QuestionGate | 질문 한 건 검열 | 사용자에게 가는 모든 질문은 QuestionGate를 먼저 통과한다(코드·문서·웹으로 self-answer 가능하면 안 묻는다). 본 엔진은 그 상위 루프다. |

## 2. 6축 품질 — 정식화와 차단 메커니즘

매몰은 단일 실패가 아니라 여섯 가지 양상으로 나타난다. 각 축은 별도 메커니즘으로만 막힌다 — 체크리스트 하나로는 못 막는다.

| 축 | 막는 실패 | 강제 메커니즘 |
|---|---|---|
| **완전성 (breadth)** | 범위 일부만 다루고 종료 (의도의 1·3·4만 다룸) | coverage map의 **모든** 항목이 닫혀야 종료(§5). 범위 추출을 단일 시야가 아니라 **여러 각도 fresh sweep**로 수행(§4.2) — 한 에이전트의 분해에 갇히지 않게. |
| **중립성 (non-bias)** | 한 범위 안에서 편향된 질문으로 한쪽 결론 몰이 | 범위마다 Dialectic **정(Producer)/반(Opponent)/판정(Synthesizer)** 3역 강제(§4.3). 생성된 사용자 질문이 leading인지 **별도 fresh 에이전트가 검수**. fresh context라 직전 기울기에 안 물듦. |
| **균형 (depth)** | 범위 간 깊이 불균형 (작은 범위 20문항, 가장 큰 범위 3문항) | 각 범위에 **필요-깊이 추정치**(weight) 부여 → Manager가 "필요 대비 미달" 범위를 식별·차단(§4.4). 균등이 아니라 **필요 비례**. readiness 쌍대 게이트를 범위별로 적용. |
| **발견 (discovery)** | 명시 안 된 숨은 영역("기타")을 못 끌어냄 | 전용 **completeness-critic 패스**("우리가 명시 안 한·놓친 영역은?")를 **새 가지가 안 나올 때까지 반복**(loop-until-dry, §4.5). 찾은 영역은 coverage 트리에 자식으로 분기(append) → 그 가지도 닫고 확장이 dry해야 종료. |
| **우선순위 (priority)** | 모든 범위를 동등 의무로 닫느라 사용자가 가장 중요시하는 범위를 정작 얕게 다룸 (균형의 역실패, dialectic-review OBJ-5) | 노드에 **사용자 우선순위**를 표시(judge가 추정 후 사용자 확인). 높은 우선순위 노드는 `depth_weight`·dry 기준을 가중하고 사용자 질문을 우선 배정. 중요 노드가 미달이면 종료를 차단 — "다 동등하게 닫음"이 정작 핵심을 묻지 못하게. |
| **시간 정합 (temporal)** | plan 단계에서 합의한 의도가 구현 단계에서 조용히 표류 | plan_brief·coverage 결과를 구현의 **기준선(baseline)**으로 고정 → 구현 중 합의 안 된 interface/범위 변경을 autopilot reviewer/verifier가 기준선 대비 감지(intentDriftGate·ACG drift와 연계). 본 엔진은 기준선을 *생성*하고, 표류 감지는 구현 단계가 집행한다. |

이 여섯 축은 Manager 혼자 보장하지 못한다. Manager는 *추적·조율*만 하고, 실제 완전성·중립성·발견·우선순위는 **fresh-context 서브에이전트들의 적대적·다각도 fan-out**으로 만들어진다(§4).

## 3. Coverage Map (정직한 전 범위 — 동적 성장 트리)

### 3.1 자료구조 — 마인드맵형 트리/그래프

coverage map은 평면 목록이 아니라 **루트(사용자 최초 의도)에서 뻗는 범위 트리**다(마인드맵). 한 범위를 심문하다 하위 관심사가 갈라지면 자식 노드로 분기한다 — 대개 트리지만, 한 하위 범위가 둘 이상의 상위 범위에 걸리면 DAG가 된다(cross-cutting).

각 노드:

```text
{ id, parent_id, label, origin, depth_weight, state, children[] }
```

- `origin`: `seed`(최초 분해) | `derived`(답변에서 파생) | `discovered`(completeness-critic 발굴).
- `state`: `open` | `resolved` | `user_owned` | `out_of_scope`(§3.3).
- `depth_weight`: 필요-깊이 추정(§4.4).

### 3.2 동적 성장 (고정 1회 분해가 아님 — append-only)

트리는 심문 진행 중 계속 자란다:

- (a) **seed**: 최초 의도를 §4.2 다각도 sweep로 분해해 1차 트리.
- (b) **derived**: 답변·심문에서 파생된 하위 범위를 *해당 부모 아래* 자식으로 append.
- (c) **discovered**: completeness-critic(§4.5)이 발굴한 숨은 영역을 append.

노드는 **append-only** — 한번 자라난 가지는 동등한 의무가 된다. 발견 축(§4.5)이 "이 노드에서 더 분기할 게 없다"(확장 dry)를 판정하기 전까지 그 노드는 잠정적이다.

intent 단계에서는 트리의 노드를 Deep Interview의 `dimension`으로 **투영**해 깊이 판정에 쓴다. 단, `interviewReadinessGate`(gates.ts:54)는 인터뷰 *전체*를 단일 `readiness`로 평가하므로 그대로 못 쓴다 — per-node readiness/`depth_weight`는 **신규 구조**이고, 평면 게이트는 1-dimension 부분 state로 호출하는 **어댑터**로 두며 `deterministicFloor` 공식만 차용한다(dialectic-review OBJ-2 — "재사용"이 아니라 신규+차용). 트리 자체는 `coverage.json`이 소유한다.

**false-green 차단 불변식(dialectic-review OBJ-7):** 부모 dimension은 서브트리 전체가 dry(§4.5)이기 전에는 `resolved`로 투영될 수 없다 — 자식이 열렸는데 부모만 resolved로 게이트를 통과하는 거짓 완료를 막는다. DAG 노드(부모 둘 이상)는 모든 부모의 서브트리 평가에 동일 상태로 기여한다. plan 단계 노드는 plan-범위(영향받는 인터페이스 표면·대안 결정점·위험)다.

### 3.3 노드를 닫는 유일한 방법

| 닫는 방식 | 조건 |
|---|---|
| `resolved` | 그 범위에 대해 6축이 충족됨 — 적대 심문 수렴 + 필요-깊이 도달 + 편향 검수 통과 + **서브트리 확장 dry**(자식이 모두 닫힘 + 새 자식 안 나옴). |
| `user_owned` | 사용자만 답할 수 있는 결정이 사용자 답변으로 확정됨. |
| `out_of_scope` | **사용자 명시 승인**으로 가지째 제외. 에이전트 임의 축소 금지(§8). |

"나중에·대충·연기"로 닫을 수 없다. 부모는 자식이 더 자랄 수 있는 한 잠정적이다 — 서브트리 전체가 dry해야 부모가 닫힌다. Manager는 "열린/얕은/확장 미완" 노드를 명시 추적하고, 하나라도 열려 있으면 종료를 차단한다.

## 4. Manager · fresh fan-out · 사용자 질문

### 4.1 Manager = 결정론 오케스트레이터 (LLM 아님 — 매몰 자체를 차단)

처음엔 Manager를 "인터뷰 내용 관리 에이전트"로 상상했으나, **그 에이전트도 서브에이전트 결과를 누적해 읽으면 컨텍스트가 길어지고 내용에 편향된다** — 막으려던 매몰을 Manager가 다시 들여온다. 그래서 Manager는 **LLM 에이전트가 아니라 결정론 코드 오케스트레이터**다(autopilot 드라이버 §3.1과 동형, 원칙 10: 판단=에이전트, 강제=결정론). 코드는 구조 필드만 처리하고 자연어 내용을 해석하지 않으므로, 편향될 누적 컨텍스트가 없다.

Manager(코드)의 책임 — *내용을 해석하지 않는다*:

- `coverage.json` 트리를 소유. 미해소·확장 미완·깊이 미달 노드를 **구조적으로** 선택(`selectReadyNodes`류).
- 각 fresh 서브에이전트에 **최소 컨텍스트만** 전달: [해당 노드 + 최초 의도 + 관련 cross-cutting 제약]. **전체 transcript는 주지 않는다.** 단, *어떤* cross-cutting 제약이 이 노드에 걸리는지 고르는 것은 의미 판단이라 코드가 결정론으로 못 한다(dialectic-review OBJ-1) — 이 선택도 **fresh·무상태 judge**가 한다(해당 노드 + 후보 제약 목록만 받고, 끝나면 상태를 안 들고 감). Manager는 그 결과를 구조 필드로 받을 뿐이다.
- 서브에이전트의 **구조화 반환**(verdict·derived 노드·질문·근거)을 받아 트리를 갱신하고 종료조건(§5)을 평가 — 구조 필드만 처리, 자연어를 "판단"하지 않는다.
- dialog md는 서브에이전트 산출을 **해석 없이 직렬화**해 append(§6). 매 라운드 트리를 re-read(컨텍스트 누적 안 함, autopilot §3.1).

**내용 판단이 필요한 곳은 그때그때 fresh judge 서브에이전트로 위임한다** — cross-cutting 제약 선택, leading-question 검수(§4.3), 필요-깊이 충족 판정(§4.4), derived 노드 중복 판정. Manager는 judge를 trigger만 하고, 결과는 구조화 verdict로 받는다. 핵심은 **영속적으로 누적되는 단일 컨텍스트가 시스템에 존재하지 않는 것**이다 — 모든 의미 판단은 매번 fresh·범위 한정 judge가 하고 상태를 들고 가지 않는다. 이것이 *세션 누적* 편향의 근본 차단이다. (절대적 "누적 판단 0"이 아니다: 개별 judge의 1회성 판단 오류는 견제장치 + 다중 judge로 완화하되 0은 아니다 — §4.1 한계 문단·dialectic-review OBJ-1.)

**결정론의 한계 (정직).** 결정론 코드가 *판단을 대체하지는* 못한다. 범위 충족·필요-깊이·발견 dry·편향 여부는 본질적으로 의미론적 판단이라 LLM이 내려야 한다. 결정론이 하는 일은 셋뿐이다 — (a) **집계·강제**: 트리 저장, 노드 스케줄링, "모든 노드 닫힘 + 서브트리 확장 dry" 종료 집계(§5), "K회 연속 새 가지 0"(§4.5) 같은 기계적 카운팅; (b) **판단 견제**: LLM 자기보고 점수를 결정론 하한으로 누르고(`deterministicFloor` 재사용), 모호 용어 정규식(grading.py식 VAGUE_TERMS)으로 untestable한 닫힘을 1차 거부; (c) **수집**: judge verdict를 구조 필드로 받기. 즉 편향을 막는 진짜 메커니즘은 "결정론"이 아니라 **"판단을 누적 없는 fresh judge로 분산"**이다. Manager를 코드로 둔 목적은 판단을 없애는 게 아니라 *누적 판단 지점*을 없애는 것이다. 결정론은 그 분산된 판단들을 **강제·집계·견제**할 뿐, 스스로 충족 여부를 판정하지 않는다.

### 4.2 범위 추출 (완전성 — 다각도 sweep)

최초 의도 분해를 단일 에이전트가 하면 그 시야에 갇힌다. 서로 다른 각도(예: 데이터/경계, 인증/권한, 인터페이스 표면, 실패 모드, 운영/배포)로 **복수 fresh 에이전트가 병렬 분해** → 합집합을 coverage map 초기값으로. 각 에이전트는 다른 에이전트가 무엇을 냈는지 모른다(blind).

### 4.3 범위별 심문 (중립성 — Dialectic 재사용, fresh context)

각 미해소 범위마다 Dialectic 3역(`opponent-router` 그대로)을 **fresh context로** 1단위 돌린다:

- Producer: 그 범위에 대한 현재 최선 해석/제안.
- Opponent: 누락·위험·곡해·대안 공격(Codex 우선). 이전 범위 논의에 물들지 않은 깨끗한 시야.
- Synthesizer: 채택/기각 판정 + 사용자만 답할 수 있는 잔여 질문 추출.

Synthesizer가 뽑은 "사용자만 답할 수 있는 것"만 사용자에게 간다(§4.6). 나머지는 코드·문서·웹으로 self-answer.

### 4.4 깊이 균형 (균형 — 필요 비례)

각 범위는 `depth_weight`(필요-깊이 추정)를 가진다 — **fresh judge가 산출**한다(weight 자체가 누적 편향의 산물이 되지 않게; Manager 코드는 저장만). Manager는 범위별 심문 깊이(라운드·해소도)를 weight에 비례해 요구한다. 큰 weight 범위가 얕으면 per-node 깊이 게이트(§3.2: 신규+어댑터, `deterministicFloor` 차용)를 그 범위에 통과시키지 않는다 — score만 높고 critical 미해소면 닫지 않는 그 구조와 동형.

### 4.5 숨은 영역 발굴 (발견 — loop-until-dry)

매 라운드, "명시되지 않은·놓친 범위는?"만 묻는 전용 completeness-critic fresh 패스를 돌린다. 새 영역이 나오면 coverage 트리에 가지로 append(§3.2c).

**dry 판정 (종료 보장).** append-only 트리는 critic이 사소한 가지를 끝없이 낼 수 있어 단순 "새 가지 0"으로는 종료가 보장되지 않는다(dialectic-review OBJ-3). 그래서 dry는 **admissible-novelty 소진**으로 정의한다(dialectic 계약 §6 admissibility와 동형): dry 카운터는 **critical/major** 새 가지가 나올 때만 리셋되고, info/low(사소·기존 인접) 발굴은 dialog에 기록만 하고 카운터를 막지 않는다. **K=2회 연속 admissible 새 가지 0**(K는 configurable 기본값)이면 그 서브트리 확장을 dry로 본다. 이로써 종료는 "critic이 우연히 침묵"이 아니라 "비용을 정당화하는 새 발견의 소진"에 달리고, admissible 발견은 유한하므로 단조감소 측도가 되어 종료가 보장된다(완벽이 아니라 수렴).

### 4.6 사용자 질문 경로

- intent 단계: Deep Interview의 소크라테스 질문 + 본 엔진의 범위별 잔여 질문. 둘 다 QuestionGate 통과.
- plan 단계: §4.3 Synthesizer가 추출한 "사용자만 답할 수 있는 것". 에이전트끼리(자기확신)는 fan-out이 깨고, 의도·가치는 사용자에게.
- 질문은 항상 `why_matters`(답에 따라 무엇이 갈리는지)를 포함(deep-interview 계약 §3).

## 5. 종료조건 (양축 — 완벽 추구 금지)

종료 = **(넓이) AND (깊이)**:

- **넓이**: coverage 트리의 *모든* 노드가 §3.3으로 닫힘 + 모든 서브트리 확장이 dry(§4.5) — 새 가지가 더 안 자람.
- **깊이**: 각 항목이 수렴(적대 심문이 새 admissible 반론을 못 냄) 또는 라운드 상한 도달.

상한 도달은 성공이 아니다(`cap ≠ converged`, deep-interview §4.3·dialectic §7과 동형). 상한에서 닫지 못한 항목은 `user_owned` escalate 또는 명시 assumption으로 남기고, dialog에 "열린 채 상한 종료"로 기록한다. **완벽을 추구해 루프를 끝없이 돌리지 않는다** — 새 admissible 반론·새 범위가 안 나오면 수렴으로 본다.

## 6. Dialog 산출 (사용자가 교정)

intent·plan 양 단계 모두, Manager가 주고받은 전 과정을 **dialog md로 산출**한다:

```text
.ditto/local/runs/<wi>/intent-dialog.md     # intent 단계 인터뷰/pre-mortem Q&A
.ditto/local/runs/<wi>/plan-dialog.md       # plan 단계 변증법 Q&A
```

dialog는 **사용자가 본 것**만이 아니라 **에이전트가 사용자 몰래 내린 의도 결정**까지 드러내야 신뢰성을 가진다. 세 가지를 범위별로 묶어 표기한다:

- **사용자 Q&A**: 사용자에게 간 질문과 답변(Q→A 순서).
- **QuestionGate self-answer** (§6.2): 에이전트가 사용자에게 *묻지 않기로 하고* 코드/문서/웹/메모리로 스스로 답한 항목 — 질문, self-answer source·결과, 안 물은 근거(`self_answer_attempts` 재사용). 잘못된 self-answer를 사용자가 교정할 수 있어야 한다. 이걸 숨기면 사용자에게 안 보이는 곳에서 의도가 고정되어 pre-mortem 신뢰성이 깨진다.
- **assumptions**: 답을 못 얻어 `hypothesis` 라벨로 남긴 가정(deep-interview §6.3) — 무엇을 근거 없이 가정한 채 진행하는지.

추가 규칙:
- 형식: 사람 읽기용 단순 md(frontmatter 최소).
- **반드시 표기**: 닫힌 항목과 *아직 열린/얕은 항목* 둘 다 → 사용자가 어느 범위가 부실한지 한눈에 보고 교정.
- 산출 시점: 각 단계 종료 직전(사용자 확인 전).

## 7. plan_brief 와 구현 brief hard-gate

### 7.1 plan_brief (변경 범위 = interface 표면)

planner(또는 plan 단계 종료 산출)는 `generated_nodes`에 더해 **plan_brief**를 산출한다. 목적은 사용자가 **변화(무엇이 바뀌나)와 결과(끝나면 무엇이 보장·검증되나)를 구현 전에 예측**하는 것 — 세부 구현 태스크가 아니라 변화·결과의 윤곽이다.

- **interface 표면의 추가/수정/삭제**: HTTP req/resp, 메서드 시그니처, 객체(class/interface)·추상화(상속/계약/유틸리티) 수준, 시스템 구조·흐름.
- 설계 선택 + 고려한 대안(§4.3 산출) + 위험(pre-mortem 승격분).
- **DoD / 완수조건**: 이 plan이 끝났을 때 충족돼야 하는 관찰 가능한 조건. intent AC를 plan 수준에서 구체화하고 각 노드 `acceptance_refs`에 연결(autopilot §2.2 design 노드의 DoD 설계 산출을 사용자-facing으로 노출).
- **테스트 시나리오**: 각 완수조건을 무엇으로 검증하는가 — *시나리오 수준*(어떤 동작·경로를 확인하는가)이지 테스트 코드나 세부 케이스 나열이 아니다.
- 각 항목은 기존 코드 근거(file:line)에 묶인다.

plan_brief는 §4.3 변증법의 검증 대상이자 §7.2 게이트의 본문이다.

### 7.2 brief hard-gate (approval gate 확장)

기존 `approval_gate`(autopilot.json)를 **확장**한다 — 별도 게이트 신설은 아니지만 "재사용"도 아니다(dialectic-review OBJ-6): `approval_gate`에 `plan_brief`(+`change_surface`) 필드를 **신규 추가**하고, `mutationGate`(autopilot-driver.ts:18, 현재 `status`만 검사)가 brief 승인 여부도 읽도록 **로직을 변경**해야 한다.

- implement(mutating) 노드 진입 전, **사용자가 plan_brief를 승인**해야 mutationGate가 열린다. brief 부재 시: 승인 필요인데 brief가 없으면 gate는 `pending`으로 막는다(false-green 방지).
- **소규모 자동승인**: §8.2 경량 판정이 `light`면 brief를 산출·기록하되 자동승인(`not_required`)으로 진행.
- 목적: autopilot이 *건드리면 안 되는 것을 건드리거나 잘못된 방향으로 가는 것*을, 구현 전에 사용자가 변경폭을 보고 차단.

## 8. 분리 유도와 소규모 경량화

### 8.1 과대 범위 → 분리 제안 (자동 분리 금지)

coverage map이 일정 규모·이질성을 넘으면(서로 무관한 다수 범위), 엔진은 **분리를 제안**한다(autopilot §7.2 충돌·광범위 분리 기준). 단 prime directive 준수 — **에이전트가 임의로 split하지 않고**, 사용자 승인 시에만 분리. 미승인 시 단일 work item으로 끝까지.

### 8.2 비용 통제 — 경량화(3등급) + 상한

§2 6축 fan-out은 노드마다 3역 + judge들 + 매 라운드 critic이라 비용이 곱셈으로 큰다(dialectic-review OBJ-4). 두 장치로 통제한다.

**경량화(3등급).** "risk 3축 모두 음성"만으로는 risk 하나라도 양성인 중간 규모가 풀 fan-out에 걸린다. 그래서 규모 기반 3등급:

| 등급 | 조건 | 동작 |
|---|---|---|
| `light` | 변경 파일 소수 ∧ interface 무변경 ∧ risk 3축 음성 | sweep 단일 패스, 범위별 1라운드, 사용자 질문 0~1, brief 자동승인 |
| `standard` | 중간 규모 또는 risk 일부 양성 | sweep 2~3각도, 핵심 범위만 3역·나머지 단일 Opponent 1패스, brief 사용자 승인 |
| `full` | 대규모 ∨ irreversible ∨ non-local | §2~§4 전체 |

**상한.** `caps`에 노드당 LLM 호출 상한·트리 노드 수 상한·총 라운드 상한을 둔다(configurable). 상한 도달은 §5 `cap≠converged` — 멈추되 닫지 않고 escalate.

경량화·상한은 **넓이를 줄이지 않는다** — *깊이*만 줄인다. 모든 노드는 여전히 §3.3으로 닫혀야 하고, 상한 도달 시 미닫힘은 escalate된다.

## 9. 산출물과 스키마 (신규는 additive)

```text
.ditto/local/runs/<wi>/coverage.json        # 신규 — coverage 트리(노드: id·parent_id·label·origin·depth_weight·state·children)
.ditto/local/runs/<wi>/intent-dialog.md     # 신규 — §6
.ditto/local/runs/<wi>/plan-dialog.md       # 신규 — §6
```

기존 확장:
- `interview-state.ts`: `premortem` 승격 항목 추가(deep-interview 계약 §5, 현재 미구현).
- `autopilot.ts`: `plan_brief`(+ `change_surface`) 필드 추가, `approval_gate`가 plan_brief 승인을 포함.
- `dialectic.ts`: 그대로 재사용(범위별 심문 단위).

재사용(신설 금지): `interview-state.ts`의 `dimensions`/`readiness`/`questions`, `dialectic.ts`의 3역 출력, `autopilot.ts`의 `approval_gate`, `opponent-router.ts`, `gates.ts`의 `interviewReadinessGate`/`deterministicFloor`.

## 10. 기존 자산 매핑 (재사용 / 차용 / 신규·확장 — dialectic-review OBJ-2·6 반영)

"재사용"으로 뭉뚱그리면 구현 추정과 TDD 슬라이싱이 거짓 기반 위에 선다. 정직하게 분류한다:

| 본 엔진 요소 | 기존 구현 | 분류 |
|---|---|---|
| 범위별 심문 3역 | `dialectic.ts:53-118` 3역 출력 + `opponent-router.ts` | **재사용** — 그대로 |
| self-answer 노출 | `interview-state.ts:37` `self_answer_attempts` | **재사용** — 필드 그대로 |
| floor 견제 | `gates.ts:35` `deterministicFloor` | **차용** — 공식만 |
| per-node readiness / `depth_weight` 깊이 게이트 | `gates.ts:54` `interviewReadinessGate`(인터뷰 전체 단일) | **신규 + 어댑터** — 함수를 그대로 못 씀; per-node readiness·`depth_weight` 신규, 평면 게이트를 1-dimension 부분 state로 호출 |
| coverage 트리 | (없음) | **신규** — `coverage.json` |
| brief hard-gate | `autopilot.ts:159` `approval_gate` + `autopilot-driver.ts:18` `mutationGate` | **확장** — `plan_brief`/`change_surface` 필드 신규 + mutationGate가 brief 승인 검사하도록 로직 변경 |
| dialog md | (없음) | **신규** — intent/plan-dialog.md |
| 분리 제안 | autopilot 계약 §7.2 | **재사용** — 자동 split 금지 정책 |

## 11. 불변 규칙 요약 (체크리스트)

- [ ] coverage 트리의 모든 노드가 §3.3으로 닫히고 모든 서브트리 확장이 dry여야 종료한다(넓이). "나중에·대충·연기"로 닫지 않는다.
- [ ] coverage 트리는 append-only로 자란다 — derived(답변 파생)·discovered(critic 발굴) 가지도 동등한 의무다. 부모는 서브트리가 dry해야 닫힌다.
- [ ] 범위 제외(`out_of_scope`)는 사용자 명시 승인으로만. 에이전트 임의 축소 금지.
- [ ] 각 변증법 심문 단위는 fresh context다. Manager는 전체 transcript를 심문 에이전트에 주지 않는다.
- [ ] Manager는 내용을 논쟁하지 않고 추적·조율만 한다.
- [ ] 범위마다 3역(정/반/판정) — 단일 에이전트 역할극 금지(dialectic §2 그대로).
- [ ] 사용자 질문은 "사용자만 답할 수 있는 것"만(QuestionGate 통과) + `why_matters` 포함.
- [ ] 깊이는 필요 비례(weight) — 큰 범위가 얕으면 닫지 않는다.
- [ ] 발견 축은 loop-until-dry — K회 연속 새 항목 0까지.
- [ ] 종료 = 넓이 AND 깊이. dry는 admissible-novelty 소진(K=2회 연속 admissible 새 가지 0)으로 판정 — info/low 발굴은 dry 카운터를 막지 않는다(§4.5). cap 도달 ≠ converged. 완벽 추구로 무한 루프 금지.
- [ ] 부모 dimension은 서브트리 dry 전 `resolved`로 투영 금지(false-green 차단, §3.2).
- [ ] 비용 통제: 경량화 3등급(light/standard/full) + 노드당 호출·노드수·라운드 상한(§8.2). 단 넓이는 안 줄인다.
- [ ] readiness/`depth_weight` 게이트와 brief gate는 "재사용"이 아니라 신규+어댑터·확장이다(§10) — 구현 추정·증분 분할에 반영.
- [ ] intent·plan 양 단계 모두 dialog md 산출 — 닫힌 항목과 열린 항목 둘 다 표기.
- [ ] dialog는 사용자 Q&A + QuestionGate self-answer(안 물은 근거 포함) + assumptions를 모두 드러낸다 — 에이전트가 사용자 몰래 고정한 의도까지 투명하게.
- [ ] plan_brief는 interface 변경 범위 + DoD/완수조건 + 테스트 시나리오(시나리오 수준)를 담아 사용자가 변화·결과를 예측하게 하고, implement 전 사용자 승인이 hard 조건(소규모 자동승인).
- [ ] 과대 범위는 분리 *제안*만(사용자 승인 시 분리). 자동 split 금지.
- [ ] 신규 스키마/파일은 additive. 기존 자산 재사용, 신설 최소화.

## 12. 적용 단계와 구현 순서

**구현 범위 결정(2026-06-14, 사용자 승인).** 사용자 최초 요청대로 **plan 단계를 먼저 구현·실증**한다. intent 단계 적용은 같은 공통 엔진의 후속 확장으로 미룬다(엔진 재사용이므로 plan에서 검증되면 저렴). dialectic-review OBJ-8(범위 과대) 완화.

| 단계 | 구현 순서 | 위치 | coverage 트리 | 심문 | 산출 |
|---|---|---|---|---|---|
| **plan** | **1차 (이번)** | autopilot `design`→`review` 사이 | plan-범위(interface·대안·위험) | Dialectic 3역 fan-out | plan-dialog.md, plan_brief → brief gate |
| **intent** | 후속 | autopilot 이전(Deep Interview 게이트) | `dimensions` 투영 | 소크라테스 + 범위별 잔여 | intent-dialog.md, premortem 승격 |

두 단계는 같은 엔진(§2~§6)을 쓰고, 단계별로 coverage 트리의 항목 종류와 심문 owner만 다르다.
