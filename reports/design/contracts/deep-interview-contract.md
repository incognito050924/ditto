---
title: "DITTO Deep Interview Contract (상세 설계)"
kind: design-detail
last_updated: 2026-05-26 KST
status: draft
parent: reports/design/ditto-claude-code-harness-design.md
owns: "§6.3 Deep Interview Contract의 'how' (메커니즘 · 스키마 · 임계치)"
inputs:
  - reports/design/ditto-claude-code-harness-design.md  # §6.1 Intent, §6.2 QuestionGate, §6.3 Deep Interview, §6.6 Dialectic, §6.9 Convergence
  - reports/harnesses/oh-my-codex.md                     # $deep-interview + $ralplan
  - reports/harnesses/mattpocock-skills.md               # grill-with-docs / grill-me
  - reports/harnesses/get-shit-done.md                   # gsd-discuss-phase / gsd-plan-phase
  - reports/harnesses/superpowers.md                     # brainstorming / writing-plans
  - reports/harnesses/ouroboros.md                       # 코드 수준 구현 참조 (모호성 측정 · 이중 게이트 · 온톨로지)
  - src/schemas/common.ts, src/schemas/work-item.ts      # 재사용 스키마 (authoritative)
---

# DITTO Deep Interview Contract (상세 설계)

> **이 문서의 위치.** 이것은 메인 설계문서(`ditto-claude-code-harness-design.md`)의 §6.3을 대체하지 않고 **확장**한다. 메인 문서는 §line 16 철학대로 "무엇(what)"의 자기모순만 닫고 "어떻게(how)"는 열어둔다. 이 문서가 바로 그 열어둔 "how" — Deep Interview의 질문 생성 메커니즘, 모호성 수치화 구조, 종료 게이트, 사이드카 스키마 — 를 소유한다. 이것은 per-contract 상세 문서의 **첫 사례**이자 템플릿이다.

## 0. 권위 규칙 (메인 ↔ 상세 ↔ 스키마)

`ditto-application` 산출물은 세 층위로 나뉘고, 충돌 시 우선순위가 정해져 있다(메인 §3.3의 일반화).

| 층위 | 소유 대상 | 충돌 시 |
|---|---|---|
| 실제 스키마 (`src/schemas/*.ts`, `schemas/*.json`) | 필드명, enum, validation | **최우선.** 본 문서 예시 JSON과 다르면 스키마가 이긴다. |
| 메인 설계문서 §6.x | "what" — 계약의 목적, 진입조건, 산출물, 불변규칙 | "what"이 충돌하면 메인이 이긴다. 본 문서는 메인과 모순되면 안 된다. |
| 본 상세문서 | "how" — 메커니즘, 점수 공식, 임계치 기본값, 사이드카 구조 | "how"의 단일 출처. 메인은 여기로 링크만 한다. |

규칙: 본 문서의 예시 스키마는 **구현 전 반드시** 기존 Zod/JSON 스키마와 맞춘다. 새 사이드카(`interview-state.json`)는 additive이며 `work-item.json` status를 대체하지 않는다.

per-contract 상세 문서 컨벤션 (이 문서로 확립):

- 위치: `reports/design/contracts/<contract-kebab>.md`
- frontmatter에 `parent`, `owns`를 명시한다.
- 메인 §6.x 본문은 "what" 요약 + 본 문서 링크 + 권위 규칙 한 줄만 둔다.
- 나머지 계약은 **필요할 때** 같은 틀로 분리한다(전부 미리 만들지 않는다).

## 1. 목적과 경계

### 1.1 한 문장 정의

Deep Interview는 **계획·현황파악 단계에서, 사용자도 인지하지 못한 의도의 모호성을 변증법적(소크라테스식)·무편향 질문으로 채우고, pre-mortem으로 되돌리기 어려운 위험을 조기에 드러내, 의도를 "검증 가능한 목표"로 좁히는 사전 게이트**다.

