---
title: "ACG v0 — DITTO Binding Implementation Plan"
kind: plan
last_updated: 2026-06-04 KST
status: implemented
scope: "ACG 스펙 계층(00~50)의 첫 번째 바인딩인 DITTO 바인딩을 코드로 내리는 v0 범위·작업단위·수용기준·증거를 권위있게 적재한다. 이 문서가 v0 in/out scope의 단일 진실원이다(dialectic-5 OBJ-59). 2026-06-04: 코드베이스 대조로 실제 구현 상태를 적재."
parent: 00-framework.md
reviews: [reviews/dialectic-4.json, reviews/dialectic-5.json, reviews/dialectic-6.json]
---

# ACG v0 — DITTO Binding Implementation Plan

> **이 문서의 위치.** [00](00-framework.md)의 스펙 계층을 DITTO에 끼워 맞추는 **첫 번째 바인딩**의 구현 계획이자 **현재 구현 상태의 진실원**이다. dialectic-4 "전면 NO-GO" → dialectic-5 "doc-fix 후 조건부 GO" → 구현 착수 → **2026-06-04 기준 WU-1~6 전부 구현·테스트 통과**.

> **구현 상태 요약 (2026-06-04, 코드 대조).** v0는 "설계까지"가 아니라 **실제로 동작한다.** WU-1~6 전부 구현되고 각 WU의 acceptance가 테스트로 닫혔다. 그뿐 아니라 §2에서 v0 OUT-of-scope로 명시했던 **단계 3 impact 게이트·단계 6 boundary 게이트·ArchitectureSpec 부트스트랩·단계 8 fitness 스케줄러/러너 + CodeQL provider도 이후 구현되어 IN으로 이동**했다(commit `4f64a19` 등). 따라서 [10](10-methodology.md)·[00](00-framework.md)·[60](60-practice-ingestion-map.md)의 "v0 작업/아직 도는 동작이 아님/미구현" 주석은 갱신 대상이다(이 개정과 함께 정정).

## 0. IntentContract (범위 보존)

- **달성할 결과**: ACG 스펙의 DITTO 바인딩을, 기존 DITTO 자산을 깨지 않고, *검증 가능한 좁은 슬라이스*로 동작시킨다. — **달성됨.**
- **이 v0가 아닌 것**: 전 8단계 lifecycle *완전* 자동화, 다중 저장소(boxwood) 바인딩, fitness `executed` mode 실행 엔진. (단계 3/6/8의 deterministic 게이트는 당초 후속이었으나 v0 내에 흡수됨 — §2 참조.)
- **stack-agnostic 유지**: v0는 DITTO 바인딩 *하나*만 구현한다. 스펙(00~50)의 **규범 내용은 건드리지 않는다**(dialectic-5까지 lock). 단 스펙 문서에 박힌 *구현 상태 주석*("미구현/v0 작업")은 사실이 바뀌면 갱신한다 — 규범이 아니라 진척 메모이기 때문이다. 호스트-추상 기계는 두 번째 바인딩(boxwood) 전까지 만들지 않는다(Charter §4-3).

## 1. v0 IN-scope — 구현 상태 (착수 표면)

| WU | 작업 | 상태 | 구현 | 증거(테스트) |
|---|---|---|---|---|
| **WU-1** | 9개 ACG 스키마 정의(Zod SoT→JSON Schema export) | ✅ done | `src/schemas/acg-*.ts` 9종 + `acg-common.ts`; `scripts/export-schemas.ts`(결정론·byte-identical) | `tests/schemas/acg-schemas.test.ts`, `acg-conformance.test.ts` — 24 pass |
| **WU-2** | cross-ref 정합 conformance 테스트 | ✅ done | enum 정합(evidence_kind 7·fitness_kind 9·scope→public_surface)·journey_id 무결성 | `tests/schemas/acg-conformance.test.ts` — 24 pass |
| **WU-3** | ICL→ChangeContract(+FitnessFunction) 컴파일러 | ✅ done | `src/acg/icl/{tokenizer,parser,ast,compile,static-check,index}.ts` | `tests/acg/icl-compiler.test.ts` — 14 pass |
| **WU-4** | ReviewGraph ↔ reviewer-output 어댑터 | ✅ done | `src/acg/review/acg-review-adapter.ts` + `src/schemas/acg-review-graph.ts`(별도 `acg_review` 객체, D3) | `tests/acg/acg-review-adapter.test.ts`(5) + `acg-review-producer.test.ts`(8) |
| **WU-5** | JourneyRun ↔ e2eJourney 어댑터 + envelope 보강 | ✅ done | `src/acg/journey/journey-run-adapter.ts`; `e2e-journey.ts`에 `journey_id`/`work_item_id` 옵셔널 추가(D4) | `tests/acg/journey-run-adapter.test.ts` — 10 pass |
| **WU-6** | 완료 게이트 배선(CompletionContract 슬롯 + Stop 훅 ledger 독해) | ✅ done·**가동** | `src/hooks/stop.ts`(high-risk no-evidence → exit 2 continuation) + `completion-contract.ts` `acg_governance` 옵셔널 슬롯 + `src/core/acg-review-store.ts` | `tests/hooks/stop.test.ts` acc-a/b/c + `acg-review-producer.test.ts` — 48 pass |

