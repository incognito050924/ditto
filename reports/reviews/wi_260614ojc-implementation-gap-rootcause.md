---
title: "wi_260614ojc pre-mortem coverage 엔진 — 구현/배선 갭 근본원인 진단"
kind: review
work_item: wi_260614z7r
last_updated: 2026-06-15 KST
---

# wi_260614ojc 구현/배선 갭 근본원인 진단 (ac-1)

> 독립 진단. 사전 서사를 신뢰하지 않고 저장소 산출물만으로 재구성했다. 결론은 모두 file:line / 문서 §절 / 노드 task 텍스트에 묶었다.

## 1. 범위·방법

`wi_260614ojc`는 final_verdict=pass(ac-1..ac-9 9개 전부 pass)로 종결됐다. 그러나 AC은 전부 **UNIT/CONTRACT 테스트**로 통과했고, 엔진은 대부분 autopilot 런타임에 **배선되지 않았다**. 다섯 갭의 "why"를 분류한다.

읽은 산출물(상태 근거):

- `reports/design/contracts/premortem-coverage-contract.md` — 계약 본문. §9(산출물), §10(자산매핑), §11(체크리스트), §12(적용 단계). git status상 `??`(untracked) 신규 파일.
- `.ditto/local/work-items/wi_260614ojc/work-item.json` — ac-1..ac-9 문구, `status:"done"`, `closed_at` 존재.
- `.ditto/local/work-items/wi_260614ojc/autopilot.json` — 노드 그래프 N1·N4~N21, `approval_gate.status:"approved"(source:user)`.
- `.ditto/local/work-items/wi_260614ojc/completion.json` — per-AC verdict 9개 전부 `pass`, `final_verdict:"pass"`.
- `src/core/coverage-manager.ts` — 엔진 본체(615줄). git status상 `??`.
- `src/core/autopilot-loop.ts`, `src/core/autopilot-driver.ts`, `src/core/autopilot-complete.ts`, `src/core/completion-coverage-doctor.ts` — 배선/게이트.

**핵심 배선 증거 (직접 grep, fresh).** `coverage-manager.ts`의 export 35개 중 src/(non-test, non-self)에서 import되는 것은 **`producePlanGate` 단 하나**다:

```
$ grep -rln "coverage-manager" src/ tests/ --include="*.ts"
src/core/autopilot-loop.ts            # producePlanGate 만 import (line 28)
tests/core/coverage-manager.test.ts   # 그 외 전부 — 테스트만
```

- `serializePlanDialog` 프로덕션 호출자: **0** (non-test, non-self grep 무결과).
- `COVERAGE_AXIS_MECHANISMS` 프로덕션 호출자: **0**.
- `addNode / closeNode / selectReadyCoverageNodes / coverageClosureGate / recordDryRound / isCoverageTerminated / buildJudgeInput` 프로덕션 호출자: **0** (grep의 `addNode` 히트는 전부 `AutopilotStore.addNodes` — 별개 함수).
- `selectCoverageTier / tierBriefApproval / tierDepthBudget / capStatus` 프로덕션 호출자: **0** (단 `selectCoverageTier`는 `producePlanGate` 내부에서 호출되어 간접 도달).
- `plan-dialog`/`coverage.json` 문자열을 런타임에 파일로 쓰는 곳: src/ 전체에서 **0** (히트는 `coverage-manager.ts`의 주석/직렬화 내용과 `schemas/coverage.ts`의 describe 문자열뿐).
- `skills/autopilot/SKILL.md`에 coverage/pre-mortem/fan-out/sweep/plan_brief/plan-dialog/6축 언급: **0**.

즉 살아 있는 배선은 `autopilot-loop.ts:637-657`의 한 곳뿐 — design 노드 결과의 `payload.plan_brief`를 `producePlanGate`로 변환해 `approval_gate`에 기록하는 경로다. 엔진의 나머지(트리 빌더·Manager·fan-out·dialog·6축 레지스트리·caps)는 라이브러리로만 존재하고 호출자가 없다.

## 2. 갭별 근본원인 표

