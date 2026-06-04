---
title: "Effect-Visible Functional Core Pattern"
kind: design-pattern
last_updated: 2026-06-04 KST
status: draft
scope: "agent가 작성하는 core/domain 로직을 순수 함수, 불변 데이터, 선언형 규칙, 명시적 effect command로 구성해 예측 가능한 코드를 만들기 위한 ACG 디자인 패턴."
parent: 00-framework.md
intended_consumers:
  - implementer agent
  - refactorer agent
  - reviewer/verifier agent
  - ACG spec maintainer
update_policy: "ACG 40/20/10에 흡수되기 전까지 패턴 정의, gate 후보, 바인딩 후보를 기록한다. 실제 코드 바인딩이나 테스트가 생기면 evidence와 enforcement 등급을 갱신한다."
deletion_condition: "이 패턴이 40-refactoring-criteria.md와 20-contracts.md에 완전히 흡수되어 별도 문서가 중복이 되거나, 실제 적용 결과 agent 변경 품질을 개선하지 못한다고 검증되면 삭제한다."
---

# Effect-Visible Functional Core Pattern

> **이 문서의 위치.** 이 문서는 ACG core spec(00~50)에 바로 합쳐진 규범이 아니라, [40-refactoring-criteria.md](40-refactoring-criteria.md)의 Deep Module Gate를 보강하기 위한 **디자인 패턴 후보**다. 초점은 "좋은 코드 스타일"이 아니라 **agent가 망치기 쉬운 숨은 상태, 암묵 side effect, 절차적 흐름, 넓은 영향 범위를 줄이는 것**이다.

## 0. 패턴 정의

**Effect-Visible Functional Core**는 core logic을 순수 함수와 불변 데이터로 작성하고, 상태 전이를 함수로 표현하며, side effect를 명시적 command/event로 반환해 boundary interpreter가 실행하게 하는 패턴이다.

영문 한 문장:

> Agent-authored code should prefer a **declarative, pure, immutable core**. Effects and mutable state are allowed only at declared boundaries and must be visible through type, name, module placement, or returned commands.

구조:

```text
Input + State + Policy
        ↓
Pure Core Function
        ↓
Next State + Decision + EffectCommand[]
        ↓
Effect Interpreter / Object Shell
        ↓
DB / HTTP / File / Time / External System
```

한국어로 줄이면:

> agent가 작성하는 핵심 로직은 가능한 순수 함수, 불변 데이터, 선언형 규칙으로 만들고, side effect와 mutable state는 경계 밖에 격리해 드러내야 한다.

보조 슬로건:

> State as data, transition as function, effect as command.

## 1. 문제

agent가 상태 의존 코드를 만들면 정확성은 현재 입력이 아니라 **과거 실행 순서**에 의존한다. 어떤 메서드를 먼저 불렀는지, 어떤 필드가 언제 바뀌었는지, 캐시와 singleton이 누가 건드렸는지 추적해야 한다. 이것은 사람에게도 어렵고, agent에게는 특히 취약하다.

ACG 관점에서 문제는 다음 네 가지다.

| 문제 | agentic 실패 형태 | ACG가 봐야 할 위험 |
|---|---|---|
| 숨은 mutable state | 호출 순서에 따라 결과가 달라짐 | 영향 범위가 코드 표면에 드러나지 않음 |
| 암묵 side effect | core 로직이 DB, 파일, 시간, env를 직접 읽음 | 테스트 통과가 의미 보존을 보장하지 않음 |
| 명령형 절차 과다 | flag, loop, 중간 mutation이 도메인 규칙을 숨김 | ReviewGraph가 위험 사유를 설명하기 어려움 |
| 가변 객체 중심 설계 | 역할 경계와 상태 변화가 뒤섞임 | ArchitectureSpec 경계와 ChangeContract 계약이 약해짐 |

따라서 이 문서는 "FP를 취향으로 선호하자"가 아니다. **agent가 예측 가능한 코드를 쓰도록 기본 형태를 제한하자**는 규칙이다.

## 2. OOP와 FP의 역할 분리

현대 언어는 OOP와 FP를 함께 쓸 수 있다. ACG에서 둘의 역할은 경쟁이 아니라 분담이다.

| 패러다임 | ACG에서의 강점 | 주로 둘 위치 |
|---|---|---|
| OOP | 역할, 책임, 권한, lifecycle, 외부 경계를 제한 | adapter, gateway, runner, stateful shell |
| FP | 입력/출력 계약, 순수 변환, 불변 데이터, 의미 보존 | domain core, validation, policy, state transition |

권장 구조:

