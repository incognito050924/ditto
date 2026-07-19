# acg-review — reviewer-output을 acg_review 위험 원장으로 사영해 완료를 차단하는 게이트 생산기

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋: `c2d2e16` (2026-07-19).

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto acg-review`는 리뷰 결과(`reviewer-output`)를 **위험 분류 원장**(`acg_review`, 스키마 `acg.review-graph.v1`)으로 변환해 work item 디렉터리에 남기는 **생산기(producer)**다. 이 원장은 그 자체로 끝이 아니라, Stop 게이트(`acgReviewForcesContinuation`)가 읽어 **증거 없는 고위험 변경이 남아 있으면 완료를 차단**하는 데 쓰인다(`src/hooks/stop.ts:318-329`, `:1001`).

핵심 개념은 ACG의 **Review by Exception(예외만 사람이 판단)**이다. 전체 diff를 사람이 다 보는 게 아니라, 위험도로 분류해 **사람이 반드시 판단해야 할 최소 예외 집합**(`human_review_set`)만 뽑는다(`src/schemas/acg-review-graph.ts:4-6`, `:76`).

DITTO 4축 분류상 이 기능은 **거버넌스(변경 거버넌스)** 축에 속한다. ACG(Agentic Change Governance)는 "모든 코드베이스용 변경 거버넌스"를 스펙/바인딩 2계층으로 두고 DITTO를 첫 바인딩으로 삼는데(`src/schemas/acg-common.ts:4-13`), `acg-review`는 그 바인딩 D3(ReviewGraph↔reviewer-output) 규칙의 CLI 진입점이다(`src/acg/review/acg-review-adapter.ts:5-20`).

의도의 뿌리 하나: **위험 판정은 코드가 하지 LLM이 손으로 계산하지 않는다.** severity→risk 사상은 결정론적 어댑터 코드다(진입 파일 주석 `src/cli/commands/acg-review.ts:19-25`, 어댑터 `src/acg/review/acg-review-adapter.ts:22-35`). ADR-0006이 "거버넌스 게이트의 입력은 결정론적 정적 사실이어야 한다"고 못박은 것과 같은 원칙이다(`ADR-0006` 컨텍스트: "LLM 구조 추론은 규모 비례로 부정확하다").

## 2. 코드 위치와 진입점

| 경로 | 역할 |
|---|---|
| `src/cli/commands/acg-review.ts` | CLI 진입점. `--from` reviewer-output을 읽어 어댑터로 사영하고 store에 기록 |
| `src/acg/review/acg-review-adapter.ts` | 순수 함수 어댑터. `projectReviewerOutputToAcgReview` — severity→risk, unverified→unresolved, human_review_set 파생 |
| `src/core/acg-review-store.ts` | `AcgReviewStore` — 원장을 `.ditto/local/work-items/<wi>/acg-review.json`에 스키마 검증 + 원자적 기록 |
| `src/schemas/acg-review-graph.ts` | zod 스키마(SoT, ADR-0002). `acgReviewGraph`(`acg.review-graph.v1`), `acgReviewFile` |
| `src/schemas/acg-common.ts` | ACG 공통 스키마. `acgEvidenceKind`, 봉투(envelope) 헬퍼 |
| `src/acg/review/unit-review.ts` | **standing-code**(작업항목 무관, 아키텍처 단위 전수)용 짝. `planUnitReview`/`aggregateUnitReview` — `ditto review`가 소비 |
| `src/hooks/stop.ts:318-329` | 소비처. `acgReviewForcesContinuation` — 증거 없는 high-risk면 완료 차단 |

### 서브커맨드·CLI 인자 (`ditto acg-review`)

이 커맨드는 서브커맨드가 없는 단일 명령이다(`src/cli/commands/acg-review.ts:27-50`).

| 인자 | 타입 | 필수 | 의미 |
|---|---|---|---|
| `--from` | string | 예 | 사영할 reviewer-output JSON 경로 |
| `--work-item` | string | 아니오 | 원장을 기록할 work item id. 없으면 `reviewer-output.work_item_id` 사용 (`:77`) |
| `--output` | string | 아니오 | `human`\|`json` (기본 `human`) |

> 주의: `ditto acg-review`(work-item 범위, 이 문서)와 `ditto review`(standing-code, 아키텍처 단위 전수)는 다른 커맨드다. 둘 다 같은 어댑터를 재사용하고 같은 `acg-review.json` 원장에 기록하지만, 전자는 리뷰 1건 사영, 후자는 여러 role output 집계(`aggregateUnitReview`)다(`src/acg/review/unit-review.ts:1-21`).

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

```
reviewer-output.json (--from)
   │  Bun.file(...).text() → JSON.parse → reviewerOutput.parse   (src/cli/commands/acg-review.ts:65-66)
   │      실패(파일 없음/깨진 JSON/스키마 위반) → USAGE_ERROR_EXIT, 아무것도 안 씀 (fail-closed)
   ▼