| # | 갭 | 분류 | 증거 | deferral? |
|---|---|---|---|---|
| 1 | `coverage.json`·`plan-dialog.md` 런타임 미산출 (§9) | **(c) 너무 좁은 입도** (주) + (g) 게이트 약함 | ac-6 문구 = "serializePlanDialog **출력 문자열**에 4섹션 포함"(work-item.json:40, N12.purpose는 명시적으로 "함수가 STRING 반환, **caller가 파일 write 소유**" coverage-manager.ts:209-210). 계약 §9는 두 파일을 런타임 산출물로 요구하나 AC은 직렬화 함수 단위로만 번역됨. 파일 write 소유자(caller)를 만드는 AC이 **부재**. completion.json ac-6 evidence는 `serializePlanDialog` 단위 테스트뿐. | **UNINTENDED** — §12에서 plan-dialog 산출은 1차(이번) 범위. coverage.json도 §9 신규 산출물. 연기 문구 없음. |
| 2 | `COVERAGE_AXIS_MECHANISMS` 레지스트리 프로덕션 호출자 부재 (6축 강제) | **(c) 너무 좁은 입도** (주) + (g) | ac-4 문구 = "6축이 각각 별도 메커니즘으로 강제됨이 **테스트를 통과**"(work-item.json:28). 메커니즘 *함수의 존재·동작*만 요구하고 *루프가 호출*함은 요구 안 함. 레지스트리는 `coverage-manager.ts:394-446`에 존재하나 grep상 호출자 0. N20이 no-op→genuine으로 고친 것도 함수 내부 로직일 뿐 배선 아님(autopilot.json N20.purpose). | **UNINTENDED** — 계약 §2가 핵심. 연기 없음. |
| 3 | plan 단계 fan-out 루프(트리빌드→다각도 sweep→3역→fresh judge→6축→loop-until-dry) autopilot 미배선 | **(b) 계약엔 있으나 AC 미번역** (주) + (a) SKILL 부재 | 계약 §4 전체·§12 "plan 1차(이번)"이 fan-out 루프를 요구. 그러나 ac-1..ac-9 어디에도 "Manager+fan-out 루프가 design→review 사이에서 **실행된다**"는 행위 AC 없음. N18.purpose는 "Manager+fan-out 엔진 호출"을 적었으나 ac-9에 매핑되고 ac-9 문구는 "배선 후 전체 테스트 0 fail"(work-item.json:58)일 뿐 — 루프 실행을 검증하는 행위 조건이 아님. 실제 N18 evidence는 `bun test` 회귀뿐, 배선 증거 file은 `autopilot-loop.ts producePlanGate`만 가리킴(autopilot.json:675-677). `skills/autopilot/SKILL.md`에 엔진 언급 0. | **UNINTENDED** (§12 1차 범위). 단, ac-9가 "0 fail"로만 정의돼 배선 부재가 테스트로 드러나지 않음. |
| 4 | temporal 축 표류 감지가 autopilot reviewer/verifier 미연결 | **(d) 계약이 경계를 외부로 위임** + (c) | 계약 §2(l.62) + coverage-manager.ts:436-444가 명시: "Drift ENFORCEMENT proper는 **구현 단계(reviewer/verifier)**, 이 엔진은 baseline 생성·divergence 검출만". `temporal.enforce`는 baseline==current 집합비교 순수함수로 존재하나 reviewer/verifier가 이 baseline을 읽는 배선 0. ac-4가 "메커니즘 존재"만 요구해 연결을 포착 못 함. | **부분 INTENDED** — 계약이 enforcement를 구현 단계로 명시 위임. 그러나 그 위임처(reviewer/verifier)를 연결하는 AC/노드가 **없어** 실질 UNINTENDED 갭으로 남음. |
| 5 | intent 단계(Deep Interview 적용) 미구현 | **(a) 의도적 연기 — AC에 없음** | 계약 §12 "사용자 승인(2026-06-14): plan 단계 **먼저** 구현·실증. intent 단계는 후속 확장으로 미룬다"(contract:279, 286). work-item.json goal도 "plan 먼저, intent는 후속". ac-1..ac-9 어디에도 intent 없음. `deep-interview`는 별개 기존 command/hook(`src/cli/commands/deep-interview.ts`, `user-prompt-submit.ts:233`)로 존재하나 coverage 엔진의 intent 적용(`intent-dialog`, premortem 승격)은 미배선. | **INTENDED DEFERRAL** — 계약·사용자 승인으로 명시 연기. 갭 아님. |

## 3. 종합 판정

**지배 원인 = PLANNING-STAGE (AC 작성 입도).** 5개 갭 중:

- 갭 5는 **의도적 연기**(계약 §12, 사용자 승인) — 결함 아님. 제외.
- 남은 4개 실질 갭(1·2·3·4)은 **전부 planning-stage 기원**:
  - 갭 1·2 = (c) 너무 좁은 입도 — 런타임 행위를 단위 테스트 AC로 번역.
  - 갭 3 = (b) 계약엔 있으나 어떤 AC로도 번역 안 됨 (루프 *실행* AC 부재).
  - 갭 4 = (d) 계약이 경계를 모호하게 외부 단계로 위임 + 연결 AC 부재.
- **AUTOPILOT-EXECUTION 기원 (e/f/g/h): 0건이 1차 원인.** planner가 계약을 조용히 축소(e)했다고 보기 어렵다 — N18.purpose는 오히려 "Manager+fan-out 엔진 호출, seed N2/N3 supersede"라고 **배선을 적었다.** 즉 planner는 의도를 그래프에 적었으나, 그 노드가 매핑된 ac-9의 문구가 "0 fail"이어서 **배선 부재가 통과를 막지 못했다.** 이것은 execution 실패가 아니라 AC가 약해 execution을 검증하지 못한 것 — 근본은 planning이다.

**정량: planning-stage 4 / autopilot-execution 0 (실질 갭 4건 기준).** 갭 4는 계약 모호성(d)이 가중.

**완료 게이트는 force-pass 했는가? — 아니다. "설계대로 동작했으나 너무 약하다"(g, but worked-as-designed).** 증거:

- `deriveAcVerdicts`(autopilot-complete.ts:36-60)의 `nodeVerdictFor`: `status==='passed' && evidence_refs.length>0` ⇒ `pass`. **evidence의 *종류*(unit/integration/runtime)를 구분하지 않는다.** `bun test tests/...` command 요약 한 줄이면 evidence 조건 충족.
- `isClosed`(completion-coverage-doctor.ts:25-28): `verdict==='pass' && (evidence.length>0 || evidence_records.length>0)`. 역시 종류 무관.
- 따라서 게이트는 "AC이 단위 테스트 증거로 닫혔다"와 "기능이 실제 배선·실행된다"를 **구조적으로 구별할 수단이 없다.** ac-1·2·5·6·7·8 모두 `bun test` 단위 증거로 적법하게 pass. completion.json의 notes "evidence-less implementation pass covered by a downstream verified pass"가 이를 명시.
- **억지 통과(force-pass)·테스트 비활성화·완화의 흔적은 없다.** 오히려 게이트는 정직하게 동작했다: ac-4의 N10 review가 no-op placeholder를 **fail로 검출**→N20 fix→N21 재검증으로 수렴(autopilot.json N10.ac_verdicts ac-4=fail). false-green 보호(worst()-fold, supersession)도 의도대로 작동. 문제는 게이트가 **묻는 질문 자체("증거가 있나")가 약한 것**이지, 답을 위조한 게 아니다.

요컨대: **계약 §9·§4·§2가 요구한 "런타임 산출·루프 실행·6축 배선"을 어떤 AC도 행위 조건으로 번역하지 않았고, 완료 게이트는 evidence 종류를 안 보므로 단위 테스트만으로 9/9 pass가 적법하게 성립했다.** 게이트는 설계대로 동작했고, 단지 "배선 여부"라는 차원을 측정하지 않을 뿐이다.

## 4. 재발 방지 권고 (최소 가드레일)

이 부류(계약은 런타임 행위를 요구하나 AC은 단위로 좁혀지고 게이트가 못 잡음)를 잡는 가장 작은 가드 둘로 나눈다.

### A. AC 작성 규율 (planning-stage 수정 — 지배 원인)

1. **계약 §9 산출물 ↔ AC 매핑 강제.** 계약이 "런타임 산출물"(파일·사이드카)을 명시하면, 그 *파일이 런타임 경로에서 실제로 생성됨*을 검증하는 AC을 별도로 둔다 — 직렬화 함수 단위 테스트로 대체 금지. (이번엔 ac-6이 함수 STRING만 검증, 파일 write caller AC이 빠짐.) **이게 단일 최고 가드.** 갭 1·2·3을 동시에 잡는다.
   - 거주지: 계약→intent 컴파일/AC 작성 단계. 강제 지점은 `reports/design/contracts/premortem-coverage-contract.md §11 체크리스트`에 "각 §9 산출물마다 *런타임 생성* AC 1개" 항목 추가 + planner(`ditto:planner`) 프롬프트에 "계약 §9 산출물에 배선 AC 누락 시 flag".

2. **"존재" AC와 "배선" AC 분리 명문화.** "X가 정의되고 테스트를 통과한다"류 AC은 *배선*을 함의하지 않는다. 배선이 필요한 항목은 "X가 autopilot 루프에서 **호출되어** Y를 산출한다"로 행위화. (ac-4·ac-9가 "0 fail"로만 정의된 게 핵심 결함.)

### B. autopilot 게이트 수정 (execution gate — 보조, 부류 자체를 못 잡지만 신호를 준다)

3. **evidence 종류 인식.** 현재 `nodeVerdictFor`(autopilot-complete.ts:42)·`isClosed`(completion-coverage-doctor.ts:25)는 evidence 유무만 본다. 최소 가드: **`change_surface`/§9 산출물을 가진 work item에서, AC이 `kind:"command"` 단위 테스트 증거만으로 닫히고 `kind:"file"`이 런타임 경로(예: `src/cli`·loop 배선)나 산출물 경로를 가리키지 않으면 `unverified`로 강등 또는 경고.** 이는 force-pass를 막는 게 아니라 "단위만으로 닫힘"을 가시화한다.
   - 거주지: `src/core/autopilot-complete.ts` `nodeVerdictFor` (or 신규 헬퍼). 단, 이 가드는 휴리스틱이라 A보다 약하다 — 근본은 A다.

**우선순위: A-1 > A-2 > B-3.** A-1(§9 산출물마다 런타임 생성 AC) 하나만 있었어도 갭 1·2·3이 이번에 fail로 드러났을 것이다.

---

### 부기: 범위 밖이지만 기록할 사실

- 엔진 라이브러리 자체의 *품질*은 진단 범위 밖이나, ac-4 수정 이력(N10 fail→N20 fix→N21 pass)은 review/verify 분리가 false-green을 실제로 한 번 잡았음을 보여준다 — 게이트의 review 단계는 건강하다. 잡지 못한 것은 "배선 부재"라는, 어떤 AC도 묻지 않은 차원이다.
- `coverage-manager.ts`·`coverage.ts`·계약 문서는 git status상 미커밋(`??`) 상태다(상태 근거).
