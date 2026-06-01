---
title: "reports/harnesses 현행화 통합 보고서 — DITTO 적용"
kind: synthesis-report
repo: ditto
last_updated: 2026-06-01
scope: "2026-06-01 현행화된 15개 하네스 조사 보고서에서 DITTO 적용 항목을 재추출·통합한다."
inputs:
  - reports/harnesses/03-claude-codex-adoption-map-ko.md
  - reports/harnesses/04-claude-code-codex-omc-omx-research-ko.md
  - reports/harnesses/blogs/01-anthropic-engineering-survey.md
  - reports/harnesses/blogs/02-managed-agents-annotated-ko.md
  - reports/harnesses/oh-my-codex.md
  - reports/harnesses/oh-my-claudecode.md
  - reports/harnesses/oh-my-openagent.md
  - reports/harnesses/oh-my-opencode-slim.md
  - reports/harnesses/deepagents.md
  - reports/harnesses/superpowers.md
  - reports/harnesses/ouroboros.md
  - reports/harnesses/hannes.md
  - reports/harnesses/andrej-karpathy-skills.md
  - reports/harnesses/mattpocock-skills.md
  - reports/harnesses/get-shit-done.md  # 신규 활성 저장소 open-gsd/gsd-core @ 9b5ee373(브랜치 next)로 전환·갱신
related:
  - reports/harnesses/ditto-application-plan.md  # Phase 로드맵(2026-05-24). 본 문서는 그 위에서 현행화 적용 항목을 통합.
---

# reports/harnesses 현행화 통합 보고서 — DITTO 적용

## 0. 이 문서의 위치

이 문서는 `reports/harnesses/` 하위 조사 보고서들의 **2026-06-01 현행화본**에서 DITTO에 적용할 항목만 재추출해 한 곳에 통합한 것이다. 각 보고서는 개별 하네스(또는 원칙 묶음)에 대한 1차 조사이고, 본 문서는 그 15개를 DITTO 개념축으로 가로질러 정리한다.

- **`ditto-application-plan.md`(2026-05-24)와의 관계**: plan은 Phase 0~11 로드맵이다. 본 문서는 그 로드맵을 대체하지 않고, 현행화로 새로 드러난 적용 항목과 plan에 누락됐던 하네스 3종(`hannes`, `ouroboros`, `04-...research`)을 반영한 **적용 카탈로그**다.
- **분류 체계**: 각 항목은 `apply-now`(지금 적용) / `adapt`(변형 적용) / `defer`(나중) / `avoid`(반면교사)로 표시한다. 이는 `03-claude-codex-adoption-map-ko.md`가 정의한 상위 분류를 그대로 따른다.

### 0.1 현재 DITTO 실제 상태 (코드 기준)

이 통합은 추상 계획이 아니라 이미 존재하는 인터페이스 위에 적용 항목을 얹는다. 2026-06-01 기준 저장소에 실재하는 표면:

- **schemas/**: `intent`, `question-gate`, `interview-state`, `autopilot`, `convergence`, `dialectic`, `completion-contract`, `reviewer-output`, `e2e-journey`, `evidence-record`, `evidence-index`, `run-manifest`, `work-item`, `handoff`, `knowledge-record`, `glossary`, `language-ledger`, `command-log-entry`
- **skills/**: `autopilot`, `deep-interview`, `dialectic`, `dialectic-review`, `plan`, `verify`, `handoff`
- **agents/**: `planner`, `researcher`, `implementer`, `reviewer`, `verifier`, `dialectic-{producer,opponent,synthesizer}`
- **src/core/**: `autopilot-{graph,driver,dispatch,store,bootstrap}`, `convergence-store`, `completion-store`, `evidence-store`, `intent-store`, `context-packet`, `gates`, `instruction-bridge`, `bridge-sync`, `charter`, `hosts/`(host adapter)
- **CLI**: `work`, `run`, `verify`, `doctor`, `bridge`, `context`, `deep-interview`, `autopilot`
- **reports/design/contracts/**: `autopilot`, `convergence`, `deep-interview`, `dialectic-deliberation`, `knowledge`, `e2e-journey`

즉 plan 문서의 v0.1/v0.2(evidence ledger + doctor/bridge)뿐 아니라 autopilot 그래프, convergence, dialectic, deep-interview 계약까지 이미 1차 구현 또는 계약화돼 있다. 아래 적용 항목은 대부분 **새 개념 추가가 아니라 기존 계약의 강화·정밀화**다.

---

## 1. 현행화가 바꾼 것 — 한눈에

이번 현행화에서 여러 하네스가 동시에 같은 방향으로 움직였다. 이게 DITTO 설계에 주는 가장 큰 신호다.

1. **계획과 실행의 경계가 전반적으로 엄격해졌다.** OMX `ralplan`은 consensus gate를 영속화하지 않으면 실행 handoff가 막히고 planning 중 write tool이 차단된다. OMC `ralplan`은 `pending-approval` terminal phase로 승인 전 구현·커밋·PR을 막는다. → DITTO `plan` 노드는 read-only profile로 강제하고, `implement` 노드 ready 조건에 승인/consensus 레코드를 건다.
2. **오케스트레이션 루프가 자연어에서 명시적 상태기계(FSM)로 굳어졌다.** OMX `autopilot`이 `src/autopilot/fsm.ts`로 형식화되고 권장 경로가 `deep-interview → ralplan → ultragoal → code-review → ultraqa`로 바뀌며 ralph류 무한 지속이 강등됐다. → DITTO `autopilot-graph`의 전이를 transition table test로 고정하고, 검증(ultraqa 대응)을 루프 종단에 정식 편입한다.
3. **완료·모호성·검증가능성을 코드가 측정한다.** Anthropic 블로그(Outcomes rubric grader), deepagents(RubricMiddleware), ouroboros(`deterministic_floor`, GradeGate, VAGUE_TERMS)가 모두 "LLM 자기보고를 코드 바닥이 누른다"로 수렴. → DITTO `completion-contract`/`convergence`/`question-gate`의 hard gate를 LLM 판정이 아니라 결정론 검사로 1차 닫는다.
4. **goal/state를 host 내부 세션이 아니라 repo artifact가 소유한다.** OMX ultragoal aggregate goal mode, OMC `.omc/ultragoal/goals.json` + PreToolUse `/goal` hard gate가 모두 artifact-first ownership으로 이동. → DITTO `.ditto/work-items/`가 authority를 갖고 host native goal은 guard로만 결합하는 현 설계가 양 host에서 검증됨.
5. **안전 기본값이 사용자 환경을 덜 침범하는 쪽으로.** OMX Lore commit guard가 opt-out→opt-in, plugin-scoped hooks 정식화, hook payload guard, OMC fail-open 훅, OpenCode auto-update 위험 경고. → DITTO 훅/setup은 fail-open + kill switch + managed-block 보존을 기본값으로.

신규로 통합 plan에 편입할 하네스 2종:

- **`hannes`**: DITTO의 직접 전신(prior art). 설계 계약 11개 중 10개가 이미 살아 돌아간 구현이고, 검증된 실패 패턴 132건(lessons.jsonl)을 평가 fixture로 즉시 회수 가능.
- **`ouroboros`**: 모호성·검증가능성·완료를 측정하는 **결정론 primitive**의 코드 원천. `deterministic_floor`, source×status ledger, GradeGate A/B/C, VAGUE_TERMS는 거의 그대로 차용 가능.

저장소 전환으로 재활성된 하네스 1종:

- **`get-shit-done`**: 구 `gsd-build/get-shit-done`(2026-05-22 아카이브)이 `open-gsd/gsd-core`(개명 `@opengsd/gsd-core`, 브랜치 `next`, 커밋 `9b5ee373`)로 전환·갱신돼 제외에서 풀렸다. 핵심 기여(thin command/lazy workflow, planner/plan-checker/executor/verifier 분리, PLAN frontmatter + wave overlap gate, INVENTORY drift-control, runtime parity matrix)는 여전히 유효하고, 전환에서 **ADR-0174로 별도 SDK 패키지 경계가 폐기**되어 단일 CJS(`gsd_run query`) no-throw 결과 계약으로 통합된 것이 새 교훈이다.

---

## 2. 통합 적용 카탈로그 (DITTO 개념축)

각 개념마다 기여 보고서를 묶고, 지금 적용할 항목(apply-now/adapt)을 근거와 함께 정리한다. defer/avoid는 §5에 모은다.

### 2.A 의도 파악 · 사용자 인터뷰 (intent / question-gate / deep-interview)

기여: `ouroboros`, `hannes`, `oh-my-codex`(deep-interview, prometheus-strict), `oh-my-opencode-slim`(/interview), `get-shit-done`(spec-phase/discuss-phase), `mattpocock-skills`, `03`, `02`

- **[apply-now] 결정론 ambiguity floor — LLM 자기보고를 코드가 누름.** ambiguity를 `max(LLM_reported, deterministic_floor(ledger))`로 채택해 모델이 측정 가능한 수준 아래로 모호성을 과소보고하지 못하게 한다. DITTO 형태: `question-gate`/`interview-state` 스키마에 open 필수섹션 수·CONFLICTING 수·assumption-only 비율로 floor를 산출, 모델 self-readiness와 max 결합. 근거: ouroboros `auto/grading.py:401-425`, `auto/pipeline.py:3759-3763`.
- **[apply-now] 종료 게이트는 ledger-primary, 모델 동의는 advisory.** "구조 완전성(필수 섹션 open_gap 없음)"만 hard gate로 닫고, LLM 동의는 `closure_mode`(mutual_agreement/ledger_only/safe_default) 레코드로만 남긴다. AND-gate(모델+ledger 동시 만족)는 LLM 평가자 미포화 시 무한 stall이 실제 재현돼(ouroboros #1170) 폐기됨. DITTO 형태: `deep-interview`/`convergence` 종료 조건을 ledger-primary로. **현행화 신규** — 이전 분석의 AND-gate 표현을 수정해야 함. 근거: ouroboros `auto/interview_driver.py:617-693`.
- **[apply-now] source×status ledger — provenance가 타입.** dimension을 `source`(user_goal/repo_fact/inference/assumption/auto_fill_inference) × `status`(missing/weak/confirmed/conflicting) 타입으로 박아 evidence-backed와 assumption-only를 구조적으로 분리, 동일 키 충돌은 merge하지 않고 CONFLICTING 차단. DITTO 형태: `interview-state`/`evidence-record`에 finding(evidence-backed) vs hypothesis(inference/assumption) 라벨을 스키마 강제. **현행화 신규**(`AUTO_FILL_INFERENCE` source 추가). 근거: ouroboros `auto/ledger.py:11-103`.
- **[adapt] ambiguity scoring 공식 — 검증된 정답지.** greenfield/brownfield 가중 `1 - (goal×0.40 + constraints×0.30 + criteria×0.30)` + crystallize 게이트. DITTO 형태: `deep-interview-contract.md`의 "how"에 직접 이식. hannes에 이미 살아 돌아간 구현 존재. 근거: hannes §4.2 `interview/SKILL.md`.
- **[adapt] Socratic 단일 질문 생성기 + breadth control.** 인터뷰어는 질문만(구현/약속 금지), 한 번에 한 질문, 앵커링 방지, brownfield self-answer 우선(`[from-code]`/`[from-user]`/`[from-research]`). PURPOSE의 "질문 전 사전 답변 가능성 타진"과 정합. DITTO 형태: `deep-interview` 스킬 본문 + `question-gate`의 self-answer 우선 규칙. 근거: ouroboros `agents/socratic-interviewer.md:5-49`.
- **[adapt] critical 차원은 safe-default로 못 닫는다.** `goal`은 conservative default 불가 → 없으면 즉시 blocker. `failure_modes`(pre-mortem)·`verification_plan`이 모호성 필수 차원에 포함. DITTO 형태: deep-interview 차원 집합에 critical 표시, 미해소 시 user-owned로 차단. 단 작은 요청에 10차원 강제는 비대화 금지 원칙과 충돌하므로 critical만 hard-gate. 근거: ouroboros `auto/ledger.py:57-68`.
- **[adapt] 인터뷰 깊이 프로파일 + downstream binding gate.** quick/standard/deep 프로파일과 threshold·maxRounds 설정 계층, 인터뷰 산출물이 후속 plan/run의 binding authority. DITTO 형태: `deep-interview`에 깊이 프로파일, 산출물이 plan 노드의 입력 권위가 되도록 게이팅. **현행화 신규**. 근거: oh-my-codex `src/config/deep-interview.ts`, prometheus-strict(Metis/Momus/Oracle) `skills/prometheus-strict/SKILL.md`.

### 2.B 계획 · 승인 게이트 (plan / planner)

기여: `oh-my-codex`(ralplan), `oh-my-claudecode`(ralplan), `get-shit-done`(plan-checker), `superpowers`, `03`, `mattpocock-skills`

- **[apply-now] planning/execution 경계 — 계획 중 write 차단.** plan은 planning mode이며 합의 완료 전 코드 편집을 명시 금지하고 planning artifact만 쓴다. DITTO 형태: `plan` 노드를 read-only provider profile로 강제, 실행은 별도 run으로 분리. dialectic(producer/opponent/synthesizer)도 이 경계를 따른다. **현행화 신규**. 근거: oh-my-codex `skills/ralplan/SKILL.md:56-67`, 04 커밋 `c46acf9c`.
- **[apply-now] consensus/approval 영속화 없이는 handoff 불가.** PRD/test-spec 파일 존재만으로는 plan 완료·실행 전이가 안 되고, architect_review + critic_review + consensus_gate.complete 모두 영속화해야 handoff 허용(OMX). OMC는 `pending-approval` terminal phase로 승인 전 구현·커밋·PR 차단. DITTO 형태: `plan`의 approval decision에 consensus gate record를 completion-contract 형태로 요구, 레코드 없으면 `implement` 노드 ready 안 됨. 되돌리기 어려운 작업은 `pending-approval`에서 정지 → 사용자/deep-interview gate. **현행화 신규**. 근거: oh-my-codex `skills/ralplan/SKILL.md:68-94`, oh-my-claudecode `persistent-mode/index.ts:618-626,1703-1712`.
- **[adapt] plan↔execution artifact 분리 + 무수정 invariant.** executing agent는 plan을 임의 수정하지 않고 노드 상태(ready/done/blocked)만 갱신한다. DITTO 형태: `autopilot-graph` 실행이 노드 상태만 전이하고 plan 구조를 변형 못 하게 invariant 강화. 근거: superpowers `skills/writing-plans/SKILL.md:8-20`.
- **[adapt] reviewer 서브에이전트 순차 강제.** architect/critic을 동일 parallel batch 동시 호출 금지, 각각 별 agent_type으로 순차 launch, 임시 reviewer prompt 대체 불가. DITTO 형태: `dialectic`의 producer/opponent를 별 subagent로 순차 실행, ad-hoc prompt 대체 금지. **현행화 신규**. 근거: oh-my-codex `skills/ralplan/SKILL.md:49-60`.
- **[adapt] seam-first 계획.** PRD 단계에서 deep module 설계 용어 대신 테스트 seam 위치를 먼저 잡는다("highest seam possible"). tdd public-interface 우선과 일치. DITTO 형태: `plan` 노드에서 implement/verify 매핑 시 seam 우선. **현행화 신규**. 근거: mattpocock `skills/engineering/to-prd/SKILL.md:14-16`.
- **[apply-now] read-only plan-checker — 구현 전 게이트(planner와 context 분리).** 실행 전 계획을 read-only로 검토해 requirement coverage, dependency correctness, context compliance, 자동 검증 가능성(Nyquist), 파일 충돌을 확인하고 실패 시 계획으로 되돌린다. **planner와 context를 공유하지 않는 게 핵심**(자기 계획을 자기가 검토하는 과신 차단). DITTO 형태: `convergence` 쌍대 게이트의 한 쪽 — plan 노드 산출 후 별도 bounded subagent(read-only profile)가 통과 판정, planner와 분리된 evaluator lane. 근거: get-shit-done `agents/gsd-plan-checker.md:1-5,300-494 @ 9b5ee373`.

### 2.C 오케스트레이션 루프 (autopilot / orchestrator)

기여: `oh-my-codex`(autopilot FSM), `oh-my-claudecode`(persistent mode), `hannes`(orchestrator), `get-shit-done`(thin orchestrator), `oh-my-openagent`(CLI 완료 조건), `04`, `01`

- **[adapt] autopilot을 명시적 FSM으로 고정 + child-phase supervision.** 권장 경로 `deep-interview → plan → implement → review → verify`를 transition table로 박고 각 노드 진입/이탈 gate(ready 조건, 증거 수집, 실패 분류)를 코드 invariant로. ralph류 무한 지속은 default가 아닌 명시 opt-in 노드로 분리. DITTO 형태: `autopilot-graph`/`autopilot-driver` 전이를 transition table test로 선작성(workflow overlap, auto-complete, denied rollback 케이스). **현행화 신규**. 근거: oh-my-codex `skills/autopilot/SKILL.md:45-94`, `docs/STATE_MODEL.md:142-173`, 04 `src/autopilot/fsm.ts`.
- **[apply-now] orchestrator 에이전트 — content 생성 금지, dispatch·판단만.** fan-out 시 context isolation(supervisor 가설 주입 금지, Task spec 원문만 전달). 노드 dispatch·실패 분류·재시도/전환/에스컬레이트 판단 주체. DITTO 형태: `autopilot-dispatch`/`autopilot-driver`의 orchestrator 역할(이미 `agents/`에 planner/implementer/reviewer/verifier 존재). hannes가 설계서 §7.4의 "worker만 있고 driver 없던 구멍"을 메우는 선행구현. 근거: hannes §1, §6.
- **[apply-now] 얇은 오케스트레이터 + fresh-context 전문 에이전트.** workflow는 context 로드·에이전트 spawn·결과 수집·상태 갱신만 하고, 전문 에이전트가 매번 fresh context window·제한된 도구·명확한 산출물을 받는다(메인 context 30-40% 유지, 실행 wave마다 새 200k context). DITTO 형태: autopilot 노드가 절차 본문을 직접 들지 않고 context packet 참조만 보유, owner subagent가 fresh context로 실행 — Context Rot 완화의 직접 수단. 근거: get-shit-done `docs/ARCHITECTURE.md:72-83,133-143`, `docs/AGENTS.md:9 @ 9b5ee373`.
- **[apply-now] primary loop authority — 세션당 하나 + nested bubble-up.** nested workflow는 parent authority로 bubble up해 Stop enforcement와 phase accounting을 한 경로로 모은다. DITTO 형태: autopilot이 work item당 단일 authority를 run state에 기록, bounded subagent는 완료/중단 사유 enum만 보고하고 continuation 판단은 parent 독점. 근거: oh-my-claudecode `persistent-mode/index.ts:2021-2049`.
- **[apply-now] 자동 재시도 예외 목록.** explicit cancel, user abort, rate limit, auth failure, context compaction, scheduled wakeup, oversized output, pending async work는 자동 continuation에서 제외(특히 rate limit 무한 재시도 방지). DITTO 형태: autopilot stop conditions + failure classifier의 1급 분기 enum. 근거: oh-my-claudecode `persistent-mode/index.ts:1898-2014`.
- **[apply-now] CLI run 완료 조건 = 그래프 terminal + subagent 전부 idle.** 단순 프로세스 종료가 아니라 모든 노드 terminal + background child 전부 idle일 때만 종료. DITTO 형태: autopilot final_verdict 진입 조건에 "미완 노드 0 + 대기 subagent 0" 추가. PURPOSE의 "멋대로 중단 않고 끝까지 완수"와 정합. 근거: oh-my-openagent `src/cli/cli-program.ts:74-134`.
- **[apply-now] artifact-first goal ownership.** goal authority를 host 내부 세션이 아니라 repo artifact + ledger가 갖고, host native goal(`/goal`)은 PreToolUse hard gate로만 결합. DITTO 형태: `.ditto/work-items/`가 authority, host goal은 guard. handoff·재개성의 토대. **현행화 신규**(OMC `/goal` hard gate, OMX aggregate goal). 근거: 04 §4.7/§9.4, OMC `pre-tool-enforcer.mjs:592-616`.

### 2.D 수렴 · 완료 게이트 (convergence / completion-contract)

기여: `hannes`(ConvergenceContract), `ouroboros`(GradeGate), `deepagents`(RubricMiddleware), `superpowers`, `01`, `02`, `andrej-karpathy`

- **[apply-now] ConvergenceContract — 쌍대 게이트.** CompletionGate(증거로 STOP)와 ConvergenceGate(grounded·novel·admissible 반론 있어야 CONTINUE)의 교집합으로 고정점 정의. "cap-reached ≠ converged", ratchet(최선본 보존), decision ledger, admissibility gate. DITTO 형태: `convergence` 스키마/`convergence-store`(이미 존재) + `completion-contract` 쌍. dialectic 반론을 admissibility로 필터, autopilot 종료에 양방향 게이트. **hannes에 선행구현이 없는 유일 항목 → 설계 검증 우선순위 최상위.** 근거: hannes §3.1, `convergence-contract.md`.
- **[apply-now] GradeGate A/B/C — 실행 전 결정론 차단.** B/C 등급 실행을 막는 게이트. A(may_run) = blocker 0 AND coverage≥0.90·ambiguity≤0.20·testability≥0.85·feasibility≥0.80·risk≤0.25. closure_mode가 ledger_only/degraded면 stale한 LLM ambiguity blocker는 억제(단 BLOCKED gap은 hard 유지). DITTO 형태: `draft→in_progress` 전이 게이트 + final_verdict. 임계는 work item/profile별 configurable 상수. **closure_mode-aware 억제는 반드시 ledger-primary 정책과 묶어서만 차용**(억제만 떼면 안전 우회 구멍). **현행화 신규**. 근거: ouroboros `auto/grading.py:109-296`.
- **[apply-now] acceptance criterion 검증가능성 기계 판정.** vague 용어(easy/robust/scalable/better)가 있으면 vague finding, 관찰 가능 패턴(명령·exit code·stdout·HTTP 2xx·테스트 통과)에 안 걸리면 untestable finding. DITTO 형태: `completion-contract`의 acceptance_criteria "관찰 가능" 강제를 정규식·상수로 구현 — `VAGUE_TERMS`/`_OBSERVABLE_HINTS`는 거의 그대로 차용. 근거: ouroboros `auto/grading.py:23-57,352-376`.
- **[apply-now] 증거 없는 완료 금지 (verification-before-completion).** 완료/통과/수정 주장은 fresh command output·체크리스트·실행 로그가 있을 때만 허용, 검증 못 한 항목은 실패가 아니라 `unverified`로 분리 보고. DITTO 형태: `verify` 스킬 + completion-contract hard gate, 응답 스키마에 `변경/검증 명령·결과/미검증/남은 리스크` 4필드 필수. PURPOSE의 "근거 없으면 모른다고 답한다"와 직결. 근거: superpowers `verification-before-completion/SKILL.md:16-38`, 01 "Generator/evaluator 분리".
- **[apply-now] RubricMiddleware 패턴 — self-eval 재실행 루프.** grader subagent가 acceptance 충족을 `satisfied/needs_revision/failed`로 판정하고 부족 시 피드백 주입 재실행, max_iterations(기본 3·하드상한 20). DITTO 형태: `verify`/autopilot 노드 완료 게이트를 하네스 계층에 구현 — completion-contract의 criteria를 rubric으로 넘기고 grader가 판정. no-op-safe(rubric 없으면 통과)라 상주 가능. **현행화 신규**(deepagents 813 LOC 신규). 근거: deepagents `middleware/rubric.py`.
- **[apply-now] high-risk assumption 자동 blocker.** credential/api key/production/payment/legal/medical 용어를 가진 활성 ASSUMPTION은 blocker로 승격(`non_goals` 섹션 제외). DITTO 형태: plan approval gate의 자동 트리거 — irreversible/high-blast 결정의 user-owned 승인 강제, pre-mortem 승격. 상수 용어집 그대로 차용. **현행화 신규**(`AUTO_FILL_INFERENCE` 포함). 근거: ouroboros `auto/grading.py:512-535`.

### 2.E 검증 lane (verify / reviewer / dialectic / E2E)

기여: `hannes`(Codex-opponent), `oh-my-claudecode`(read-only lane), `oh-my-openagent`(병렬 review-work), `oh-my-opencode-slim`(council), `get-shit-done`(evidence-first verifier, review), `mattpocock`(diagnose), `01`, `02`(Outcomes), `superpowers`

- **[apply-now] generator/evaluator 권한·context 분리.** 작성자와 분리된 검증 에이전트가 Write/Edit 금지(read-only profile) 상태로 acceptance별 fresh evidence(VERIFIED/PARTIAL/MISSING)만 보고. 같은 agent의 self-eval은 과신 편향. Anthropic Outcomes(rubric grader 독립 context)가 +8~10% 실증. DITTO 형태: `verifier`/`reviewer` 에이전트(이미 존재) + `reviewer-output` 스키마. 근거: oh-my-claudecode `agents/verifier.md:9-107`, 02 "MAD Outcomes".
- **[apply-now] evidence-first verifier — executor의 SUMMARY를 불신한다.** verifier는 executor 자기보고 SUMMARY를 신뢰하지 말고 observable truth, artifact 존재, data-flow, wiring, debt marker/probe를 codebase evidence로 직접 확인한다. DITTO 형태: `verify` + `evidence-store`/`evidence-record`로 acceptance별 직접 재확인 → completion-contract. "수정했다 ≠ 검증했다"의 직접 enforcement(헌장 §4-5, PURPOSE 할루시네이션 방지와 정합). 근거: get-shit-done `agents/gsd-verifier.md:15-26,217-321 @ 9b5ee373`.
- **[apply-now] Codex-as-Opponent — 모델 다양성 라우팅.** 동일계열 critic은 공통 맹점을 갖는다(hannes critic 전부 Claude opus → close 후 codex 재리뷰에서 BLOCKER 2건 발견, 재작업 1사이클). DITTO 형태: `dialectic`의 Opponent를 Codex 우선, Claude opus→sonnet fallback으로 provider profile에 내장(이미 `dialectic-opponent` agent가 Codex-preferred). 근거: hannes §3.2 `registry.json` mi-scope-fix.
- **[apply-now] 구현 후 적대적 다관점 review.** review-work를 목표적합성/QA/코드품질/보안/컨텍스트누락 5개 병렬 sub-agent로 검토, 모두 통과해야 pass. 작은 diff는 lightweight 모드. spec-compliance 검토를 code-quality보다 선행(over/under-building 전파 차단). DITTO 형태: `verify`/`dialectic-review` lane에서 acceptance별 pass/partial/missing 합산 → completion-contract. 근거: oh-my-openagent `review-work/SKILL.md`, superpowers `subagent-driven-development/SKILL.md`.
- **[adapt] diagnose feedback-loop-first.** 버그 처리 시 먼저 deterministic pass/fail loop를 만들고 reproduce → hypothesis(3-5 falsifiable) → instrument(prediction-mapped, "log everything and grep" 금지) → fix → regression. HITL script 템플릿(사람 클릭 상황의 step/capture + KEY=VALUE 출력). DITTO 형태: `verify` lane의 기본 루프 + diagnose 보조 스킬. 근거: mattpocock `diagnose/SKILL.md:12-31`.
- **[adapt] LSP/AST-grep을 evidence path로.** grep/glob로 닫지 말고 LSP diagnostics/rename/reference + AST 구조 검색으로 주장을 닫는다. DITTO 형태: `verify` evidence 수집에 LSP/AST 결과 포함. 단 LSP MCP bootstrap(submodule/npm/build)은 위험 → doctor 선검증, 오프라인 시 degraded + 미검증 표시. 근거: oh-my-openagent `docs/reference/features.md:604-623`.
- **[adapt] E2E는 브라우저 자동화로 evidence path 연결.** MCP 의존만 두지 않고 Playwright CLI류로 screenshot/trace/console/network failure를 run artifact로 저장. 브라우저 설치 실패는 성공으로 포장 않고 `unverified`. DITTO 형태: `e2e-journey` 스키마/계약(이미 존재) + verify lane 연결. PURPOSE §34 "MCP 말고" 요구와 정합. 근거: PURPOSE.md, oh-my-openagent.

### 2.F 증거 원장 · 실행 기록 (evidence-store / run-manifest)

기여: `03`, `01`, `02`, `04`, `oh-my-codex`(doctor proof boundary), `hannes`(lessons)

- **[apply-now] session log = append-only evidence ledger, 요약은 파생.** session은 context window가 아니라 durable event stream. 요약이 원본을 덮으면 postmortem·eval 불가. DITTO 형태: `evidence-store`/`evidence-record`(이미 존재). completion-contract 증거가 ledger 원본 event를 가리키고, 요약은 context packet 단계에서만 생성. 근거: 01 "Session log는 context window가 아니다", 02 §2.8.
- **[apply-now] run manifest — 실행 전후 git/provider/profile/검증 기록.** 테스트 통과/실패를 수사가 아니라 artifact로. DITTO 형태: `run-manifest`(이미 존재) — git_before/after, provider, profile, commands, verification, unverified. 근거: 03 §3.2.
- **[apply-now] proof boundary 분리 — 설치 증거 ≠ 실행 증거.** hook 설치 증거 / plugin hook 증거 / fallback 증거 / 실제 execution readiness는 서로 다르다. doctor가 4종을 분리 보고. DITTO 형태: `doctor` 결과를 "설치/config·hook/실행 smoke/운영" 레벨로 구분. "증거 없는 완료 금지"의 직접 근거. 근거: oh-my-codex `docs/codex-native-hooks.md:168-181`, 04 §7.2.
- **[apply-now] lessons.jsonl 132건을 게이트 fixture로 회수.** hannes 자가진화 루프(생산 메커니즘)는 버리되 그 산물(검증된 실패 패턴 132건)은 DITTO 게이트의 기성 acceptance/fixture로 회수 — 최대 비용 절감 레버. 예: `partial-user-response-treated-as-full-delegation`→question-gate fixture, `plan-integrity-anchor`→autopilot fixture, `structural-fix-over-incremental-raise`→코드품질 fixture. DITTO 형태: evaluator lane regression fixture. 근거: hannes §4.1, §6.

### 2.G 컨텍스트 패킷 · Context Rot (context-packet)

기여: `02`, `01`, `deepagents`(offload), `oh-my-opencode-slim`(codemap), `oh-my-claudecode`(descriptor), `get-shit-done`(context-monitor, map-codebase), `mattpocock`(CONTEXT.md)

- **[apply-now] context는 append가 아니라 selection.** event stream에서 필요한 slice만 골라 context로 변환. always-in(active instruction/task/safety) / on-demand(errors/diff/test) / pointer(logs/transcript/screenshot) / subagent-summarized(대형 조사) 4분류. DITTO 형태: `context-packet`(이미 존재)이 ContextAssembler.select/render. 근거: 02 §2.8-2.9.
- **[apply-now] 큰 출력은 artifact로 offload, context엔 path/hash/preview만.** 원문 history는 별도 파일로 저장하고 summary에 경로 삽입, 큰 tool result는 별도 경로로 offload, ContextOverflow fallback. DITTO 형태: context-packet + evidence-store. control plane(작은 상태)과 data plane(큰 artifact descriptor) 분리. offload 파일 수명/삭제 정책 선행 필요. 근거: deepagents `summarization.py:474-505`, oh-my-claudecode `ARCHITECTURE.md:461-498`.
- **[adapt] codemap — repo atlas + 변경 감지.** core file만 포함한 repo map과 hash 기반 change detection으로 장기 세션 반복 탐색 비용 절감. stale 시 잘못된 판단을 유발하므로 change detection이 전제. DITTO 형태: long-session context packet 보조 스킬. 대형 분석은 mapper subagent가 artifact store에 직접 쓰고 parent는 존재/품질만 확인(secret/generated 제외). 근거: oh-my-opencode-slim `codemap/SKILL.md:18-77`, get-shit-done `agents/gsd-codebase-mapper.md:18-23 @ 9b5ee373`.
- **[adapt] context 압박 임계 → 자동 handoff 트리거.** context remaining(예: 35/25% 임계)·active phase·current state를 statusline으로 노출하고 임계 구간에서 세션을 기록(advisory/silent-fail). DITTO 형태: 임계 도달 시 `handoff` skill을 자동 트리거(autopilot 정지 조건과 연동). host별 context metric 신뢰도 차이 → doctor의 host compatibility 점검 필요. 근거: get-shit-done `hooks/gsd-context-monitor.js:1-19 @ 9b5ee373`.
- **[apply-now] context packet 구성 8요소.** goal / acceptance / git state / relevant files / last failure / what not to touch / evidence pointers / expected output contract. DITTO 형태: `context-packet` 생성 템플릿. 근거: 03 §3.7.

### 2.H Bounded subagent · 병렬 조정 (delegation / team)

기여: `oh-my-opencode-slim`(subtask), `oh-my-openagent`(6-section), `oh-my-codex`(team Big Five), `deepagents`(stateless), `get-shit-done`(PLAN frontmatter, wave overlap), `03`, `02`

- **[apply-now] 6-section delegation contract.** 위임을 `TASK / EXPECTED OUTCOME / REQUIRED TOOLS / MUST DO / MUST NOT DO / CONTEXT` + post-delegation verification으로 표준화. DITTO 형태: bounded subagent 호출 계약(context packet)의 필수 필드. parent가 같은 형식으로 위임 후 검증. 헌장 §5-6과 정합. 근거: oh-my-openagent `sisyphus/gpt-5-5.ts:204-216`.
- **[apply-now] stateless subagent + 부모 state 누수 차단.** 복잡·독립 작업을 stateless subagent에 위임, 단일 결과만 반환, 부모 state(messages/todos/memory)를 입력에서 기본 제외. parent엔 answer/evidence/uncertainty만. DITTO 형태: bounded subagent 표준 — 입력에 목표·허용 파일·금지 작업·출력 형식, 출력은 요약+근거. 근거: deepagents `subagents.py:228-257`, 02 §2.10.
- **[apply-now] bounded subtask worker + configurable timeout.** parentID·file context·transcript read cap·summary·abort cleanup·nested depth 제한을 가진 child session, 작업유형별 timeout 예산(0-disable해도 부모 abort 유지). DITTO 형태: run 단위 격리 실행, 실행 전 경계 주입. **현행화 신규**(timeoutMs config화). 근거: oh-my-opencode-slim `subtask/tools.ts:73-185`, `config/schema.ts:255-270`.
- **[adapt] 단순 fan-out vs 상호의존 작업 분기 (Team Big Five/ATEM).** 독립 fan-out은 경량 프로토콜(ACK, claim-safe lifecycle) 유지. 의존성/공유 파일/cross-boundary/handoff/통합 작업일 때만 closed-loop ACK, mutual performance monitoring, backup/reassignment, adaptability checkpoint, team orientation gate 활성화. DITTO 형태: bounded subagent fan-out 정책의 분기 기준. context packet에 shared mental model(task/inbox canonical) 명시. **현행화 신규**. 근거: oh-my-codex `docs/team-coordination-protocol.md`.
- **[adapt] state-first team API — 파일 직접 갱신 금지.** worker가 파일을 직접 쓰지 않고 claim/transition/release/mailbox/heartbeat 단일 API로만 상태 변경, dependency readiness·lock·version·lease·terminal guard·claim token 검사. CLI를 worker process로 보는 file-backed state machine은 provider 혼합(Claude+Codex+OpenCode)을 가능케 함. DITTO 형태: bounded subagent run 기록을 파일/API 프로토콜로 먼저(tmux 런타임은 defer), 완료를 sentinel polling이 아닌 명시 transition record로 수신. 근거: oh-my-codex `src/team/state/tasks.ts:27-282`, 04 §4.6, oh-my-claudecode `runtime-v2.ts:432-473`.
- **[apply-now] PLAN frontmatter + same-wave 파일 겹침 직렬화.** planner가 plan을 executor가 해석 없이 구현 가능한 프롬프트로 쓰고 `wave/depends_on/files_modified/autonomous/requirements/must_haves`를 frontmatter에 기입. execute 단계가 같은 wave의 files_modified 겹침을 검사해 충돌 시 직렬화(병렬 작업자가 같은 파일 동시 수정·되돌림 방지). nested delegation 기본 금지. DITTO 형태: planner가 run-manifest/노드에 wave·depends·files_modified·must_haves 메타를 부여, `autopilot-driver`가 병렬 dispatch 전 overlap 거부/직렬화. 근거: get-shit-done `agents/gsd-planner.md:421-439`, `workflows/execute-phase.md:440-472 @ 9b5ee373`, 03 §3.10.

### 2.I Doctor · instruction bridge · host adapter

기여: `oh-my-codex`(doctor/plugin), `oh-my-claudecode`(inventory drift), `oh-my-openagent`(core/adapter DAG), `oh-my-opencode-slim`(doctor/smoke), `get-shit-done`(INVENTORY drift-control, runtime parity, surface), `04`, `andrej-karpathy`, `mattpocock`

- **[apply-now] AGENTS.md ↔ host projection drift 검사 + 결정론 sync.** canonical guidance를 한 곳에서 관리하고 host 투영의 drift를 read-only doctor가 검사, sync는 별도 destructive 명령(managed block marker + sha256). DITTO 형태: `doctor`/`instruction-bridge`/`bridge-sync`(이미 v0.2 구현). 근거: 03 §3.4, andrej `CURSOR.md:21-28`(수동 동기화 = drift 약점).
- **[apply-now] self-inventory drift 검사 — INVENTORY를 authoritative roster로.** skill/command/profile/tool 수량·참조를 단일 생성형 inventory가 authoritative로 보유하고 drift-guard 테스트가 선적 누락을 검증, description budget·dependency closure lint를 별도 게이트로. **README/문서에 숫자를 직접 쓰지 말 것** — GSD조차 사람이 쓴 ARCHITECTURE에 "11 hooks"(실제 13) 같은 drift가 남는다. OMC 현행화에서도 schema drift가 실제 버그(`handoff` command를 `disabled_commands`로 끌 수 없음)로 이어졌다. DITTO 형태: `doctor surface`에 self-inventory drift 항목 추가, skill catalog를 생성물에서 검증. **현행화 신규**. 근거: get-shit-done `docs/INVENTORY.md:3-9`, `scripts/lint-command-contract.cjs:39-74 @ 9b5ee373`, oh-my-openagent `config/schema/commands.ts`.
- **[adapt] runtime parity matrix — 미지원 조합은 fail-closed.** 같은 명령이라도 런타임별 concurrency·model routing·hook·worktree 지원이 달라 결과·실패 모드가 갈린다. GSD는 Codex worktree isolation 미지원을 fail-closed 처리하고 runtime artifact layout을 코드로 source-of-truth화. DITTO 형태: provider profile별 병렬·worktree·hook 지원 범위를 `doctor`/host adapter가 matrix로 관리, 미지원 조합은 silent 우회가 아니라 fail-closed + 명시 사유. 근거: get-shit-done `workflows/execute-phase.md:80-111`, `bin/lib/runtime-artifact-layout.cjs:214-299 @ 9b5ee373`.
- **[apply-now] host-neutral core / adapter DAG.** "Adapters depend on Core. Nothing depends on Adapters." host 전용 이벤트명은 어댑터 안에만 가두고 순수 로직은 중립 코어로. hook은 "마지막 통합 지점"으로 제한. DITTO 형태: work-orchestration core(work item/run/evidence/completion)와 host adapter(`hosts/`) 분리(이미 HostAdapter 존재). OpenAgent가 shared-skills/prompts-core 패키지로 실제 코드 분리를 실증. **현행화 신규**(어댑터 분리 진행). 근거: oh-my-openagent `ROADMAP.md:27-49`.
- **[apply-now] setup의 user state 보존.** setup이 기존 `.codex`/`.claude`/MCP/hook을 덮지 않고 소유 block만 merge, trust hash 기록, stale legacy archive, dry-run, rollback report. DITTO 형태: DITTO setup이 host config 만질 때 managed block + trust hash + user hook 보존 + dry-run 기본. doctor가 보존 여부 검증. 근거: 04 §7.1, 03.
- **[apply-now] plugin discovery ↔ setup(환경 변경) 경계 분리.** plugin은 skill/MCP/메타데이터 발견만, setup은 config/hook/agent 환경 변경. "plugin=발견, setup=환경 변경" 한 문장 라벨을 CLI/doctor에 반복 표시. DITTO 형태: 배포 메타데이터와 host 환경 변경을 분리 명령으로. 근거: oh-my-codex `docs/plugin-bundle-ssot.md:7-12`.
- **[adapt] host별 permission/hook vocabulary 차이를 doctor drift로.** Claude(allow/deny/ask + tool matcher, 넓은 hook surface)와 Codex(approval_policy + sandbox_mode, 좁은 hook)를 각각 매핑하고 가용성 차이를 doctor가 점검. host 공통 분모 위에서만 강제 기능 설계, Codex측은 Stop gate/state file로 우회. **현행화 신규**(plugin_hooks feature, model×agent 호환성 매트릭스). 근거: 04 §4.3-4.4, oh-my-codex `docs/codex-native-hooks.md:6-24`.

### 2.J Provider profile · 안전 (sandbox / safety shim / hooks)

기여: `oh-my-opencode-slim`(safety shim), `oh-my-codex`(hook 기본값), `oh-my-claudecode`(fail-open), `deepagents`(backend 경고), `get-shit-done`(package legitimacy, advisory vs CI), `01`(격리), `02`(sandbox), `mattpocock`(git guard)

- **[apply-now] provider profile은 단일 sandbox 전략을 전제하지 않는다.** auto mode 83% 차단에도 17%는 sandbox가 받아야 하고, trust dialog/정책 평가는 도구 실행 *전*에 와야 한다(사후는 늦음). prompt injection은 단발 0.1% → 100회 적응 시 5-6%. DITTO 형태: profile(read-only/workspace-write/reviewer/networked/isolated)을 layered defense 공리로 추상화, doctor permission/MCP 검사를 실행 전 게이트로. networked/isolated 구분의 정량 근거. **현행화 신규**(How we contain Claude, 2026-05-25). 근거: 01 "격리 전략은 환경 복잡도에 따라".
- **[adapt] tool-specific safety shim.** stale apply_patch 자동복구(모호하면 fail-closed, workspace 밖은 안전오류), AST replace dry-run 기본, webfetch cross-origin redirect 차단·content limit. 모든 보정을 "무엇을·왜" evidence로 기록. DITTO 형태: action 실행 계층 safety shim, ambiguity는 자동복구 금지. 근거: oh-my-opencode-slim `apply-patch/index.ts:61-147`.
- **[apply-now] 훅·오케스트레이션 fail-open + kill switch.** 보조 자동화 실패 시 `continue: true`로 사용자 기본 작업을 막지 않고, kill switch를 먼저 확인. DITTO 형태: 모든 자동 개입(autopilot 진입, doctor, context 주입)은 실패 시 fail-open + 전역 kill switch(env 또는 `.ditto` 플래그). 근거: oh-my-claudecode `bridge.ts:3020-3031`.
- **[apply-now] commit guard류 hook은 opt-in 기본값.** OMX Lore commit guard가 opt-out→opt-in으로 전환. 강제 차단을 default로 만들지 않음. DITTO 형태: 안전 hook 기본값을 opt-in으로 둬 사용자 환경 침범 최소화. **현행화 신규**. 근거: oh-my-codex `docs/codex-native-hooks.md:45,74-90`.
- **[apply-now] 파괴적 path 조작은 소유 경로 검증 helper로 단일화.** worktree 삭제 대상이 하네스 소유 경로 하위인지 검증, fs root/home/NUL 거부, 두 호출부 공유. DITTO 형태: worktree/temp 디렉터리 파괴적 조작을 단일 safety helper 경유. 헌장 §7과 일치. **현행화 신규**. 근거: oh-my-claudecode `worktree-cleanup-safety.ts:1-118`, mattpocock(local installer `rm -rf` 반면교사).
- **[apply-now] config secret allowlist는 user-only.** `mcp_env_allowlist`를 user-level config에만 부여해 clone-and-load attack 차단, schema 부분 실패 시 유효 섹션만 부분 로드. DITTO 형태: `.ditto` config 병합 시 secret env allowlist 확장을 repo-supplied config에서 차단, doctor가 경계 위반 탐지. 근거: oh-my-openagent `plugin-config.ts:430-437`.
- **[adapt] hook payload 크기 가드.** notify argv 64KB, native stdin 1MB, raw scan 64KB. malformed/oversized Stop hook이 host teardown을 유발하는 것을 방지. DITTO 형태: hook 기반 context 주입 시 payload guard 기본 적용. **현행화 신규**. 근거: oh-my-codex `hook-payload-guard.ts`.
- **[adapt] package legitimacy gate — slopsquatting 다층 방어.** AI executor가 패키지를 제안·설치할 수 있는 하네스의 공급망 위험(typo/slopsquatting, 유지보수 중단)을 research/plan/execute 세 레이어에 같은 gate로 반복 배치해 한 단계에서 놓친 위험을 다음에서 재확인. DITTO 형태: dependency·외부 패키지·보안 민감 변경에만 켜지는 게이트 — networked profile WebSearch 검증 + provenance tag를 completion-contract 조건에 추가(일반 구현 경로엔 비강제). 근거: get-shit-done `docs/ARCHITECTURE.md:682-703`, `agents/gsd-phase-researcher.md:267-293 @ 9b5ee373`.
- **[adapt] advisory hook과 CI blocking scan 분리.** prompt guard·injection scanner·secret scan이 호환성을 위해 advisory/silent-fail이면 강제 보안 장치로는 부족하다. 강제하려면 런타임 advisory hook(경고·evidence-record)과 CI blocking scan(실패)을 별도 계층으로. DITTO 형태: 런타임 hook은 경고 중심, release/CI는 실패시키는 blocking scan으로 이원화. 근거: get-shit-done `hooks/gsd-prompt-guard.js:80-95`, `scripts/secret-scan.sh:19-57 @ 9b5ee373`.

### 2.K 지식베이스 · 스킬 카탈로그 (knowledge / skill)

기여: `mattpocock`(CONTEXT.md/ADR), `superpowers`(description discipline), `andrej-karpathy`(예제 fixture), `deepagents`(progressive disclosure), `ouroboros`(본질 스키마), `oh-my-codex`(catalog SSOT), `get-shit-done`(thin command/lazy workflow)

- **[apply-now] CONTEXT.md + ADR — 먼저 소비, 해결될 때만 생성.** domain glossary/결정을 lazy-write·consume-first로. ADR은 3조건(hard to reverse, surprising, real trade-off) 충족 시에만 durable. hard/soft dependency 구분(없으면 "wrong"이면 hard → 멈춤, "fuzzy"면 soft → 가볍게 진행). DITTO 형태: `knowledge-record`/`.ditto/knowledge/`(CONTEXT.md+ADR 이미 존재). **현행화 신규**(CONTEXT-FORMAT 7→4 규칙 간소화). 근거: mattpocock `grill-with-docs/SKILL.md:72-86`, ADR-0001.
- **[apply-now] skill description = routing metadata only.** description에 절차를 요약하면 모델이 본문을 안 읽고 shortcut → 단계 누락. description은 "언제 쓰는가"만, 절차는 본문 contract. 1024자 제한, validator로 "workflow summary 금지" 자동 검사. DITTO 형태: skill catalog frontmatter 규칙 + validator. 근거: superpowers `writing-skills/SKILL.md:140-158`, mattpocock `write-a-skill`.
- **[apply-now] thin command + lazy workflow — 상시 prompt surface 축소.** 런타임 entrypoint(command)에는 frontmatter·objective·참조만 두고 실제 절차는 lazy-load되는 workflow로 미뤄 상시 토큰 비용을 줄인다(네임스페이스 라우터로 ~2150→120 토큰). DITTO 형태: skill/command를 thin entrypoint로, 긴 절차는 context packet으로 on-demand 로드. autopilot 노드가 절차 본문을 직접 안 들고 참조만 보유(§2.C 얇은 오케스트레이터와 연결). 근거: get-shit-done `commands/gsd/plan-phase.md:1-35`, `docs/ARCHITECTURE.md:145-170 @ 9b5ee373`.
- **[adapt] skill = progressive disclosure(metadata-first), 실행은 별도 런타임.** skill은 metadata 목록만 노출하고 필요 시 SKILL.md를 펼침. **deepagents가 `SkillMetadata.module` 필드를 완전 제거** — skill은 prompt/disclosure 계층일 뿐 실행 책임은 분리됨. DITTO 형태: skill을 실행층으로 기대하면 별도 런타임 설계 필요(차용 가정 정정). memory는 항상 로드되는 프로젝트 결정/용어. **현행화 신규**(module 제거). 근거: deepagents `skills.py:232`.
- **[adapt] 본질 기반 지식 스키마 + drift/freshness.** ESSENCE("What IS this?")/ROOT_CAUSE/PREREQUISITES/HIDDEN_ASSUMPTIONS로 지식 항목 정규화, drift_score·uncertainty·evidence 강제 출력. DITTO 형태: `knowledge-record` 엔티티 스키마 + graphify 연계(essence=노드, prerequisites=엣지) + freshness(fresh/stale) 결합. PURPOSE "지식을 fresh하게 유지"와 정합. 근거: ouroboros `core/ontology_questions.py`.
- **[adapt] bad/good 예제 pair를 regression fixture로(runtime prompt 아님).** 원칙별 실패/수정 pair를 평가 fixture로 회수("요청 밖 기능 추가", "단일 사용 추상화", "검증 없는 완료"). DITTO 형태: evaluator lane regression prompt set(코드/문서 경로, runtime 비용 절약). 근거: andrej `EXAMPLES.md`, hannes lessons.
- **[apply-now] durable vs throwaway artifact 분리.** ADR/CONTEXT/issue/brief는 durable, architecture report/prototype/handoff 초안은 temp. DITTO 형태: 산출물 위치 정책 — 분석 보고서는 `reports/`(durable), 탐색 산출물은 temp. 헌장 §9와 정합. 근거: mattpocock, 헌장 §9.

### 2.L 하네스 회귀 · 거버넌스

기여: `01`(postmortem), `deepagents`(better-harness), `andrej`(예제), `superpowers`(governance), `get-shit-done`(no-throw result, SDK 경계 폐기), `02`(versioned policy)

- **[apply-now] 하네스 변경도 모델 변경만큼 회귀를 만든다.** system prompt 한 줄·reasoning effort default가 coding quality를 떨어뜨린 실증(Anthropic 2026-04-20). prompt/hook/tool policy 변경마다 eval·canary·trace diff. DITTO 형태: doctor를 회귀 감지 지점으로, run 기록에 harness config(prompt/profile/tool set) 필수 필드로 박아 trace diff 가능. 근거: 01 "Postmortem은 harness 변경도 품질 저하를 만든다".
- **[apply-now] 모델별 보정은 core가 아니라 versioned policy.** 특정 모델 약점 보정 hand-coded 규칙은 모델 발전 후 stale assumption/회귀 원인(Bitter Lesson). DITTO 형태: host instruction을 코드에 흩지 말고 doctor가 drift 감지하는 versioned 설정으로. profile별 보정을 core에 박지 않음. 근거: 02 §3.7.
- **[adapt] 3층 분리 — 바는 코드(schema), 판단은 LLM, 라우팅은 얇은 hook.** hannes 실패의 근본 원인은 hook 분량이 아니라 *판단을 결정론 코드에 얼린 것*(cost_gate 200, intent 키워드 라우터 → 케이스마다 mutation). 처방은 "코드 줄이기"가 아니라 층 분리. DITTO 형태: (1) Zod 단일 소스 스키마가 바 정의, (2) 얇은 결정론 hook(라우팅/IO/lock/검증, fail-open advisory), (3) LLM 판단(모호성/증거충족/admissibility)은 skill·agent. 근거: hannes §5.1-5.4.
- **[adapt] authoring-environment disclosure + dev 브랜치 분리.** 외부 harness 기여·skill 수용 시 모델/하네스/버전/설치 플러그인 신원 공개, agent-생성 기여와 세션 기반 기여를 다른 신뢰도로. DITTO 형태: 외부 skill 제안 수용 contract + 릴리스 브랜치 전략 참고. **현행화 신규**(superpowers governance). 근거: superpowers PR 템플릿.
- **[adapt] no-throw closed-enum result + 별도 SDK 패키지 불필요(실증).** GSD는 상태/phase/verify 조작을 단일 명령(`gsd_run query`)으로 중앙화하고, routing hub가 절대 throw하지 않고 4-값 closed enum(`UnknownCommand`/`InvalidArgs`/`HandlerRefusal`/`HandlerFailure`) pure-result만 반환한다. ADR-0174로 별도 `sdk/` 패키지 경계는 폐기되고 단일 CJS로 일원화됐다. DITTO 형태: subagent result·내부 상태 조작을 no-throw closed-enum result로 표준화(provider별 quoting·drift 감소), **별도 SDK 패키지를 만들지 말 것**(GSD가 비용 대비 불필요함을 실증). **저장소 전환 신규**. 근거: get-shit-done `docs/CLI-TOOLS.md:1-20`, `bin/lib/command-routing-hub.cjs:39-47 @ 9b5ee373`(ADR-0174).

---

## 3. 신규 편입 하네스 — plan 미반영분 상세

### 3.1 hannes — DITTO의 직접 전신 (prior art)

`ditto-application-plan.md`에 없던 가장 중요한 누락. hannes는 Claude Code 위에 9-agent 7-stage 자가진화 사이클을 구현해 실제 dogfooding(closed 37건, lessons 132건, applied mutation 29건)까지 돌린 하네스다. **DITTO 설계 §6의 11개 핵심 계약 중 10개가 hannes에 이미 살아 돌아간 구현으로 존재** → DITTO는 greenfield가 아니라 hannes의 재구성이다.

| 자산 | DITTO 활용 | 분류 |
|---|---|---|
| lessons.jsonl 132건 | evaluator lane fixture로 즉시 회수(최대 비용 절감) | apply-now |
| ConvergenceContract | 유일한 진짜 신규 — hannes 선행구현 없음, **설계 검증 우선순위 최상위** | apply-now |
| Codex-as-Opponent | dialectic Opponent 모델 다양성 라우팅의 비싸게 학습한 근거 | apply-now |
| interview ambiguity scoring 공식 | deep-interview "how"의 검증된 정답지 | adapt |
| orchestrator 에이전트 | autopilot driver(설계 §7.4 구멍) | apply-now |
| 3층 분리(schema/hook/LLM) | 코드품질 원칙 | adapt |
| llm_judge_stop / session_handoff | Stop gate·handoff 선행구현 | adapt |

**도려낸 실패 양식(avoid, 명시적 비목표로 박기)**: ① 자가진화 lesson→mutation 루프(자기참조 증식), ② hook 21개·npm bootstrap 비대화, ③ 상태 비가역성 붕괴(`done` 정정·string\|int hybrid stage·close 후 PARTIAL 정정). DITTO는 `done`을 되돌릴 수 없게, 새 status enum 금지(문서≠스키마면 스키마 우선), Scope Authority 단일 표로 차단.

2026-06-01 재확인: boxwood 저장소 신규 커밋 없음(HEAD `46ad7c5`), 수치·참조 전부 현행 유효.

### 3.2 ouroboros — 결정론 측정 primitive의 코드 원천

ouroboros는 자율 Socratic 인터뷰 + 모호성 측정 + 결정론 품질 게이트를 갖춘 수렴 지향 시스템이다. 제1원칙은 "LLM의 readiness 자기보고를 코드 바닥이 누른다"이고, 보고서는 DITTO 계약에 직접 재사용 가능한 두 서브시스템(인터뷰/모호성 게이트 + 온톨로지 weaver)만 코드 수준으로 본다.

superpowers가 "행동 게이트·하네스 통합"을 준다면, **ouroboros는 모호성·검증가능성·완료의 결정론적 측정 코드**를 준다. 거의 그대로 차용 가능한 primitive: `deterministic_floor`, source×status ledger, GradeGate A/B/C, `VAGUE_TERMS`/`_OBSERVABLE_HINTS`, high-risk 차단 용어집. DITTO의 `question-gate`/`convergence`/`completion-contract`와 코드 수준 동형이다.

**현행화 핵심(SSOT #1157 Closure Policy)**: 이전 분석의 **AND-gate(backend_done AND ledger_done)가 ledger-primary 단일 게이트로 전환**됐다 — backend 동의는 `closure_mode` 레코드로만 남고 무한 stall을 회피한다. ouroboros를 차용한다면 "두 게이트 동시 만족" 표현을 ledger-primary로 수정해야 하고, GradeGate의 closure_mode-aware 억제는 반드시 ledger-primary 정책과 묶어서만 안전하다.

### 3.3 04-...research — control plane 소유권 프레임

`04`는 하네스가 아니라 Claude Code vs Codex를 control plane 소유권 관점에서 비교한 문서다. 핵심 명제: **"확장성은 기능 수가 아니라 누가 control plane을 소유하는가"**. OMC는 Claude Code의 풍부한 native 위에 얹고, OMX는 Codex의 열린 표면에 별도 control plane을 세운다. **DITTO는 후자(OMX형) 포지션** — coding agent(data plane) 위 work-orchestration layer(control plane) — 에 직접 해당한다. 이 문서의 "검증 기준 7항"(hook firing evidence / execution readiness / state transition integrity / permission precedence / user state preservation / compaction-resume safety / worker cleanup)은 DITTO 자체 acceptance 골격으로 채택한다.

---

## 4. 현행화 델타 요약 (보고서별)

| 보고서 | 현행화 핵심 델타 | DITTO 영향 |
|---|---|---|
| 03-adoption-map | 분류(apply/delegate/defer/avoid) 불변. 참고 구현 3건 추가(OMC ultragoal PreToolUse blocking, ralplan read-only, OMX $team protocol). 제품 claim 일부 미검증 표시 | 분류 결론 불변. doctor가 fresh evidence로 실제 설정 검사하도록 강화 |
| 04-research | 양 host control plane 형식화 강화(OMX FSM, auth hot-swap; OMC `/goal` hard gate). "Codex 팀 orchestration 미성숙" 명제 약화 | artifact-first goal·state-first team·proof boundary가 양 host에서 동시 강화 → DITTO 설계와 동방향 |
| blogs/01 | `How we contain Claude`(2026-05-25) 신규 — 제품별 격리 + layered defense 수학 | trust dialog는 실행 전 게이트, profile은 단일 sandbox 전제 금지 |
| blogs/02 | MAD 제품 문서 확장 — Outcomes/self-hosted sandbox/Dreaming/Multiagent | DITTO 핵심 개념 4개가 제품 수준 검증(rubric grader +8~10% 등) |
| oh-my-codex | autopilot FSM화 + 권장 loop 재정의(ralph 강등, ultraqa 추가), ralplan consensus/planning 경계, prometheus-strict·Scholastic, Team Big Five, guard opt-in, plugin_hooks | autopilot/plan/deep-interview/dialectic 계약 강화의 최대 원천 |
| oh-my-claudecode | ralplan `pending-approval` terminal phase, ultragoal `/goal` PreToolUse deny, worktree safety, MCP 위임 deprecated | plan 승인 gate·authority↔외부승인 매핑·외부 analyzer는 CLI 경로 |
| oh-my-openagent | shared-skills/prompts-core 패키지 외부화(core/adapter 분리 실증), Light Edition, security-research, schema drift 버그 | core/adapter 분리 근거 강화, single-source + doctor drift 필요성 입증 |
| oh-my-opencode-slim | 기능 델타 적음 — subtask configurable timeout 1건 | bounded subagent 작업유형별 timeout 예산 |
| deepagents | RubricMiddleware(813 LOC 신규), `SkillMetadata.module` 제거, read_file 계약 변경 | verify self-eval 루프 청사진, skill=disclosure 전용 정정 |
| superpowers | 기능 영향 없음, 거버넌스만(authoring disclosure, dev 브랜치) | 외부 기여 수용 contract 참고(코드 차용 가치 낮음) |
| ouroboros | SSOT #1157 — AND-gate→ledger-primary, `AUTO_FILL_INFERENCE`, GradeGate closure_mode 전파 | 종료 게이트 차용 시 ledger-primary로 수정 필수 |
| hannes | 신규 커밋 없음, 전부 현행 유효 | DITTO 전신 — lessons fixture·ConvergenceContract·orchestrator |
| andrej-karpathy | HEAD 변경 없음 | 4대 원칙 이미 헌장 흡수, 남은 건 fixture화·측정지표·high-risk 예외 |
| mattpocock | teach skill 신규(defer), to-prd seam sketch 교체, CONTEXT-FORMAT 7→4 간소화 | plan seam-first, CONTEXT.md 포맷 경량화 |
| get-shit-done | **저장소 전환**: `gsd-build/get-shit-done`(아카이브) → `open-gsd/gsd-core @ 9b5ee373`(개명 `@opengsd/gsd-core`, 브랜치 next). ADR-0174로 SDK 패키지 폐기·단일 CJS 통합, INVENTORY authoritative 격상, spec-phase/plan-review-convergence/review(Antigravity) 등 신규 표면 | thin orchestrator·plan-checker·PLAN frontmatter wave gate·INVENTORY drift-control·runtime parity·no-throw result·SDK 경계 불필요 |

---

## 5. 분류별 정리

### 5.1 지금 적용 (apply-now) — 우선순위 묶음

이미 존재하는 계약 위에 즉시 강화 가능한 것들. 대략의 권고 순서:

1. **completion/convergence 결정론 게이트** (§2.D): VAGUE_TERMS/OBSERVABLE 검증가능성 판정, GradeGate A/B/C, ConvergenceContract 쌍대 게이트, high-risk 자동 blocker. ← ouroboros·hannes에서 거의 그대로 차용.
2. **deep-interview 결정론 floor + ledger-primary 종료** (§2.A): question-gate에 deterministic_floor, source×status ledger, ledger-primary closure. ← ouroboros.
3. **plan 승인/경계 게이트** (§2.B): planning 중 write 차단(read-only profile), consensus/approval 영속화 없이 implement ready 금지.
4. **autopilot FSM 고정 + 종료 조건** (§2.C): transition table test, orchestrator content-금지, 재시도 예외 enum, terminal+idle 완료 조건.
5. **verify lane 분리·다양성** (§2.E): generator/evaluator 권한 분리, Codex-opponent, 다관점 병렬 review, RubricMiddleware식 재실행.
6. **lessons.jsonl 132건 fixture 회수** (§2.F): hannes 산물을 evaluator regression으로.
7. **fail-open + safety 기본값** (§2.J): kill switch, commit guard opt-in, 파괴적 path 단일 helper, secret allowlist user-only.
8. **read-only plan-checker + PLAN frontmatter wave gate** (§2.B/§2.H): planner와 분리된 사전 검증, files_modified 겹침 직렬화. ← get-shit-done.
9. **INVENTORY drift-control + thin command/lazy workflow** (§2.I/§2.K): 생성형 inventory를 authoritative로, 문서에 숫자 직접 기입 금지, 상시 prompt surface 축소. ← get-shit-done.

### 5.2 변형 적용 (adapt)

team Big Five/ATEM 조정 분기, state-first team API, codemap, LSP/AST evidence, host-neutral core/adapter 분리, 3층 분리, seam-first plan, 본질 기반 지식 스키마, prometheus-strict식 인터뷰 역할 분리, hook payload guard, host별 permission/hook vocabulary 매핑, runtime parity matrix(미지원 fail-closed), package legitimacy gate(slopsquatting), advisory hook↔CI blocking 분리, context-monitor 자동 handoff, no-throw closed-enum result(별도 SDK 패키지 금지).

### 5.3 나중 (defer)

Scholastic 온톨로지 리뷰어, ultragoal aggregate goal mode, auth slot hot-swap, async subagent 핸들, better-harness eval 외부루프(train/holdout/scorecard), multiplexer(tmux 시각화), catalog SSOT/mirror CI gate, auto_fill substrate, teach skill, marketplace sync, plan-review-convergence(cross-AI 계획 수렴, convergence+dialectic로 대응), 팀업 통합(GitHub/Confluence), Dreaming(memory 파생).

### 5.4 반면교사 (avoid)

context 과적재, bypassPermissions 기본값, vendor agent loop 얕은 복제, session-start auto-update(네트워크 side effect), telemetry/star 강요, MCP 경유 외부 모델 위임(CLI worker 권장), regex-only git guardrail(structured parsing 필요), 강한 MUST-invoke vs 사용자 지시 우선 충돌(conflict resolution 없이 차용 금지), LocalShell 비샌드박스 기본 실행, hannes 자가진화 루프·비가역성 붕괴, GSD 전체 표면 복제(67 commands/88 workflows/33 agents — 최소 core loop부터), 사람이 쓴 문서에 수량 직접 기입.

---

## 6. 권고 다음 작업

1. **결정론 게이트 primitive 이식 (가장 높은 ROI).** ouroboros `VAGUE_TERMS`/`_OBSERVABLE_HINTS`/GradeGate 임계와 high-risk 용어집을 DITTO `completion-contract`/`gates`로 차용. ledger-primary 종료를 `question-gate`/`convergence`에 반영. 단일 work item으로 묶어 fixture 우선 작성.
2. **ConvergenceContract 설계 검증.** hannes에 선행구현이 없는 유일 계약이라 위험이 가장 크다. `convergence-contract.md`와 `convergence-store` 구현 가정을 dialectic으로 먼저 압박.
3. **hannes lessons.jsonl 132건 회수.** evaluator lane fixture로 분류·이식하는 별도 work item. plan §10(하네스 regression)의 초기 평가 fixture 공급원으로 직접 연결.
4. **plan/autopilot 경계·승인 게이트 강화.** planning 중 write 차단과 consensus 영속화 없는 implement-ready 금지를 `autopilot-graph` transition table test로 고정.
5. **`ditto-application-plan.md` 동기화.** 본 문서의 신규 편입 하네스(hannes/ouroboros/04)와 현행화 델타를 plan의 inputs·근거·Phase 본문에 반영하고, get-shit-done 인용을 신규 저장소(`open-gsd/gsd-core @ 9b5ee373`) 기준으로 갱신(아카이브된 구 `gsd-build/get-shit-done` 앵커 교체, ADR-0174 SDK 폐기·INVENTORY authoritative 반영). (산출물 형태는 별도 결정 — 본 통합 보고서가 그 입력.)

---

## 7. 검증 상태 · 주의

이전 판의 검증 보류(VERIFY) 항목은 2026-06-01에 **실제 upstream 저장소(지정 커밋 체크아웃) 또는 공식 문서로 직접 대조해 해소**했다. 결과:

- **앵커 드리프트 (해소됨)**: oh-my-codex(`ff17267b`)·oh-my-claudecode(`ed7800dd`)·oh-my-openagent(`7afa4d08f`)·gsd-core(`9b5ee373`)를 실제 클론해 각 보고서의 검증 보류 앵커를 직접 읽었다. oh-my-codex 핵심 claim 8건 VERIFIED(정정 1건: prometheus-strict `oracle`는 frontier가 아니라 `modelClass:'standard'`, `definitions.ts:345`), oh-my-openagent 삭제 앵커 8건 삭제 확정(→ `packages/prompts-core`·`shared-skills`로 이동), gsd-core 4개 앵커 줄번호 드리프트 확정(surface `:12-18/:51`, CLI-TOOLS init `:291-319`·commit `:411-416`, map-codebase `:15-21/:28/:66-71`). 각 보고서에 "검증 완료 2026-06-01"로 반영됨.
- **제품 claim (해소됨)**: Claude Code permission 모드 목록(default/acceptEdits/plan/auto/dontAsk/bypassPermissions)과 Codex CLI sandbox(OS-level, network off 기본)·Codex Cloud(setup/agent phase 분리, agent network off 기본, secret은 setup에만·agent 전 제거)는 모두 공식 문서로 검증됨(`docs.claude.com`, `developers.openai.com/codex/*`). repo commit이 아닌 문서 기준이므로 제품 버전 변경 시 재확인 필요.
- **소스 대조 (해소됨)**: oh-my-claudecode model×agent 호환성 문서의 이름(Prometheus/Sisyphus 등)은 OMC 로컬 19개 agent와 매핑되지 않는 oh-my-opencode(OMO) 계열 역할 라벨로 확정(전수 grep 0건). ouroboros `auto/auto_fill.py`는 `interview_driver.py`에 **미wiring(importer 0건) 확인**(PR-2 대기) — 단 `auto/ledger_seed.py`는 `pipeline.py`가 import해 사용 중(보고서가 둘을 묶은 건 부정확). REFERENCE.md 플랫폼 모순은 **미해소 상태로 유지**됨이 확정(`OMC_USE_NODE_HOOKS`는 doc-only).
- **남은 standing 캐비엇**: blogs/02의 Dreaming/Outcomes/Multiagent는 research preview/공개 베타라 GA 시 성능·제약 재확인이 필요한 forward-looking 항목이다(현 상태 자체는 검증됨). 이는 앵커 드리프트가 아니라 제품 성숙도 캐비엇이다.
- **본 문서 자체의 범위**: 이 통합은 "무엇을 적용할지"의 카탈로그다. 각 항목의 실제 구현·검증은 별도 work item에서 fresh evidence로 닫아야 하며, 본 문서의 분류·근거 인용은 구현 완료를 의미하지 않는다.
