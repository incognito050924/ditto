---
title: "하네스 흡수 — 갭 분석 (구현 보류)"
kind: gap-analysis
repo: ditto
last_updated: 2026-06-01
scope: "흡수 계획(ditto-harness-absorption-plan.md)의 각 WI를 실제 구현(M0~M4 코드 + 508 통과 테스트)과 대조해 DONE/PARTIAL/GAP를 증거로 판정한다. 구현은 하지 않는다."
method: "읽기 전용. 4개 병렬 조사 에이전트가 src/·tests/·skills/·agents/·hooks/와 reports/design/ditto-v0-implementation-plan.md를 대조. 모든 판정에 file:line + 테스트 근거."
inputs:
  - reports/harnesses/ditto-harness-absorption-plan.md   # 검증 대상(결함 있음 — §4 참조)
  - reports/design/ditto-v0-implementation-plan.md        # 실제 구현 계획(M0~M4)
supersedes_premise_of:
  - reports/harnesses/ditto-harness-absorption-plan.md    # "전부 미구현"이라는 전제를 무효화
---

# 하네스 흡수 — 갭 분석 (구현 보류)

## 0. 핵심 결론

흡수 계획(`ditto-harness-absorption-plan.md`)은 디렉터리 목록만 보고 작성돼, **이미 구현·테스트된 작업을 "앞으로 할 일"처럼 적었다.** 실제로는 마일스톤 M0~M4가 구현되고 **508개 테스트가 통과** 중이며, 별도의 진짜 구현 계획 `reports/design/ditto-v0-implementation-plan.md`가 같은 하네스를 이미 인용해 흡수를 마쳤다.

따라서 "흡수 계획을 전부 구현"은 대부분 재구현이 된다. 본 문서는 **진짜로 빠진 것만** 가린 갭 지도다. 구현은 하지 않았다(사용자 결정 보류).

## 1. WI별 판정 (증거)

`DONE` = 이미 구현·테스트됨(흡수 불필요) / `PARTIAL` = 일부만 / `GAP` = 미구현.