> **WU-6는 단순 "슬롯 추가"가 아니라 실제로 도는 게이트다.** Stop 훅이 `.ditto/work-items/<wi>/acg-review.json` ledger를 읽어 미해소 high-risk(증거 없는 high) 발견 시 `exitCode:2`로 continuation을 강제한다(`stop.ts`). 같은 Stop 훅이 fitness 위반(`assuranceSnapshotForcesContinuation`)·impact unresolved(`impactForcesContinuation`)도 소비한다. host hook으로 등록됨(명령 등록 `hooks/hooks.json`, capability 인벤토리 `src/core/hosts/claude-code.ts`).

## 2. v0 OUT-of-scope — 이후 변화 반영 (OBJ-59 적재)

당초 OUT으로 적재했으나 **이후 구현되어 IN으로 이동한 항목**과, **여전히 OUT인 항목**을 분리한다.

### 2.1 이후 구현됨 (원래 OUT → 현재 done)

| 항목 | 구현 | 증거 | 해소된 의존 |
|---|---|---|---|
| 단계 3 impact 분석 + 게이트 | graph 생성·caller 해석(누락 0)은 analyzer/CLI `src/acg/impact/{impact-graph,ts-analyzer}.ts`(심볼 해석·텍스트검색 아님) + `cli/commands/impact.ts`. Stop 게이트(`stop.ts` `impactForcesContinuation`)는 `unresolved[]` 항목만 continuation 강제(caller 해석 자체는 analyzer 몫) | `tests/acg/impact-graph.test.ts` — 7 pass(동명 decoy 미매칭·unknown→unresolved) | Q3, OBJ-40 |
| 단계 6 boundary 게이트 | `src/acg/boundary/{boundary,ts-edges}.ts`(alias 인지 import 해석) + `cli/commands/boundary.ts`(ledger 투영) | `tests/acg/boundary.test.ts`(layer 위반·alias 회귀) | Q3, OBJ-46 |
| ArchitectureSpec 부트스트랩 | `src/acg/architecture/propose.ts`(비권위 candidate 제안, `forbidden_dependencies=[]` 자동박제 금지, ADR-0004) | `tests/acg/architecture-propose.test.ts` | Q3 (boundary 선결) |
| 단계 8 FitnessFunction 실행/스케줄러 | `src/acg/fitness/fitness-runner.ts`(`scheduleDecision` 비용정책·fail-closed escalate, `runFitness`→AssuranceSnapshot) + `cli/commands/fitness.ts` + Stop 게이트 | `tests/acg/fitness-runner.test.ts` — 13 pass | Q4, OBJ-41/47 |
| CodeQL deterministic provider | `src/acg/fitness/codeql-provider.ts`(SARIF→정규화 violation identity, raw line 제외) + `cli` `codeql-sarif:<path>` | `tests/acg/fitness-codeql-provider.test.ts` — 7 pass(line 이동 동일성 보존) | — |

### 2.2 ~~여전히 OUT (미구현)~~ → 전부 IN (2026-06-05 마무리, wi_260605acg 코드 대조)

> **갱신.** 2026-06-04 기준 OUT이던 항목이 이후 전부 구현·테스트되어 IN으로 이동했다.
> ACG v0 governance 표면에 **미구현 항목 없음**(아래 표는 폐지된 OUT 목록의 종결 기록).