```text
Object / Imperative Shell
  - I/O, DB, 파일, HTTP, 시간, 랜덤, process env
  - lifecycle, 권한, 외부 시스템 조율
  - effect interpreter

Functional / Declarative Core
  - domain rule
  - validation
  - classification
  - state transition
  - effect command 생성
```

즉 OOP는 "누가 무엇을 할 수 있는가"를 제한하고, FP는 "어떤 입력이 어떤 출력과 불변식을 만든다"를 고정한다.

### 2.1 Strategy 패턴과의 관계

Strategy 패턴은 이 패턴의 일부를 설명할 수 있지만 전체를 대체하지 않는다. Strategy는 같은 인터페이스 아래에서 알고리즘이나 정책을 교체하는 패턴이다. Effect-Visible Functional Core에서 Strategy는 보통 **순수 policy function** 슬롯으로 들어간다.

```ts
type RetryPolicy = (input: RetryInput) => RetryDecision;

function transitionRetry(
  state: RetryState,
  event: RetryEvent,
  policy: RetryPolicy,
): { state: RetryState; effects: EffectCommand[] } {
  const decision = policy({ attempts: state.attempts, event });

  if (decision.kind === 'retry') {
    return {
      state: { ...state, attempts: state.attempts + 1 },
      effects: [{ kind: 'schedule_retry', delayMs: decision.delayMs }],
    };
  }

  return { state, effects: [] };
}
```

ACG식 Strategy는 가능하면 stateless pure function이어야 한다. stateful class strategy가 hidden state나 side effect를 품으면 이 패턴의 목적을 깨뜨린다. 따라서 관계는 다음과 같다.

| 패턴 | 책임 |
|---|---|
| Effect-Visible Functional Core | 순수 core, 상태 규율, effect 가시성, 선언형 규칙 구조 |
| Strategy | core 안에서 policy/algorithm을 순수 함수로 교체 |

## 3. 원칙

### P1 — 순수 함수가 기본값

core/domain 로직은 같은 입력에 같은 출력을 내야 한다. 시간, 랜덤, 파일, DB, HTTP, env, global singleton 접근은 core 안에서 직접 수행하지 않는다.

허용:

```ts
function classifyRisk(severity: Severity): Risk {
  return severityToRisk[severity];
}
```

거부:

```ts
function classifyRisk(severity: Severity): Risk {
  if (process.env.FORCE_HIGH_RISK === 'true') return 'high';
  return severityToRisk[severity];
}
```

환경에 따른 정책이 필요하면 env는 shell에서 읽고 core에는 명시적 입력으로 전달한다.

### P2 — 불변 데이터가 기본값

core 함수는 입력 객체를 변경하지 않고 새 값을 반환한다. 불변성은 agent가 "어디서 값이 바뀌었는가"를 추적해야 하는 부담을 줄인다.

권장:

```ts
function addFinding(review: ReviewGraph, finding: Finding): ReviewGraph {
  return {
    ...review,
    files: [...review.files, findingToFile(finding)],
  };
}
```

거부:

```ts
function addFinding(review: ReviewGraph, finding: Finding): void {
  review.files.push(findingToFile(finding));
}
```

mutable state가 필요하면 adapter/shell 경계에 격리하고, core에는 snapshot을 값으로 넘긴다.

### P3 — effect는 보여야 한다

side effect는 허용된다. 단 숨으면 안 된다. Haskell의 `IO` 타입은 effect를 타입에 드러내고, Clojure의 `swap!`/`reset!` 같은 `!` 관례는 상태 변경을 이름에 드러낸다. ACG는 특정 언어에 묶이지 않고 이 원칙만 차용한다.

effectful 함수는 다음 중 하나 이상으로 표시해야 한다.

| 표시 방식 | 예 |
|---|---|
| 타입 | `IO<T>`, `Task<T>`, `Effect<T>`, `Promise<T>` 중 effectful wrapper |
| 이름 | `run*`, `execute*`, `persist*`, `send*`, `*Effect`, `*!` |
| 위치 | `adapter/`, `gateway/`, `runner/`, `shell/`, `effects/` |
| 반환값 | core가 직접 실행하지 않고 `EffectCommand[]` 반환 |

TypeScript에서 `Promise<T>`는 비동기만 드러낼 뿐 effect 종류를 충분히 설명하지 못한다. 그러므로 이름·위치·command 타입으로 보강한다.

### P4 — 선언형을 우선한다

core 로직은 "어떻게 수행할지"보다 "무엇이 참이어야 하는지 / 어떤 결과가 나와야 하는지"를 드러내야 한다.

권장:

```ts
const severityToRisk = {
  critical: 'high',
  high: 'high',
  warning: 'medium',
  note: 'low',
} as const;

function classifyRisk(severity: Severity): Risk {
  return severityToRisk[severity];
}
```

거부:

```ts
function classifyRisk(severity: Severity): Risk {
  let risk: Risk = 'low';
  if (severity === 'critical') risk = 'high';
  else if (severity === 'high') risk = 'high';
  else if (severity === 'warning') risk = 'medium';
  return risk;
}
```

선언형은 데이터 table, schema/refinement, discriminated union, pure mapping, transition table, rule set 형태로 나타날 수 있다. 단 복잡한 DSL이나 fluent chain으로 control flow를 숨기면 실패다. 기준은 "선언형처럼 보이는가"가 아니라 **규칙과 effect가 더 잘 드러나는가**다.

### P5 — 상태는 데이터, 전이는 함수

상태는 숨은 mutable field가 아니라 명시적 데이터로 둔다. 상태 변화는 순수 함수로 표현하고, 외부 반영은 effect command로 분리한다.

```ts
type OrderState =
  | { kind: 'draft'; items: Item[] }
  | { kind: 'submitted'; orderId: string }
  | { kind: 'cancelled'; reason: string };

type OrderEvent =
  | { kind: 'add_item'; item: Item }
  | { kind: 'submit' }
  | { kind: 'cancel'; reason: string };

type EffectCommand =
  | { kind: 'persist_order'; orderId: string }
  | { kind: 'send_confirmation'; orderId: string };

function transitionOrder(
  state: OrderState,
  event: OrderEvent,
): { state: OrderState; effects: EffectCommand[] } {
  if (state.kind === 'draft' && event.kind === 'add_item') {
    return { state: { ...state, items: [...state.items, event.item] }, effects: [] };
  }

  if (state.kind === 'draft' && event.kind === 'submit') {
    const orderId = createOrderId(state.items);
    return {
      state: { kind: 'submitted', orderId },
      effects: [
        { kind: 'persist_order', orderId },
        { kind: 'send_confirmation', orderId },
      ],
    };
  }

  return { state, effects: [] };
}
```

effect 실행은 바깥 interpreter가 담당한다.

```ts
async function runOrderEffect(effect: EffectCommand, deps: EffectDeps): Promise<void> {
  if (effect.kind === 'persist_order') await deps.orders.persist(effect.orderId);
  if (effect.kind === 'send_confirmation') await deps.mail.sendConfirmation(effect.orderId);
}
```

이 구조는 agent가 봐야 할 것을 명확히 만든다: 가능한 상태, 가능한 이벤트, 전이 규칙, 실행할 effect, 금지된 상태 조합.

## 4. Gate 후보

### G-F1 — Functional Core Gate

새 core/domain 로직은 다음 질문을 통과해야 한다.

| 질문 | 통과 조건 | 실패 신호 |
|---|---|---|
| I/O 없이 입력값만으로 결과를 계산할 수 있는가? | 가능하면 순수 함수로 작성 | class/service가 이유 없이 상태와 I/O를 품음 |
| 의존성이 명시적 입력인가? | config, clock, random, policy가 인자로 전달 | global singleton, env, Date.now 직접 접근 |
| 테스트가 입력/출력 계약을 검증하는가? | public behavior와 invariant 검증 | 내부 호출 순서, private 상태, call count 검증 |
| 같은 입력에 같은 출력인가? | deterministic | 캐시, 시간, 호출 순서에 따라 결과 변경 |

### G-F2 — Effect Visibility Gate

side effect 함수는 effect를 드러내야 한다.

| 검사 | 통과 | 실패 |
|---|---|---|
| 위치 | adapter/shell/effects/runner에 있음 | domain/core 내부에서 DB/HTTP/file/env 접근 |
| 이름 | `run`, `execute`, `persist`, `send`, `Effect`, `!` 등 표시 | 순수해 보이는 이름이 effect 수행 |
| 타입/반환 | effect wrapper 또는 command 반환 | `void` mutation, hidden singleton write |
| ReviewGraph | high-risk effect에는 evidence 또는 unresolved marker | effect가 risk surface에 안 잡힘 |

### G-F3 — Immutability Gate

core 데이터는 불변으로 다룬다.

| 검사 | 통과 | 실패 |
|---|---|---|
| 입력 변경 | 입력을 변경하지 않음 | `push`, `splice`, 필드 대입으로 입력 mutation |
| 반환 형태 | 새 값 반환 | mutation 후 `void` 반환 |
| 상태 보관 | snapshot/value로 전달 | module-level mutable cache, class field |
| 타입 | `readonly`, immutable collection, value object 활용 | mutable object를 public surface로 노출 |

