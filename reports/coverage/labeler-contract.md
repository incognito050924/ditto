# Verdict-blind fabrication labeler — 계약 (wi_260706n4w ac-5, n9)

> **목적**: far-field sweep이 남긴 oracle claim이 "코드베이스 대비 실재(real)인가
> 날조(fabricated)인가"를 oracle과 **독립적으로** 판정하는 라벨러의 운영 계약.
> **소비자**: 라벨링 세션을 띄우는 운영자(사람 또는 autopilot 밖의 fresh 세션)와
> 라벨러 에이전트 자신.
> **권위**: 스키마·함수는 코드가 SoT — `src/schemas/coverage.ts`(`labelerLabel`,
> `oracleProvenance`), `src/core/coverage-oracle.ts`(`correlateFabrication`).
> 이 문서는 코드가 강제할 수 없는 **절차** 부분만 계약으로 든다.

## 1. 역할 분리 — ENFORCE / JUDGE / CORRELATE

| 슬롯 | 담당 | 산출 |
|---|---|---|
| **ENFORCE** | 결정적 2-mode oracle (`evaluateOracleClaim`) | `oracle_verdicts[]` (confirmed / refuted / advisory_unverified) |
| **JUDGE** | 이 계약의 라벨러 — oracle과 **별개의 fresh-context host-delegated 에이전트** | `labeler_labels[]` (real / fabricated) |
| **CORRELATE** | 결정적 ditto 코드 `correlateFabrication` — **어느 에이전트도 아님** | 날조율·일치율 tally |

- 라벨러는 oracle verdict를 재사용하지 않는 **별개 에이전트**다. 사람이 라벨링하면
  더 강한 옵션이다(모델 prior 공유조차 없음).
- ditto는 LLM provider를 직접 호출하지 않는다(ADR-0001) — 라벨러는 호스트가
  위임 실행하고, ditto는 라벨러의 **structured output만 consume**한다
  (relevance refuter §5-3 · session-blind reviewer 선례).

## 2. 순환 차단 3조건 (전부 필수 — 하나라도 깨지면 측정 무효)

1. **입력 = raw claim + 코드베이스뿐.** oracle verdict(outcome / tier /
   advisory_reason / exit_code / detail)와 tally는 **절대 입력에 포함하지 않는다**.
   운영자는 사이드카에서 claim을 추출할 때 verdict 필드를 벗겨내야 한다(§4).
2. **Fresh context.** 라벨러 세션에는 oracle을 돌린 세션의 추론·요약·핸드오프가
   없어야 한다. sweep을 수행한 세션이나 그 compaction을 재사용하면 안 된다.
3. **날조율은 결정적 코드가 산출.** 두 독립 집합 {oracle confirmed/refuted} ×
   {labeler real/fabricated}의 상관은 `correlateFabrication`
   (`src/core/coverage-oracle.ts`)이 claim_id join으로 계산한다 — oracle도
   라벨러도 자신·상대의 점수를 매기지 않는다.

## 3. 라벨러 입력 (운영자가 준비)

- 측정 대상 working tree(측정 시점 commit으로 checkout).
- claim 목록 — 각 항목은 다음 필드**만**:
  - `claim_id` (상관 키)
  - `category_id` (있으면)
  - `claim` — `mode: 'presence'`면 `maps_to`(file:line 인용),
    `mode: 'absence'`면 `pattern` + `scope_path`
- 출처는 `.ditto/local/runs/<wi>/oracle-provenance.json`의 `oracle_verdicts[]`지만,
  **verdict 필드를 제거한 사영(projection)** 만 전달한다. 사이드카 파일 자체를
  라벨러에게 열어주면 조건 1 위반이다.

## 4. 라벨러 과제와 출력

과제: 각 claim에 대해 **코드베이스를 직접 확인**하고 판정한다 —

- `real` = claim이 가리키는 근거가 실재한다 (presence: 인용된 file:line이 실제로
  그 내용을 담음; absence: 해당 scope에 그 토큰이 정말 없음).
- `fabricated` = claim의 근거가 실재하지 않는다 (없는 파일/라인 인용, 실재하는
  토큰을 "없다"고 주장 등).

출력: `labelerLabel`(`src/schemas/coverage.ts`) 배열 — JSON only, 산문 금지:

```json
[
  { "claim_id": "<입력의 claim_id>", "label": "real" | "fabricated", "reason": "선택: 판정 근거 한 줄" }
]
```

운영자는 이 배열을 사이드카의 `labeler_labels[]`에 merge한다(같은 `claim_id`는
last-wins — 사이드카의 verdict merge와 동일 의미론). oracle 루프는
`labeler_labels[]`를 건드리지 않는다(`src/core/coverage-loop.ts`
`appendOracleVerdicts`가 보존).

## 5. 상관 실행 (결정적)

```ts
import { correlateFabrication } from '~/core/coverage-oracle';
// sidecar = oracleProvenance.parse(<oracle-provenance.json>)
const tally = correlateFabrication(sidecar.oracle_verdicts, sidecar.labeler_labels);
```

- rate가 `null`이면 **미측정**이다(분모 0) — 0%로 읽지 않는다.
- `unmatched.labeler_only > 0`이면 ENFORCE 집합 밖 라벨이 섞인 것 — 입력 사영
  오류를 의심하고 측정을 다시 본다.

## 6. 관측 모집단 blind spot (리뷰 carried-forward — 해석 시 필수)

**self-declared `category_id`가 라우팅을 결정한다.** sweep 에이전트가 claim에
user-intent(-라우팅) 카테고리를 선언하면 그 claim은 oracle을 우회하고
사이드카에 **기록되지 않는다** — 따라서 라벨러의 관측 모집단에서 사라진다.

- 이 하네스가 측정하는 모집단 = **code-verify로 라우팅된 claim뿐**.
- "날조율 X%"는 항상 "code-verify 라우팅분의 날조율 X%"로 읽는다. 스스로
  user-intent를 선언해 oracle을 벗어난 claim의 날조는 이 하네스로 관측 불가하며,
  그 비율이 낮다는 주장을 이 측정으로 뒷받침할 수 없다.
- `correlateFabrication.unmatched`는 이 공백의 사이드카-내부 잔영(라벨/verdict
  편측)을 가시화하지만, **사이드카에 아예 안 들어온 claim은 어떤 필드로도 보이지
  않는다** — 그래서 이 문단이 계약에 있다.

## 7. 코드로 강제 못 하는 잔여 (정직한 한계)

LLM 라벨러의 완전한 **판단** 독립성은 코드가 강제할 수 없다 — oracle을 만든
모델과 prior를 공유할 수 있다. 절차적 독립(verdict-blind 입력 · fresh context ·
별도 집합 · 결정적 상관)이 코드·계약이 보장할 수 있는 최대이고, 완전 독립이
필요하면 **다른 모델 패밀리 또는 사람**을 라벨러로 쓴다.