핵심 가설(여러 하네스의 공통 투자 근거): **초기 의도 정렬 비용 ≪ 사후 수정 비용.** grill, omx, gsd, superpowers가 모두 실행 전 의도 수집에 비싼 단계를 두는 이유다.

### 1.2 인접 계약과의 경계 (무엇이 Deep Interview가 *아닌가*)

| 계약 | 다루는 것 | Deep Interview와의 차이 |
|---|---|---|
| §6.2 QuestionGate | "이 질문을 해도 되는가" 한 건 단위 검열 | Deep Interview는 QuestionGate를 **호출하는 상위 루프**다. 모든 질문은 QuestionGate를 먼저 통과한다. |
| §6.3 Deep Interview (메인) | 진입조건·산출물·불변규칙(what) | 본 문서가 그 how. |
| §6.6 DialecticDeliberation | **plan/decision/document**를 Producer/Opponent/Synthesizer로 적대 검증 | Deep Interview는 **intent 층위**에서 모호성을 줄인다. 산출(좁혀진 intent + plan 후보)을 §6.6이 **이후에** 적대 검증한다. omx의 `deep-interview`(의도 수집) → `ralplan`(전방위 분석) 분리와 동형. |
| §6.1 IntentContract | `intent.json` / work-item `acceptance_criteria` 권위 상태 | Deep Interview의 **출력 대상**. 인터뷰가 끝나면 IntentContract를 갱신한다. |

**변증법의 두 층위 구분(중요).** Deep Interview의 "변증법"은 §6.6처럼 별도 Opponent 에이전트를 spawn하는 게 아니라, **인터뷰어가 자기 현재 해석을 스스로 반증하는 질문을 생성**하는 *내부* 소크라테스 자세다(§3 참조). 무거운 적대 검증은 plan이 생긴 뒤 §6.6이 맡는다. 둘을 섞으면 intent도 안 정해진 상태에서 plan을 공격하는 strawman이 된다.

## 2. 진입 / 비진입 조건

메인 §6.3 진입조건을 그대로 따르되(아래 a–d), **자동 진입은 advisory**다(메인 §4.2 "자동 activation은 advisory로 시작"). 실제 진입은 보수적으로 한다.

진입(아래 중 하나라도 참):

- (a) 최소 1개의 검증 가능한 acceptance criterion조차 자동 도출할 수 없다.
- (b) 요구가 제품/도메인 의미에 의존한다(용어 미합의 — §6.11 glossary 미존재 포함).
- (c) 구현 방향이 둘 이상이고 결과가 **크게** 갈린다.
- (d) pre-mortem상 되돌리기 어려운 위험(데이터/스키마/외부/보안/production)이 보인다.

비진입(작은 요청을 거대 워크플로로 키우지 않는다 — 메인 §4.1):

- 요청에서 acceptance criterion 1개를 자명하게 도출할 수 있고(메인 §6.1: 작은 작업도 agent가 자동 도출, 사용자에게 안 물음), 방향이 사실상 하나면 **진입하지 않는다.**
- 코드·문서·설정·로그·웹·메모리로 답이 확인되는 사실 질문만 남았다면 진입하지 않고 그냥 조사한다(§6.2).

## 3. 질문 생성 메커니즘 (변증법 · 무편향 · 한 번에 하나)

매 턴 한 개의 질문만 나가지만, 그 한 개를 고르는 과정은 다음 5단계다. 이 절차가 "무편향 전방위"를 보장한다 — 가장 눈에 띄는 모호성에만 앵커링하지 않게 한다.

