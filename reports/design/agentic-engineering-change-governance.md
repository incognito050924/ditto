---
title: "Agentic Engineering Change Governance"
kind: concept
last_updated: 2026-06-03 KST
status: draft
scope: "Agentic coding의 병목을 change governance 문제로 보고, DITTO에서 구체화할 설계 패턴과 산출물 후보를 정리한다."
inputs:
  - https://chatgpt.com/share/6a1fc271-ac24-83e8-ab61-9b1eb2bcbe8e
  - PURPOSE.md
  - AGENTS.md
  - reports/design/ditto-claude-code-harness-design.md
  - reports/design/ditto-v0-implementation-plan.md
---

# Agentic Engineering Change Governance

> **문서의 위치.** 이 문서는 구현 계획이 아니라 아이디어 베이스다. 목적은 agentic coding의 반복적인 실패 양상을 하나의 설계 언어로 묶고, DITTO가 이후 어떤 계약, 그래프, 게이트, 리뷰 표면을 만들어야 하는지 정리하는 것이다. 구체적인 스키마와 런타임 단계는 후속 contract 문서에서 분리한다.

> **승격됨.** 이 아이디어 베이스는 공학적 프레임워크 **ACG — Agentic Change Governance**로 발전했다. 검증된 SW 공학 기법(Design by Contract·Fitness Function·Characterization Test·Deep Module·Dependency Rule)에 뿌리내린 방법론·스키마·DSL·리팩토링 기준·의사소통 표기를 보려면 [agentic-governance/00-framework.md](agentic-governance/00-framework.md)를 참조한다. 이 문서는 그 토대가 된 문제 정의로 보존한다.

> **핵심 가설.** Agentic coding의 병목은 코드 생성 능력 자체보다 **변경 통제(Change Governance)** 에 가깝다. 모델은 코드를 만들 수 있지만, 무엇을 바꿔도 되는지, 무엇을 절대 건드리면 안 되는지, 변경이 어디까지 전파되는지, 기존 의도가 보존됐는지를 안정적으로 소유하지 못한다.

## 0. 배경

기존 소프트웨어 개발에서는 여러 책임이 분리되어 있었다.

| 책임 | 기존 역할 | Agentic coding에서의 붕괴 |
|---|---|---|
| 변경 수행 | 개발자 | agent가 수행 |
| 영향 범위 확인 | 개발자 + 리뷰어 | agent가 일부 검색으로 대체 |
| 설계 일관성 확인 | 아키텍트 + 시니어 | agent의 패턴 복제에 의존 |
| 동작 검증 | QA + 테스트 | agent의 자기보고로 축소되기 쉬움 |
| 완료 판단 | 팀의 acceptance | agent의 최종 응답으로 압축 |

문제는 agent 하나가 이 모든 책임을 동시에 맡으면서도, 각 책임 사이의 계약과 검증 경계가 약하다는 점이다.

따라서 DITTO가 다뤄야 할 질문은 "어떻게 더 많은 코드를 생성할 것인가"가 아니다.

DITTO가 다뤄야 할 질문은 다음에 가깝다.

- 무엇이 사용자의 원래 의도인가?
- 어떤 범위는 변경 가능하고, 어떤 범위는 변경 금지인가?
- 특정 API 변경이 어디까지 전파되는가?
- 타입은 맞지만 비즈니스 의미가 깨진 변경을 어떻게 찾을 것인가?
- 사람이 모든 diff를 보지 않고도 고위험 변경만 판단하게 할 수 있는가?
- 시니어 개발자의 패턴 선택 기준을 agent가 참조 가능한 형태로 남길 수 있는가?

## 1. 문제 정의

### 1.1 의도하지 않은 변경

Agent는 요청을 해결하는 과정에서 주변 코드, 이름, 구조, 흐름을 임의로 고친다. 컴파일과 테스트가 통과해도, 사용자가 허용하지 않은 변경이면 실패다.

대표 실패:

- 요청과 직접 관련 없는 public API rename
- 기존 흐름을 새 helper나 V2 함수로 우회
- 호출자는 고쳤지만 기존 domain decision을 바꿈
- dead code처럼 보이는 fallback 제거
- 테스트 통과를 위해 acceptance를 축소

