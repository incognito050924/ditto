# review — 아키텍처 단위(unit) 단위로 서 있는(standing) 코드를 일관성·보안 감사하는 결정적 seam

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋: `c2d2e16` (2026-07-19).

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto review --scope <unit>`는 **작업(work-item)의 diff가 아니라, HEAD 기준으로 지금 서 있는 코드 전체**를 아키텍처 단위 단위로 리뷰하기 위한 커맨드다. 사용자가 아키텍처 단위(`all | component:<name> | layer:<name> | api | <glob>`)를 이름으로 지목하면, 그 단위에 속하는 표준(standing) 소스 파일 집합을 해석해 리뷰 배치로 쪼개고, 두 리뷰 역할(`code-reviewer`·`security-reviewer`)의 산출물을 하나의 `acg-review.json` 리스크 원장(ledger)으로 집계한다 (`src/cli/commands/review.ts:18-34`).

핵심 설계 긴장은 하나다: **CLI는 LLM 리뷰어 서브에이전트를 직접 spawn할 수 없다.** 실제 `reviewer`/`security-reviewer` 패스는 autopilot이 dispatch하는 owner 서브에이전트다 (`src/cli/commands/review.ts:29-33`). 그래서 이 커맨드는 LLM을 부르는 대신 그 주위를 감싸는 **결정적(deterministic) seam**만 담당한다 — 범위 해석 → 배치 계획 → (역할 산출물을 받아) 집계 → 원장 기록. LLM이 손으로 계산하면 안 되는 부분(범위 해석, severity→risk 투영, 파일 누락 방지)을 전부 코드로 고정한다.

DITTO 4축 중 **거버넌스(ACG, Agentic Change Governance)** 에 속한다. 이 커맨드는 ACG의 "Review by Exception"(예외만 사람이 판단) 개념을 서 있는 코드 전체로 확장한 것이다. work-item diff를 리뷰하는 자매 커맨드가 `ditto acg-review`이고 (`src/cli/commands/acg-review.ts:16`), refactor 쪽 자매가 `ditto refactor`다 — 셋 다 아키텍처 단위 개념을 공유한다.

## 2. 코드 위치와 진입점

| 경로 | 역할 |
| --- | --- |
| `src/cli/commands/review.ts` | CLI 진입점. 인자 파싱 → 범위 해석 → 계획 → (`--from` 시) 집계·원장 기록 |
| `src/acg/scope/unit-resolve.ts` | 공유 범위 해석기. `--scope` 문자열 → 단위 구조 → 파일 집합 (refactor와 공유) |
| `src/acg/review/unit-review.ts` | `planUnitReview`(배치 분해) + `aggregateUnitReview`(역할 산출물 집계) |
| `src/acg/review/acg-review-adapter.ts` | `projectReviewerOutputToAcgReview` — reviewer-output → acg_review 투영(severity→risk) |
| `src/core/acg-review-store.ts` | `acg-review.json` 원장을 work-item 디렉터리에 원자적으로 기록 |
| `src/schemas/reviewer-output.ts` | 리뷰 역할 산출물 계약(입력) |
| `src/schemas/acg-review-graph.ts` | acg_review 원장 계약(출력) |
| `src/hooks/stop.ts:318` | `acgReviewForcesContinuation` — 원장을 읽어 완료를 차단하는 소비처 |
| `agents/reviewer.md`, `agents/security-reviewer.md` | 실제 LLM 리뷰 패스(autopilot dispatch, CLI 밖) |

### CLI 인자

`ditto review` 에는 서브커맨드가 없다. 인자만 있다 (`src/cli/commands/review.ts:83-106`):

| 인자 | 필수 | 의미 |
| --- | --- | --- |
| `--scope <unit>` | 예 | `all \| component:<name> \| layer:<name> \| api \| <glob>` |
| `--from <r1.json,r2.json>` | 아니오 | 리뷰 역할 산출물(reviewer-output) 경로들. 있으면 집계·원장 기록 모드 |
| `--work-item <id>` | `--from`과 함께 필수 | 원장을 기록할 work-item id (`review.ts:136-141`) |
| `--batch-size <n>` | 아니오 | 배치당 파일 수 (기본 25) |
| `--file-limit <n>` | 아니오 | 리뷰 파일 수 상한. 초과분은 drop되되 **로깅**됨(PM-5) |
| `--output human\|json` | 아니오 | 출력 형식(기본 human) |

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

이 커맨드는 두 모드로 동작한다. `--from` 유무가 갈림길이다.

**계획 모드 (`--from` 없음)** — 무엇을 리뷰할지 산출:

```
--scope <unit>
  → parseUnitScope           (문자열 → UnitScope 구조)
  → trackedSrcFiles(repo)    (git ls-files -- src, HEAD 기준 .ts 표준 파일, test/spec 제외)
  → loadArchSpec             (.ditto/architecture-spec.json, layer:<name>에만 필요)
  → resolveUnitScope         (단위 → 파일 집합)
  → planUnitReview           (파일 집합 → 배치[] + progress + dropped)
  → 출력 (human/json): 파일 수, 배치 수, 역할(code-reviewer+security-reviewer), dropped