```text
(1) 후보 전수 생성  : 모든 ambiguity 차원(§4)에서 후보 질문을 만든다. 한 차원만 보지 않는다.
(2) self-answer     : 각 후보를 §6.2 QuestionGate에 통과시킨다. code/docs/repo/web/memory로
                      스스로 답할 수 있으면 후보에서 제거하고 그 근거를 evidence로 남긴다.
(3) 소크라테스 변환 : 남은 후보를 "빈칸 채우기"가 아니라 사용자의 *암묵 가정*을 드러내는
                      형태로 바꾼다. 예: "X라 하셨는데, 그러면 Y가 함의되나요, 아니면 Z를
                      의도하셨나요?" — agent의 현재 해석을 스스로 반증하는 질문을 우선한다.
(4) 정보이득 랭킹   : 후보별로 "이 답이 ambiguity score를 얼마나 떨어뜨리는가 / critical
                      차원을 닫는가"로 정렬한다(info_gain_estimate).
(5) 단일 발사       : 최상위 1개만 묻는다. 질문은 반드시 "답에 따라 무엇이 달라지는지"
                      (why_matters)를 포함한다(메인 §6.3 규칙).
```

무편향 규칙:

- **차원 커버리지**: 한 차원의 질문을 연속으로 발사해 다른 차원을 방치하지 않는다. critical 미해소 차원이 있으면 그 차원의 최고 이득 질문이 우선한다.
- **자기반증 우선**: 자기 해석을 확증하는 질문(confirmation)보다 반증·분기하는 질문을 우선한다. 이것이 §6.6의 Opponent 역할을 intent 층위에서 내부화한 것이다.
- **양자택일 금지의 예외**: "A냐 B냐"는 §6.2에서 금지지만, 제품 가치/도메인 의미 판단이면 허용된다. Deep Interview는 주로 이 예외 영역에서 작동한다.

## 4. 모호성 수치화 (구조 명시)

> ouroboros의 "모호성 수치 측정", omx `$deep-interview`의 ambiguity/readiness score를 차용하되, **임계치는 configurable**로 둔다(메인 §16: 값은 열어둠). 아래는 *구조*를 박는 것이지 최종 공식이 아니다.

### 4.1 차원 (the "전방위")

무편향을 강제하기 위해 모호성을 고정된 차원 집합으로 분해한다. 각 차원은 `critical` 여부를 가지며, critical 차원이 하나라도 미해소면 readiness 게이트를 통과할 수 없다.

| 차원 id | 묻는 것 | critical 기본값 |
|---|---|---|
| `goal_clarity` | 관찰 가능한 결과가 일의적인가 | true |
| `scope_boundary` | in/out of scope가 분명한가 | true |
| `acceptance_testability` | 검증 가능한 acceptance criterion을 쓸 수 있는가 | true |
| `domain_semantics` | 프로젝트/도메인 용어가 합의됐는가(§6.11) | false |
| `constraints` | 기술/성능/보안/호환 제약을 아는가 | false |
| `integration_surface` | 외부 시스템·데이터·크리덴셜을 아는가 | false |
| `risk_reversibility` | 되돌리기 어려운·blast radius 큰 행위를 식별했는가(§5 pre-mortem) | true |

차원 집합은 v0 고정이다. 새 차원 추가는 본 문서 개정으로만 한다(drift 방지).

### 4.2 점수와 readiness 게이트

- 각 차원은 `ambiguity ∈ [0,1]`을 가진다(0 = 완전 해소, 1 = 완전 모호). 또는 ordinal `unknown|partial|resolved`로 두고 매핑해도 된다(`resolved=0`, `partial=0.5`, `unknown=1`).
- `readiness.score`(예시 공식, 구현에서 교체 가능): `1 - (Σ wᵢ · ambiguityᵢ / Σ wᵢ)`. critical 차원에 더 큰 가중치 `wᵢ`를 준다.
- **게이트(쌍대 정의 — §6.9 Convergence와 동형):**
  - `ready` ⟺ **모든 critical 차원이 `resolved`** AND `readiness.score ≥ threshold`.
  - 둘 다여야 한다. 질문을 적게 했다는 이유로 조기 종료(early convergence)하지 않고, score가 높아도 critical 미해소면 종료하지 않는다.
- `threshold` 기본값은 configurable(예: 0.85). 본 문서는 기본값만 제안하고 강제하지 않는다.

