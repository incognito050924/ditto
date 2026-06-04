---
title: "ACG Refactoring and Module Design Criteria"
kind: criteria
last_updated: 2026-06-04 KST
status: draft
scope: "agent가 리팩토링을 해도 되는 조건과 새 모듈·인터페이스를 어떻게 설계해야 하는지를, 검증된 공학 원칙(Tidy First·Characterization·Deep Module)에 근거해 형식화한다."
parent: 00-framework.md
---

# ACG Refactoring and Module Design Criteria

> **이 문서의 위치.** ACG의 리팩토링·모듈 설계 축. agent의 구조 변경은 사람의 것과 다르다 — 빠르고, 넓고, "하는 김에" 주변을 고치고, 얕은 wrapper를 즐겨 만든다. 이 문서는 리팩토링을 *금지*하지 않는다. 또한 좋은 모듈/인터페이스 설계를 agent의 순간 감각에 맡기지 않는다. **언제 리팩토링이 허용되고, 새 모듈·인터페이스가 어떤 형태여야 하며, 어떤 증거로 안전을 증명하는가**를 형식화한다. [10-methodology.md](10-methodology.md) 단계 4·5·6의 구조 설계/리팩토링 게이트가 이 기준을 집행한다.
>
> **무엇을 막고 무엇을 만든다.** agent가 당위성 없는 코드를 쏟아내고 얕은 wrapper·단일 사용 추상화를 즐겨 만드는 것은 [00](00-framework.md) §1.1(1)(3)의 직접 산물이다 — 당위성 없는 생성과 SLOP 증식. 이 문서의 게이트는 그 증식을 *입구*에서 막고(Deep Module Gate §3), §6에서 그것을 지속 적합성으로 넘겨 *쌓이지 못하게* 한다. 동시에 "좋은 모듈/인터페이스를 어떻게 설계할까"를 ACG 안으로 가져온다. 즉 ACG의 Deep Module 기준은 사후 리팩토링 심사만이 아니라, 기능 추가 중 새 abstraction을 만들 때 따라야 하는 **선행 설계 규칙**이다.

## 0. 리팩토링의 정의 (먼저 못박는다)

ACG에서 리팩토링은 **외부에서 관찰 가능한 동작을 바꾸지 않으면서 내부 구조를 바꾸는 것**이다(Fowler). 이 정의가 곧 첫 번째 게이트다 — "동작이 바뀌면 그것은 리팩토링이 아니라 동작적 변경"이고, 다른 단계(전체 lifecycle)를 따라야 한다.

따라서 모든 리팩토링은 두 질문에 답해야 한다:
1. **분리**: 이것이 정말 구조적 변경인가, 동작적 변경이 섞였는가? (Tidy First)
2. **보존**: 동작이 보존됐다는 증거가 있는가? (Characterization)

## 1. 토대가 되는 세 원칙

| 원칙 | 원전 | ACG에서의 역할 |
|---|---|---|
| **Tidy First** | Kent Beck | 구조적 변경과 동작적 변경을 분리. 같은 커밋에 섞지 않음 |
| **Characterization Test** | M. Feathers, WELC | 동작 보존의 증거. 리팩토링 전 기존 동작을 고정 |
| **Deep Module / Information Hiding** | Ousterhout / Parnas | 모듈·인터페이스 설계 기준. 작은 인터페이스와 단순한 호출자 경험 뒤에 큰 내부 복잡도를 숨기고, 얕은 wrapper·누출 추상화를 금지 |