### 1.2 API 영향 범위 판단 실패

Agent는 보통 텍스트 검색 기반으로 호출자를 찾고 수정한다. 하지만 API 변경의 영향은 단순 호출자 목록보다 넓다.

영향 범위에는 다음이 포함된다.

- direct callers
- callers of callers
- interface and type contract
- generated clients
- tests and fixtures
- documentation and examples
- external consumers
- business assumptions encoded around the old API

### 1.3 의미 호환성 실패

타입 호환성과 의미 호환성은 다르다.

예를 들어 `User | null`을 `User`로 바꾸면 TypeScript 관점에서는 null check 제거가 자연스러워 보일 수 있다. 하지만 도메인에서는 "존재하지 않는 사용자"라는 상태 자체가 중요했을 수 있다.

이 경우 agent가 사용처를 전부 새 타입에 맞춰 고쳐도, 실제로는 기존 API의 의도를 파괴한 것이다.

### 1.4 사람 리뷰의 붕괴

Agent는 짧은 시간에 많은 파일을 수정한다. 사람이 모든 diff를 따라가며 의도, 맥락, 영향, 품질을 검토하는 것은 비용이 너무 크다.

리뷰 병목은 단순히 "diff가 많다"가 아니다.

- 어떤 변경이 위험한지 먼저 분류되어 있지 않다.
- 변경 이유와 acceptance가 diff에 붙어 있지 않다.
- public surface 변경과 내부 구현 변경이 섞인다.
- 테스트 통과와 의도 보존이 구분되지 않는다.
- reviewer가 봐야 할 최소 단위가 없다.

### 1.5 시니어 수준의 설계 판단 부족

LLM은 알려진 패턴을 복제하는 데 강하다. 그러나 언제 추상화해야 하는지, 언제 하지 말아야 하는지, 어떤 경계를 지켜야 하는지, 어떤 변화 가능성을 격리해야 하는지에 대한 판단은 약하다.

즉 문제는 "패턴을 모른다"가 아니라 "패턴의 적용 조건을 모른다"에 가깝다.

## 2. 진화 단계

Agentic coding은 다음 단계로 진화한다고 볼 수 있다.

```text
1세대: Code Generation
  주어진 설명으로 코드를 생성한다.

2세대: Code Editing
  기존 코드베이스를 읽고 파일을 수정한다.

3세대: Impact-aware Editing
  변경 전 영향 그래프를 만들고, 영향 범위를 따라 수정한다.

4세대: Intent-aware Engineering
  사용자의 의도, 금지 범위, 도메인 의미, 설계 경계를 보존하면서 변경한다.
```

현재 대부분의 coding agent 경험은 2세대에 머문다. 사용자가 피로를 느끼는 지점은 대부분 3세대와 4세대의 부재에서 나온다.

DITTO의 방향은 4세대에 둔다.

## 3. 핵심 모델

DITTO는 agentic engineering을 다음 네 그래프의 조합으로 모델링한다.

```text
Intent Graph
  사용자의 목적, acceptance, in-scope, out-of-scope, 금지 범위

Architecture Graph
  레이어, 모듈, public surface, 허용된 의존 방향, ownership

Impact Graph
  변경 대상에서 출발한 호출, 타입, 테스트, 문서, 외부 소비자 영향

Review Graph
  변경 파일, 위험도, 근거, 검증 상태, 사람이 봐야 할 exception
```

이 네 그래프의 목적은 agent에게 더 많은 맥락을 주는 것이 아니다. 목적은 변경 전후에 **통제 가능한 계약면**을 만드는 것이다.

변경은 다음 질문을 통과해야 한다.

- Intent Graph를 위반하지 않았는가?
- Architecture Graph의 경계를 넘지 않았는가?
- Impact Graph의 affected node가 처리되었는가?
- Review Graph가 고위험 변경을 숨기지 않았는가?

## 4. Pattern 1: Intent Preservation

### 문제

Agent는 사용자의 요청을 해결하면서 허용되지 않은 변경을 섞는다. 그 변경이 기술적으로 맞아도, 사용자의 의도와 다르면 실패다.

