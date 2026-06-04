---
title: "ACG Methodology — Change Lifecycle"
kind: methodology
last_updated: 2026-06-04 KST
status: draft
scope: "ACG의 코딩 방법론 축. 한 변경이 지나는 8단계 lifecycle을, 각 단계의 입력·산출물·게이트·실패 처리로 명세한다."
parent: 00-framework.md
---

# ACG Methodology — Change Lifecycle

> **이 문서의 위치.** [00-framework.md](00-framework.md)가 "왜·무엇"이라면, 이 문서는 "어떻게"다. ACG의 다섯 그래프와 차용 기법을, 한 변경이 실제로 지나는 **8단계 작업 루프**로 내린다. 각 단계는 입력 / 산출물 / 게이트 / 실패 처리를 갖는다. 이 방법론은 DITTO의 Agent Behavior Charter §3 기본 작업 루프(의도→조사→성공기준→계획→실행→검증→보고)를 변경 거버넌스 관점에서 구체화한 것이다.

## 0. 방법론의 형태

ACG 방법론은 워터폴이 아니라 **게이트 있는 루프**다. 각 단계는 다음 단계로 넘어가기 위한 게이트(통과 조건)를 갖고, 게이트 실패는 단계를 되돌리거나 사람에게 올린다. 핵심 규칙 셋:

- **G1 — 산출물 없으면 통과 없음.** 각 단계는 명시된 산출물을 남겨야 다음 단계로 간다. "머릿속에서 했다"는 통과가 아니다.
- **G2 — 게이트는 증거로 판정.** 게이트 통과는 주장이 아니라 증거(테스트·diff·그래프·로그)로 판정한다. Charter §4-5와 동일.
- **G3 — 축소는 드러낸다.** 단계를 건너뛰거나 범위를 줄이면 그 사실과 이유를 산출물에 남긴다. 조용한 축소 금지(Charter §4-6).

## 1. 단계 개요

```text
                 ┌─────────────────────────────────────────────────┐
                 │  한 변경(change)의 생애 — 1~7은 이 변경 안에서 닫힘  │
                 └─────────────────────────────────────────────────┘
 1 Intake    요청            → work item + Intent
 2 Contract  Intent          → ChangeContract           [DSL 컴파일 지점]
 3 Graph     ChangeContract  → Architecture·Impact Graph
 4 Plan      Graph           → migration plan
 5 Apply     plan            → diff
 6 Validate  diff            → 테스트·타입·boundary·semantic 결과
 7 Review    검증결과         → Review Graph → Change Map  [사람은 exception만]
                 ┌─────────────────────────────────────────────────┐
                 │  8은 코드베이스 전체로 — 변경을 가로질러 살아남음     │
                 └─────────────────────────────────────────────────┘
 8 Assure    불변식          → FitnessFunction 등록 → Assurance Graph 지속 평가
```

## 2. 단계별 명세

### 단계 1 — Intake

| | |
|---|---|
| 입력 | 사용자 요청(자연어) |
| 산출물 | work item, Intent(목적·acceptance 초안) |
| 게이트 | **의도가 검증 가능한 목표로 환원되는가.** acceptance를 쓸 수 없으면 통과 불가 |
| 실패 처리 | acceptance를 쓸 수 없으면 `deep-interview`로 모호성 해소(Charter §4-2). 사용자만 답할 수 있는 가치/도메인 질문만 올린다 |

요청을 "더 많은 코드"가 아니라 "보존해야 할 결과"로 다시 읽는다. DITTO의 `IntentContract`/work item을 그대로 쓴다 — ACG는 여기에 새 산출물을 추가하지 않는다.

### 단계 2 — Contract

| | |
|---|---|
| 입력 | Intent |
| 산출물 | `ChangeContract` (목적·allowed_scope·forbidden_scope·invariants·acceptance·decision_ref) |
| 게이트 | **허용 범위와 금지 범위가 모두 명시됐는가.** forbidden_scope가 비면 통과 불가(빈 금지 = 무제한 변경). risk가 medium 이상이면 `decision_ref` 필수 |
| 실패 처리 | 범위가 불명확하면 단계 3의 Architecture Graph를 먼저 참조해 경계를 추론하고, 여전히 가치 판단이 필요하면 사용자 확인 |

핵심 단계다. Design by Contract를 변경에 적용한다: `allowed_scope`는 변경의 사전조건(pre), `invariants`는 변경 후에도 유지돼야 할 불변식(post), `forbidden_scope`는 절대 흔들리면 안 되는 영역(invariant). 

