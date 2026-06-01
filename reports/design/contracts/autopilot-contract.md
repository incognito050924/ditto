---
title: "DITTO Autopilot Contract (상세 설계)"
kind: design-detail
last_updated: 2026-05-26 KST
status: draft
parent: reports/design/ditto-claude-code-harness-design.md
owns: "§6.5 Autopilot Contract의 'how' (그래프 구조 · 드라이버 ReAct 루프 · 실패 분류 · approval gate 메커니즘 · autopilot.json 스키마)"
inputs:
  - reports/design/ditto-claude-code-harness-design.md  # §5.2~5.5, §6.1 Intent, §6.2 QuestionGate, §6.4 Delegation, §6.8 Completion, §6.9 Convergence, §6.10 Handoff, §7.4 Subagent
  - reports/harnesses/hannes.md                          # HANNES harness 오케스트레이터 (Autopilot Loop · failure classification · Context Isolation · stage→owner)
  - reports/harnesses/oh-my-openagent.md                 # Sisyphus "orchestrator, not implementer" · 6-section delegation · 병렬 fan-out
  - reports/harnesses/oh-my-claudecode.md                # persistent Stop 으로 루프 지속
  - src/schemas/common.ts, src/schemas/work-item.ts      # 재사용 스키마 (authoritative)
---

# DITTO Autopilot Contract (상세 설계)

> **이 문서의 위치.** 이것은 메인 설계문서(`ditto-claude-code-harness-design.md`)의 §6.5를 대체하지 않고 **확장**한다. 메인은 "무엇(what)" — 목적·불변규칙·범위 보존 — 만 두고 "어떻게(how)"는 열어둔다. 이 문서가 그 how — autopilot 그래프 구조, 드라이버(orchestrator)의 ReAct 루프, 실패 분류·결정, approval gate 메커니즘, `autopilot.json` 스키마 — 를 소유한다. per-contract 상세 문서의 **두 번째 사례**다(첫 사례: [`deep-interview-contract.md`](deep-interview-contract.md)).

## 0. 권위 규칙 (메인 ↔ 상세 ↔ 스키마)

| 층위 | 소유 대상 | 충돌 시 |
|---|---|---|
| 실제 스키마 (`src/schemas/*.ts`, `schemas/*.json`) | 필드명, enum, validation | **최우선.** 본 문서 예시 JSON과 다르면 스키마가 이긴다. |
| 메인 설계문서 §6.5 | "what" — 목적, 불변규칙, 범위 보존 | "what"이 충돌하면 메인이 이긴다. 본 문서는 메인과 모순되면 안 된다. |
| 본 상세문서 | "how" — 그래프·드라이버·실패분류·스키마 | "how"의 단일 출처. 메인은 여기로 링크만 한다. |

규칙: 본 문서의 예시 스키마는 **구현 전 반드시** 기존 Zod/JSON 스키마와 맞춘다. `autopilot.json`은 additive 사이드카이며 `work-item.json` status를 대체하지 않는다(메인 §3.3). 본 문서는 메인의 `internal_checkpoints`/`nodes` 명칭 불일치(§5.3 ↔ §6.5)를 `nodes`로 **canonical 통일**한다(§8.2 reconciliation note) — 이는 "how"/스키마 정합이므로 본 문서 권한 안이다.

## 1. 목적과 경계

### 1.1 한 문장 정의

Autopilot은 **큰 범위 작업을 "한 phase씩 사용자에게 반환"하지 않고, 하나의 사용자 의도(work item) 안에서 계획-구현-검증-수정-완료까지 끊김 없이 끝까지 미는 실행 계약**이다. 내부 분할은 드라이버(`orchestrator`)의 스케줄링 책임일 뿐 사용자-facing 완료·승인 경계가 아니다.