projectReviewerOutputToAcgReview(parsedOutput)                    (adapter, 순수 함수)
   │  findings[]  → files[] { path, risk=severity사상, risk_reason, unresolved:false }
   │  unverified[] → files[] { path=item, risk:'low', risk_reason=reason, unresolved:true }
   │  human_review_set = files 중 (risk==='high' ∨ unresolved===true)의 path|journey_id (중복제거)
   ▼
AcgReviewStore.write(workItemId, graph)                            (writeJson, 스키마 재검증)
   ▼
.ditto/local/work-items/<wi>/acg-review.json   ── 읽힘 ──▶  Stop 게이트 acgReviewForcesContinuation
```

- **입력 상태**: reviewer-output JSON. 스키마 `src/schemas/reviewer-output.ts` — `work_item_id`, `findings[]{severity,file?,reason}`, `unverified[]{item,reason}`(`:41,:54,:55`).
- **출력 상태**: `.ditto/local/work-items/<wi>/acg-review.json`, 스키마 `acgReviewGraph`. 경로는 `localDir(repoRoot,'work-items',wi,'acg-review.json')`로 조립(`src/core/acg-review-store.ts:17-19`).
- 이 원장은 **자체 봉투가 없다**(work_item_id/schema_version 필드 없음). reviewer-output에 얹히는 확장 객체(extension object)라서, work item id는 그래프에서 읽지 않고 store에 **명시적으로 넘긴다**(`src/core/acg-review-store.ts:5-13`, 스키마 주석 `src/schemas/acg-review-graph.ts:6-11`).

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

- **결정론적 severity→risk (LLM 배제).** `critical|high → high`, `medium → medium`, 그 외 → `low`(`src/acg/review/acg-review-adapter.ts:26-34`). 위험 판정을 코드로 고정해 LLM의 손계산을 배제한다. ADR-0006(정적 사실은 결정론 엔진에서)의 위험 판정판이다.

- **Review by Exception — human_review_set.** 전체가 아니라 `risk==='high' ∨ unresolved===true`인 파일만 사람 판단 집합에 넣는다(`src/schemas/acg-review-graph.ts:76-77`, 파생 로직 `adapter:78-85`). 스키마 설명이 "not the whole diff"라고 명시(`acg-review-graph.ts:77`).

- **게이트 키 = "고위험 ∧ 증거 없음", `unresolved`가 아님.** Stop 게이트는 `high ∧ evidence===undefined`로 차단한다(`src/hooks/stop.ts:321`). 왜 `unresolved`로 안 하나: 어댑터가 `unverified[]`를 항상 `risk:'low'`로 고정하므로(`adapter:62-67`) `high ∧ unresolved`는 절대 생기지 않아 게이트가 무력화된다. 그래서 "증거 없는 고위험"을 키로 삼아야 실제로 발화한다(`src/hooks/stop.ts:312-316`).

- **unresolved는 evidence.kind가 아니라 별도 플래그(OBJ-53).** 증거 부재 표식을 evidence 종류로 넣지 않고 독립 boolean으로 둔다(`src/schemas/acg-review-graph.ts:47-49`, `adapter:16-18`). 증거의 "종류"와 증거의 "부재"를 개념적으로 분리한다.

- **Fail-closed 입력.** reviewer-output이 없거나/깨졌으면 non-zero로 종료하고 **아무것도 안 쓴다**(`src/cli/commands/acg-review.ts:61-75`). 깨진 입력이 조용히 빈(=통과) 원장을 만들지 못하게 한다.

- **관련 ADR.**
  - ADR-0006: 정적 분석/구조 추론 엔진을 CodeQL 단일로 통일, LLM을 1차 구조 추론 수단으로 쓰지 않음 — `acg-review`의 결정론 severity 사상과 같은 정신.
  - ADR-0017: 정리(Tidy/deslop) 워크플로를 ACG 게이트 위에 세우되 정리는 "동작 보존만"이고 **정합성/보안 리뷰는 별도 형제 표면 `ditto review`의 책임**이라고 분리(ADR-0017 D2). `acg-review`/`review`가 그 리뷰 표면이다.
  - ADR-0004: ACG fitness/architecture 비용·출처 정책. 위험 계층(risk tiering)의 base가 계산 점수가 아니라 수동 enum이라는 "안전 불변식"과 결이 같다(ADR-0004 "안전 불변식").

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### `acgReviewCommand.run` (`src/cli/commands/acg-review.ts:51-104`)
- 입력: `--from`, `--work-item?`, `--output`.
- 하는 일: (1) 포맷 파싱, (2) reviewer-output 읽기+검증, (3) 어댑터 사영, (4) store 기록, (5) 요약 출력.
- 산출 효과: `acg-review.json` 파일 생성 + `high_risk_without_evidence` 개수 리포트.
- 미묘한 결정:
  - `const workItemId = args['work-item'] ?? parsedOutput.work_item_id;`(`:77`) — CLI 인자가 우선, 없으면 입력에서 파생.
  - 요약의 위험 카운트가 게이트와 **동일 술어**를 쓴다: `f.risk === 'high' && f.evidence === undefined`(`:83-85`). 즉 CLI가 보고하는 숫자와 Stop이 막는 조건이 일치한다(gate↔report 정합).
  - 읽기 실패는 `USAGE_ERROR_EXIT`, store 쓰기 실패는 `RUNTIME_ERROR_EXIT`로 종류를 구분(`:73`, `:102`).

### `projectReviewerOutputToAcgReview` (`src/acg/review/acg-review-adapter.ts:46-88`)
- 입력: `ReviewerOutput`. 출력: 검증된 `AcgReviewGraph`. I/O 없는 순수 함수.
- `findings` 처리: `file`이 없는 finding은 **버린다**(`:50-51`, `filter`). 스키마가 비-journey 파일에 path를 요구하므로 위치 없는 finding은 파일 항목이 될 수 없다. 남은 것은 `{path, risk, risk_reason, unresolved:false}`.
- `unverified` 처리: 각 항목을 `{path:item, risk:'low', risk_reason:reason, unresolved:true}`로(`:62-67`). **evidence 객체를 전혀 달지 않는다.**
- `human_review_set` 파생: 일단 draft를 `acgReviewGraph.parse`로 검증한 뒤(`:76`), `risk==='high' ∨ unresolved===true`인 파일의 `path ?? journey_id`를 중복 없이 모은다(`:78-85`). 마지막에 다시 parse(`:87`) — 두 번 검증해 반환 전 계약을 보장.
- 인과: severity가 critical/high인 finding은 곧바로 `risk:'high'`이고 evidence가 없으므로, **이 생산기가 만든 원장에서 그 파일은 즉시 Stop 게이트를 발화시킨다.**

### `severityToRisk` (`:22-35`) / `fileIdentity` (`:37-40`)
- severity 5값을 risk 3값으로 접는다. `default`가 low라서 `info`/`low`뿐 아니라 스키마에 없는 값도 low로 안전 강등.
- identity는 `path ?? journey_id` — journey 항목은 path가 없고 journey_id로 식별(OBJ-52, 스키마 `acg-review-graph.ts:20-22`).

### `AcgReviewStore` (`src/core/acg-review-store.ts:14-32`)
- `write`는 `writeJson(path, acgReviewGraph, graph)` — 기록 시점에 스키마 재검증(원자적, CompletionStore 패턴 미러링, `:6-8`).
- `get`/`exists`도 같은 경로 규약. work item id는 **인자로만** 받는다(그래프에 봉투가 없으므로).

### `acgReviewForcesContinuation` (`src/hooks/stop.ts:318-329`) — 소비처
- 입력: `AcgReviewGraph`. 출력: 차단 사유 문자열 배열.
- `risk==='high' && evidence===undefined`인 파일마다 한글 사유 1건 생성(`:321-325`). low/medium은 절대 차단 안 함. high라도 evidence가 붙으면 통과.
- Stop hook은 `acg-review.json`을 다른 원장들과 함께 work-item 디렉터리에서 읽고(부재→no-op, 깨짐→fail-closed, `:761-765`), 사유를 `reasons`에 합류시킨다(`:1001`).

### `planUnitReview` / `aggregateUnitReview` (`src/acg/review/unit-review.ts`) — 짝 표면
- `acg-review`가 work item 1건 리뷰를 사영한다면, 이쪽은 아키텍처 **단위 전수**를 배치로 쪼개고(`:75-107`) 여러 role output을 한 원장으로 집계한다(`:115-125`). `aggregateUnitReview`는 같은 `projectReviewerOutputToAcgReview`를 output마다 재사용하고 files를 병합해 human_review_set을 재파생 — **재사용으로 severity→risk 결정론을 두 표면이 공유**한다. 소비 CLI는 `ditto review`(`src/cli/commands/review.ts`).

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위: `acg-review.ts`, `acg-review-adapter.ts`, `acg-review-store.ts`, `acg-review-graph.ts`, `acg-common.ts`, `unit-review.ts`, `stop.ts`의 관련 함수(정적 읽기). 테스트 실행·런타임 확인은 하지 않음(미검증).

- **의도대로 동작하는 부분(정적 확인):**
  - severity→risk 결정론 사상, fail-closed 입력, human_review_set 파생, 게이트가 CLI 리포트와 같은 술어 사용 — 코드가 주석의 의도와 일치.
  - 게이트가 `unresolved`가 아니라 "high ∧ no-evidence"를 키로 삼는 이유(무력화 방지)가 어댑터 동작(`unverified`→항상 low)과 정합 — 주석의 근거가 실제 코드로 성립(`stop.ts:312-316` ↔ `adapter:62-67`).

- **갭/주의(미확인 또는 설계상 공백):**
  1. **이 생산기 경로는 evidence를 절대 채우지 않는다.** `acg-review.ts`/어댑터 어디서도 `acgReviewFile.evidence`를 세팅하지 않는다. grep 확인 결과 `review-to-ledger.ts`·`boundary.ts`·`unit-review.ts` 어느 producer도 evidence 객체를 쓰지 않는다(확인: `grep -rn "evidence:" ...` → 매치 없음). 따라서 critical/high finding은 원장에 들어오는 순간 무조건 게이트를 발화하고, **이를 해소하는 유일한 코드 경로는 "근본 원인을 고쳐 리뷰를 다시 돌려 high finding이 없는 깨끗한 원장을 재생산"하는 것**이다(이 재생산 해소 모델은 `stop.ts:355-356` 주석이 impact 게이트에 대해 명시한 것과 동형). evidence 필드는 스키마상 존재하나(수동 편집/미래 소비처용), 현재 이 커맨드 흐름에서 자동으로 붙는 경로는 없음 — **재설계 시 "high finding을 evidence 첨부로 통과시키는" 시나리오를 원한다면 별도 배선이 필요**하다.
  2. **위치 없는 finding은 조용히 사라진다.** `file`이 undefined인 finding은 filter로 버려진다(`adapter:50-51`). 위험한 발견이라도 파일 경로가 없으면 원장에 안 남고 게이트도 못 건다. 이는 스키마 제약(비-journey는 path 필수)의 귀결이지만, **고위험 발견의 은닉 통로가 될 수 있다**(reviewer가 file을 안 채운 경우).

## 7. 잠재 위험·부작용·재설계 시 고려점

- **여러 생산기가 같은 원장 파일을 덮어쓴다.** `.ditto/local/work-items/<wi>/acg-review.json`은 최소 4곳이 쓴다: `ditto acg-review`, `ditto review`(unit), `ditto codeql review`(`src/cli/commands/codeql.ts:44`), `ditto boundary`(`src/cli/commands/boundary.ts:145`). `store.write`는 병합이 아니라 **전체 교체**다(`acg-review-store.ts:29-31`). 나중에 실행한 생산기가 앞의 결과를 지운다 — 재설계 시 "누가 최종 원장의 소유자인가", 또는 병합/append 모델이 필요한지 검토 대상. (미검증: 실제 오케스트레이션에서 어떤 순서로 쓰는지는 확인 안 함.)
- **보존해야 할 불변식:**
  - severity→risk는 코드가 소유(LLM 금지). 게이트 키 = "high ∧ no-evidence". CLI 리포트 술어 = 게이트 술어(둘을 어긋나게 하면 false-green).
  - fail-closed: 깨진 입력이 빈 통과 원장을 못 만든다.
  - 봉투 없음(D3): work item id는 그래프가 아니라 파일 위치/인자로만 운반.
- **재고 가능한 결정:**
  - `unresolved` 플래그가 게이트에 참여하지 않는 현 상태(low로 고정되어 사실상 human_review_set 파생과 표시용). 미해결 항목을 완료 차단에 넣을지는 열린 결정.
  - evidence 첨부 경로 부재(§6-1) — 고위험을 "고치지 않고 증거로 통과"시킬 필요가 생기면 배선 추가 필요.
- **drift 위험:** 이 문서는 코드 스냅샷(`c2d2e16`) 설명이다. 어댑터의 severity 사상, 게이트 키, 저장 경로가 바뀌면 본문과 어긋난다 — 권위는 코드/스키마/테스트에 있다.