### 4.3 종료 조건 (cap ≠ converged)

종료는 항상 명시적 `exit.reason`을 남긴다. 조용한 종료 금지(메인 §6.8).

| exit.reason | 의미 | 후속 |
|---|---|---|
| `readiness_met` | 게이트 통과 | intent 확정 → work item `draft → in_progress` 가능(메인 §5.5) |
| `diminishing_returns` | 남은 후보 최고 info_gain이 ε 미만 | 남은 모호성을 **assumption**(label=`hypothesis`, §6.9 정직 라벨)으로 기록하고 진행 |
| `user_deferred` | 사용자가 "그냥 진행" | assumption 기록 + acted-confidence 낮춤 + 진행 |
| `user_owned_decision` | critical 차원이 사용자만 답할 수 있는 결정에 막힘 | work item `blocked` + §5.4 plan approval gate에서 함께 제시 |
| `cap_reached` | 질문 상한 도달했으나 게이트 미통과 | **converged 아님.** non-pass로 닫고 handoff 또는 assumption 진행. `cap_reached ≠ ready`(§6.9). |

`question_cap`은 안전 정지이지 성공 조건이 아니다. 캡 도달이 곧 "충분히 물었다"가 아니다.

## 5. Pre-mortem (조기 위험 발견)

pre-mortem은 `risk_reversibility` 차원을 닫는 메커니즘이다.

절차:

1. **가정 전제**: "이 작업이 출시/적용되었고 *실패하거나 피해를 냈다*고 가정한다. 어떤 원인들이 그럴듯한가?"를 전방위로 열거한다(낙관 편향 차단).
2. 각 항목을 구조화한다(아래).
3. **승격 규칙**: `reversibility=irreversible` 또는 `blast_radius≥high`인 항목은 반드시 셋 중 하나가 된다 — (a) 새 acceptance criterion, (b) `out_of_scope` + 근거, (c) `user_owned_decision` 질문. 그냥 기록만 하고 넘어갈 수 없다.

premortem 항목 구조(`premortem.md` + critical 항목은 사이드카로 미러):

```json
{
  "scenario": "마이그레이션이 기존 컬럼을 덮어써 데이터 유실",
  "likelihood": "low|medium|high",
  "blast_radius": "low|medium|high|critical",
  "reversibility": "reversible|hard|irreversible",
  "early_signal": "무엇을 보면 이 위험이 현실화 중인지",
  "promoted_to": "ac|out_of_scope|user_owned_decision|none",
  "ref": "AC-3 | intent.out_of_scope[1] | Q-5"
}
```

## 6. 산출물과 스키마

### 6.1 파일 (메인 §6.3 경로 유지 + 사이드카 1개 추가)

```text
.ditto/work-items/<id>/interview.md          # 사람이 읽는 인터뷰 로그 (메인 §6.3)
.ditto/work-items/<id>/premortem.md          # pre-mortem 결과 (메인 §6.3)
.ditto/work-items/<id>/interview-state.json  # 신규 additive 사이드카 (본 문서 소유)
```

`interview-state.json`은 work item status를 대체하지 않는다. 인터뷰는 work item이 `draft`인 동안 진행되고, `readiness_met` 시 IntentContract(`intent.json` + work-item `acceptance_criteria`)를 갱신한 뒤 status 전이를 가능하게 한다.

### 6.2 `interview-state.json` (예시 — 구현 전 Zod/JSON 스키마와 정합)

재사용: `schema_version`(`0.1.0`), `work_item_id`(`wi_…`), `evidenceRef`(`kind: command|file|artifact|url|note`)는 `src/schemas/common.ts`를 그대로 쓴다. 새 enum/필드만 신설한다.