| WI | 판정 | 증거 / 빠진 것 |
|---|---|---|
| **W1-1** 관찰가능성 게이트(VAGUE_TERMS+observable) | DONE | `src/core/gates.ts:72-104` `acceptanceTestable`; `tests/core/gates.test.ts:53-67`, m0 conformance |
| **W1-2** deterministic floor + ledger-primary | PARTIAL | floor/floor-capping DONE(`gates.ts:32-68`). **GAP: closure_mode 레코드**(mutual_agreement/ledger_only/safe_default) — `src/`·`tests/` 0건. exit.reason enum에 종료 모드 구분 없음 |
| **W1-3** GradeGate A/B/C + high-risk | PARTIAL | high-risk DONE(`gates.ts:178-190`). **GAP: 명시적 A/B/C 등급 게이트**(SeedGrade/GradeGate 대응물) 0건. DITTO는 high-risk boolean + completionGate로 우회 |
| **W1-4** ConvergenceContract 쌍대 게이트 | DONE | `gates.ts:144-174` `convergenceGate`(CompletionGate∩open-admissible+ratchet+admissibility), `src/schemas/convergence.ts`, `convergence-store.ts`, `tests/core/gates.test.ts:97-118` |
| **W1-5** hannes lessons fixture 회수 | GAP(coverage) | lesson 기반 fixture 0건. 단 게이트는 자체 fixture로 이미 검증 — 기능 갭이 아니라 검증 커버리지 보강 |
| **W2-1** plan read-only 경계 | DONE | `agents/planner.md`(tools: Read/Grep/Glob), `skills/plan/SKILL.md`(user-invocable:false), `autopilot-dispatch.ts:24-52`; m2 conformance:345-350 |
| **W2-2** consensus/approval 영속 게이트 | DONE | `approval_gate.status`(pending/approved/not_required/rejected) `autopilot.ts:72-78` + `autopilot-bootstrap.ts:30-45` + `autopilot-driver.ts:18-32`; m2:141-159,294-313. **단 명명 불일치**: 흡수 계획의 "architect+critic consensus"는 코드에 없음 — 실제는 단일 approval_gate + 별도 dialectic ledger |
| **W2-3** autopilot FSM 전이 + Stop continuation | PARTIAL | ready-selection/auto-advance/실패분류/Stop continuation/네이티브 Task dispatch DONE(`autopilot-graph.ts`, `stop.ts:115-203`, m1/m2). **GAP: 명시적 transition table test + denied(rejected)→rollback 전이** — rollback 코드·테스트 0건, overlap 전용 테스트 없음 |
| **W3-1** generator/evaluator 분리 | DONE / PARTIAL | verifier lane DONE(`agents/verifier.md`, `completion-store.ts`, `reviewer-output.ts`, m3:149-268). **PARTIAL: reviewer lane** — `agents/reviewer.md:20` "v0 skeleton: role/permission boundary only" 본문 미구현 |
| **W3-2** Codex-opponent 라우팅 | DONE | `src/core/opponent-router.ts:33-126`, `skills/dialectic/SKILL.md:23`, `tests/core/opponent-router.test.ts`(9), m3:518-532 |
| **W3-3** rubric 재실행 루프 | GAP(의도적 비채택) | rubric/needs_revision/max_iteration 0건. 흡수 계획이 "미들웨어 런타임 이식 금지"로 의도 제외. 등가(상한 재실행)는 `decideOnFailure`(retry/switch/cap) + convergence cap + dialectic max_rounds로 분산 구현 |
| **W3-4** evidence-first verifier | DONE | `agents/verifier.md:16-45`(SUMMARY 불신, "Reading is not running", runnable evidence 없으면 unverified); m3 PostToolUse evidence green |
| **W3-5** E2E journey(브라우저) | GAP(post-v0 M5) | **schema-only**: `src/schemas/e2e-journey.ts`만 존재(헤더가 "post-v0 M5 runtime" 명시). playwright-e2e agent·/ditto:e2e skill·Playwright CLI·artifact 캡처 전부 부재. m1:467-473이 agent 부재를 적극 단언. 의도적 연기 |
| **W4-1** 6-section 위임 + file-overlap gate | PARTIAL | 6-section packet + Context Isolation DONE(`autopilot-dispatch.ts:10-61`, m2:317-349). **GAP: file-overlap 직렬화 gate** — `overlap` 0건 |
| **W4-2** doctor self-inventory drift | PARTIAL | drift 검사 + false-green 차단 DONE(`surface-inventory.ts:44-89`, `tests/doctor/surface.test.ts`). **GAP: 생성형 inventory** — catalog `.ditto/surfaces.json`이 손으로 관리되는 정적 파일(생성 스크립트 0건). "코드에서 생성해 문서 숫자와 대조"가 미충족 |
| **W4-3** native hooks(fail-open + opt-in) | PARTIAL | fail-open/kill-switch/UserPromptSubmit/Stop/PostToolUse DONE(`hooks/runtime.ts:13-45`, m1:67-97). **PreToolUse는 부재**(stub도 아님, v0 표면 4개에서 제외). "opt-in 기본값" 미구현(opt-out kill-switch만) |
| **W4-4** safety policy(PreToolUse) | GAP(post-v0) | PreToolUse 자체 부재. package-legitimacy/slopsquatting/dependency provenance/dry-run/파괴적 path helper 0건. 구현 계획이 "post-v0 별도 build unit"으로 의도 연기(§8-1 승인 채널 선결) |
| **runtime parity matrix**(추가) | GAP | parity/runtime matrix 0건. doctor 서브커맨드 4개(instructions/permissions/mcp/surface)에 capability parity·미지원 fail-closed 없음 |

## 2. 진짜 갭 분류

### 2.1 v0 범위 내 정제 (착수 가능한 후보 — 작고 additive)

