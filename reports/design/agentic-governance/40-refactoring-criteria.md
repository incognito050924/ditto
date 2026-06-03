---
title: "ACG Refactoring Criteria"
kind: criteria
last_updated: 2026-06-03 KST
status: draft
scope: "agent가 리팩토링을 해도 되는 조건과 하면 안 되는 조건을, 검증된 공학 원칙(Tidy First·Characterization·Deep Module)에 근거해 형식화한다."
parent: 00-framework.md
---

# ACG Refactoring Criteria

> **이 문서의 위치.** ACG의 리팩토링 축. agent의 리팩토링은 사람의 것과 다르다 — 빠르고, 넓고, "하는 김에" 주변을 고치고, 얕은 wrapper를 즐겨 만든다. 이 문서는 리팩토링을 *금지*하지 않는다. **언제 허용되고 언제 금지되며 어떤 증거로 안전을 증명하는가**를 형식화한다. [10-methodology.md](10-methodology.md) 단계 5·6의 리팩토링 게이트가 이 기준을 집행한다.
>
> **무엇을 막는가.** agent가 당위성 없는 코드를 쏟아내고 얕은 wrapper·단일 사용 추상화를 즐겨 만드는 것은 [00](00-framework.md) §1.1(1)(3)의 직접 산물이다 — 당위성 없는 생성과 SLOP 증식. 이 문서의 게이트는 그 증식을 *입구*에서 막고(추상화 게이트 §3), §6에서 그것을 지속 적합성으로 넘겨 *쌓이지 못하게* 한다. 입구 차단(40)과 추세 감시([20](20-contracts.md) §6 `duplication`/`complexity`)는 SLOP에 대한 한 쌍의 방어다.

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
| **Deep Module / Information Hiding** | Ousterhout / Parnas | 추상화의 적용 조건. 얕은 wrapper·단일 사용 추상화 금지 |

> **원전과의 차이.** 세 원칙 모두 인간 개발자를 위한 *권고*였다. ACG는 이를 *게이트*로 만든다 — agent는 권고를 무시하기 쉽고(특히 "하는 김에" 리팩토링), 얕은 추상화를 과잉 생산하므로, 권고를 통과 조건으로 강제한다.

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

## 3. 추상화 생성 기준 (Abstraction Gate)

agent가 리팩토링 중 새 추상화(클래스·인터페이스·helper·모듈)를 만들 때, Deep Module 원칙으로 적용 조건을 검사한다.

### 새 추상화는 다음을 만족해야 허용된다

| 검증 질문 | 통과 조건 | 위반 시 |
|---|---|---|
| 인터페이스가 구현보다 좁은가? | 노출 표면 < 내부 복잡도 | **얕은 wrapper** → 거부 |
| 호출자가 둘 이상인가? | caller ≥ 2 또는 명시된 미래 caller | **단일 사용 추상화** → 거부(Charter §4-3). 단 단일 사용이라도 *복잡도 은닉*이 분명하면 예외 — [00](00-framework.md) §9 Q7의 열린 항목 |
| 호출자가 내부 결정을 몰라도 되는가? | 정보 은닉 성립 | 누출 추상화 → 재설계 |
| 기존 local 패턴과 일치하는가? | 저장소 패턴 따름 | 불일치 → `decision_ref` 요구 |

### 거부되는 안티패턴 (명시)

- **Shallow wrapper**: 이름만 바꾼 한 줄 위임. `getUserById(id) { return repo.find(id) }` 류.
- **Pass-through layer**: 아무 로직 없이 호출만 전달하는 계층.
- **Speculative generality**: 현재 호출자가 하나인데 "확장성"을 위한 인터페이스(Charter §4-3, YAGNI).
- **Premature framework**: 한 줄 규칙 변경으로 될 일을 설정 가능한 프레임워크로(Charter §4-3).

> **원전과의 차이.** Ousterhout는 "깊은 모듈을 선호하라"고 권한다. ACG는 caller 수·인터페이스 폭·내부 복잡도를 **측정 가능한 통과 조건**으로 바꾼다 — agent는 "이 추상화가 깊은가"를 직관으로 판단하지 못하므로, 측정으로 대체한다.

## 4. 리팩토링 유형별 게이트 매트릭스

| 리팩토링 유형 | G-R1 보존증거 | G-R2 분리 | G-R3 범위 | Abstraction Gate | 기본 위험도 |
|---|---|---|---|---|---|
| 이름 변경(rename) | 필수 | 해당 | 필수 | — | low (public이면 high) |
| 메서드 추출 | 필수 | 필수 | 필수 | 적용 | low |
| 인터페이스 도입 | 필수 | 필수 | 필수 | **엄격 적용** | medium |
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

리팩토링이 도입하거나 강화하는 구조 성질 중 일반화 가능한 것은 [20](20-contracts.md) `FitnessFunction`으로 승격한다. 예: "service 계층은 repository만 호출한다"는 경계를 리팩토링으로 복원했다면, 그 경계를 적합성 함수로 등록해 이후 변경이 다시 무너뜨리지 못하게 한다. 이것이 리팩토링을 *일회성 청소*가 아니라 *지속 보장*으로 바꾼다.

## 7. 다음 문서

- 의미 보존 verdict 스키마 → [20-contracts.md](20-contracts.md) §SemanticCompatibility
- 리팩토링을 포함한 변경 lifecycle → [10-methodology.md](10-methodology.md) 단계 5·6·8
- 리팩토링 범위의 ICL 선언 → [30-intent-change-dsl.md](30-intent-change-dsl.md)