| 과거 OUT 항목 | 현재 상태 | 구현·증거 |
|---|---|---|
| FitnessFunction `executed` mode **실행** | ✅ DONE | `src/acg/fitness/executed-provider.ts`(flake/timeout/retry, real-spawn 라우팅) · `tests/acg/fitness-executed.test.ts` |
| Assurance drift 집계 | ✅ DONE | `src/acg/fitness/drift.ts` · `tests/acg/fitness-drift.test.ts` |
| 단계 6 semantic 게이트 *강제* | ✅ DONE | 소비(sg1)+생산자(sv1)+diff 자동추출(de1)+characterization 게이트(ch1)+다언어 바인딩(ml1)+자동배선(aw1). `tests/hooks/stop.test.ts`·`tests/acg/signature-codeql*` |
| PreToolUse forbidden_scope 집행 | ✅ DONE | path/glob/layer/public_surface는 hot-path 즉시 집행(`src/acg/scope/resolve.ts`), `symbol`은 계약 저장 시점 CodeQL 해소(`src/acg/scope/symbol-expand.ts`→path 치환). `tests/hooks/pre-tool-use.test.ts`·`tests/acg/symbol-expand.test.ts` |
| Change Map 렌더러(Mermaid) | ✅ DONE | `src/acg/change-map/render.ts` · `tests/acg/change-map-mermaid.test.ts` |

> **남은 micro-item은 "구현 안 함"으로 명시 종결**(ADR-0009): semantic-scan-status.json(복잡성>효과), nudge opt-out(실 신호 은폐 위험), executed 자동-stop 트리거(CodeQL 비용 — opt-in 유지), 어휘 enum 승격(표본 1 — premature). 각 철회조건은 ADR-0009.
>
> 스키마(SemanticCompatibility·FitnessFunction·AssuranceSnapshot·ArchitectureSpec·ImpactGraph·JourneySpec)는 전부 WU-1에 정의·검증됨. 그 실행·집행 러너/게이트도 위와 같이 전부 IN이다.

## 3. [DECIDED] 기술 결정 (구현으로 확정됨)

- **D1 — envelope: DITTO-native.** ACG 산출물은 DITTO envelope(`schema_version`/`work_item_id`/`id`/`kind`)를 쓴다. `acg.<name>.v1`은 `kind` 디스크리미네이터로 실린다(`acg-common.ts`). [DONE]
  - *바인딩 귀결*: `FitnessFunction`의 vocabulary 필드는 코드에서 `fitness_kind`다 — `kind`가 envelope 리터럴에 점유됐기 때문(`acg-fitness-function.ts`). 9개 값은 [20](20-contracts.md) §6과 동일.
- **D2 — 스키마 SoT: Zod.** `src/schemas/acg-*.ts`(Zod)가 SoT, `schemas/acg-*.schema.json`은 `scripts/export-schemas.ts`로 생성(결정론·재실행 시 무변경). [DONE]
- **D3 — ReviewGraph: 확장 객체.** reviewer-output을 mutate하지 않고 별도 `acg_review` 객체로 싣는다(`acg-review-graph.ts`). reviewer-output 스키마 불변(회귀 테스트). [DONE]
- **D4 — journey 연결: 신규 필드.** e2eJourney에 `journey_id`·`work_item_id`를 **옵셔널** 추가, `journey` 이름 오버로드 안 함. 기존 소비처 회귀 없음. [DONE]
- **D5 — 완료 게이트: ledger + 슬롯.** ReviewGraph를 **`.ditto/work-items/<wi>/acg-review.json`** ledger로 떨구고(원래 D5 문구의 `.ditto/runs/<wi>/`에서 **실제 구현은 work-item 디렉터리로 변경** — 다른 Stop ledger 관례와 통일, 스펙 00~50은 경로를 못박지 않음), Stop 훅이 읽어 미해소 시 continuation 강제. CompletionContract에 옵셔널 `acg_governance` 슬롯 추가. [DONE]
- **D6 — ICL 컴파일러: 얇은 변환기.** `.icl`→ChangeContract(+FitnessFunction) JSON 변환만, 집행(PreToolUse) 제외. B 타깃만, A/C 미방출. [DONE — 과설계로 안 번짐]

## 4. 작업 단위 — acceptance 충족 증거