### G-F4 — Declarative Bias Gate

도메인 규칙은 가능한 declarative surface로 드러낸다.

| 질문 | 통과 조건 | 실패 신호 |
|---|---|---|
| 규칙을 table/schema/type/pure function으로 표현할 수 있는가? | 가능하면 선언형 표현 사용 | 중간 flag와 if-chain이 규칙을 숨김 |
| 실행 순서가 도메인 규칙인가? | 순서가 acceptance/invariant에 설명됨 | 구현 편의상 순서에 의존 |
| 선언이 해석 가능하고 테스트 가능한가? | table/schema가 테스트 대상 | 설정 덩어리나 DSL이 control flow를 숨김 |

### G-F5 — State Discipline Gate

상태는 명시적 데이터와 전이 함수로 표현한다.

| 질문 | 통과 조건 | 실패 신호 |
|---|---|---|
| 상태가 함수 입력으로 명시되는가? | `state, event -> state, effects` | 객체 내부 필드에 숨김 |
| 불가능한 상태가 막히는가? | discriminated union/schema로 표현 | boolean flag 조합으로 invalid state 가능 |
| 전이가 테스트 가능한가? | 순수 transition test 가능 | init/order/call sequence 없으면 테스트 불가 |
| 외부 반영이 분리됐는가? | effect command + interpreter | transition 함수가 직접 DB/HTTP 호출 |

## 5. ACG 산출물로의 번역

이 패턴은 조언으로 끝나면 안 된다. ACG 산출물에 다음처럼 내려와야 한다.

| ACG 표면 | 반영 방식 |
|---|---|
| `ChangeContract` | 새 core 로직은 purity/immutability/effect visibility invariant를 포함 |
| `ArchitectureSpec` | `domain/core`에서 금지 import(`fs`, DB client, HTTP client, env, clock/random 직접 접근) 선언 |
| `ImpactGraph` | effect command와 interpreter를 affected node로 분리 |
| `SemanticCompatibility` | state transition 전후의 behavior/invariant 보존 검증 |
| `ReviewGraph` | hidden effect, hidden mutable state, imperative drift를 risk_reason으로 기록 |
| `FitnessFunction` | 결정론적으로 잡히는 금지 import, mutation pattern, effect boundary 위반을 지속 검사 |
| `AssuranceSnapshot` | purity/effect boundary 위반 추세를 시계열로 추적 |

후보 `risk_reason` 토큰:

| 토큰 | 의미 | 기본 enforcement |
|---|---|---|
| `hidden_effect` | 순수해 보이는 core 함수가 side effect 수행 | warn 또는 block(정적 금지 import면 block) |
| `hidden_mutable_state` | 상태가 module/class field/singleton에 숨어 있음 | warn |
| `temporal_coupling` | 호출 순서가 정확성 조건 | warn |
| `imperative_drift` | 선언 가능한 domain rule이 절차/mutation으로 숨음 | warn |
| `invalid_state_representable` | boolean/nullable 조합으로 불가능한 상태 표현 가능 | warn |
| `effect_not_interpreted` | core가 effect command를 반환하지 않고 직접 실행 | warn 또는 block(ArchitectureSpec 위반이면 block) |

## 6. Enforcement 등급

모든 위반을 block하면 레거시 코드베이스가 멈춘다. ACG의 일반 규율처럼 결정론은 block까지 가능하고, 휴리스틱은 warn/track이 기본이다.

| 항목 | 판정 성격 | 기본 등급 |
|---|---|---|
| domain/core의 금지 import | 결정론 | block |
| `Date.now`/`Math.random`/`process.env` 직접 접근 | 결정론 | block 또는 warn(초기 도입 시 track) |
| input mutation pattern | 일부 결정론 | warn, 신규 core에는 block 가능 |
| hidden mutable state | 휴리스틱+일부 정적 분석 | warn |
| declarative로 바꿀 수 있는 imperative flow | 휴리스틱 | warn |
| invalid state representable | 타입/스키마 검토 필요 | warn |
| effect 표시 이름/위치 누락 | 일부 결정론 | warn |

신규 코드에는 강하게 적용하고, 기존 레거시는 `baseline.delta_only`로 신규 위반만 막는다. 이는 [20-contracts.md](20-contracts.md)의 FitnessFunction 비용/부채 정책과 같은 방향이다.

## 7. 언어별 적용 예

### TypeScript

