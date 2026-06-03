---
title: "ACG v0 — DITTO Binding Implementation Plan"
kind: plan
last_updated: 2026-06-03 KST
status: draft
scope: "ACG 스펙 계층(00~50)의 첫 번째 바인딩인 DITTO 바인딩을 코드로 내리는 v0 범위·작업단위·수용기준·증거를 권위있게 적재한다. 이 문서가 v0 in/out scope의 단일 진실원이다(dialectic-5 OBJ-59)."
parent: 00-framework.md
reviews: [reviews/dialectic-4.json, reviews/dialectic-5.json]
---

# ACG v0 — DITTO Binding Implementation Plan

> **이 문서의 위치.** [00](00-framework.md)의 스펙 계층을 DITTO에 끼워 맞추는 **첫 번째 바인딩**의 구현 계획이다. dialectic-4가 "전면 NO-GO", dialectic-5가 "doc-fix 후 조건부 GO"로 닫았고, 그 doc-fix는 반영됐다. 이 문서는 dialectic-5가 v0-scope로 분류한 항목(OBJ-51/55/56/57/59)을 **권위있게 적재**한다 — 더 이상 review ledger에만 있지 않다.

## 0. IntentContract (범위 보존)

- **달성할 결과**: ACG 스펙의 DITTO 바인딩을, 기존 DITTO 자산을 깨지 않고, *검증 가능한 좁은 슬라이스*로 동작시킨다.
- **이 v0가 아닌 것**: 전 8단계 lifecycle 자동화, 다중 저장소(boxwood) 바인딩, fitness 실행 엔진. 이것들은 후속 work item.
- **stack-agnostic 유지**: v0는 DITTO 바인딩 *하나*만 구현한다. 스펙(00~50)은 건드리지 않는다(이미 dialectic-5까지 lock). 두 번째 바인딩(boxwood)이 스펙의 저장소 독립성을 검증할 때까지 호스트-추상 기계는 만들지 않는다(Charter §4-3).

## 1. v0 IN-scope (착수 표면)

dialectic-4가 합의한 4 include + dialectic-5가 v0-scope로 내린 바인딩 정밀화 항목.

| WU | 작업 | 닫는 항목 |
|---|---|---|
| **WU-1** | 9개 ACG 스키마를 DITTO 바인딩 형태로 정의(Zod SoT→JSON Schema export) | 스펙→코드, OBJ-31/32/57 |
| **WU-2** | cross-ref 정합 conformance 테스트(=dialectic-4 verification_gaps fixture) | 실행증명 0 해소 |
| **WU-3** | ICL→ChangeContract 컴파일러(결정론 변환기) | OBJ-33/34 실증 |
| **WU-4** | ReviewGraph ↔ reviewer-output 어댑터 | OBJ-36/51/52/53 |
| **WU-5** | JourneyRun ↔ e2eJourney 어댑터 + e2eJourney envelope/journey_id 보강 | OBJ-39/55/56 |
| **WU-6** | 완료 게이트 배선(CompletionContract 거버넌스 슬롯 + Stop 훅 ReviewGraph ledger 독해) | OBJ-37/48/58 |

## 2. v0 OUT-of-scope (명시적·권위적 — OBJ-59 적재)

아래는 **v0에서 구현하지 않는다.** 미해소 열린질문(Q3/Q4)에 의존하거나, provider를 요구하기 때문이다. v0 표면을 이 밖으로 넓히면 즉시 blocker로 복귀한다(dialectic-4).

| 제외 항목 | 이유 | 의존 |
|---|---|---|
| 단계 3 impact 게이트("caller 누락 0") | 심볼/호출 그래프 provider 필요 | Q3, OBJ-40 |
| 단계 6 boundary 게이트 | ArchitectureSpec 부트스트랩 미정 | Q3, OBJ-46 |
| 단계 6 semantic 게이트 강제 | SemanticCompatibility↔acceptance 연결 규칙 미정 | OBJ-43 |
| 단계 8 FitnessFunction 실행/스케줄러 | 비용·selection 알고리즘 미정 | Q4, OBJ-41/47 |
| PreToolUse forbidden_scope 집행 | v0 schema slice 밖 | OBJ-44 |
| Change Map 렌더러(Mermaid) | 텍스트 정본만 v0, 다이어그램 후속 | — |
| FitnessFunction `executed` mode, Assurance 주기 평가 | e2e 실행 비용·flaky | Q4 |