```json
{
  "schema_version": "0.1.0",
  "work_item_id": "wi_example1234",
  "status": "active|converged|deferred|aborted",
  "started_at": "2026-05-26T00:00:00.000Z",
  "updated_at": "2026-05-26T00:00:00.000Z",
  "dimensions": [
    {
      "id": "acceptance_testability",
      "critical": true,
      "state": "unknown|partial|resolved",
      "ambiguity": 0.5,
      "resolved_by": ["Q-3"],
      "notes": ""
    }
  ],
  "readiness": {
    "score": 0.62,
    "threshold": 0.85,
    "critical_unresolved": ["acceptance_testability"],
    "gate": "blocked|ready"
  },
  "questions": [
    {
      "id": "Q-1",
      "asked_at": "2026-05-26T00:00:00.000Z",
      "dimension": "scope_boundary",
      "question": "...",
      "why_matters": "답에 따라 무엇이 달라지는가",
      "info_gain_estimate": "high|medium|low",
      "self_answer_attempts": [
        { "source": "code|docs|repo-artifact|web|memory", "result": "근거 또는 실패 이유" }
      ],
      "answer": "...",
      "answer_kind": "user|assumption",
      "ambiguity_delta": -0.3
    }
  ],
  "assumptions": [
    {
      "statement": "기본 정렬은 최신순으로 가정",
      "label": "hypothesis",
      "confidence": "low",
      "because_no_answer_to": "Q-5"
    }
  ],
  "exit": {
    "reason": "readiness_met|diminishing_returns|user_deferred|user_owned_decision|cap_reached",
    "question_cap": 7,
    "questions_asked": 4
  }
}
```

### 6.3 인터뷰 종료 시 IntentContract 갱신 (메인 §6.1)

- 해소된 차원은 `intent.json`의 `in_scope`/`out_of_scope`/`acceptance_criteria`로 반영한다.
- premortem 승격 항목은 AC 또는 `out_of_scope` + `follow_up_candidates`로 들어간다.
- `assumptions`는 `intent.json`에 명시적으로 남기고, 그에 의존한 후속 결정은 `hypothesis` 라벨을 유지한다(백킹 없는 주장은 `finding`이 아니다 — §6.9).
- 사용자에게는 **짧게 동기화**한다(메인 §6.3): 좁혀진 goal, 추가/제외된 scope, 남은 가정, 막힌 user-owned decision.

## 7. 불변 규칙 요약 (체크리스트)

- [ ] 모든 질문은 §6.2 QuestionGate self-answer를 먼저 통과한다.
- [ ] 한 턴에 한 질문. 단, 후보는 전 차원에서 생성한다(앵커링 금지).
- [ ] 각 질문은 `why_matters`를 포함한다.
- [ ] critical 차원이 하나라도 미해소면 `ready`가 될 수 없다.
- [ ] readiness는 score AND critical-resolved의 교집합으로만 정의된다(early-converge/treadmill 동시 차단).
- [ ] `cap_reached`는 성공이 아니다. non-pass로 닫고 assumption/handoff.
- [ ] irreversible/high-blast pre-mortem 항목은 AC/out_of_scope/user-owned 중 하나로 승격된다.
- [ ] 종료는 항상 명시적 `exit.reason`을 남긴다. 조용한 종료 금지.
- [ ] 산출은 IntentContract를 갱신하고 사용자에게 짧게 동기화한다.
- [ ] plan 층위 적대 검증은 Deep Interview가 아니라 §6.6 Dialectic이 한다.

## 8. 참조 하네스 매핑 (무엇을 어디서 차용했는가)