```

**집계 모드 (`--from r1,r2` + `--work-item`)** — 역할 산출물을 원장으로:

```
--from r1.json,r2.json (각각 reviewer-output 스키마)
  → readReviewerOutput       (읽기 + zod 검증, 실패 시 fail-closed)
  → aggregateUnitReview      (각 산출물 → projectReviewerOutputToAcgReview → files 병합
                              → human_review_set 재도출 → 하나의 acgReviewGraph)
  → AcgReviewStore.write(wi) → .ditto/local/work-items/<wi>/acg-review.json
```

읽는 상태: `.ditto/architecture-spec.json`(`acgArchitectureSpec` 스키마, layer 해석용). 쓰는 상태: `.ditto/local/work-items/<wi>/acg-review.json`(`acgReviewGraph` 스키마, `src/core/acg-review-store.ts:17-18`).

기록된 원장은 나중에 **Stop 훅**이 같은 경로에서 읽어 완료를 차단한다 (`src/hooks/stop.ts:761-764, 1000-1002`). 즉 CLI는 원장을 *생산*만 하고, 차단 판단은 Stop 게이트가 한다.

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

**(a) 공유 단위 해석기 — review와 refactor가 같은 "단위"를 본다.**
`unit-resolve.ts`는 WU-4(`ditto refactor`)와 WU-5(`ditto review`) 둘이 공유한다 (`src/acg/scope/unit-resolve.ts:1-16`). 한 아키텍처 단위가 두 자매 표면에서 다른 파일 집합을 뜻하면 안 되기 때문이다. 실제로 `refactor.ts:93`도 같은 `resolveUnitScope`를 호출한다(확인됨).

**(b) Review by Exception — 전체 diff가 아니라 사람이 판단할 예외 집합만.**
`acg-review-graph`는 리스크 분류된 파일과 `human_review_set`(고위험 또는 unresolved 파일만)을 담는다 (`src/schemas/acg-review-graph.ts:70-79`). 사람은 전부가 아니라 예외만 본다. Stop 게이트는 그중에서도 **"증거 없는 고위험"** 만 차단한다 (`src/hooks/stop.ts:318-329`).

**(c) severity→risk는 코드가 계산한다(LLM 손계산 금지).**
`projectReviewerOutputToAcgReview`가 결정적 어댑터다: `critical/high→high`, `medium→medium`, 나머지→`low` (`src/acg/review/acg-review-adapter.ts:22-35`). 커맨드 주석은 "severity→risk is code, not an LLM's hand calculation"이라고 못박는다 (`unit-review.ts:15-17`). ACG binding D3: acg_review는 reviewer-output을 **읽기만** 하고 별도 아티팩트로 투영하며, reviewer-output 스키마는 건드리지 않는다 (`acg-review-adapter.ts:5-11`).

**(d) 파일 무손실 불변식(PM-5, ac-13).**
`reviewedCount + dropped.length === resolvedCount` — 모든 파일은 리뷰되거나, `--file-limit` 초과로 **drop되되 로깅**된다. 조용한 절단(silent truncation)은 없다 (`src/acg/review/unit-review.ts:70-107`). 컨텍스트/비용 폭발을 막으면서도 "몰래 빠진 파일"을 없앤다.

**(e) fail-closed 집계.**
`--from`의 산출물 하나라도 없거나 스키마 위반이면 예외를 던지고 원장을 **쓰지 않는다** (`src/cli/commands/review.ts:64-67, 146-149`). 깨진 입력이 조용히 빈(=통과하는) 원장을 만드는 사고를 막는다. `acg-review.ts:61-75`의 자매 커맨드도 동일하게 fail-closed.

**관련 ADR.** ACG의 적합성 함수 비용/ArchitectureSpec 출처는 `ADR-0004`, 정리(refactor)·리뷰 절차를 2차 정적 엔진 없이 ACG 게이트 위에 정립한 결정은 `ADR-0017`(D1: 정리는 ACG 위 동작-보존 워크플로, unit-scoped 후속 WU 분리). `ADR-0006`(정적 분석 = CodeQL 단일)도 재확인된다. 이 문서에서 인용한 범위 안에서 review는 ADR-0017이 분리한 unit-scoped 후속 WU에 해당한다(추론 — WU-5 명명이 커맨드 주석에 있으나 ADR-0017 본문은 WU 번호를 review에 직접 매핑하지 않음).

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

**`trackedSrcFiles(repoRoot)` (`review.ts:37-51`)** — `git ls-files -- src`로 HEAD에 추적되는 파일만 열거하고, `.ts/.tsx/.cts/.mts`만, `.test.`/`.spec.`은 제외한다. 효과: 리뷰 대상이 "지금 커밋된 표준 코드"로 결정적으로 고정된다(워킹트리 미추적 파일·테스트 제외). git 실패 시 즉시 throw → 조용한 빈 집합 방지.

**`loadArchSpec` (`review.ts:54-61`)** — 스펙 파일이 없으면 `undefined`를 반환한다. 이 값이 `undefined`면 `layer:<name>`은 **아무것도 매치하지 않는다**(보수적) — `fileInUnit`의 `layer` 케이스가 `archSpec !== undefined`를 요구하기 때문 (`unit-resolve.ts:59-61`). 주석: "a false unit is worse than empty"(`unit-resolve.ts:12-14`). 다른 단위(all/component/api/glob)는 스펙 없이도 동작.

**`resolveUnitScope` (`unit-resolve.ts:72-78`)** — 순수 함수. 파일마다 `fileInUnit`으로 필터. 단위별 판정 (`unit-resolve.ts:52-66`):
- `api` → 경로 세그먼트에 `controller(s)`/`route(s)`가 있으면 (`API_LAYERS`, `unit-resolve.ts:31`)
- `layer` → `pathToLayer(path, spec.layers) === name` (스펙 필수)
- `component` → `layerOf(path) === name` (top-level `src/<name>/` 디렉터리)
- `glob` → `globToRegExp(glob).test(path)`

**`planUnitReview` (`unit-review.ts:75-107`)** — `--file-limit`로 `reviewed`/`dropped`를 slice로 가른 뒤, `reviewed`를 `batchSize`(기본 25)로 배치화. 모든 배치의 `roles`는 `[code-reviewer, security-reviewer]`로 고정 — 두 역할이 **모든 배치를 함께** 본다(ac-11, `unit-review.ts:26-27, 92-94`). `total`을 두 번 순회해 채우는 건 배치 생성 시점엔 총 개수를 모르기 때문(`unit-review.ts:96-97`). 산출: `dropped`는 `review.ts:173`에서 "over --file-limit, logged"로 출력됨 → 무손실 불변식이 사용자에게 보임.

**`aggregateUnitReview` (`unit-review.ts:115-125`)** — 각 reviewer-output을 어댑터로 투영해 `files`를 `flatMap`으로 병합하고, `human_review_set`을 병합된 files에서 재도출(risk==='high' 또는 unresolved===true인 path/journey_id, 중복 제거). 마지막에 `acgReviewGraph.parse`로 검증 — 병합 결과가 유효한 단일 원장임을 보장.

**어댑터 세부 (`acg-review-adapter.ts:46-88`)** — 두 갈래로 files를 만든다: (1) `finding.file`이 있는 findings → risk/risk_reason/`unresolved:false`. `file`이 없는 finding은 **drop**된다(스키마가 non-journey 파일에 path를 요구하므로, `acg-review-adapter.ts:47-57`). (2) `unverified[]` → `unresolved:true`, `risk:'low'` 고정, 증거 객체 없음(OBJ-53: unresolved는 evidence.kind가 아니라 별도 플래그). 이 고정이 아래 (6)의 미묘한 게이트 상호작용을 만든다.

**`acgReviewForcesContinuation` (`stop.ts:318-329`)** — 원장에서 `risk === 'high' && evidence === undefined`인 파일마다 continuation 사유 1개. 즉 **증거 없는 고위험**만 완료를 막는다. 저/중위험, 그리고 증거 붙은 고위험은 통과.

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위: `review.ts`·`unit-review.ts`·`unit-resolve.ts`·`acg-review-adapter.ts`·`acg-review-store.ts`·소비 게이트(`stop.ts:318-329, 1000-1002`)의 정적 읽기. 테스트 실행은 안 함(미검증).

- **의도대로 동작하는 부분(코드 읽기 근거):** 범위 해석 공유(refactor와 동일 `resolveUnitScope` 호출 확인), 무손실 불변식(slice 로직상 `reviewed + dropped === resolved`), fail-closed 집계, severity→risk 결정성, Stop 게이트가 CLI가 쓴 원장을 같은 경로에서 읽음(`acg-review-store.ts:17`의 경로 == `stop.ts:762`의 경로).

- **게이트 반-무력화 지점(설계가 이미 인지·문서화함, 갭 아님):** `high ∧ unresolved` 조합은 **어댑터에서 절대 생성되지 않는다** — unverified→unresolved 파일은 risk를 `low`로 고정하기 때문(`acg-review-adapter.ts:62-67`). Stop 게이트가 `unresolved` 플래그가 아니라 "high-risk without evidence"로 키잉하는 이유가 이것(`stop.ts:312-316`에 명시). 즉 unresolved 파일은 이 게이트를 발화시키지 못한다. 의도된 설계이나, "미검증 항목은 완료를 막지 않는다"는 부작용을 낳는다(고위험 finding만 막음).

- **집계 모드의 unit-scoped 원장이 work-item 게이트를 탄다(정합 확인 필요 지점):** `ditto review --from ... --work-item <wi>`는 unit(표준 코드 전체) 리뷰 결과를 **work-item** 디렉터리의 `acg-review.json`에 쓴다(`review.ts:149`, `AcgReviewStore`는 `work-items/<wi>/` 고정). Stop 게이트는 이 파일을 work-item 완료 차단에 쓴다. 즉 "단위 전체 감사" 결과가 특정 work-item의 완료 게이트에 얹힌다 — 의도된 배선인지, 아니면 unit-scoped 원장이 별도 위치를 가져야 하는지는 이 코드만으로 단정 불가(미확인). `acg-review`(work-item diff)와 `review`(unit standing) 둘 다 같은 파일을 덮어쓸 수 있어, 마지막 writer가 이긴다.

- **standalone seam — autopilot이 `ditto review`를 구동하지 않는다(확인됨):** `grep`상 `reviewCommand`/`planUnitReview`/`aggregateUnitReview`를 호출하는 코드는 CLI 등록(`src/cli/index.ts:89`)과 테스트뿐이다. autopilot의 reviewer 노드는 이 커맨드가 아니라 `agents/reviewer.md`를 dispatch하고, 그 산출물은 `ditto acg-review`(work-item)로 흘린다(`agents/reviewer.md:51`). 따라서 `ditto review --scope`는 **수동으로 부르는 unit-scoped 표면**이다 — 파이프라인에 자동 배선돼 있지 않다. 이게 미완인지 의도인지는 코드만으로 단정 불가(미확인).

## 7. 잠재 위험·부작용·재설계 시 고려점

- **원장 경로 충돌.** `ditto review`(unit)와 `ditto acg-review`(work-item diff)가 같은 `work-items/<wi>/acg-review.json`을 대상으로 한다. 순서에 따라 한쪽이 다른 쪽을 덮어써 게이트가 보는 리스크 집합이 달라진다. 재설계 시 unit-scoped 원장을 별도 네임스페이스로 분리할지 검토.

- **미검증(unverified) 항목이 완료를 안 막는다.** 어댑터가 unverified를 risk=low로 고정하므로, 리뷰어가 "검증 못 함"으로 표시한 항목은 Stop 게이트를 발화시키지 못한다(§6). 이건 reviewer-output의 `unverified[]`와 acg_review의 게이트가 의도적으로 분리된 결과다 — 보존해야 할 불변식이지만, "완료 = 증거"라는 상위 원칙과 부분적으로 긴장한다.

- **location 없는 finding은 조용히 사라진다.** `finding.file`이 없는 findings는 원장에 못 들어간다(`acg-review-adapter.ts:47-51`). 파일에 못 묶는 아키텍처-레벨 finding(예: "이 계층 경계 자체가 잘못")은 게이트에 반영 안 됨. 재설계 시 파일-무관 finding 채널 검토.

- **layer 해석의 조용한 빈 결과.** `.ditto/architecture-spec.json`이 없으면 `layer:<name>`이 0개 파일로 해석되고(보수적) 리뷰가 "0 files"로 통과처럼 보인다(`unit-resolve.ts:59-61`). 사용자가 스펙 부재를 눈치 못 채면 감사 누락으로 오인 가능. 재설계 시 layer 요청 + 스펙 부재를 경고로 승격 검토.

- **보존해야 할 불변식:** (1) severity→risk가 코드에 있고 LLM이 손계산하지 않음(D3), (2) 파일 무손실(`reviewed + dropped === resolved`, PM-5), (3) fail-closed 집계, (4) review/refactor의 단위 해석 공유. 이 넷은 재설계에서도 유지해야 커맨드의 신뢰성이 보존된다.

- **재고 가능한 결정:** 원장 저장 위치(work-item 고정), unit vs work-item 리뷰의 게이트 공유 여부, 파일 단위 리스크 모델(파일-무관 finding 미지원).