| 갭 | 대상 | 비고 |
|---|---|---|
| G1 closure_mode 레코드 | `interview-state`/`convergence` 스키마 | ledger-primary 종료 모드(mutual_agreement/ledger_only/safe_default) 기록. floor는 이미 있음 |
| G2 GradeGate A/B/C | `gates` | **필요성 먼저 판단**: DITTO는 high-risk boolean + completionGate로 이미 실행 차단. ouroboros식 등급이 추가 가치가 있는지 평가 후 결정(과설계 위험) |
| G3 transition table test + denied→rollback | `autopilot-graph`/`autopilot-driver` | 전이를 암묵 규칙에서 명시 테이블 테스트로, rejected 시 rollback 전이 추가 |
| G4 reviewer lane 본문 | `agents/reviewer.md` | 현재 v0 skeleton. verifier lane은 완성 |
| G5 file-overlap 직렬화 gate | `autopilot-dispatch`/`autopilot-graph` | 같은 wave 파일 겹침 직렬화 |
| G6 생성형 inventory | `surface-inventory`/`scripts` | catalog를 코드에서 생성해 손기입 제거 |

### 2.2 post-v0 (이미 계획상 연기됨 — 흡수 계획이 잘못 주장한 것)

- **E2E 브라우저 런타임**(W3-5) — M5. playwright-e2e agent / `/ditto:e2e` / Playwright CLI / artifact 캡처.
- **PreToolUse safety + package-legitimacy + dependency provenance**(W4-3 PreToolUse, W4-4) — post-v0, §8-1 승인 채널 선결.
- **runtime parity matrix** — post-v0.

이들은 "미구현 버그"가 아니라 `ditto-v0-implementation-plan.md`가 **의도적으로 v0 밖으로 둔** 것이다.

### 2.3 커버리지/위생 (기능 갭 아님)

- **hannes lessons fixture**(W1-5) — 게이트는 이미 자체 fixture로 검증됨. 회수는 회귀 커버리지 보강.
- **rubric 재실행 루프**(W3-3) — native-first로 의도적 비채택. 등가 메커니즘 존재.

## 3. 요약

- **이미 구현(흡수 불필요)**: W1-1, W1-4, W2-1, W2-2, W3-2, W3-4, W4-1(packet), W4-2(drift), W4-3(fail-open). 흡수 계획 4개 wave의 다수가 M0~M4에 흡수 완료.
- **v0 내 정제 후보(6건)**: closure_mode, (조건부)GradeGate A/B/C, transition table+rollback, reviewer 본문, file-overlap gate, 생성형 inventory.
- **post-v0(이미 연기)**: E2E 브라우저, PreToolUse safety/package-legitimacy, runtime parity matrix.
- **커버리지**: hannes lessons fixture, (비채택)rubric.

## 4. 흡수 계획 문서 자체의 결함

`ditto-harness-absorption-plan.md`는 다음 이유로 신뢰해 실행하면 안 된다:

1. **실제 구현 상태 미반영** — `ditto-v0-implementation-plan.md`(M0~M4)와 코드를 읽지 않고 작성. 다수 WI가 이미 DONE.
2. **명명 불일치** — W2-2 "architect+critic consensus"는 코드에 없음(실제: approval_gate + 별도 dialectic).
3. **post-v0를 v0 작업처럼 기술** — E2E/PreToolUse/parity가 이미 의도적으로 연기됐는데 wave에 평면 배치.

→ 권고: 흡수 계획을 본 갭 문서 기준으로 정정하거나, "전제 무효 — 본 갭 문서로 대체"로 표시. (배너는 추가해 둠.)

## 5. 이동한 참고 하네스 재확인 (2026-06-01)

최초 갭 분석은 보고서 고정 커밋 기준이었다. 7개 참고 하네스 중 5개(ouroboros·oh-my-codex·oh-my-claudecode·deepagents·superpowers)는 여전히 고정 커밋 = 최신이라 재확인 불필요. **2개는 보고서 현행화 이후 이동**해, 고정 커밋과 현재 HEAD 사이를 diff했다:

- **oh-my-openagent** `7afa4d08f → c14f327`(38커밋, 대부분 codex/lazycodex 패키징·prompt-gate 수정).
- **gsd-core(next)** `9b5ee373 → e3bc53f8`(6커밋).