> SemanticCompatibility·FitnessFunction·AssuranceSnapshot·ArchitectureSpec·ImpactGraph·JourneySpec **스키마 자체는 WU-1에 포함**(정의·검증). 빠지는 것은 그것들을 *실행·집행하는 게이트/러너*다.

## 3. [DECIDED] 기술 결정 (기본값 — 절차 위임 안 함)

되돌리기 어려운 것만 표시. 구현 세부는 구현자 재량.

- **D1 — envelope: DITTO-native.** ACG 산출물은 별도 wire envelope를 만들지 않고 DITTO envelope(`schema_version`/`work_item_id`/`id`)를 쓴다. `acg.<name>.v1`은 `$id`/`kind`로만 남는다. (스펙 §0.1·바인딩 §0.2 그대로.) [DECIDED]
- **D2 — 스키마 SoT: Zod.** ADR-0002(Schema source of truth)에 따라 `src/schemas/acg-*.ts`(Zod)를 SoT로 두고 `schemas/acg-*.schema.json`은 `scripts/export-schemas` 패턴으로 생성. 손으로 JSON Schema 두 벌 관리 금지. [DECIDED]
- **D3 — ReviewGraph: 확장 객체.** reviewer-output을 mutate하지 않고 별도 `acg_review` 확장 객체(role/risk/risk_reason/unresolved/journey_id/human_review_set)로 싣는다. reviewer-output의 `additionalProperties` 정책을 깨지 않는다. (OBJ-51 결정.) [DECIDED]
- **D4 — journey 연결: 신규 필드.** e2eJourney에 `journey_id`(JourneySpec.id 참조)와 envelope 필드(`work_item_id` 등)를 **추가**한다. `journey`(이름) 오버로드 금지. 기존 e2eJourney 소비처 회귀 없게 옵셔널로. (OBJ-55/56 결정.) [DECIDED]
- **D5 — 완료 게이트: ledger + 슬롯.** ReviewGraph는 `.ditto/runs/<wi>/`에 ledger로 떨군다. Stop 훅이 그 ledger를 읽어 high-risk/unresolved 미해소 시 continuation 강제. CompletionContract에 거버넌스 입력 슬롯(옵셔널) 추가. 별도 gate 신설 안 함. (OBJ-37/48/58 결정.) [DECIDED]
- **D6 — ICL 컴파일러: 얇은 변환기.** 거대 런타임 없이 `.icl`→ChangeContract(+선택적 FitnessFunction) JSON 변환만. Change Map(C 타깃)·Agent 제약(A 타깃)은 v0에서 텍스트 산출까지만, 집행(PreToolUse)은 제외. [DECIDED]

## 4. 작업 단위 (target / acceptance / evidence)

순서는 Tidy First — 구조적 토대(스키마) 먼저, 동작(어댑터·게이트) 나중. 각 WU는 독립 커밋 가능하게.

### WU-1 — ACG 스키마 정의 (구조적)
- **target**: `src/schemas/acg-*.ts` 9종(ChangeContract·ImpactGraph·ArchitectureSpec·SemanticCompatibility·ReviewGraph(acg_review)·FitnessFunction·AssuranceSnapshot·JourneySpec·JourneyRun) + export.
- **acceptance**: (a) 9 스키마가 D1 envelope 사용 (test). (b) ImpactGraph affected_node가 kind∈{ui_surface,user_journey}면 journey_id 필수·아니면 path 필수 (test). (c) AssuranceSnapshot violation_ids/new_violation_ids가 `uniqueItems` 집합 (test, OBJ-57). (d) `scripts/export-schemas`로 JSON Schema 생성·ajv 로드 성공 (build).
- **evidence**: ajv compile 로그, zod 단위테스트 결과.

### WU-2 — cross-ref conformance 테스트 (구조적)
- **target**: dialectic-4 `verification_gaps`를 테스트로.
- **acceptance**: (a) evidence_kind 7값·fitness_kind 9값·scope_kind→public_surface 매핑이 코드 상수와 문서 enum 일치 (test). (b) journey_id 참조 무결성(ImpactGraph/ReviewGraph/JourneyRun→JourneySpec.id) (test). (c) user_journey affected_node without path가 valid, with neither path nor journey_id가 invalid (test, OBJ-31).
- **evidence**: 테스트 통과 로그.

