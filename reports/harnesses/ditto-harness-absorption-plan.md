---
title: "하네스 이식(흡수) 계획 — DITTO"
kind: absorption-plan
repo: ditto
last_updated: 2026-06-01
scope: "통합 보고서가 추출한 적용 항목을 'native-first 필터 → DITTO 계약 단위 work item'으로 흡수하는 방법·순서·작업 단위를 정의한다."
inputs:
  - reports/harnesses/ditto-harness-synthesis.md   # WHAT — 추출된 적용 항목 카탈로그
  - reports/harnesses/*.md                          # 각 하네스 1차 조사(앵커 검증 완료 2026-06-01)
relationship:
  - "synthesis = WHAT(무엇을 흡수), 본 문서 = HOW(어떻게 흡수)."
  - "ditto-application-plan.md(2026-05-24)는 구 Phase 로드맵으로 stale. 본 wave 구조가 후속."
---

# 하네스 이식(흡수) 계획 — DITTO

> **⚠️ 전제 정정 (2026-06-01)**: 이 문서는 디렉터리 목록만 보고 작성돼 **실제 구현 상태(M0~M4 + 508 통과 테스트, `reports/design/ditto-v0-implementation-plan.md`)를 반영하지 못한다.** 갭 분석 결과 다수 WI(W1-1·W1-4·W2-1·W2-2·W3-2·W3-4·W4-1·W4-2·W4-3 등)가 **이미 구현·테스트 완료**이고, E2E·PreToolUse·parity는 이미 **post-v0로 의도 연기**된 것이다. 진짜 갭과 증거는 **`reports/harnesses/ditto-harness-absorption-gap.md`**를 보라. 본 문서의 wave/WI 구조는 참고용이며, 그대로 실행하면 재구현이 된다.

## 0. 이 문서의 위치

통합 보고서(`ditto-harness-synthesis.md`)는 15개 하네스에서 **무엇을** 흡수할지 카탈로그로 정리했다. 본 문서는 그것을 **어떻게** 흡수할지 — 흡수 방법, 작업 단위, 순서 — 를 정의한다. 모든 출처 앵커는 2026-06-01에 upstream 저장소(지정 커밋) 또는 공식 문서로 직접 검증됐다(synthesis §7).

흡수는 새 개념을 늘리는 일이 아니다. DITTO에는 이미 흡수 대상 계약이 코드로 존재한다: `schemas/`(intent·question-gate·interview-state·autopilot·convergence·completion-contract·reviewer-output·e2e-journey·evidence-*·run-manifest·work-item·handoff·knowledge-record), `skills/`(autopilot·deep-interview·dialectic·plan·verify·handoff), `agents/`(planner·researcher·implementer·reviewer·verifier·dialectic-*), `src/core/`(autopilot-*·convergence-store·completion-store·evidence-store·intent-store·context-packet·gates·instruction-bridge·hosts). 흡수는 **이 계약들을 검증된 패턴으로 강화하는 것**이다.

## 1. 흡수 원칙

### 1.1 native-first 필터 (1차 스크린)

후보 패턴마다 먼저 묻는다 — **"이 primitive를 Claude Code가 이미 주는가?"**

- **준다** → 네이티브에 바인딩하고, 그 위의 얇은 contract/policy 본문만 흡수한다. 하네스가 그 primitive를 재구현한 코드는 **이식하지 않는다.**
- **안 준다** → DITTO가 소유하고 직접 구현/이식한다.

| 구분 | 대상 | 흡수 방식 |
|---|---|---|
| **DITTO 소유** (네이티브 없음) | work item·run·evidence ledger·`completion-contract`·`convergence`·`question-gate`/deep-interview scoring·`dialectic`·`handoff`·knowledge·doctor(drift inventory) | 직접 구현/이식 — ouroboros primitive·hannes 계약이 여기 안착 |
| **네이티브 바인딩** (Claude Code 제공) | 에이전트/서브에이전트 호출·병렬(Agent/Task), hook lifecycle(SessionStart/PreToolUse/PostToolUse/Stop), permission/sandbox 모드(default/acceptEdits/plan/bypassPermissions — 실측 확인), skill/MCP 디스커버리, Stop 기반 continuation | 네이티브 그대로 + 그 안에 들어갈 policy/contract 본문만 흡수 |

> 이 필터는 멘탈 모델("자동차는 안 만든다")의 적용이다. Claude Code가 이미 구현한 것을 재구현하거나 우회하지 않는다. **하네스 채택 규율(아래 1.4 avoid)과는 별개 개념이다.**

### 1.2 흡수 단위 = DITTO 계약, 하네스 아님

하네스를 통째로 옮기지 않는다. 같은 계약 하나에 여러 하네스가 기여한다(예: `convergence` ← hannes + ouroboros + deepagents). 작업 단위는 synthesis §2 개념축(=기존 계약)이고, work item 하나가 계약 하나를 강화한다.

### 1.3 이식하지 않는 것 (native 재구현물)

native-first 필터에 걸려 **이식 대상에서 제외**되는, "호스트에 없는 primitive를 하네스가 재구현한" 코드:

- OMX `src/team/*` tmux·claim/lease·mailbox 팀 런타임 — Codex CLI를 worker로 묶으려고 만든 것. Claude Code는 네이티브 병렬 Agent가 있음.
- deepagents `SubAgentMiddleware`/`async_subagents` 런타임 — LangGraph 위 재구현.
- 커스텀 sandbox provisioner / 커스텀 hook dispatcher / 커스텀 skill 로더 — 전부 네이티브 존재.
- OMX `ultragoal` aggregate goal 세션 소유 모델 — host 특수성.

### 1.4 하네스 채택 규율 (synthesis §5.4 avoid, 별개 규율)

native-first와 무관하게 지키는 것: 전체 표면 복제 금지(GSD 67 commands 등), context 과적재 금지, telemetry/star 강요 배제, regex-only guardrail 대신 structured parsing, auto-update 같은 런타임 side effect 배제.

## 2. 각 하네스의 역할 (donor classification)

| 하네스 | 역할 | 흡수 방식 |
|---|---|---|
| **hannes** | 전신(prior art) | *채굴* — lessons.jsonl 132건 → fixture, 11계약 중 10개는 재발명 말고 대조 |
| **ouroboros** | 결정론 primitive 공급 | *코드 이식*(DITTO 소유) — VAGUE_TERMS·GradeGate·deterministic_floor·ledger-primary |
| **oh-my-codex / -claudecode / -openagent / get-shit-done / opencode-slim** | 검증된 패턴 공급 | *적응* — 검증된 앵커 근거로 기존 계약 강화. native 재구현물은 제외 |
| **deepagents** | 패턴 공급 | *적응* — RubricMiddleware 패턴(런타임은 제외), 구조화 파일 도구 |
| **blogs 01/02 · 03 · 04** | 경계·원칙 공급 | *불변식* — session/harness/sandbox 분리, control plane 소유 |
| **andrej / mattpocock / superpowers** | 이미 헌장 흡수됨 | *잔여* — 예제 pair → fixture, skill description 규율 |

## 3. 표준 흡수 work item 형태

각 흡수는 DITTO work item 1개이며 다음을 채운다:

- **target**: 강화할 DITTO 계약/인터페이스
- **native-first 판정**: DITTO 소유(이식/구현) | 네이티브 바인딩(+policy만)
- **source**: 출처 패턴 + **검증된 앵커**(`path:line @ commit`)
- **acceptance**: 관찰 가능 기준(가능하면 결정론 판정)
- **fixture**: 통과/실패 케이스 — 우선 hannes lessons에서 회수
- **avoid 경계**: 끌고 오면 안 되는 것(§1.3/§1.4)

원칙: 하네스 코드를 옮기지 말고 **검증된 규칙을 DITTO 계약 테스트로 먼저 박은 뒤(fixture-first) 최소 구현**한다. hannes 교훈대로 바(schema)·판단(LLM)·라우팅(얇은 hook) 3층을 섞지 않는다.

## 4. Wave 계획

순서는 ROID + 의존성. 앞 wave일수록 "거의 복붙 + 최고 레버리지 + DITTO 소유라 native-first 무관"이다.

### Wave 1 — 결정론 게이트 (전부 DITTO 소유, native-first 무관)

가장 안전하고 ROI 높은 출발점. 다른 wave의 검증 기반이 된다.

| WI | target | source(검증된 앵커) | acceptance / fixture |
|---|---|---|---|
| **W1-1** 관찰가능성 게이트 | `completion-contract` + `src/core/gates` | ouroboros `auto/grading.py:23-57, 352-376 @ 32fcaf10`(VAGUE_TERMS/_OBSERVABLE_HINTS) | vague/untestable acceptance → finding. fixture: hannes lessons + ouroboros 케이스 |
| **W1-2** 모호성 floor + ledger-primary 종료 | `question-gate` · `interview-state` | ouroboros `grading.py:401-425`(floor), `interview_driver.py:617-693`(ledger-primary closure), `ledger.py:11-103`(source×status) | max(LLM, floor) 채택; ledger 구조 완전성만 hard gate, 모델 동의는 closure_mode 레코드 |
| **W1-3** GradeGate A/B/C + high-risk blocker | `src/core/gates` · `completion-contract` | ouroboros `grading.py:109-296, 512-535` | B/C 등급 실행 차단; credential/production 등 ASSUMPTION 자동 blocker. closure_mode-aware 억제는 ledger-primary와 묶어서만 |
| **W1-4** ConvergenceContract 쌍대 게이트 | `convergence` · `convergence-store` | hannes §3.1(설계), `reports/design/contracts/convergence-contract.md` | **선행구현 없음 → 착수 전 dialectic 설계 검증 필수.** CompletionGate ∩ ConvergenceGate, ratchet, admissibility |
| **W1-5** lessons fixture 회수(병렬 substrate) | evaluator fixture 세트 | hannes lessons.jsonl 132건 §4.1 | 각 lesson → 통과/실패 fixture. W1-1~3·Wave3 검증 기반 |

ConvergenceContract(W1-4)는 hannes에 선행구현이 없는 유일 계약이라 **위험이 가장 크다 → 착수 전 `dialectic`으로 설계 압박**.

### Wave 2 — 계획/실행 경계 (DITTO 계약 + 네이티브 바인딩)

| WI | target | native-first | source(검증된 앵커) | acceptance |
|---|---|---|---|---|
| **W2-1** plan read-only 경계 | `plan`·`planner` | 네이티브 permission(plan/read-only 모드)에 바인딩 | oh-my-codex `skills/ralplan/SKILL.md:67-77 @ ff17267b` | 합의 전 write 차단(네이티브 plan 모드), 실행은 별도 run |
| **W2-2** consensus/approval 영속 게이트 | `plan`·`completion-store` | DITTO 소유 | `ralplan/SKILL.md:79-90 @ ff17267b`; OMC `pending-approval` | architect+critic+consensus 레코드 없으면 implement 노드 not ready |
| **W2-3** autopilot FSM 전이 테이블 | `autopilot-graph`·`autopilot-driver` | 전이=DITTO 소유 / continuation=네이티브 Stop hook / dispatch=네이티브 Agent | `docs/STATE_MODEL.md:162, 170-173 @ ff17267b` | transition table test 선작성(overlap/auto-complete/denied rollback). 런타임 스케줄러 재구현 금지 |

### Wave 3 — 검증 lane (네이티브 서브에이전트 + DITTO 계약)

| WI | target | native-first | source(검증된 앵커) | acceptance |
|---|---|---|---|---|
| **W3-1** generator/evaluator 분리 | `verifier`·`reviewer`·`reviewer-output` | 네이티브 Agent + read-only 모드에 바인딩 | oh-my-claudecode `agents/verifier.md:9-107`; 02 "MAD Outcomes" | 작성자와 분리된 read-only 검증, acceptance별 pass/partial/fail/unverified |
| **W3-2** Codex-as-Opponent 라우팅 | `dialectic`·`dialectic-opponent` | 네이티브(Codex 플러그인 경유) | hannes §3.2 `registry.json` mi-scope-fix | Opponent Codex 우선, Claude opus→sonnet fallback |
| **W3-3** rubric 재실행 루프 | `verify`·`autopilot` 노드 게이트 | 재실행=네이티브 Agent 재호출(미들웨어 런타임 아님) | deepagents `middleware/rubric.py`(패턴) | acceptance를 rubric으로, grader가 satisfied/needs_revision/failed, max_iterations 상한 |
| **W3-4** evidence-first verifier | `verify`·`evidence-store` | DITTO 소유 | get-shit-done `agents/gsd-verifier.md:15-26 @ 9b5ee373` | SUMMARY 불신, observable truth 직접 재확인 |
| **W3-5** E2E journey(브라우저) | `e2e-journey` | 네이티브 외부 도구 호출 | PURPOSE §34; oh-my-openagent Playwright | screenshot/trace/console를 run artifact로. 설치 실패는 unverified |

### Wave 4 — doctor · bounded subagent · safety (native-first가 가장 강하게 작용)

| WI | target | native-first | source(검증된 앵커) | acceptance |
|---|---|---|---|---|
| **W4-1** bounded subagent 위임 계약 | context-packet + 위임 계약 | **네이티브 Agent에 바인딩**. 팀 런타임 이식 금지 | oh-my-openagent 6-section; deepagents stateless | 6-section 계약 + scope/forbidden/evidence-return. file-overlap gate만, claim/lease 런타임 제외 |
| **W4-2** doctor self-inventory drift | `doctor`·`instruction-bridge` | DITTO 소유(네이티브 config 위 검사) | get-shit-done `docs/INVENTORY.md:3-9 @ 9b5ee373`; OMC schema drift 버그 | skill/command를 생성형 inventory로, 문서 숫자 직접 기입 금지 |
| **W4-3** native hooks policy | hook policy 본문 | **네이티브 hooks**(SessionStart/PreToolUse/Stop)에 바인딩 | oh-my-claudecode fail-open; oh-my-codex guard opt-in | fail-open + kill switch + opt-in 기본값. hook dispatcher 재구현 금지 |
| **W4-4** safety policy | PreToolUse policy 본문 | 네이티브 PreToolUse에 바인딩 | opencode-slim safety shim; get-shit-done package legitimacy | dry-run/fail-closed, 파괴적 path 단일 helper, dependency provenance. 커스텀 shim 런타임 아님 |

## 5. 흡수 게이트 — DITTO 자신의 루프로 (dogfooding)

각 WI는 DITTO work item으로 `plan → 구현 → verify → handoff`로 닫는다. 흡수 작업 자체가 DITTO를 시험한다(synthesis §1.14: DITTO 자체 work item은 DITTO 도구로 검증·마감).

- **completion 게이트**: 각 WI는 acceptance별 evidence 없이 `final_verdict=pass` 불가.
- **fixture-first**: 구현 전 계약 테스트(W1-5 lessons fixture) 선작성.
- **하네스 변경 회귀**: prompt/hook/profile/contract를 건드리는 WI는 변경 전후 manifest + smoke + rollback을 남긴다(synthesis §2.L; "harness 변경도 모델 변경만큼 회귀를 만든다").
- **native-first 판정 기록**: 각 WI의 work-item.json에 "DITTO 소유 / 네이티브 바인딩" 판정과 근거를 남겨, 이후 같은 패턴 재검토 시 재구현 유혹을 차단.

## 6. 위험 · 열린 질문

1. **ConvergenceContract(W1-4)** — 유일하게 선행구현이 없다. 착수 전 dialectic 설계 검증을 게이트로 둔다.
2. **closure_mode-aware 억제(W1-3)** — ledger-primary 정책과 분리해 차용하면 안전 우회 구멍. 반드시 W1-2와 묶는다.
3. **네이티브 경계의 실제 표면** — Claude Code의 Agent 병렬·hook·permission 모드가 위 바인딩 가정을 실제로 충족하는지 각 wave 착수 시 doctor로 fresh 확인(제품 버전 의존).
4. **wave 간 의존** — Wave 1 게이트가 Wave 3 검증 lane의 acceptance 기준을 공급하므로 순서 역전 금지.
5. **fixture 출처 분류** — hannes 132 lessons를 어느 게이트/계약 fixture로 매핑할지는 W1-5에서 확정.

## 7. 다음 작업

- **즉시 착수 후보**: W1-1(관찰가능성 게이트) + W1-5(lessons fixture) — DITTO 소유라 native-first 무관, ouroboros 코드 거의 복붙, fixture-first 가능.
- **착수 전 선행**: W1-4(ConvergenceContract) dialectic 설계 검증.
- 이 계획을 실행하려면 각 WI를 `ditto:plan`으로 구체화(대상 계약·검증된 앵커·acceptance·fixture까지)한 뒤 autopilot으로 닫는다.

본 문서는 흡수의 "방법·순서·단위"를 고정한다. 각 WI의 실제 구현·검증은 별도 work item에서 fresh evidence로 닫으며, 본 문서의 매핑·근거 인용이 구현 완료를 의미하지 않는다.