여기가 **DSL 컴파일 지점**이다. 사용자/agent가 의도를 [30-intent-change-dsl.md](30-intent-change-dsl.md)의 DSL로 선언하면, 해석기가 ChangeContract로 컴파일한다. DSL을 쓰지 않으면 ChangeContract를 직접 작성한다 — 산출물은 같다.

> **boxwood 예시.** "automation-engine의 BPMN 런타임 재시도 정책을 바꾼다"는 의도는 allowed_scope={runtime 서브모듈, 관련 테스트}, forbidden_scope={kafka 어댑터, external-client 계약, public REST 표면}, invariant={tenant 격리 유지}로 컴파일된다.

### 단계 3 — Graph

| | |
|---|---|
| 입력 | ChangeContract |
| 산출물 | `ArchitectureSpec`(또는 기존 것 로드), `ImpactGraph` |
| 게이트 | **정적으로 해소 가능한 direct caller 누락 0건 ∧ 정적 해소 불가분은 `ImpactGraph.unresolved`에 전수 표기.** exported/public symbol이면 external surface 표시 필수. **사용자 노출 변경(프론트 route/component·UI 소비 endpoint·사용자 가시 카피/상태·screen/e2e acceptance)은 `journey_id` 매핑 또는 `unresolved: journey_unknown` 필수**(없으면 통과 불가 — OBJ-15/17) |
| 실패 처리 | 정적으로 해소 안 되는 영향(동적 디스패치, 문자열 기반 호출, config 주도, cross-repo, **미상 여정**)은 `ImpactGraph.unresolved`에 남기고 숨기지 않는다 |

> **게이트의 측정 가능성.** "누락 0건"은 *정적으로 결정 가능한* 호출(심볼 해석·타입·export 그래프로 잡히는 것)에만 적용된다. 동적/config/cross-repo 영향은 본질적으로 정적 oracle이 없으므로 "0건"을 주장하지 않는다 — 대신 `unresolved`에 전수 기록하고 단계 7에서 사람에게 올린다. 즉 게이트는 "정적으로 잡히는 것은 다 잡았는가 + 못 잡는 것은 다 드러냈는가"로 측정되며, 이것이 [00](00-framework.md) §8의 missed-impact(사후 발견) 지표와 직결된다.

Impact Analysis를 한다(아이디어 베이스 Pattern 2). 텍스트 검색이 아니라 심볼 해석 → 호출 그래프 → 타입/export 그래프 → 테스트/문서 표면 순으로 affected node를 분류한다. ArchitectureSpec은 저장소별 knowledge로 한 번 만들어 재사용한다(매 변경 재작성 아님).

> **provider는 바인딩이 꽂는다([00](00-framework.md) stack-agnostic 노트).** 단계 3·6의 게이트가 소비하는 *분석기*(영향 분석=심볼/호출 그래프, 경계 검사, deterministic evaluator §3.1)는 스펙이 결과 형식(`ImpactGraph`·boundary 위반 목록)만 정하고, 실제 도구는 **바인딩이 제공**한다. 언어마다 다르기 때문이다 — DITTO(TS)는 TS 도구, boxwood(Java/Kotlin)는 그쪽 도구. 그래서 "어느 분석기로 caller 누락 0을 계산하는가"는 방법론이 아니라 바인딩의 책임이며, 바인딩이 provider를 못 꽂은 차원은 `unresolved`로 남는다.

### 단계 4 — Plan

| | |
|---|---|
| 입력 | ImpactGraph, ArchitectureSpec, ChangeContract |
| 산출물 | migration plan (변경 대상 × 순서 × 검증 방법 × 새 모듈/인터페이스 설계 근거) |
| 게이트 | **plan의 모든 항목이 affected node를 덮는가, forbidden_scope를 건드리지 않는가, 새 모듈/API를 도입한다면 [40](40-refactoring-criteria.md) §3 Deep Module Gate의 선행 설계 질문을 답했는가** |
| 실패 처리 | plan이 forbidden_scope를 건드려야만 완성된다면 → ChangeContract가 틀렸다는 신호. 단계 2로 되돌려 사용자에게 의도 차원 확인 |

계획은 작업 목록이 아니라 검증 가능한 목표 목록이다(Charter §5-2). 위험이 큰 항목은 되돌리기 방법을 포함한다. 새 abstraction을 만들 계획이라면 plan은 "어떤 파일을 만들 것인가"가 아니라 "호출자 표면이 어떻게 줄고, 파라미터가 어떻게 단순해지며, 어떤 내부 복잡도가 숨겨지는가"를 포함해야 한다.

### 단계 5 — Apply