### 원칙

코드 변경 전에 변경 계약을 만든다. 변경 후에는 diff를 계약과 대조한다.

### 산출물 후보

```markdown
CHANGE CONTRACT

목적:
- 세금 계산 로직의 반올림 규칙을 수정한다.

변경 허용 범위:
- TaxCalculator
- InvoiceService의 TaxCalculator 호출부
- 관련 단위 테스트

변경 금지:
- PaymentGateway
- DiscountPolicy
- public invoice API response shape

Acceptance:
- 기존 할인 정책은 동일하게 유지된다.
- 세금 계산 결과만 새 반올림 규칙을 따른다.
- 기존 invoice API contract test가 통과한다.
```

### Runtime 흐름

```text
User Request
  -> Intent extraction
  -> Change Contract draft
  -> Ambiguity gate
  -> Apply change
  -> Diff vs Change Contract
  -> Intent violation report
```

### DITTO 매핑

- 기존 `IntentContract`와 `work item`이 원천이 된다.
- `in_scope`, `out_of_scope`, `acceptance_criteria`를 diff 검증에 직접 사용해야 한다.
- Stop/Completion gate는 테스트 통과뿐 아니라 contract 위반 여부를 봐야 한다.

### 검증 기준

- out-of-scope 파일 수정 시 경고 또는 차단
- public API 변경 시 contract에 명시되어 있는지 확인
- acceptance와 무관한 대형 refactor 감지
- 변경 금지 항목을 건드린 diff를 Review Graph에 high risk로 기록

## 5. Pattern 2: Impact Analysis

### 문제

API 변경을 단순 검색으로 처리하면 영향 범위를 놓친다. 호출자만 고쳐도 실제 의존자는 남는다.

### 원칙

변경 전 Impact Graph를 만든다. 변경은 graph traversal 결과를 기준으로 계획된다.

### 산출물 후보

```json
{
  "change_target": "foo()",
  "change_type": "rename",
  "affected_nodes": [
    {
      "kind": "direct_caller",
      "path": "src/a.ts",
      "symbol": "loadA"
    },
    {
      "kind": "test",
      "path": "tests/a.test.ts",
      "reason": "covers old foo behavior"
    },
    {
      "kind": "external_surface",
      "path": "src/index.ts",
      "reason": "exports foo"
    }
  ],
  "unresolved": [
    {
      "kind": "dynamic_call",
      "path": "src/plugin.ts",
      "reason": "string-based dispatch"
    }
  ]
}
```

### Runtime 흐름

```text
Change target
  -> Symbol resolution
  -> Call graph
  -> Type/export graph
  -> Test/doc surface scan
  -> Affected node classification
  -> Migration plan
```

### DITTO 매핑

- Graphify 같은 AST/knowledge graph 도구는 이 계층에 들어간다.
- 영향 그래프는 planner의 입력이고, reviewer/verifier의 검증 대상이다.
- unresolved 영향은 숨기지 않고 Review Graph에 남긴다.

### 검증 기준

- 변경 target의 direct caller 누락 0건
- exported/public symbol 변경 시 external surface 표시
- 관련 테스트가 없으면 "미검증 영향"으로 남김
- unresolved dynamic dispatch는 완료 판정에서 unverified risk로 남김

## 6. Pattern 3: Semantic Compatibility

### 문제

Agent는 타입 변경에 맞춰 사용 코드를 고치지만, 기존 API가 표현하던 도메인 의미를 보존하지 못할 수 있다.

### 원칙

API 변경은 타입 diff가 아니라 semantic diff로 본다. 기존 코드가 암묵적으로 의존하던 비즈니스 가정을 찾아야 한다.

### 산출물 후보

```markdown
SEMANTIC COMPATIBILITY NOTE

변경:
- getUser(): User | null
- getUser(): User

기존 의미:
- null은 "사용자가 존재하지 않음"을 표현했다.
- 호출자는 null일 때 onboarding flow로 이동했다.

새 의미의 위험:
- User가 항상 존재한다고 가정하면 onboarding branch가 사라질 수 있다.

보존해야 할 의도:
- 존재하지 않는 사용자 상태는 여전히 표현되어야 한다.

허용 가능한 migration:
- getUserOrThrow()를 새로 만들고 기존 getUser()의 null 의미는 유지한다.
- 또는 Result<User, UserNotFound> 형태로 명시한다.
```