### WU-3 — ICL→ChangeContract 컴파일러 (동작적)
- **target**: `.icl` 파서 + ChangeContract(+FitnessFunction) 방출.
- **acceptance**: (a) 30 §5 boxwood 예시 `.icl`이 ChangeContract schema valid JSON으로 컴파일 (test). (b) `surface`→`public_surface`, `as`→`note`, `cmd/query`→`deterministic`, `judge`→`llm_judged` 매핑 (test, OBJ-33/34). (c) forbid 빈 블록·accept 빈 블록·allow/forbid 겹침이 컴파일 에러 (test). (d) `judge` 컴파일 시 reproducibility가 **object**로 채워짐 (test).
- **evidence**: 컴파일 입출력 fixture diff, schema valid 검증.

### WU-4 — ReviewGraph ↔ reviewer-output 어댑터 (동작적)
- **target**: reviewer-output → `acg_review` 확장 투영/역투영.
- **acceptance**: (a) reviewer-output finding이 acg_review file 항목(role/risk/risk_reason/evidence)으로 투영, 직렬화 왕복 무손실 (test, OBJ-36). (b) unresolved가 evidence.kind가 아니라 `unresolved` marker로 실림 (test, OBJ-53). (c) role∈{ui,user_journey}면 journey_id로 식별(path 없이) (test, OBJ-52). (d) reviewer-output `additionalProperties` 정책 불변 (test, D3).
- **evidence**: 왕복 직렬화 테스트, 기존 reviewer-output 스냅샷 회귀 없음.

### WU-5 — JourneyRun ↔ e2eJourney 어댑터 + envelope 보강 (동작적)
- **target**: e2eJourney에 journey_id/envelope 필드 추가 + JourneyRun 매핑.
- **acceptance**: (a) e2eJourney result(pass/fail/blocked)→JourneyRun outcome(pass/fail/skipped) 매핑, blocked→skipped (test, OBJ-39). (b) journey_id/work_item_id 필드 추가가 기존 e2e 소비처 회귀 없음 (test, OBJ-55/56·D4). (c) flaky는 산출하지 않음을 어댑터가 명시(주석/타입) (review).
- **evidence**: 어댑터 테스트, 기존 e2e 스킬 스냅샷 회귀 없음.

### WU-6 — 완료 게이트 배선 (동작적)
- **target**: ReviewGraph ledger + Stop 훅 독해 + CompletionContract 슬롯.
- **acceptance**: (a) `.ditto/runs/<wi>/`의 ReviewGraph ledger에 미해소 high-risk가 있으면 Stop이 continuation 강제 (test, OBJ-37/58). (b) 미해소 없으면 통과 (test). (c) CompletionContract 거버넌스 슬롯이 옵셔널이라 기존 완료 흐름 회귀 없음 (test, D5).
- **evidence**: Stop 훅 단위테스트(미해소→continue, 해소→pass), 기존 stop 테스트 회귀 없음.

## 5. 검증 전략 (완료는 증거로)

- 각 WU는 기존 DITTO 테스트 스위트(메모리 기준 800+ pass)에 회귀를 내지 않아야 한다 — `npm test`(또는 repo 명령) green이 모든 WU의 공통 게이트.
- v0 전체 완료 기준: WU-1~6 acceptance 전부 evidence로 닫힘 + 회귀 0 + `ditto:verify`로 독립 재검증.
- 착수 전 권장: WU 분해를 autopilot 노드 그래프로 내리기 전에 이 플랜 자체를 `ditto:verify` 대상으로 한 번 더 확인.

## 6. 위험과 되돌리기

| 위험 | 완화 |
|---|---|
| e2eJourney 필드 추가가 기존 e2e 스킬 깨뜨림 | 전부 옵셔널 필드, 스냅샷 회귀 테스트(WU-5 acc-b) |
| CompletionContract 슬롯이 기존 완료 막음 | 옵셔널 슬롯, 미존재 시 기존 동작(WU-6 acc-c) |
| reviewer-output 확장이 reviewer 에이전트 출력과 충돌 | 별도 acg_review 객체(D3), reviewer-output 불변 |
| ICL 파서가 과설계로 번짐 | D6 — ChangeContract 변환만, 집행 제외 |

## 7. 다음

이 플랜은 **설계까지**다. 실제 구현은 별도 work item(autopilot 노드 그래프)로 착수한다. WU-1(스키마)이 진입점 — 나머지가 전부 거기에 의존한다.