각 WU의 acceptance가 테스트로 닫힌 상태. (이하 acceptance는 원안 유지, 상태만 갱신.)

### WU-1 — ACG 스키마 정의 ✅
- acceptance (a)~(d) 전부 충족: 9 스키마 D1 envelope, journey_id/path 상호배제, AssuranceSnapshot uniqueItems, export+로드. 증거: `tests/schemas/acg-schemas.test.ts`·`acg-conformance.test.ts`(24 pass), `scripts/export-schemas.ts` 결정론.

### WU-2 — cross-ref conformance ✅
- enum 정합(evidence_kind 7·fitness_kind 9·scope→public_surface)·journey_id 참조 무결성·user_journey 노드 path/journey_id 규칙 — 전부 테스트. 증거: `acg-conformance.test.ts`.

### WU-3 — ICL→ChangeContract 컴파일러 ✅
- boxwood `.icl`→valid ChangeContract, `surface→public_surface`·`as→note`·`cmd/query→deterministic`·`judge→llm_judged(+reproducibility object)`, 빈 forbid/accept·overlap 컴파일 에러. 증거: `tests/acg/icl-compiler.test.ts`(14), fixture `tests/acg/fixtures/retry-policy.icl`.

### WU-4 — ReviewGraph 어댑터 ✅
- reviewer-output→`acg_review` 투영 왕복 무손실, `unresolved`는 evidence.kind 아닌 별도 marker, role∈{ui,user_journey}→journey_id 식별, reviewer-output 불변. 증거: `acg-review-adapter.test.ts`·`acg-review-producer.test.ts`.

### WU-5 — JourneyRun 어댑터 + envelope ✅
- e2e result→outcome(blocked→skipped, flaky 미산출), journey_id/work_item_id 옵셔널 추가 회귀 없음. 증거: `journey-run-adapter.test.ts`(10).

### WU-6 — 완료 게이트 배선 ✅·가동
- 미해소 high-risk → Stop continuation 강제(exit 2), 미해소 없으면 통과, `acg_governance` 옵셔널이라 기존 완료 회귀 없음. 증거: `tests/hooks/stop.test.ts` acc-a/b/c, `acg-review-producer.test.ts`(48 pass).

## 5. 검증 전략 (완료는 증거로) — 충족됨

- 각 WU는 기존 DITTO 스위트에 회귀 없음 — ACG 영역 테스트(스키마 24 + icl 14 + review 13 + journey 10 + stop 48 + impact/boundary/fitness 42)가 green. 전체 `bun test` 회귀 0이 공통 게이트.
- v0 완료 기준: WU-1~6 acceptance 전부 evidence로 닫힘 + 회귀 0. **충족.** 독립 재검증(`ditto:verify`)은 후속 확인 권장.

## 6. 위험과 되돌리기 (사후)

| 위험 | 결과 |
|---|---|
| e2eJourney 필드 추가가 기존 e2e 깨뜨림 | 옵셔널 필드 + 회귀 테스트로 차단됨(WU-5 acc-b green) |
| CompletionContract 슬롯이 기존 완료 막음 | 옵셔널 슬롯, 미존재 시 기존 동작(WU-6 acc-c green) |
| reviewer-output 확장 충돌 | 별도 `acg_review` 객체(D3), reviewer-output 불변 회귀 테스트 |
| ICL 파서 과설계 | D6 유지 — ChangeContract 변환만, A/C/집행 제외 확인 |

## 7. 남은 작업 (다음 work item)

v0 핵심(WU-1~6)은 닫혔다. 남은 것은 §2.2와 후속 바인딩이다:

1. **FitnessFunction `executed` mode 실행 provider** — 스케줄은 됨, e2e 실행 엔진 미구현(Q4 비용).
2. **Assurance drift 집계 뷰** — snapshot 시계열을 SLOP 추세로 투영하는 소비처.
3. **단계 6 semantic 게이트 강제** — SemanticCompatibility↔acceptance 연결 규칙(OBJ-43).
4. **PreToolUse forbidden_scope 집행** — ICL 텍스트 산출을 런타임 집행으로(OBJ-44).
5. **Change Map Mermaid 렌더러** — 텍스트 정본→다이어그램.
6. **두 번째 바인딩(boxwood)** — 스펙의 저장소 독립성 검증, 그때 호스트-추상 기계 도입 여부 결정.