### 갭 분석에 없던 신규 패턴 후보 (2건)

| 패턴 | 출처 | DITTO 관련성 / 현 상태 |
|---|---|---|
| **G7 subagent 완료신호 ≠ 완료 증명** (확정 갭, 좁혀짐 — 2026-06-01 검증) | oh-my-openagent review-work "Codex Subagent Reliability"(`packages/shared-skills/skills/review-work/SKILL.md @ c14f327`) | **검증 결과 확정 갭.** ① `decideOnFailure`(`autopilot-dispatch.ts:77-95`)는 raw child 결과를 보지 않음 — 이미 내려진 `failureClass`를 action으로 매핑만(주석 71-72 "classification is a judgment made upstream"). ② 그 upstream classification·`node.status='passed'` mutation이 `src/` 프로덕션 코드에 0건(`decideOnFailure` 호출부도 테스트 전용) — child 결과를 PASS/실패로 판정하는 deterministic 코드 자체가 v0에 없고, 판정은 `skills/autopilot/SKILL.md` step 6(LLM 루프)가 내림. ③ step 6에도 "빈/ack-only/content-free 결과를 failure로 분류" 지시 없음. verifier.md의 "should pass는 claim"·"Reading is not running"은 verifier 한 owner의 자기 증거 기준일 뿐, 오케스트레이터가 임의 owner의 content-free 결과를 PASS로 세지 않게 막는 가드 아님. **좁힘(native-first):** 원본의 `wait_agent`/mailbox 폴링 timeout 메커니즘은 DITTO가 native Task(동기 dispatch)를 써서 폴링/mailbox 레이어가 없으므로 N/A. 잔존 갭은 "native Task가 반환한 content-free 결과 → 비-PASS inconclusive 처리" 가드 부재(SKILL.md step 6 + deterministic helper/fixture 0건) |
| **G8 ack ≠ verification** | gsd-core #38(`workflows/execute-phase.md @ e3bc53f8`) | human_needed 체크포인트에서 "approved/ok/pass/done" 같은 가벼운 ack를 검증 대체로 받지 않음 — 실제 verify 완료 전까지 pending 유지. DITTO는 completion이 acceptance별 evidence로 게이트돼 **구조적으로 ack≠완료**이나(verifier "should pass는 claim"), 이 실패모드를 명시 fixture로 둘 가치 있음 |

부수(비-갭): gsd-core #558 spawn liveness 문구는 호스트-UI 영역(native-first상 DITTO 비대상)이나 "완료됐는데 출력 없으면 결과 유실 가능 → 재실행"은 G7과 같은 맥락의 minor 견고성. oh-my-openagent `opencode-qa`는 호스트 자체 QA 스킬이라 DITTO 일반 패턴 아님.

**결론**: 이동한 2개에서 나온 신규 패턴은 기존 DONE/GAP 판정을 **바꾸지 않는다**(전부 DITTO 코드 기준이고 최신 확인됨). 추가된 것은 갭 2건(G7·G8)으로, 둘 다 작은 견고성/정직성 가드다. **G7은 2026-06-01 코드 검증으로 확정 갭으로 승격**(content-free child 결과 → 비-PASS inconclusive 가드 부재; 원본의 wait_agent/mailbox 메커니즘은 native-first상 N/A로 좁혀짐). G8은 미검증 후보로 유지.

## 6. 다음 결정 (사용자 몫)

구현은 보류 상태다. 진행한다면 우선순위 후보는 §2.1의 G1·G3·G4·G5(작고 v0 정합) → G6 → (필요성 판단 후)G2, 그리고 §5의 G7·G8(견고성 가드). **§7의 G9(autopilot 루프 CLI 결선)는 G7·산문 중복·미배선을 한 번에 닫는 구조 갭이라 별도 우선 검토 대상**; G10(dialectic 부분 중복)은 낮음. post-v0(§2.2)는 별개 마일스톤. 어느 갭을 실제 work item으로 열지는 사용자 결정.