| 차용 요소 | 출처 | 본 설계 반영 |
|---|---|---|
| 한 번에 하나, 코드로 답 가능하면 먼저 조사 | grill-with-docs / grill-me (`mattpocock-skills.md:126`) | §3 (2) self-answer, (5) 단일 발사 |
| 용어 해소 즉시 영속화 | grill-with-docs `CONTEXT.md` (`mattpocock-skills.md:127`) | §4.1 `domain_semantics` → §6.11 glossary |
| ambiguity/readiness score + 산출물 | omx `$deep-interview` (`oh-my-codex.md:145,188`) | §4 수치화, §6.2 사이드카 |
| 의도수집과 전방위 분석의 분리 | omx `deep-interview` → `ralplan` | §1.2 Deep Interview(intent) vs §6.6 Dialectic(plan) |
| 모호성 수치 측정 + 질문 방식 | ouroboros → `reports/harnesses/ouroboros.md` | §4.2 게이트 구조, §3 소크라테스 변환 (§9에서 코드 수준 반영) |
| 논의→계획 게이트 분리 | gsd `discuss-phase`/`plan-phase` (`get-shit-done.md:82,83`) | §4.3 종료 → 메인 §5.4 plan approval |
| 구현 전 설계 승인 게이트 | superpowers `brainstorming` (`superpowers.md:53`) | §2 진입조건, §6.3 IntentContract 확정 후 전이 |

## 9. 구현 참조 — ouroboros (코드 수준)

> 전체 분석·근거: [`reports/harnesses/ouroboros.md`](../../harnesses/ouroboros.md) (기준 커밋 `d47b1431`). 아래는 본 계약 구현 시 직접 차용할 메커니즘만 추린 것이다. 다른 계약(§6.2 QuestionGate, §6.6 Dialectic, §6.9 Convergence, §6.11 Knowledge)도 같은 보고서를 참조한다.

| 본 계약 요소 | ouroboros 레퍼런스 구현 | 근거 |
|---|---|---|
| §4.2 모호성 점수가 모델 자기보고를 못 넘게 | `deterministic_floor(ledger)` = `0.05·열린섹션 + 0.10·CONFLICTING + 0.05·assumption비율`, 그리고 `max(llm_score, floor)` 채택 | `grading.py:401-425`, `pipeline.py:642-651` |
| §4.2 readiness 쌍대 게이트 | 인터뷰는 **backend(semantic) ∧ ledger(structural)** 동의 시에만 종료. 한쪽만 done이면 다음 답변으로 재구성 | `interview_driver.py:204-227` |
| §4.3 cap ≠ converged + 명시적 종료 | max_rounds 후 `mutual_agreement / ledger_only / safe_default / blocked`로 분기, unsafe gap은 차단 + 롤백 | `interview_driver.py:339-555`, `state.py:378-379` |
| §4.1 차원의 검증가능성 기계 판정 | `VAGUE_TERMS`(easy/robust/...) + `_OBSERVABLE_HINTS`/정규식으로 acceptance criterion의 vague·untestable 결정론 검출 | `grading.py:23-57, 352-376` |
| §6.2 dimension에 provenance 추가 | ledger 엔트리는 source(user/repo/inference/assumption)×status(confirmed/weak/conflicting) 타입. evidence-backed vs assumption_only 분리 = §6.9 finding vs hypothesis | `ledger.py:11-103` |
| §5 pre-mortem 승격 → 자동 차단 | high-risk 용어(credential/production/payment/...) 가진 활성 assumption은 blocker로 승격 | `grading.py:428-438` |
| §4.1 `goal`은 critical·user-only | `goal` gap은 자동 기본값 불가 → 즉시 blocker(반드시 사용자) | `interview_driver.py:597-604` |
| §3 무편향 breadth control | 시작 시 ambiguity 트랙 추론·유지, 여러 deliverable 별도 트랙, 주기적 breadth check, 한 주제 지배 시 zoom-out | `agents/socratic-interviewer.md:39-49` |
| §3 소크라테스 변환 + self-answer | brownfield `[from-code]/[from-user]/[from-research]` prefix, "What exists?" 대신 "Why?/What should change?" | `agents/socratic-interviewer.md:23-37` |

DITTO 적용 시 주의(보고서 §"약한 점"): 결정론 검사(정규식·상수·floor)를 1차 게이트로 두고 LLM ambiguity 자기보고는 2차로 제한한다. 필수 차원 전부를 작은 요청에까지 hard-gate하지 않는다(critical만 hard-gate, 나머지 safe-default) — 메인 §4.1과의 충돌을 피한다.