### Runtime 흐름

```text
API Change
  -> Old behavior extraction
  -> Business assumption detection
  -> Caller intent classification
  -> Semantic migration options
  -> Compatibility verification
```

### DITTO 매핑

- AST만으로는 부족하다. LLM reasoning이 필요하지만, reasoning 결과는 structured artifact로 고정해야 한다.
- Semantic note는 reviewer와 verifier가 다시 확인할 수 있어야 한다.
- "타입상 안전"과 "의미상 안전"은 다른 verdict로 남긴다.

### 검증 기준

- 기존 branch 제거가 도메인 상태 제거인지 확인
- fallback, null, undefined, error, empty list의 의미를 문서화
- behavior test가 있으면 보존, 없으면 characterization test 후보 생성
- 의미 변경이 의도된 breaking change인지 명시

## 7. Pattern 4: Architectural Boundary

### 문제

Agent는 빠른 해결을 위해 계층 경계를 우회한다. 한 번의 우회는 편하지만, 반복되면 아키텍처가 붕괴한다.

### 원칙

저장소의 아키텍처 경계를 명시하고, 변경 후 boundary validation을 수행한다.

### 산출물 후보

```yaml
layers:
  controller:
    can_call:
      - service
  service:
    can_call:
      - repository
  repository:
    can_call: []

public_surfaces:
  - src/index.ts
  - src/cli/index.ts

forbidden_dependencies:
  - from: src/core/**
    to: src/cli/**
```

### Runtime 흐름

```text
Architecture Spec
  -> Dependency graph
  -> Boundary validation
  -> Violation classification
  -> Review exception
```

### DITTO 매핑

- Architecture Graph는 저장소별 knowledge로 관리한다.
- 작은 저장소는 간단한 YAML로 시작하고, 필요할 때 lint/AST 기반으로 확장한다.
- boundary violation은 테스트 통과 여부와 별개로 high risk다.

### 검증 기준

- 금지된 layer dependency 감지
- public surface 변경 감지
- owner가 다른 모듈 수정 감지
- 새 helper가 올바른 계층에 위치하는지 확인

## 8. Pattern 5: Review by Exception

### 문제

사람이 모든 agent diff를 직접 리뷰하는 방식은 확장되지 않는다.

### 원칙

Agent가 먼저 변경을 위험도별로 분류한다. 사람은 전체 diff가 아니라 exception을 본다.

### 산출물 후보

```markdown
REVIEW GRAPH SUMMARY

변경 파일: 18

위험도 낮음: 12
- 내부 테스트 fixture 수정
- private helper rename

위험도 중간: 4
- service 내부 branching 변경
- retry policy 조정

위험도 높음: 2
- PaymentService public method behavior 변경
- migration script 추가

사람 리뷰 필요:
- src/payments/payment-service.ts
- migrations/20260603_add_payment_state.sql
```

### Runtime 흐름

```text
Diff
  -> File role classification
  -> Risk scoring
  -> Evidence attachment
  -> Human review set
  -> Completion gate
```

### DITTO 매핑

- reviewer output은 단순 코멘트가 아니라 structured Review Graph여야 한다.
- high risk가 남아 있으면 CompletionContract가 pass로 닫히지 않아야 한다.
- 사람 리뷰는 "모든 파일을 보라"가 아니라 "이 exception을 판단하라"가 되어야 한다.

### 검증 기준

- public API, migration, auth, payment, data deletion은 기본 high risk
- 테스트만 바꾼 경우도 production behavior와 연결되면 medium 이상
- risk reason이 없는 분류는 무효
- high risk에 evidence 또는 explicit unresolved marker 필요

## 9. Pattern 6: Senior Pattern Repository

### 문제

Agent는 패턴 이름은 알지만 적용 조건을 약하게 판단한다. 그래서 과한 추상화와 부족한 격리가 모두 발생한다.

### 원칙

조직의 설계 철학과 패턴 적용 기준을 agent가 참조 가능한 repository knowledge로 남긴다.