- `domain/`과 `core/`에는 `fs`, DB client, HTTP client, process env 직접 import 금지.
- core 함수 입력은 명시적 `context` 또는 value object로 전달.
- discriminated union으로 상태를 표현.
- effect는 `EffectCommand` union으로 반환하고, interpreter는 `effects/` 또는 `runner/`에 둔다.
- `readonly` 타입과 새 값 반환을 기본값으로 사용.

### JVM / Kotlin / Java

- domain service는 repository 구현체가 아니라 port/interface를 받되, port가 speculative seam이 되지 않도록 adapter가 실제로 필요할 때만 둔다.
- mutation은 aggregate boundary 안에 가두고, 외부에는 immutable DTO/event를 노출한다.
- time/random/env는 `Clock`, `RandomSource`, config value로 주입한다.
- state machine은 enum flag 조합보다 sealed class/record hierarchy로 표현한다.

### Clojure

- pure function과 atom/ref 변경 함수를 이름으로 분리한다.
- `!` 관례로 mutation/effect를 드러낸다.
- core는 data transformation으로 두고, atom swap과 I/O는 boundary namespace에 둔다.

### Haskell / Effect-typed 언어

- `IO`/effect type이 core와 shell을 가르는 기준이 된다.
- ACG 바인딩에서는 effect type boundary를 ArchitectureSpec/FitnessFunction의 검사 대상으로 삼을 수 있다.

## 8. 40/20/10으로의 흡수 계획

이 패턴을 core spec에 흡수한다면 위치는 다음이 자연스럽다.

| 대상 문서 | 흡수 내용 |
|---|---|
| [40-refactoring-criteria.md](40-refactoring-criteria.md) | Deep Module Gate 뒤에 `Functional Core Gate`(G-F1), `Effect Visibility Gate`(G-F2), `Immutability Gate`(G-F3), `Declarative Bias Gate`(G-F4), `State Discipline Gate`(G-F5) 추가 — §4 다섯 게이트 전부 |
| [20-contracts.md](20-contracts.md) | `ArchitectureSpec.conventions`에 effect boundary/purity convention 추가, `ReviewGraph.risk_reason` vocabulary 후보 추가 |
| [10-methodology.md](10-methodology.md) | 단계 4 Plan과 단계 6 Validate에 purity/effect/state 검증 질문 추가 |
| [30-intent-change-dsl.md](30-intent-change-dsl.md) | ICL에서 `pure`, `effect`, `state_transition`, `immutable` 같은 constraint target 후보 추가 |

단, 지금 당장 00~50을 수정하지 않는 이유는 두 가지다.

1. 이 문서는 아직 실행 증거가 없는 디자인 패턴 후보이다.
2. 00~50은 ACG core spec이고, 새 패턴은 gate와 binding 증거를 얻은 뒤 좁게 흡수해야 한다.

## 9. 열린 질문

1. **effect 표시의 언어별 표준.** Haskell은 타입, Clojure는 이름 관례, TypeScript는 위치/이름/command가 현실적이다. 각 바인딩에서 무엇을 block 가능한 규칙으로 삼을지 정해야 한다.
2. **선언형 남용 방지.** table/schema/DSL이 control flow를 더 숨기면 실패다. "선언형"의 통과 기준은 문법이 아니라 검증 가능성과 규칙 노출성이다.
3. **mutation 허용 경계.** 성능, framework, aggregate lifecycle 때문에 mutation이 필요한 경우가 있다. core 내부 value mutation과 externally observable mutation을 구분해야 한다.
4. **ReviewGraph vocabulary 승격 여부.** `hidden_effect`, `temporal_coupling` 같은 토큰을 자유 텍스트에서 enum으로 승격할지는 두 번째 바인딩에서 반복성을 확인한 뒤 결정한다.
5. **FitnessFunction 비용.** 금지 import는 싸지만 mutation/temporal coupling 탐지는 휴리스틱 비용이 크다. 어떤 것은 `per_change`, 어떤 것은 `periodic/track`으로 둘지 정해야 한다.

## 10. 요약 규칙

agent가 새 core 로직을 작성하거나 리팩토링할 때 기본값은 다음이다.

1. class보다 pure function을 먼저 고려한다.
2. mutable field보다 explicit state value를 쓴다.
3. side effect는 직접 실행하지 않고 command/event로 반환한다.
4. effect 실행은 adapter/shell/interpreter에 둔다.
5. if-chain과 flag mutation보다 table/schema/type/rule set을 우선한다.
6. 불가능한 상태는 타입이나 스키마로 표현 불가능하게 만든다.
7. 예외가 필요하면 plan과 ReviewGraph에 이유를 남긴다.

한 줄로:

> State as data, transition as function, effect as command.