| | |
|---|---|
| 입력 | migration plan (단계 4 생략 시 `ChangeContract`의 allowed/forbidden_scope) |
| 산출물 | diff |
| 게이트 | **수정한 모든 줄이 plan의 항목으로 설명되는가** (Charter §4-4) |
| 실패 처리 | 계획에 없던 변경이 필요해지면(예: 예상 못 한 의존) plan을 갱신하고 그 이유를 남긴다. 임시 우회인지 구조적 해결인지 구분한다(Charter §5-3) |

구조적 변경(Tidy First)과 동작적 변경을 같은 커밋에 섞지 않는다(전역 CLAUDE.md). 리팩토링이 필요하거나 기능 추가 중 새 모듈·인터페이스를 도입한다면 [40-refactoring-criteria.md](40-refactoring-criteria.md)의 기준을 통과해야 한다.

### 단계 6 — Validate

| | |
|---|---|
| 입력 | diff, ChangeContract, ImpactGraph |
| 산출물 | 검증 결과 5종: 테스트·타입체크·boundary validation·semantic compatibility·**product validation(실행/여정)** |
| 게이트 | **테스트/타입 통과 + boundary 위반 0 + semantic 변경이 의도된 것 + ImpactGraph에 `ui_surface`/`user_journey`가 있으면 `JourneyRun`(e2e) 실행 증거로 닫힘 + `journey_unknown`이 있으면 사람 판단으로 해소** |
| 실패 처리 | semantic 변경이 의도치 않은 것이면 → 의미 회귀. 단계 5로 되돌린다. behavior test가 없어 검증 못 하면 characterization test 후보를 `SemanticCompatibility`에 남기고 "미검증"으로 표시. 제품 검증을 못 했으면(실행 환경 없음 등) "미검증 제품 영향"으로 명시. `journey_unknown`은 사람이 여정 매핑을 확정하거나 명시적으로 "여정 영향 없음"을 판정해야 닫힌다 |

여기서 "테스트 통과 = 완료"의 함정을 깬다. 다섯 검증은 독립적이다:
- **테스트·타입**: 기존 도구.
- **boundary validation**: diff가 ArchitectureSpec의 의존 규칙을 어겼는가(Dependency Rule).
- **semantic compatibility**: 타입은 맞지만 도메인 의미가 보존됐는가([20](20-contracts.md) §SemanticCompatibility). `User|null → User` 류의 변경을 잡는다.
- **product validation**: agent는 코드를 볼 뿐 제품을 못 본다([00](00-framework.md) §1.1(2)). ImpactGraph가 `ui_surface`/`user_journey`를 가리키면, 단위 테스트 통과가 아니라 **실행 증거**(screen·e2e 사용자 여정, DITTO `e2e` 스킬의 `e2eJourney` 산출물)로 닫는다. "코드는 맞지만 제품이 틀린" 변경을 여기서 잡는다. 단 이것은 결과 검증이지 agent의 제품 이해를 만들지는 못한다([00](00-framework.md) §9 열린질문 8).

### 단계 7 — Review

| | |
|---|---|
| 입력 | 검증 결과, diff |
| 산출물 | `ReviewGraph`(위험도 분류), `Change Map`(사람용 표기) |
| 게이트 | **모든 high-risk 항목에 evidence 또는 explicit unresolved marker가 있는가.** risk reason 없는 분류는 무효 |
| 실패 처리 | high-risk가 미해소면 CompletionContract를 pass로 닫지 않는다(아이디어 베이스 Pattern 5) |

Review by Exception이다. agent가 변경을 위험도로 분류하고, 사람은 전체 diff가 아니라 [50-change-map.md](50-change-map.md)의 exception만 본다. public API·migration·auth·payment·data deletion은 기본 high-risk.

> **완료 게이트 연결은 바인딩 결정([00](00-framework.md) §9 Q6).** "high-risk 미해소가 완료를 막는다"는 스펙이 요구하는 *성질*이고, 그것을 어디에 배선하는지는 바인딩이 정한다. **DITTO 바인딩(목표 상태)**: 별도 gate 없이 `ReviewGraph`의 high-risk/unresolved 집계를 `CompletionContract`가 소비하는 슬롯으로 잇고, Stop 훅이 그 ledger를 읽어 미해소 시 continuation을 강제하도록 한다. 현재 Stop 훅·CompletionContract에는 그 슬롯이 없으므로 이 배선은 **v0 작업**이다(아직 도는 동작이 아님).

### 단계 8 — Assure