### 산출물 후보

```markdown
# PATTERNS.md

## Deep Module

사용 조건:
- 외부에 노출되는 interface가 작고 안정적이어야 한다.
- 내부 복잡도가 커질 가능성이 있다.

사용하지 않을 조건:
- 단일 호출자만 있는 단순 helper
- 이름만 감춘 얕은 wrapper

검증 질문:
- interface가 구현보다 좁은가?
- 호출자가 내부 결정을 몰라도 되는가?
- 테스트가 interface 기준으로 작성 가능한가?
```

### Runtime 흐름

```text
Change Plan
  -> Pattern Repository lookup
  -> Candidate pattern selection
  -> Applicability check
  -> Anti-pattern check
  -> Design decision record
```

### DITTO 매핑

- `CONTEXT.md`, `PATTERNS.md`, knowledge record가 이 계층에 해당한다.
- 패턴은 "쓸 수 있는 기술 목록"이 아니라 "언제 쓰고 언제 쓰지 않는지"를 포함해야 한다.
- agent가 새 추상화를 만들 때는 pattern applicability를 근거로 남겨야 한다.

### 검증 기준

- 단일 사용 추상화 생성 시 warning
- shallow wrapper 감지
- 기존 local pattern과 다른 설계 선택 시 decision record 요구
- 새 abstraction의 caller 수, interface 폭, 내부 복잡도 근거 확인

## 10. Cross-cutting Pattern: Evidence-backed Completion

### 문제

Agent는 작업이 끝났다고 말하지만, 그 판단이 테스트, diff, 로그, 화면 확인, 리뷰 결과와 연결되지 않는 경우가 많다.

### 원칙

완료는 주장하지 않는다. 완료는 evidence로 계산한다.

### Runtime 흐름

```text
Acceptance Criteria
  -> Evidence collection
  -> Intent validation
  -> Impact validation
  -> Architecture validation
  -> Review exception validation
  -> Completion verdict
```

### DITTO 매핑

- 기존 `EvidenceContract`, `CompletionContract`, `ConvergenceContract`와 직접 연결된다.
- "테스트 통과"는 충분조건이 아니다.
- unverified 영향이나 unresolved semantic risk가 있으면 `partial` 또는 `unverified`로 남긴다.

## 11. 통합 Workflow

DITTO에서 이 아이디어를 구체화하면 기본 workflow는 다음 형태가 된다.

```text
1. Request Intake
   사용자 요청을 work item과 Intent Contract로 만든다.

2. Change Contract
   목적, 허용 범위, 금지 범위, acceptance를 고정한다.

3. Graph Build
   Intent Graph, Architecture Graph, Impact Graph를 만든다.

4. Plan
   영향 그래프와 경계 조건에 따라 migration plan을 만든다.

5. Apply
   변경을 수행하되 graph와 contract를 계속 참조한다.

6. Validate
   테스트, 타입체크, boundary validation, semantic compatibility를 확인한다.

7. Review by Exception
   risk-ranked Review Graph를 만들고 고위험 항목을 드러낸다.

8. Complete
   acceptance별 evidence가 닫힌 경우에만 완료 verdict를 낸다.
```

## 12. 최소 제품 표면 후보

이 아이디어를 DITTO 기능으로 내리면, 초기에 필요한 표면은 다음 정도다.

| 표면 | 목적 | 형태 |
|---|---|---|
| Change Contract | 변경 허용/금지 범위 고정 | `change-contract.json` 또는 work item sidecar |
| Impact Graph | 영향 범위 추적 | `impact-graph.json` |
| Semantic Note | 의미 호환성 검토 | `semantic-compatibility.md/json` |
| Architecture Spec | 경계 규칙 | `.ditto/architecture.yaml` |
| Review Graph | 위험도 기반 리뷰 | `review-graph.json/md` |
| Pattern Repository | 설계 판단 기준 | `PATTERNS.md` 또는 `.ditto/knowledge` |
| Completion Evidence | 완료 판단 근거 | existing completion/evidence records |

초기 구현은 모든 것을 자동화할 필요가 없다. 중요한 것은 agent가 최종 응답으로 흘려보내던 판단을 산출물로 고정하는 것이다.