검증: 4개 조사 에이전트가 각 wave를 읽기 전용 대조하고 인용 테스트의 fresh green(508 pass)을 확인. 이동한 2개 하네스는 고정 커밋↔현재 HEAD를 직접 diff. 본 문서는 코드를 수정하지 않았다.

## 7. skill ↔ core 로직 중복 전수 대조 (2026-06-01)

배경: autopilot 루프의 deterministic 로직이 `src/core` TS와 `skills/autopilot/SKILL.md` 산문에 **이중 기술**돼 동기화 강제가 없다는 지적(대화 중 발견). 7개 skill 전부를 동일 기준으로 대조했다.

**판정 기준 2축:** ① skill 산문이 core TS의 deterministic 로직(임계값·전이·결정 매핑·gate 술어)을 **재기술**하는가, ② drift 시 잘못된 동작을 잡는 **enforcement backstop**(스키마 거부·CLI 게이트·count 검증)이 있는가. backstop 없는 재기술 = 진짜 중복(드리프트가 조용히 오동작).

| skill | 판정 | 근거 (재기술 위치 ↔ core, backstop) |
|---|---|---|
| **autopilot** | **❌ 중복 (확정, backstop 없음)** | SKILL.md:24-29가 `selectReadyNode`(pending+deps passed)·`mutationGate`(approved/pending/rejected 분기)·`decideOnFailure`(retry/switch within caps→cap=non-pass) 로직을 산문 재기술 ↔ `autopilot-graph.ts`·`autopilot-driver.ts:19-31`·`autopilot-dispatch.ts:77-95`. **CLI 브리지 0**(autopilot CLI는 bootstrap만), **backstop 0**(LLM이 손으로 노드 선택·분류, 검증 장치 없음). 드리프트가 조용히 오동작 |
| **dialectic** | **△ 부분 중복** | SKILL.md step3가 opponent 라우팅 절차(`resolveOpponentCandidates`/`selectOpponent`)를 산문 재기술 ↔ `opponent-router.ts`(9 테스트). CLI 브리지 0. 단 라우팅은 "codex-plugin 존재 여부"라는 LLM만 아는 런타임 입력에 의존 → 완전 코드화 어려움. **admissibility 술어**("maps_to∧novel∧severity")는 중복 아님: `convergence-store.ts:15`이 명시하듯 admissible 플래그는 LLM 소관이고 코드는 count만 검증(`gates.ts:158` 불일치 시 throw=backstop) |
| **plan** | **△ 경미** | 승인 risk 술어(non_local∨irreversible∨unaudited)를 산문 재기술 ↔ `gates.ts`·`interview-driver.ts`. 단 그래프는 `bootstrapAutopilot`가 코드로 생성(CLI `ditto autopilot bootstrap` + deep-interview finalize에서 호출)하므로 산문은 서술적, 코드가 load-bearing |
| **verify** | **△ 경미 (backstop 있음)** | final_verdict 집계 규칙("모든 criterion pass ∧ in-scope unverified 없음")을 산문 재기술 ↔ `completion-store.ts:38-45`. 단 completion 스키마가 invalid pass를 **하드 거부**(backstop) → 드리프트가 false-pass 못 만듦. `ditto verify` CLI는 집계기가 아니라 범용 evidence 기록기(`verify.ts:43`)라 별개 |
| **deep-interview** | **✅ 깨끗** | 전 단계 CLI 위임(`ditto deep-interview {start,record-turn,check-readiness,finalize}`)이 스키마·상태기계 강제. 산문의 threshold 0.7·cap 8은 사람 대상 표기일 뿐 코드가 enforce. 의도된 dedup 정답 패턴 |
| **dialectic-review** | **✅ 깨끗** | `--mode review` thin alias, 로직 0 |
| **handoff** | **✅ 깨끗** | 스키마 기반 산출물 생성(판단형), deterministic 로직 재기술 없음. (CLI 미배선 특성은 공유하나 중복 아님) |

### 신규 갭 등록