> **원전과의 차이.** 세 원칙 모두 인간 개발자를 위한 *권고*였다. ACG는 이를 *게이트*로 만든다 — agent는 권고를 무시하기 쉽고(특히 "하는 김에" 리팩토링), 얕은 추상화를 과잉 생산하므로, 권고를 통과 조건으로 강제한다. Deep Module은 Ousterhout의 "작은 인터페이스 + 깊은 구현" 원칙을 따른다. Matt Pocock의 [`deep-modules.md`](https://github.com/mattpocock/skills/blob/e74f0061/skills/engineering/tdd/deep-modules.md)도 같은 실무 질문으로 요약한다: 메서드 수를 줄일 수 있는가, 파라미터를 단순화할 수 있는가, 더 많은 복잡도를 내부에 숨길 수 있는가.

## 2. 허용 게이트 (Refactoring Allowance Gate)

리팩토링은 다음을 **모두** 통과할 때 허용된다.

### G-R1 — 동작 보존 증거 (Characterization)

리팩토링 대상에 동작을 고정하는 테스트가 있어야 한다.

- **있으면**: 리팩토링 전후로 그 테스트가 동일하게 통과 → 증거 충족.
- **없으면**: characterization test 후보를 먼저 생성한다([20](20-contracts.md) §SemanticCompatibility). 생성도 불가능하면(예: 부수효과가 외부 시스템) → 리팩토링을 **"미검증 리팩토링"으로 표시**하고 high-risk로 Review Graph에 올린다.

> **boxwood 함의.** automation-engine 커버리지 2.7%, portal-backend 11%. 대부분의 리팩토링이 G-R1에서 "테스트 없음"에 걸린다. 이것은 ACG의 버그가 아니라 **기능**이다 — agent가 테스트 없는 코드를 무증거로 리팩토링하는 것을 막고, characterization test 생성을 선행하게 만든다. 리팩토링이 테스트 커버리지를 끌어올리는 부수효과를 낸다.

### G-R2 — Tidy First 분리

구조적 변경과 동작적 변경이 분리됐는가.

- 한 커밋/변경 단위에 둘이 섞이면 게이트 실패. 구조 변경을 먼저 분리한다(전역 CLAUDE.md 규율).
- 커밋 메시지에 변경 유형(structural / behavioral)을 명시한다.
- ICL `intent`가 `purpose`에 "리팩토링"을 선언했는데 diff에 동작 변경이 섞이면 → 단계 6에서 차단.

### G-R3 — 범위 일치 (Surgical)

리팩토링이 ChangeContract의 `allowed_scope` 안에 있는가.

- "하는 김에" 주변 코드·이름·포맷을 고치는 것 = forbidden. 수정한 모든 줄이 리팩토링 목적으로 설명돼야 한다(Charter §4-4).
- 죽은 코드처럼 보이는 것을 임의 제거 금지 — fallback일 수 있다(아이디어 베이스 §1.1). 제거하려면 ImpactGraph로 미사용을 증명한다.

## 3. 모듈·인터페이스 설계 기준 (Deep Module Gate)

agent가 기능 추가나 리팩토링 중 새 추상화(클래스·인터페이스·helper·모듈)를 만들 때, Deep Module 원칙으로 적용 조건을 검사한다. 이 게이트는 "나쁜 추상화 금지"만이 아니라 "좋은 모듈/인터페이스를 어떻게 설계할까"에 대한 ACG의 답이다.

### 3.1 선행 설계 질문

새 모듈·인터페이스를 만들기 전에 plan에는 다음 질문의 답이 있어야 한다.

| 질문 | 통과 조건 | 실패 신호 |
|---|---|---|
| 호출자가 보는 표면을 줄였는가? | 공개 메서드·옵션·설정 지점이 문제 해결에 필요한 최소 집합 | 비슷한 메서드 다수, mode 플래그 과다, 호출자가 조합 순서를 알아야 함 |
| 파라미터를 단순화했는가? | caller가 도메인 intent를 넘기고, 내부 프로토콜·상태·순서를 넘기지 않음 | caller가 내부 단계, 캐시 키, retry 수, transport 세부를 직접 조립 |
| 내부 복잡도를 숨겼는가? | 분기·검증·재시도·캐싱·트랜잭션·외부 시스템 조율이 구현 안으로 들어감 | "helper"가 호출자에게 복잡한 절차를 그대로 떠넘김 |
| 정보 은닉 경계가 생겼는가? | caller가 내부 저장소·프레임워크·프로토콜 결정을 몰라도 됨 | 구현 세부가 타입/옵션/이름으로 public surface에 누출 |
| 기존 local 패턴과 맞는가? | ArchitectureSpec `conventions.approved_patterns` 또는 인접 코드 패턴과 일치 | 새 스타일·새 계층·새 naming을 근거 없이 도입 |

이 질문은 TDD의 설계 단계에도 적용된다. 테스트를 먼저 쓰는 경우에도 테스트가 새 모듈의 내부 절차가 아니라 **작은 public contract**를 고정해야 한다. 테스트가 내부 단계를 과하게 알아야 한다면, 그 인터페이스는 이미 얕거나 새고 있을 가능성이 높다.

### 새 추상화는 다음을 만족해야 허용된다

| 검증 질문 | 통과 조건 | 위반 시 |
|---|---|---|
| 인터페이스가 구현보다 좁은가? | 노출 표면 < 내부 복잡도 | **얕은 wrapper** → 거부 |
| caller 부담을 줄였는가? | 호출자가 알아야 할 순서·상태·분기·환경 지식이 감소 | caller complexity가 그대로면 pass-through → 거부 |
| 단일 사용이어도 깊은가? | caller가 1개라도 복잡도 은닉·정보 은닉이 명확하면 허용 | 단지 "미래 확장"만 근거면 speculative generality → 거부 |
| 호출자가 내부 결정을 몰라도 되는가? | 정보 은닉 성립 | 누출 추상화 → 재설계 |
| 기존 local 패턴과 일치하는가? | 저장소 패턴 따름 | 불일치 → `decision_ref` 요구 |

`caller ≥ 2`는 더 이상 1차 허용 조건이 아니다. 재사용성의 보조 증거일 뿐이다. ACG가 막아야 하는 것은 "호출자가 하나인 추상화" 자체가 아니라, 내부 복잡도를 숨기지 못하고 이름만 늘리는 얕은 추상화다. 반대로 호출자가 하나여도 transaction boundary, retry/backoff, dataflow normalization, external protocol orchestration처럼 caller가 알면 안 되는 복잡도를 감추면 Deep Module로 허용된다.

### 거부되는 안티패턴 (명시)

- **Shallow wrapper**: 이름만 바꾼 한 줄 위임. `getUserById(id) { return repo.find(id) }` 류.
- **Pass-through layer**: 아무 로직 없이 호출만 전달하는 계층.
- **Speculative generality**: 현재 호출자가 하나인데 "확장성"을 위한 인터페이스(Charter §4-3, YAGNI).
- **Premature framework**: 한 줄 규칙 변경으로 될 일을 설정 가능한 프레임워크로(Charter §4-3).
- **Leaky convenience helper**: 호출자는 줄었지만 내부 순서·상태·프로토콜 결정을 파라미터로 그대로 노출하는 helper.

> **원전과의 차이.** Ousterhout는 "깊은 모듈을 선호하라"고 권한다. ACG는 인터페이스 폭·파라미터 복잡도·caller 부담·내부 복잡도·정보 은닉을 **검증 가능한 통과 조건**으로 바꾼다 — agent는 "이 추상화가 깊은가"를 직관으로 판단하지 못하므로, plan과 ReviewGraph가 검사할 수 있는 질문으로 대체한다.

## 4. 리팩토링 유형별 게이트 매트릭스

| 리팩토링/설계 유형 | G-R1 보존증거 | G-R2 분리 | G-R3 범위 | Deep Module Gate | 기본 위험도 |
|---|---|---|---|---|---|
| 이름 변경(rename) | 필수 | 해당 | 필수 | — | low (public이면 high) |
| 메서드 추출 | 필수 | 필수 | 필수 | 적용 | low |
| 인터페이스 도입 | 필수 | 필수 | 필수 | **엄격 적용** | medium |
| 새 모듈/API 도입 | 해당 없음(동작 변경이면 기능 lifecycle) | 필수 | 필수 | **엄격 적용(§3.1 포함)** | medium (public이면 high) |
| 계층 이동(move) | 필수 | 필수 | 필수 | — | medium |
| 죽은 코드 제거 | ImpactGraph 미사용 증명 | 해당 | 필수 | — | medium |
| 중복 제거(DRY) | 필수 | 필수 | 필수 | 적용(과잉 추상화 주의) | low |

## 5. 의미 보존의 증명 형태

G-R1의 "증거"는 다음 중 하나여야 한다(Charter §4-5, 증거로만 완료):

1. **기존 behavior test 전후 동일 통과** (최선).
2. **새로 생성한 characterization test 통과** ([20](20-contracts.md) candidate).
3. **변경 전후 dataflow diff 동등** (결정론) — 보안/데이터 흐름 차원에서 source→sink 집합이 불변임을 기계 검증. llm_judged보다 강한 증거. 레퍼런스 구현 CodeQL로 실증됨([reports/codeql](../../codeql/codeql-research-ko.md) 부록3 — 리팩토링 `67b27ccf` 전후 취약 경로 보존 확인). **동등성 key는 정규화 식별자(rule id + source/sink semantic symbol + enclosing function + normalized path hash)여야 하고 raw `file:line`이 아니다** — 라인 이동이 거짓 차이를 만든다(부록3 실증). 단 taint 경로 차원만 — 도메인 의미 전체는 1·2가 담당.
4. **diff 기반 의미 판정** — llm_judged FitnessFunction이 "동작 변경 없음"을 판정(재현성 조건 충족). 차단 권한 없는 `warn` 등급.
5. **(증거 불가)** → "미검증 리팩토링"으로 명시, Review Graph high-risk, CompletionContract는 partial.

증거 없이 "동작은 안 바뀌었다"고 주장하는 것은 통과가 아니다.

## 6. Assurance와의 연결

리팩토링이나 새 모듈 설계가 도입·강화하는 구조 성질 중 일반화 가능한 것은 [20](20-contracts.md) `FitnessFunction`으로 승격한다. 예: "service 계층은 repository만 호출한다"는 경계를 리팩토링으로 복원했다면, 그 경계를 적합성 함수로 등록해 이후 변경이 다시 무너뜨리지 못하게 한다. "public API는 mode 플래그 대신 intent별 메서드 1개만 노출한다"처럼 저장소 전역 설계 규칙으로 일반화되는 Deep Module 기준도 ArchitectureSpec `conventions.approved_patterns`나 FitnessFunction으로 올릴 수 있다. 이것이 리팩토링과 모듈 설계를 *일회성 청소/설계 판단*이 아니라 *지속 보장*으로 바꾼다.

## 7. 다음 문서

- 의미 보존 verdict 스키마 → [20-contracts.md](20-contracts.md) §SemanticCompatibility
- 리팩토링과 새 모듈 설계를 포함한 변경 lifecycle → [10-methodology.md](10-methodology.md) 단계 4·5·6·8
- 리팩토링/모듈 설계 범위의 ICL 선언 → [30-intent-change-dsl.md](30-intent-change-dsl.md)