## 13. DITTO 현재 설계와의 연결

이미 존재하는 DITTO 설계와 자연스럽게 맞물리는 부분은 다음과 같다.

| 현재 DITTO 요소 | 연결되는 패턴 |
|---|---|
| `AGENTS.md` 행동 헌장 | Intent Preservation, Evidence-backed Completion |
| `IntentContract` | Intent Graph, Change Contract |
| `AutopilotContract` | 통합 workflow, graph-based execution |
| `DelegationContract` | Review by Exception, 영향 범위별 subagent 분리 |
| `EvidenceContract` | Evidence-backed Completion |
| `CompletionContract` | 완료 verdict |
| `ConvergenceContract` | 자기 확신 억제, premature closure 방지 |
| `KnowledgeContract` | Senior Pattern Repository |
| `Reviewer` / `Verifier` | Review Graph, exception routing |

새로 구체화할 후보는 다음이다.

- `ChangeGovernanceContract`
- `ImpactGraphContract`
- `ArchitectureBoundaryContract`
- `SemanticCompatibilityContract`
- `ReviewGraphContract`
- `PatternApplicabilityContract`

단, 처음부터 계약을 많이 만들 필요는 없다. v0에서는 `Change Contract + Impact Graph + Review Graph` 세 개만으로도 유의미한 검증이 가능하다.

## 14. 평가 기준

이 아이디어가 실제로 가치 있는지 판단하려면 다음 지표를 본다.

| 지표 | 의미 |
|---|---|
| unintended edit count | 요청 밖 변경이 얼마나 줄었는가 |
| missed impact count | API 변경 후 누락된 호출자/테스트/문서가 얼마나 줄었는가 |
| semantic regression count | 타입은 맞지만 의도는 깨진 변경이 얼마나 줄었는가 |
| review surface reduction | 사람이 봐야 할 파일 수가 얼마나 줄었는가 |
| high-risk surfacing precision | high risk로 표시한 항목이 실제로 중요한가 |
| completion evidence coverage | acceptance별 evidence가 얼마나 붙었는가 |
| architecture violation count | 계층/경계 위반이 얼마나 줄었는가 |

정성 지표도 필요하다.

- 사용자가 "내가 원하지 않은 방향으로 갔다"고 느끼는 빈도
- reviewer가 diff 전체를 읽지 않고 판단 가능한 정도
- agent가 새 추상화를 만들 때 이유가 납득 가능한 정도
- 실패했을 때 다음 agent가 이어받을 수 있는 정도

## 15. 열린 질문

후속 구체화에서 닫아야 할 질문이다.

1. Impact Graph는 어느 수준까지 deterministic하게 만들고, 어디부터 LLM 판단에 맡길 것인가?
2. Semantic Compatibility를 어떤 schema로 표현해야 reviewer와 verifier가 재검증할 수 있는가?
3. Architecture Spec은 저장소마다 수동 작성할 것인가, 초기 graph에서 제안할 것인가?
4. Review Graph의 risk scoring rule은 hard-coded rule, repo policy, LLM classifier 중 무엇을 1차로 둘 것인가?
5. 사람 리뷰가 필요한 high-risk exception을 어떤 UX로 표시할 것인가?
6. Pattern Repository를 `PATTERNS.md`로 둘지, `.ditto/knowledge`의 structured record로 둘지 결정해야 한다.
7. 기존 `CompletionContract`에 change governance failure를 직접 연결할지, 별도 gate로 둘지 결정해야 한다.

## 16. 다음 문서 후보

이 문서를 바탕으로 다음 산출물을 만들 수 있다.

- `reports/design/contracts/change-governance-contract.md`
- `reports/design/contracts/impact-graph-contract.md`
- `reports/design/contracts/semantic-compatibility-contract.md`
- `reports/design/contracts/review-graph-contract.md`
- `.ditto/architecture.yaml` 초안
- `PATTERNS.md` 초안

작성 순서는 `change-governance-contract`가 먼저다. 이 계약이 Intent, Impact, Architecture, Review를 묶는 상위 판단면이 되기 때문이다.