| 갭 | 판정 | 비고 |
|---|---|---|
| **G9 autopilot skill↔core 로직 중복 (= 루프 런타임 미배선의 다른 얼굴)** | **확정 구조 갭** | 같은 deterministic 로직이 core TS(테스트 고정)·`autopilot-contract.md`(spec)·SKILL.md:24-29(산문) 3곳에 존재, 동기화 강제 0, backstop 0. **근본 원인은 루프 미배선**: per-round step(select→dispatch→collect→update→decide)을 노출하는 CLI가 없어(`src/cli/`에 루프 헬퍼 import 0건, `run.ts`에 루프 0건) skill이 로직을 산문으로 베낄 수밖에 없음. `AutopilotStore.updateNode`를 "유일 mutation 경로"로 못 박지만 호출할 CLI 부재. **해소법**: deep-interview처럼 루프 step을 `ditto autopilot {next-node,record-result}` 등 CLI로 노출 → skill은 "CLI 실행 + 결과에 판단 적용"으로 축소, 산문 중복·미배선·G7(content-free 결과 가드)이 한 번에 닫힘 |
| **G10 dialectic opponent-routing 부분 중복** | 부분 갭 (후보) | `opponent-router.ts` 로직이 SKILL.md step3에 산문 재기술, CLI 브리지 없음. 단 plugin-존재 판단이 LLM 런타임 입력이라 완전 코드화는 부분만 가능. 우선순위 낮음 |

**결론**: 진짜(backstop 없는) skill↔core 중복은 **autopilot 하나(G9)**. dialectic은 부분(G10), plan/verify는 backstop 있는 경미 중복(조치 불요), 나머지 3개는 깨끗. G9는 §5 G7·앞선 "루프 미배선" 지적과 **동일 뿌리**이며, 루프를 CLI로 결선하면 셋이 함께 닫힌다. 본 절은 읽기 전용 대조이며 코드를 수정하지 않았다.

## 8. 구현 완료 (2026-06-01)

사용자 지시("진짜 v0 갭만") 범위로 G1·G3·G4·G5·G6·G7·G8을 TDD(red→green)·갭별 커밋으로 구현. **G2(필요성 판단 선행)·G9(구조 변경)·G10·post-v0(§2.2)는 제외.** 전체 테스트 508→532 pass / 0 fail, biome lint clean.

| 갭 | 구현 | 증거 (커밋) |
|---|---|---|
| **G4** reviewer 본문 | `agents/reviewer.md` v0 skeleton → verifier 수준 절차·reviewer-output 정합 | `41cafc9` |
| **G1** closure_mode | `deriveClosureMode(reason, gatePassed)` 단일 출처 + interview/convergence exit 기록(`gates.ts`·두 스키마·producer 3·fixture 7) | `7e40c64` |
| **G7** content-free 가드 | `guardChildResult` — 빈/ack-only child 결과 → non-contentful → fixable(respawn), PASS 금지. SKILL.md step6 | `1bcd4c0` |
| **G5** file-overlap gate | `fileOverlapGate`(greedy 직렬화) + `selectReadyNodes` | `2671ba4` |
| **G3** transition table + rollback | `nodeTransition`(명시 테이블, 불법 throw) + `rollbackOnRejection`(rejected→running 노드 pending 복원) | `539b18a` |
| **G8** ack≠verification | `completionEvidenceGate` — pass인데 runnable 증거 전무 시 거부 + fixture `ack-only-pass.json`(스키마 통과 ∧ 게이트 거부) | `94ed875` |
| **G6** 생성형 inventory | `generateSurfaceCatalog` + `scripts/gen-surfaces.ts`(surfaces:gen) + 재생성==커밋본 drift-guard 테스트. catalog=생성 산출물 | `89f9c42` |

**미구현(의도적):** G2(GradeGate A/B/C — DITTO는 high-risk+completionGate로 이미 실행 차단, 추가 가치 판단 선행 필요), G9(autopilot 루프 CLI 결선 — 큰 구조 변경, skill↔core 중복·미배선·G7을 한 단위로 닫는 별도 work item), G10(dialectic 부분 중복, 낮음), post-v0(E2E·PreToolUse safety·parity — 별개 마일스톤). 어느 것을 열지는 사용자 결정.