핵심 명제(메인 §0 제1원칙·멘탈 모델의 적용): 진척에 대한 *행동(계속)*의 바는 stop condition이지 "한 단계 끝남"이 아니다. DITTO는 자율주행 시스템이고, autopilot은 그 **운전 판단 루프**다 — provider의 agent loop를 다시 만드는 게 아니라 그 위에 얹는 조율 층이다(메인 §2 비목표 #1 명확화).

### 1.2 인접 계약과의 경계

| 계약 | 다루는 것 | Autopilot과의 차이 |
|---|---|---|
| §6.1 Intent | `root_goal` = intent.goal, 노드 ↔ acceptance_criteria | autopilot의 **입력**. intent가 ready여야 graph가 시작된다. |
| §6.3 Deep Interview | intent 모호성 축소 | autopilot **이전** 게이트. `draft → in_progress`(메인 §5.5) 전이 후 graph 진입. |
| §6.4 Delegation | 한 번의 spawn에 넘기는 입력·금지·출력 계약 | autopilot은 **그 spawn들을 도는 루프**다. 드라이버는 매 노드마다 §6.4 packet을 구성해 owner를 spawn한다. |
| §6.8 Completion | final_verdict 판정 | autopilot은 stop condition까지 **진행**하고, 종료 시 Completion이 **판정**한다. graph 상태 ≠ 완료 판정. |
| §6.9 Convergence | 반복 정련(retry/fix)의 treadmill·조기수렴 차단 | 노드 단위 재시도 루프의 *품질*을 Convergence가 지배한다. autopilot은 *그래프 진행*을, Convergence는 *한 지점의 정련*을 맡는다. `cap-reached ≠ converged`를 공유(§4.3). |
| §6.2 QuestionGate | 질문 한 건 검열 | 드라이버가 사용자에게 묻는 유일한 경로. user-owned decision만, "진행할까요?" 금지. |
| §6.10 Handoff | 세션 전환 문맥 | context pressure 시에도 autopilot은 같은 `autopilot_id`로 이어진다(§6.3). |

## 2. autopilot 그래프 (구조)

### 2.1 노드와 엣지

autopilot은 linear phase list가 아니라 **작업 그래프**다(메인 §5.3). 노드는 작게 나누되 `root_goal`은 나누지 않는다.

- **노드(`nodes[]`)**: 하나의 내부 작업 단위. `kind`(작업 종류), `owner`(담당 에이전트), `status`, `depends_on`(선행 노드), `acceptance_refs`(닫는 AC), `evidence_refs`, `attempts`(재시도 카운트)를 가진다.
- **엣지**: `depends_on`으로 표현하는 DAG. cycle 금지.
- **ready 노드**: `status==pending` ∧ `depends_on`의 모든 노드가 `passed`.

### 2.2 node `kind` → owner 매핑 (HANNES stage→owner의 경량판)

| node `kind` | owner 에이전트(§7.4) | 비고 |
|---|---|---|
| `research` | researcher | 코드/문서/웹 근거 조사 |
| `design` | planner (+ architect: 구조 위험 시) | plan/risk/premortem |
| `implement` | implementer | 좁은 scope write |
| `review` | reviewer (high-impact 산출물은 dialectic 3역, §6.6) | diff·AC 검토 |
| `verify` | verifier | fresh evidence 수집·판정 |
| `fix` | implementer | 실패 노드 수정 |
| `e2e` | playwright-e2e (post-v0, M5) | 브라우저 여정 |
| `docs` | knowledge-curator / implementer | 문서 |
| `knowledge` | knowledge-curator (post-v0, M6) | 지식 승격 |

매핑은 v0 고정. 새 kind 추가는 본 문서 개정으로만 한다(drift 방지 — deep-interview §4.1과 동형).

### 2.3 그래프 불변식

- `root_goal`은 분할하지 않는다. 노드만 나눈다.
- 노드 실패는 autopilot 실패가 아니라 §4 분류 입력이다.
- 노드가 너무 커서 context rot이 예상되면 §6.4 delegation packet으로 분할한다(노드를 더 쪼갬, root는 불변).
- 큰 변경은 §5 approval gate 통과 전까지 mutation 노드를 실행하지 않는다.
- 그래프 mutation은 `AutopilotStore`(메인 §11)를 통해서만 한다. 드라이버가 파일을 직접 덮어쓰지 않는다.

## 3. 드라이버 (orchestrator 에이전트 + ReAct 루프)

### 3.1 드라이버 정체성

드라이버는 **main agent가 실행하는 `autopilot` skill**이다(§3.4). **"orchestrator, not implementer"**(Sisyphus 정체성, `oh-my-openagent.md`). content(설계·코드·리뷰·문서)를 직접 생성하지 않는다 — 다음 노드 선택, stage subagent spawn(1-레벨), evidence 종합, 실패 분류·결정, stop 평가만 한다. content는 owner 에이전트의 몫이다.

**전용 subagent가 아닌 이유.** subagent는 subagent를 spawn 못 하므로 spawn 루프는 main agent에만 살 수 있다(§3.4). 그래서 v0 orchestrator는 전용 subagent가 아니라 main이 `autopilot` skill로 구동하는 role이며, 주류 하네스(Sisyphus=primary, OMC Ralph)와 일치한다. 결정 로직을 별도 결정자 subagent로 떼는 HANNES harness식 분리는 future refinement로 보존한다(§3.5).

§11 원칙 10과의 정합: 드라이버의 *판단*(어느 노드, 고칠 수 있나, retry/switch)은 프롬프트(에이전트), 그래프 *상태*는 schema(`autopilot.json`), 루프 *지속력*은 Stop hook이다. 세 축을 섞지 않는다.

### 3.2 ReAct 루프 (HANNES harness "Autonomous Task Loop" 차용)

main agent가 `autopilot` skill을 따라 구동하는 루프(HANNES Autopilot Loop 차용):

```text
LOOP (stop_condition 충족까지):
  1. autopilot.json 읽기 → graph 상태 (컨텍스트 누적 최소화 위해 매 라운드 re-read)
  2. ready 노드 선택 (status==pending ∧ depends_on 전부 passed)
     - 없으면: stop_conditions 평가 → 종료 또는 escalate
  3. 노드 kind → owner 에이전트 결정 (§2.2)
  4. delegation packet 구성 (§6.4): TASK·EXPECTED OUTCOME·allowed/forbidden·acceptance_refs·output_contract
     - Context Isolation(§3.3): main의 가설·다른 노드 결과를 주입하지 않는다
  5. owner stage subagent spawn (Task tool, 1-레벨) → evidence pointer 수집
  6. 노드 상태 갱신 (passed/failed/blocked) — AutopilotStore 통해서만
  7. failed면 §4 실패 분류 → retry / switch_approach / escalate / continue
  8. stop_conditions 재평가 → 충족이면 종료(→ §6.8 Completion 판정), 아니면 1로
```

이 루프는 **사용자 개입 없이** 모든 노드가 처리되거나 stop condition에 닿을 때까지 돈다. 루프 *지속력*은 **Stop hook**이 집행한다(§11 원칙 10) — 내부 checkpoint 완료를 final answer로 오인한 조기 종료를 막아 다음 라운드로 잇는다(주류 OMC persistent-mode 패턴). 멈춤은 §6.1의 stop condition일 때만. 행동강령 신선도는 hook 재주입(UserPromptSubmit projection)으로 유지한다(plan §1 D8).

**CLI step 경계 (G9 — 결정론을 산문에서 분리).** step 1~5(re-read → 승인게이트 소비 → ready 노드 선택+file-overlap gate → dispatch(pending→running, persist) → delegation packet)는 `ditto autopilot next-node`가, step 6(결과 수렴 — G7 content-free 가드 → 분류 입력 → `decideOnFailure` → 명시 transition table 전이 → `appendDecision`)은 `ditto autopilot record-result --json`이 한 호출로 수행한다(`autopilot-loop.ts`의 `nextNode`/`recordResult`, deep-interview step CLI와 동형). **이 결정론 로직은 코드 한 곳에만 산다** — skill(`autopilot` SKILL.md)은 두 CLI를 호출하고 *판단*(어느 결과가 pass인가, fixable vs wrong_approach, escalate 시점)만 `--json` payload로 주입한다. spawn 자체(owner stage subagent를 Task로 1-레벨)는 main agent만 할 수 있어 CLI 밖에 남는다. 승인게이트는 mutating(owner=implementer) 노드 앞에서만 적용하고(§5.3 — design/research는 승인 전 진행), rejected는 전역 rollback이다.

### 3.3 Context Isolation (fan-out 시 — HANNES harness 차용)

복수 ready 노드를 병렬 spawn할 때 강제한다(`hannes.md` §1 "Fan-out & Context Isolation").

- owner에게 **전달하지 않는 것**: 드라이버의 분석 결론·가설·중간 판단, 다른 노드의 진행 상황·결과 요약.
- owner에게 **전달하는 것**: 노드 목표(Task spec 원문), `file_scope`(allowed/forbidden), `done_when`(acceptance_refs).
- 강도별: low=직렬 단일 spawn, medium=2~3 병렬 + depends_on 해제 감지, high=DAG 병렬 + 충돌 시 escalate.

### 3.4 호스팅 (확정: orchestrator = main agent role)

Claude Code subagent는 subagent를 spawn할 수 없다(claude-code-guide 확인). spawn 루프는 main agent에만 살 수 있으므로, v0 orchestrator는 **전용 subagent가 아니라 main agent가 `autopilot` skill로 구동하는 role**이다. main이 직접 결정하고 stage subagent를 1-레벨로 spawn하며, 루프 지속은 Stop hook이 집행한다.

이는 주류 하네스와 일치한다 — OMOA Sisyphus는 primary(=main) agent로 돌며 worker를 spawn하고, OMC는 main + persistent Stop hook으로 루프를 유지하며(nested 세션은 launcher가 차단), OMX `$ralph`/`$autopilot`도 동형이다. 어느 하네스도 "결정자 subagent를 재호출하는" 방식을 메인으로 쓰지 않는다(`hannes.md` 조사).

### 3.5 미래 옵션: 결정 로직 추출 (decider subagent)

v0 후 autopilot 결정 로직이 main context를 오염시키거나(긴 그래프) 단위 테스트가 필요하다는 **증거가 나오면**, 결정 단계를 별도 결정자 subagent로 떼어낼 수 있다(HANNES harness "지시자, not 실행자" 패턴 — `{decision,…}`를 반환하고 호출측이 실행). 실현은 `context: fork` + `agent: orchestrator`.

이때 필요한 것이 **orchestrator↔main 양방향 계약**(§6.4의 특수 사례): orchestrator→main `{action: spawn|escalate|done, node_id, owner, packet, …}`, main→orchestrator `{spawn 결과, 갱신된 autopilot.json, 사용자 입력}`, 공유 원장은 `autopilot.json`. 단 이 indirection은 결정 격리 이득이 입증되기 전엔 도입하지 않는다(MVP — 근거 없는 추상화 금지). v0는 §3.4(main role)로 간다.

## 4. 실패 분류와 결정 (HANNES `failure_classification` 경량판)

### 4.1 failure_class

| failure_class | 의미 | 기본 결정 |
|---|---|---|
| `fixable` | 같은 접근으로 고칠 수 있는 국소 결함 | `retry` |
| `wrong_approach` | 접근 자체가 틀림 (재시도해도 같은 실패) | `switch_approach` (대안 노드/설계 재진입) |
| `blocked_external` | 외부 시스템·크리덴셜·네트워크 차단 | `escalate` (external blocker) |
| `user_decision_needed` | 도메인 의미·되돌리기 어려운 결정에 막힘 | `escalate` (user-owned, §6.2) |

### 4.2 구조화된 결정 (드라이버 출력)

```json
{
  "node_id": "N3",
  "failure_class": "fixable|wrong_approach|blocked_external|user_decision_needed",
  "decision": "retry|switch_approach|escalate|continue",
  "reason": "근거 2~3줄 (journal/decision log에 남아 회고에 반영)",
  "attempts": {"fix": 1, "switch": 0}
}
```

- `retry` / `switch_approach`는 같은 autopilot 안에서 **자동 진행**한다(continue_after_fixable_failure).
- `escalate` / `user_decision_needed`만 사용자에게 간다. 그때도 "진행할까요?"가 아니라 *어떤 user-owned decision이 필요한지와 가능한 선택의 영향*을 설명한다(§6.2).
- HANNES Fail-safe 차용: 불확실하면 `advance`보다 `retry` 선호(한 iteration 낭비 < 잘못된 진입). `escalate`는 최후 수단.

### 4.3 재시도 상한과 cap ≠ converged

- 노드별 재시도/전환 상한을 둔다(`caps.fix_per_node`, `caps.switch_per_node` — HANNES `fix_attempts`/`redesign_attempts` 대응). 기본값은 configurable.
- **상한 도달 = 성공 아님.** 상한에서 두 게이트(완료↔수렴, §6.8↔§6.9)를 못 채우면 그 노드는 `failed`로 닫고, 전체 verdict는 Completion이 `partial|fail|unverified`로 결정한 뒤 handoff한다. `cap-reached ≠ converged`(§6.9, deep-interview §4.3과 동형).
- 한 노드의 retry/fix 정련 루프 *내부*의 종료는 §6.9 ConvergenceGate가 admissibility·ratchet·decision ledger로 지배한다. autopilot은 그 결과(passed/failed)만 받는다.

## 5. Approval Gate (승인 경계 vs 지속 경계 — 메인 §5.4)

### 5.1 무엇이 gate를 요구하는가

큰 범위, 되돌리기 어려운 변경, migration, 외부 서비스 변경, 보안/권한 변경, production 영향, 대량 파일 수정, E2E 사용자 여정 변경은 **구현 전** gate를 통과해야 한다.

### 5.2 승인 근거 source

`user`(명시 승인) | `approved_spec`/`issue`/`prd`(이미 승인된 문서) | `small_reversible_policy`(작은 reversible 작업 정책) 중 하나.

### 5.3 gate 통과 후 = 무중단 진행

- `pending`이면 드라이버는 `draft` work item + plan artifact만 남기고 mutation 노드를 시작하지 않는다.
- `approved`/`not_required`가 되면 **내부 checkpoint마다 재승인하지 않는다**. 초기 plan approval은 plan에 명시된 migration/e2e/외부 변경 checkpoint까지 한 번에 승인하는 것으로 본다.
- blocker는 다음 단계 승인 요청이 아니라 user-owned decision의 의미·영향 확인이어야 한다.

## 6. 정지 / 계속 / 핸드오프

### 6.1 stop_conditions 평가

매 라운드 끝에 평가한다. 하나라도 참이면 루프 종료:

- `all_acceptance_criteria_passed_or_explicitly_closed` — 정상 완료 경로(→ §6.8).
- `blocked_by_user_owned_decision` — work item `blocked` + §6.2 질문.
- `blocked_by_external_system` — external blocker, evidence 남기고 escalate.
- `safety_boundary_hit` — destructive·secret·권한 경계, 즉시 정지.

persistent Stop hook(메인 §7.2, OMC 차용)이 "내부 checkpoint 완료"를 final answer로 오인한 조기 종료를 막는다 — 루프의 지속력은 Stop hook이 집행한다(§11 원칙 10).

### 6.2 continue_policy

```json
{
  "continue_after_approval": true,
  "continue_after_checkpoint": true,
  "continue_after_fixable_failure": true,
  "ask_user_only_for_user_owned_decisions": true
}
```

- 내부 checkpoint 완료를 사용자에게 보고할 수 있지만, final answer의 *근거*일 뿐 final answer *자체*가 아니다.
- "다음 단계를 진행할지"는 사용자에게 묻지 않는다.

### 6.3 context handoff (같은 autopilot_id 유지)

context pressure가 생기면 §6.10 Handoff를 만들고 **같은 `autopilot_id`로 이어받는다**. handoff는 scope 축소가 아니다. handoff는 raw artifact 대신 evidence 요약/hash/exit code로 렌더링해 다음 세션이 raw 없이도 판단하게 한다(§6.7, §6.10).

## 7. 범위 보존과 정당한 분리 (메커니즘 — 메인 §6.5 "what"의 how)

### 7.1 임의 분할·축소 금지

사용자가 지시한 범위가 크다는 것은 최초 의도가 크다는 뜻이다(메인 §0, §1). 드라이버는 한 요청을 임의로 여러 work item으로 분산하지 않고 하나의 autopilot으로 끝까지 완수한다. "narrow scope" / "다음 작업 후보" framing으로 축소를 정당화하지 않는다(HANNES §3-0 Plan Integrity 차용, `hannes.md` §2).

### 7.2 분리 제안이 허용되는 두 경우 (바가 높다)

드라이버는 다음에 한해 범위 *분리를 제안*할 수 있고, 최종 결정은 사용자가 한다(user-owned decision → `blocked_by_user_owned_decision`, §5와 함께 제시):

- **충돌 분리**: 변경 간 충돌·오염 위험이 클 때. 예: 엔티티/DB 구조 변경 ↔ 그에 의존하는 기능·버그 수정의 분리, 기능에 선행해야 하는 대규모 구조 변경(Tidy First)의 분리. 단 commit 단위의 구조적/동작적 분리는 한 autopilot 내부의 commit discipline이지 범위 분리가 아니다.
- **광범위 분리**: 연관성 없는 다수 기능을 한 번에 다룰 때. 예: 무관한 여러 메뉴 동시 개발, 권한 관리 기능 자체와 서비스·리소스 권한 적용의 동시 개발.

### 7.3 분리 확정 시 처리

분리가 사용자 승인으로 확정되면 — (a) 현재 autopilot에 **남은 범위는 여전히 끝까지 완수**하고, (b) 분리분은 버리지 않고 `out_of_scope` + `follow_up_candidates` 또는 sibling follow-up work item으로 결정 근거와 함께 추적한다(§6.1, §6.8). v0에서는 child work item을 만들지 않으므로 분리분은 별도(후속) work item이다.

이 "승인에 의한 분리"는 "이번 turn에 다 못해서 줄이는" 임의 축소(메인 §5.2)와 구분된다 — 전자는 결정 근거가 남고 후자는 금지다.

## 8. 산출물과 스키마

### 8.1 파일

```text
.ditto/work-items/<id>/autopilot.json            # graph 상태 (드라이버가 AutopilotStore로만 갱신)
.ditto/work-items/<id>/autopilot.md              # 사람이 읽는 graph 뷰 + 현재 목적
.ditto/work-items/<id>/autopilot-decisions.jsonl # 신규 additive — 드라이버 실패분류·결정 append-only 로그
```

`autopilot.json`은 work item status를 대체하지 않는다. 내부 interview/planning/running/verifying 상태는 여기와 `progress.md`에만 둔다(메인 §5.5).

### 8.2 `autopilot.json` (예시 — 구현 전 Zod/JSON 스키마와 정합)

재사용: `schema_version`(`0.1.0`), `work_item_id`(`wi_…`), `evidenceRef`는 `src/schemas/common.ts`를 그대로 쓴다. 새 enum/필드만 신설한다.

> **Reconciliation note.** 메인 §5.3은 `nodes`, §6.5는 `internal_checkpoints`로 같은 개념을 다르게 불렀다. 본 문서는 **`nodes`로 canonical 통일**한다(graph 용어). 구현 스키마는 `nodes`를 쓰고, 메인 §5.3/§6.5 본문은 스키마에 맞춘다(migration: 메인 §6.5 trim 시 명칭 정리).

```json
{
  "schema_version": "0.1.0",
  "autopilot_id": "orch_example1234",
  "work_item_id": "wi_example1234",
  "mode": "autopilot",
  "root_goal": "사용자가 요청한 전체 목표",
  "completion_boundary": "entire_work_item",
  "approval_gate": {
    "status": "pending|approved|not_required|rejected",
    "source": "user|approved_spec|issue|prd|small_reversible_policy",
    "approved_at": null,
    "approved_by": null,
    "evidence_refs": []
  },
  "nodes": [
    {
      "id": "N1",
      "kind": "research|design|implement|review|verify|fix|e2e|docs|knowledge",
      "owner": "researcher|planner|implementer|reviewer|verifier|...",
      "purpose": "왜 필요한가",
      "status": "pending|running|passed|failed|blocked",
      "depends_on": [],
      "acceptance_refs": ["AC-1"],
      "evidence_refs": [],
      "attempts": { "fix": 0, "switch": 0 }
    }
  ],
  "caps": { "fix_per_node": 2, "switch_per_node": 1 },
  "continue_policy": {
    "continue_after_approval": true,
    "continue_after_checkpoint": true,
    "continue_after_fixable_failure": true,
    "ask_user_only_for_user_owned_decisions": true
  },
  "stop_conditions": [
    "all_acceptance_criteria_passed_or_explicitly_closed",
    "blocked_by_user_owned_decision",
    "blocked_by_external_system",
    "safety_boundary_hit"
  ],
  "user_interrupt_policy": "ask_only_for_user_owned_decisions"
}
```

### 8.3 `autopilot-decisions.jsonl` (드라이버 결정 로그)

각 줄은 §4.2 구조 + 타임스탬프. 회고(사후 분석)와 cap 추적의 근거. raw가 아니라 결정·근거만 남긴다.

```json
{"ts":"2026-05-26T00:00:00.000Z","node_id":"N3","failure_class":"fixable","decision":"retry","reason":"...","attempts":{"fix":1,"switch":0}}
```

## 9. 불변 규칙 요약 (체크리스트)

- [ ] `root_goal`은 분할하지 않는다. 노드만 나눈다.
- [ ] 드라이버(`orchestrator`)는 content를 생성하지 않는다 — 선택·spawn·분류·평가만.
- [ ] 매 라운드 `autopilot.json`을 re-read한다(graph를 context에 누적하지 않음).
- [ ] owner spawn 시 Context Isolation(드라이버 가설·타 노드 결과 주입 금지).
- [ ] 그래프 mutation은 `AutopilotStore`로만.
- [ ] 큰 mutation은 approval gate 통과 후. 통과 뒤 checkpoint마다 재승인 안 함.
- [ ] 노드 실패는 §4로 분류 → retry/switch는 자동, escalate/user-decision만 사용자.
- [ ] blocker는 "진행할까요?"가 아니라 user-owned decision으로 묻는다(§6.2).
- [ ] cap 도달 = 성공 아님. non-pass로 닫고 handoff(§6.9).
- [ ] 내부 checkpoint 완료 ≠ final answer. 완료 판정은 §6.8이 전체 work item 기준으로만.
- [ ] context pressure 시 같은 `autopilot_id`로 handoff. scope 축소 아님.
- [ ] 범위 분리는 §7.2 두 경우 + 사용자 승인 시만. 분리분은 §7.3으로 추적(버리지 않음).

## 10. 참조 하네스 매핑 (무엇을 어디서 차용했는가)

| 차용 요소 | 출처 | 본 설계 반영 |
|---|---|---|
| "orchestrator, not implementer" 정체성 | Sisyphus (`oh-my-openagent.md`) | §3.1 |
| ReAct 자율 루프 (개입 없이 unblocked 노드 처리) | HANNES harness "Autonomous Task Loop" (`hannes.md` §1) | §3.2 |
| Autopilot Loop = Persistence / Failure Classification / Approach Switch | HANNES harness (`hannes.md` §1·§3) | §3.2, §4 |
| 구조화 결정 `{advance\|retry\|switch_candidate\|redesign\|escalate}` | HANNES harness | §4.2 |
| Context Isolation (supervisor 가설 주입 금지, Task spec 원문만) | HANNES harness fan-out (`hannes.md` §1) | §3.3 |
| 6-section delegation packet + post-delegation verification | Sisyphus/Atlas (`oh-my-openagent.md`) | §3.2(4), §6.4 연계 |
| 병렬 fan-out을 성능 원리로 | Sisyphus (`oh-my-openagent.md`) | §3.3 강도별 |
| stage→owner 매핑 | HANNES (`hannes.md` §1) | §2.2 |
| `fix_attempts`/`redesign_attempts` cap + cap≠converged | HANNES + 메인 §6.9 | §4.3 |
| persistent Stop으로 루프 지속 | OMC (`oh-my-claudecode.md`) | §6.1 |
| `orchestrator`/`plan-executor` 역할 분리 권고 | `oh-my-openagent.md` §"수정 적용" | §3.1, §3.4 |

## 11. 구현 참조 (HANNES harness · Sisyphus, 분석 보고서 수준)

> 본 계약의 가장 가까운 선행 구현은 HANNES `harness` 에이전트다. 직접 분석: [`reports/harnesses/hannes.md`](../../harnesses/hannes.md)(원본 `boxwood-with-hannes/.claude/agents/harness.md`를 정적으로 읽음). Sisyphus 구현은 [`reports/harnesses/oh-my-openagent.md`](../../harnesses/oh-my-openagent.md)가 코드 경로와 함께 기록한다. 아래는 본 계약 구현 시 직접 차용할 메커니즘만 추린 것이다.

| 본 계약 요소 | 레퍼런스 구현 | 근거 |
|---|---|---|
| §3.2 드라이버 ReAct 루프 | HANNES harness "Autonomous Task Loop" (`LOOP until all tasks done`) | `hannes.md` §1; HANNES `harness.md` "Autonomous Task Loop" |
| §3.1 판단자/실행자 분리 (지시자이며 실행자 아님) | HANNES harness "금지 사항: content 생성 금지 / state 직접 overwrite 금지" | HANNES `harness.md`; `hannes.md` §2.2 |
| §3.3 fan-out Context Isolation | HANNES harness "Supervisor → Sub-agent 전달 규칙" + Sisyphus 병렬 발사 | `hannes.md` §1; `oh-my-openagent.md`(src/agents/sisyphus 병렬 fan-out) |
| §3.2(4) delegation packet 6 섹션 | Sisyphus/Atlas (TASK·EXPECTED OUTCOME·REQUIRED TOOLS·MUST/MUST-NOT·CONTEXT + post-verification) | `oh-my-openagent.md` §"강점"·§"차용"(src/agents/sisyphus/gpt-5-5.ts) |
| §4 실패 분류 → 결정 | HANNES harness `failure_classification` 입력 + 구조화 decision JSON | `hannes.md` §1; HANNES `harness.md` "입력/출력" |
| §4.3 cap = 안전정지지 성공 아님 | HANNES `state.json.autopilot.{fix_attempts,redesign_attempts}` + 메인 §6.9 | `hannes.md` §3.1 |
| §6.1 persistent Stop으로 조기종료 차단 | OMC persistent Stop mode | `oh-my-claudecode.md` |

DITTO 적용 시 주의(`hannes.md` §2 교훈): 드라이버의 *판단*을 hook의 키워드·임계치로 굳히지 않는다(§11 원칙 10). graph 상태는 schema(`autopilot.json`), 판단은 orchestrator 프롬프트, 루프 지속은 Stop hook으로 분리한다. HANNES가 stage 전이 판단 일부를 결정론 hook에 누출시켜 mutation cycle을 부른 양식을 답습하지 않는다.