| | |
|---|---|
| 입력 | ChangeContract.invariants, ArchitectureSpec |
| 산출물 | `FitnessFunction` 등록, Assurance Graph 갱신 |
| 게이트 | **이 변경이 도입한 불변식이 영속 적합성 함수로 승격됐는가** (승격 대상인 경우) |
| 실패 처리 | 적합성 함수로 표현 불가능한 불변식은 "수동 검토 항목"으로 knowledge에 남긴다 |

이 단계가 ACG를 단발 거버넌스와 가른다. 1~7이 *이 변경*을 정당화했다면, 8은 그 정당성을 *미래의 모든 변경*에 강제할 수 있는 형태로 고정한다. 변경의 불변식 중 일반화 가능한 것(예: "백엔드 모듈의 SB 버전은 단일", "core는 cli를 의존하지 않는다")을 적합성 함수로 승격하면, 이후 그 성질을 깨는 어떤 변경도 단계 6에서 잡힌다.

모든 불변식이 승격 대상은 아니다. 이 변경에만 국한된 불변식은 ChangeContract와 함께 닫히고, 코드베이스 전역 성질만 Assurance Graph로 올라간다.

**SLOP 증식의 추세 추적([00](00-framework.md) §1.1(3)).** 단계 8은 불변식 승격만 하는 게 아니라, `duplication`·`complexity` kind의 적합성 함수를 통해 *증식*을 시계열로 감시한다. 한 변경이 만든 SLOP은 개별로는 게이트를 통과할 수 있지만, 다음 agent가 그것을 맥락으로 모방하면 중복·복잡도가 변경을 가로질러 누적된다. 단계 8이 매 변경마다 그 추세(`AssuranceSnapshot`의 `violations` 시계열)를 갱신하므로, "서서히 감당 불가가 되는" 증식이 기울기로 드러난다 — 단발 검증으로는 절대 보이지 않는 것이다.

## 3. 단계와 그래프·기법의 매핑

| 단계 | 주로 다루는 그래프 | 차용 기법 |
|---|---|---|
| 1 Intake | Intent | — |
| 2 Contract | Intent | Design by Contract |
| 3 Graph | Architecture, Impact | Dependency Rule |
| 4 Plan | Impact | — |
| 5 Apply | — | Tidy First, Deep Module |
| 6 Validate | Architecture | Characterization Test, Dependency Rule |
| 7 Review | Review | Review by Exception |
| 8 Assure | Assurance | Fitness Function |

## 4. 단계 생략 규칙

방법론은 무겁다. 모든 변경에 8단계 전부를 강제하면 비용이 가치를 넘는다. 생략은 허용하되 **명시적으로** 한다(G3).

| 변경 유형 | 최소 단계 | 생략 가능 | 근거 |
|---|---|---|---|
| 오타·주석·포맷 | 1, 5 | 2,3,4,6,7,8 | 의미·구조 영향 없음. 단 forbidden_scope 확인은 유지 |
| 단일 함수 내부 버그픽스 | 1,2,5,6 | 3,4,7,8 | 영향 국소적. behavior test로 충분 |
| public surface 변경 | **전체** | 없음 | 외부 전파·의미 호환성·지속 적합성 모두 위험 |
| 마이그레이션·스키마 | **전체** | 없음 | 기본 high-risk(boxwood Flyway 사례) |
| 리팩토링(동작 보존) | 1,**2(얇게)**,5,6,8 | 3,4,7 | [40](40-refactoring-criteria.md) G-R3가 `ChangeContract.allowed_scope`를 소비하므로 단계 2는 scope만 담아 유지. 영향/계획(3,4)은 동작 보존이라 국소, 의미 보존 게이트가 흡수 |

생략한 단계는 work item 산출물에 "단계 N 생략: 사유"로 1줄 남긴다.

## 5. 실패와 인수인계

어떤 단계에서 막히든, 다음 agent가 이어받을 수 있도록 상태를 남긴다(Charter §11). 막힌 단계, 그때까지의 산출물, 미해소 항목을 DITTO `handoff`로 기록한다. ACG는 별도 인수 메커니즘을 만들지 않고 기존 handoff를 쓴다.

## 6. 다음 문서

- 각 단계가 만드는 산출물의 스키마 → [20-contracts.md](20-contracts.md)
- 단계 2의 의도 선언 문법 → [30-intent-change-dsl.md](30-intent-change-dsl.md)
- 단계 4·5·6의 모듈 설계/리팩토링 게이트 → [40-refactoring-criteria.md](40-refactoring-criteria.md)
- 단계 7의 사람용 표기 → [50-change-map.md](50-change-map.md)
