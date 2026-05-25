---
title: "DITTO Claude Code 기반 하네스 기본 설계"
kind: design
last_updated: 2026-05-26 KST
status: draft
scope: "Claude Code를 primary runtime으로 사용하는 DITTO v0 하네스 설계"
inputs:
  - PURPOSE.md
  - reports/harnesses/oh-my-claudecode.md
  - reports/harnesses/ditto-application-plan.md
  - reports/harnesses/04-claude-code-codex-omc-omx-research-ko.md
---

# DITTO Claude Code 기반 하네스 기본 설계

> **이 문서를 읽는 관점.** 이것은 구현 계약이 아니라 설계 문서다. 목적은 독자가 올바른 멘탈 모델을 갖게 하는 것이다. 따라서 구체적 값, 상태 전이, 임계치, 호출 메커니즘 같은 **"어떻게(how)"는 의도적으로 열어둔다** — 구현 단계에서 합리적으로 메워질 디테일을 미리 박으면 간결함만 해친다. 반면 **"무엇(what)"이 자기모순이면 안 된다.** 독자가 서로 충돌하는 두 사실을 동시에 믿게 만드는 진술은 설계 문서로서 결함이며, 그런 모순만 본문에서 닫는다. 예시 JSON과 enum은 모델 전달용이지 최종 스키마가 아니며, 충돌 시 §3.3에 따라 실제 스키마가 우선한다.

## 0. 결론

DITTO v0는 Claude Code 위의 **의도/검증/완료 하네스**로 시작한다.

Claude Code는 실행 runtime이다. 모델 루프, 파일 편집, shell 실행, permission, sandbox, hooks, subagents, skills, plugins, MCP, memory는 Claude Code의 native 기능을 사용한다. DITTO는 그 위에서 사용자의 의도를 구조화하고, 불필요한 질문을 막고, 작업을 전문 subagent에 위임하고, 검증 증거 없이 완료라고 말하지 못하게 하며, 세션이 바뀌어도 이어받을 수 있는 지식과 handoff를 남긴다.

핵심 판단은 다음이다.

- **runtime ownership은 목표가 아니다.** 사용자가 원하는 것은 agent가 의도를 정확히 이해하고 끝까지 수행하는 것이다.
- **intent ownership과 completion ownership은 DITTO가 가져야 한다.** Claude Code가 실행을 잘하더라도, 사용자의 최초 의도와 완료 판정은 DITTO의 계약으로 남아야 한다.
- **OMC는 참고 구현이다.** Hooks, Skills, Agents, State 구조와 persistent Stop hook은 참고하되, OMC의 넓은 mode/팀 런타임/복잡한 keyword activation을 그대로 복제하지 않는다.
- **v0는 작게 시작한다.** Milestone 0~2의 contract/plugin/orchestration skeleton까지만 v0로 묶고, evidence hardening, context rot 방지, E2E, project-management integration은 후속으로 분리한다.
- **큰 범위 작업은 하나의 오케스트레이션으로 끝까지 처리한다.** 계획, 구현, 리뷰, 수정, E2E, 문서, knowledge update는 내부 checkpoint일 뿐 사용자에게 매 phase마다 넘기는 완료 단위가 아니다.

목표 구조:

```text
Claude Code
  model loop / tools / permissions / sandbox / hooks / skills / subagents / memory

DITTO
  intent contract / question gate / delegation contract / evidence ledger
  one-shot orchestration / completion contract / handoff
  knowledge base / E2E journey verification

Codex
  v0: opponent/reviewer lane for dialectic checks when available
  later: alternative executor lane, compatibility lane
```

## 0.1 OMX 리셋 노트와의 관계

이 문서는 `reports/harnesses/ditto-omx-reset-plan.md`의 "provider-native 실행을 대체하지 않는다"는 원칙을 유지하되, **초기 구현 우선순위는 Claude Code-first로 피벗**한다.

피벗 이유:

- 사용자의 현재 우선순위는 runtime ownership이 아니라 의도 파악, 질문 억제, 적대적 검증, completion gate, handoff, 지식 누적이다.
- 이 목표는 Claude Code의 native hooks, skills, subagents, plugins, memory를 활용할 때 더 빨리 검증 가능하다.
- Codex의 열린 control surface는 장기적으로 중요하지만, v0에서 전체 executor lane으로 끌어오면 setup/hook/config/team 복잡도가 먼저 온다.

유지되는 원칙:

- DITTO는 Claude Code agent loop를 재구현하지 않는다.
- DITTO는 Codex/Claude Code를 같은 spawn abstraction으로 얕게 묶지 않는다.
- DITTO core contract는 provider-neutral이어야 한다. Claude Code plugin은 첫 integration surface일 뿐, work item, evidence, completion, handoff, dialectic 산출물은 `.ditto/`에 남는다.

Codex의 v0 위치:

- Codex는 "나중" 전체가 아니다. v0에서도 **dialectic Opponent/reviewer lane**으로 사용한다.
- Codex executor lane, Codex-native setup/doctor/hook/skill surface는 후속 milestone이다.
- Codex를 사용할 수 없으면 Opponent는 Claude Opus, 그 다음 Claude Sonnet으로 fallback한다.

## 1. 사용자 요구를 설계 요구사항으로 변환

사용자가 기대하는 agent는 "많은 기능을 가진 agent"가 아니라 "의도를 덜 망치고, 근거 없이 확신하지 않고, 끝까지 수행하는 agent"다. 이를 DITTO 요구사항으로 바꾸면 다음과 같다.

| 사용자 요구 | DITTO 설계 요구 |
|---|---|
| 꼬리에 꼬리를 무는 질문 금지 | `QuestionGate`가 질문 전 self-answer 가능성을 검사한다. |
| 최초 의도 확대 금지 | `IntentContract`가 in-scope/out-of-scope를 분리한다. |
| deep interview | `/ditto:deep-interview` skill이 필요한 경우에만 작동하고 산출물을 남긴다. |
| 할루시네이션 방지 | 모든 주장과 완료 판정은 `EvidenceContract`를 통과해야 한다. |
| 자기 확신 억제 | `Verifier`/`Reviewer` subagent가 작성자와 분리된다. |
| 결정/검토/제안의 정반합 토의 | `DialecticDeliberationContract`가 생성자, 반대자, 합의자를 분리해 초안 생성/반론/합의를 범용 수행한다. |
| 세션 관리 | `PreCompact`와 Stop gate가 handoff/checkpoint를 만든다. |
| 전문 도구 확보 | skills, commands, subagents, MCP를 역할별로 둔다. |
| 끈질긴 완수 | `CompletionContract`가 미완료 상태에서 조용한 종료를 막는다. |
| 큰 범위 작업의 일괄 처리 | `OneShotOrchestrationContract`가 계획-구현-검증-수정-완료를 하나의 work item 안에서 끝까지 소유한다. |
| context rot 방지 | 조사/리뷰/검증은 subagent-first로 위임한다. |
| 코드 품질 유지 | Deep Module, architecture lint, reviewer skill을 둔다. |
| 사용법 최소화 | 자연어 입력을 기본으로 하고 mode activation은 보수적으로 한다. |
| 지식 누적 | `.ditto/knowledge`와 Claude memory projection을 분리한다. |
| 진짜 E2E | Playwright/Chromium 기반 user journey verifier를 둔다. |
| 프로젝트 관리 도구 | GitHub Issues/Projects, 문서, 메신저 MCP bridge는 후속 milestone으로 둔다. |

## 2. 비목표

초기 버전에서 하지 않을 것:

1. Claude Code agent loop를 재구현하지 않는다.
2. Claude Code permission/sandbox를 복제하지 않는다.
3. 모든 사용자 입력을 heavy workflow로 자동 승격하지 않는다.
4. OMC의 모든 skill/mode/team runtime을 복제하지 않는다.
5. raw provider CLI를 agent가 임의로 조립하게 두지 않는다.
6. verifier 없이 "완료" 상태를 만들지 않는다.
7. 대형 benchmark platform이나 multi-model council을 기본 경로로 넣지 않는다.
8. context에 큰 로그, 긴 transcript, 전체 테스트 출력을 직접 밀어 넣지 않는다.

## 3. 소유권 경계

### 3.1 Claude Code가 소유하는 것

Claude Code native 기능을 그대로 사용한다.

- model/tool loop
- file edit, shell, search, web, MCP tool execution
- permission mode와 permission rule
- sandbox와 위험 명령 승인 UX
- `CLAUDE.md`, settings, memory
- skills, commands, plugins
- subagents와 native agent teams
- hook event 발생과 hook input schema
- IDE/web/desktop/terminal surface

DITTO는 이 기능을 얕게 감싸지 않는다. `ditto run with claude` 같은 process wrapper가 primary workflow가 되면 Claude Code의 세션, permission UX, TTY, hooks, memory를 훼손한다.

### 3.2 DITTO가 소유하는 것

DITTO는 Claude Code 실행 결과 위에 남아야 하는 품질 계약을 소유한다.

- `IntentContract`: 사용자의 진짜 목표, 하지 않기로 한 것, acceptance criteria
- `QuestionGate`: 질문 필요성 판단과 질문 출력 검열
- `DeepInterviewContract`: 모호한 목표를 검증 가능한 목표로 좁히는 인터뷰 산출물
- `DelegationContract`: subagent에 넘기는 입력, 금지 범위, 출력 형식
- `OneShotOrchestrationContract`: 큰 범위 작업을 내부 단계로 나누되 하나의 실행 의도로 끝까지 완수하는 계약
- `DialecticDeliberationContract`: 결정, 검토, 제안, 문서 생성을 생성자/반대자/합의자 3역으로 검증하고 합성하는 계약
- `EvidenceContract`: 테스트, diff, 로그, 브라우저 검증, 코드 위치, 문서 근거
- `CompletionContract`: 완료/부분완료/미검증/차단 판정
- `HandoffContract`: 새 세션/다른 agent가 이어받는 최소 문맥
- `KnowledgeContract`: 프로젝트 지식, 용어, 결정, 반복 학습
- `E2EJourneyContract`: 웹 서비스의 사용자 여정 검증

### 3.3 기존 구현과의 매핑

이 문서는 greenfield 설계가 아니다. 이미 존재하는 v0.1~v0.3 스키마와 CLI를 재사용하고, 필요한 계약만 sidecar로 확장한다.

| 설계 항목 | 기존 구현 | 결정 |
|---|---|---|
| work item authority | `src/schemas/work-item.ts`, `schemas/work-item.schema.json` | 대체하지 않고 재사용한다. `source_request`, `goal`, `acceptance_criteria`, `status`, `re_entry`, `runs`, `handoff_path`가 authoritative state다. |
| work item status | `draft`, `in_progress`, `blocked`, `partial`, `unverified`, `done`, `abandoned` | 새 status enum을 만들지 않는다. 내부 interview/planning/running/verifying 상태는 `orchestration.json` checkpoint 또는 `progress.md`에만 둔다. |
| completion contract | `src/schemas/completion-contract.ts`, `schemas/completion-contract.schema.json` | 대체하지 않고 재사용한다. `final_verdict`는 `pass|partial|fail|unverified`이며, `done`은 work item status로만 쓴다. |
| evidence refs | `src/schemas/common.ts`의 `evidenceRef`, `src/schemas/evidence-log.ts` | 새 evidence pointer schema를 만들지 않고 기존 `kind/path/url/command/sha256/lines/summary` 구조를 재사용한다. |
| provider run 기록 | `src/cli/commands/run.ts`, `src/core/run-with.ts`, `RunStore` | `run record`는 유지한다. `run with`는 primary workflow가 아니라 smoke/debug/manual capture/provider wrapper 연구용으로 격하한다. |
| orchestration | 없음 | `orchestration.json`은 additive sidecar다. work item status를 대체하지 않고 checkpoint graph만 저장한다. |
| dialectic deliberation | 없음 | `dialectic-<n>.json/md`는 additive review artifact다. evidence refs와 provider run ids는 기존 schema를 참조한다. |

구현 원칙:

- 새 schema는 `src/schemas/common.ts`의 `workItemId`, `runId`, `reviewId`, `providerName`, `verdict`, `evidenceRef`, `relativePath`, `schemaVersion`을 재사용한다.
- 기존 `completion-contract`가 이미 보장하는 규칙을 중복 구현하지 않는다. 예: `final_verdict=pass`는 모든 acceptance가 pass이고 in-scope unverified가 없어야 한다.
- 설계 문서의 예시 JSON은 구현 전 반드시 기존 Zod/JSON schema와 맞춘다.
- 문서와 스키마가 다르면 스키마가 우선이며, 문서 수정 또는 migration proposal을 남긴다.

`run with` 처리:

- `src/core/run-with.ts`와 `ditto run with`는 삭제하지 않는다. 이미 있는 provider 실행 기록과 smoke/debug 용도는 보존한다.
- Claude Code plugin/hook 기반 흐름을 `run with`로 구현하지 않는다. 그 경로는 native Claude Code session, permission, TTY, hook lifecycle을 우회하기 때문이다.
- 향후 CLI 문구와 문서에서는 `run with`를 primary executor가 아니라 experimental/manual capture surface로 표시한다.

## 4. OMC에서 차용할 것과 버릴 것

### 4.1 차용할 것

| OMC 패턴 | DITTO 적용 |
|---|---|
| Hooks/Skills/Agents/State 4축 | DITTO도 같은 축으로 시작한다. |
| `UserPromptSubmit` keyword detector | 실행 의도, 질문 필요성, deep interview 필요성을 분류한다. |
| skill injector | 필요한 절차 지침만 context에 주입한다. |
| `Stop` persistent mode | 미완료/미검증 종료를 막고 handoff를 요구한다. |
| `PreCompact` hook | context rot 전에 checkpoint/handoff를 만든다. |
| subagent tracker | 위임 입력/출력/근거를 work item에 연결한다. |
| verifier/reviewer 분리 | 작성자 자기평가를 그대로 믿지 않는다. |
| control plane/data plane 분리 | 작은 상태와 큰 artifact를 분리한다. |
| fail-open hook implementation | hook 오류가 사용자 세션을 깨뜨리지 않게 한다. |
| small task heavy mode suppression | 작은 요청을 불필요하게 거대한 workflow로 키우지 않는다. |

### 4.2 그대로 가져오지 않을 것

| OMC 요소 | DITTO 판단 |
|---|---|
| 너무 많은 mode | v0는 deep interview, plan, verify, handoff, dialectic skeleton 정도로 제한한다. E2E는 post-v0 milestone에서 first-class로 올린다. |
| 자연어 keyword 자동 실행 과다 | 자동 activation은 advisory로 시작하고 실행은 보수적으로 한다. |
| Team runtime 선도입 | native subagents를 먼저 쓰고, team은 후속 milestone으로 둔다. |
| 복잡한 persistent loop 우선순위 | v0 Stop gate는 완료/질문/handoff에만 집중한다. |
| 외부 provider CLI raw call | wrapper 또는 MCP bridge를 통해 artifact를 남긴다. |
| doc/source inventory drift | skills/commands/hooks inventory test를 초기에 둔다. |

## 5. 전체 작업 흐름

### 5.1 Normal flow

```text
User prompt
  -> UserPromptSubmit hook
  -> QuestionGate + IntentClassifier
  -> work item load/create
  -> needed skill injection
  -> Claude Code main agent planning
  -> subagent-first delegation
  -> tool execution with evidence capture
  -> verifier/reviewer pass
  -> CompletionContract
  -> final answer or HandoffContract
```

### 5.2 One-shot large work flow

큰 범위 작업은 사용자에게 "phase 1만 완료했습니다"라고 반환하는 방식으로 처리하지 않는다. DITTO는 큰 작업을 내부적으로 나누지만, 외부 완료 단위는 하나의 work item이다.

예:

```text
"이 설계문서를 구현 완료해줘"
  -> intent/acceptance criteria 확정
  -> internal implementation graph 생성
  -> researcher/planner/implementer/reviewer/e2e/knowledge-curator 위임
  -> 각 내부 checkpoint별 evidence 수집
  -> 실패 checkpoint 자동 수정 루프
  -> 전체 completion contract 검증
  -> 사용자에게 최종 완료 또는 차단 사유 보고
```

one-shot flow의 규칙:

- 내부 단계는 scheduling 단위일 뿐 사용자-facing 완료 단위가 아니다.
- 한 내부 단계가 끝났다는 이유만으로 final answer를 보내지 않는다.
- 다음 단계가 명확하면 agent가 계속 진행한다.
- 사용자 질문은 domain decision, irreversible tradeoff, external credential 같은 경우에만 허용한다.
- context pressure가 생기면 handoff를 만들고 같은 work item을 이어받는다. handoff는 scope 축소가 아니다.
- 실패가 나면 같은 orchestration 안에서 diagnose -> fix -> verify를 반복한다.
- 전체 acceptance criteria가 pass/partial/fail/unverified로 닫히기 전에는 완료라고 말하지 않는다.

### 5.3 Orchestration graph

one-shot orchestration은 linear phase list가 아니라 작업 그래프다. 그래프는 agent가 내부적으로 관리하고, 사용자에게는 현재 목적과 최종 결과만 노출한다.

```json
{
  "orchestration_id": "orch_...",
  "work_item_id": "wi_example1234",
  "mode": "one_shot",
  "root_goal": "설계문서를 구현 완료한다",
  "approval_gate": {
    "status": "not_required|pending|approved|rejected",
    "source": "small_reversible_policy|user|approved_spec|issue|prd",
    "evidence_refs": []
  },
  "nodes": [
    {
      "id": "N1",
      "kind": "research|design|implement|review|fix|e2e|docs|knowledge",
      "owner": "agent role",
      "status": "pending|running|passed|failed|blocked",
      "depends_on": [],
      "acceptance_refs": ["AC-1"],
      "evidence_refs": []
    }
  ],
  "stop_condition": "all_in_scope_acceptance_criteria_closed",
  "user_interrupt_policy": "ask_only_for_user_owned_decisions"
}
```

그래프 운영 규칙:

- graph node는 작게 나누되 root goal은 나누지 않는다.
- node 실패는 orchestration 실패가 아니라 수정 루프 입력이다.
- node가 너무 커서 context rot이 예상되면 subagent delegation packet으로 분할한다.
- 큰 변경은 plan approval gate를 통과하기 전까지 mutation node를 실행하지 않는다.
- graph mutation은 `OrchestrationStore`를 통해서만 한다.
- final report는 graph 전체 상태와 acceptance criteria 상태를 기준으로 한다.

### 5.4 Plan approval gate

one-shot은 "승인 없는 폭주"가 아니다. DITTO는 승인 경계와 지속 실행 경계를 분리한다.

규칙:

- 큰 범위, 되돌리기 어려운 변경, migration, 외부 서비스 변경, 보안/권한 변경, production 영향, 대량 파일 수정, E2E 사용자 여정 변경은 구현 전에 plan approval gate를 통과해야 한다.
- 승인 근거는 명시적 사용자 승인, 이미 승인된 spec/issue/PRD, 또는 작은 reversible 작업 정책 중 하나여야 한다.
- approval이 `pending`이면 agent는 `draft` work item과 plan artifact를 남기고 구현 mutation을 시작하지 않는다.
- approval이 `approved` 또는 `not_required`가 된 뒤에는 내부 checkpoint마다 사용자 승인을 다시 요구하지 않는다. 초기 plan approval은 plan에 명시된 migration/e2e/외부 변경 checkpoint까지 한 번에 승인하는 것으로 본다.
- blocker가 생겼을 때 묻는 질문은 다음 단계 승인 요청이 아니라 user-owned decision의 의미와 영향 확인이어야 한다.

sidecar 예시:

```json
{
  "approval_gate": {
    "status": "pending|approved|not_required|rejected",
    "source": "user|approved_spec|issue|prd|small_reversible_policy",
    "approved_at": "2026-05-26T00:00:00.000Z",
    "approved_by": "user|policy",
    "evidence_refs": []
  }
}
```

### 5.5 State transition

`work-item.json`의 `status`는 기존 schema enum만 사용한다.

```text
draft
  -> in_progress
  -> done

any non-terminal
  -> blocked
  -> partial
  -> unverified
  -> abandoned
```

상태 전이 규칙:

- `draft`: intent, acceptance criteria, approval 상태가 아직 실행 가능한 수준으로 닫히지 않았다.
- `draft -> in_progress`: acceptance criteria가 충분하고 plan approval gate가 `approved` 또는 `not_required`일 때 가능하다.
- 내부 상태인 interviewing/planning/running/verifying은 `work-item.json` status가 아니라 `orchestration.json` checkpoint와 `progress.md`에 기록한다.
- `in_progress -> done`: `completion.json`의 `final_verdict=pass`일 때만 가능하다.
- `blocked|partial|unverified`: 기존 `work-item` schema에 따라 `re_entry`가 필요하다.
- handoff는 status가 아니라 `handoff_path`와 `handoff.md`로 표현한다.
- `done`은 되돌릴 수 없다. 새 발견은 새 work item 또는 follow-up으로 남긴다.

## 6. Core Contracts

### 6.1 Intent Contract

목적: 사용자의 최초 의도를 보존하고 scope creep을 막는다.

권위 상태:

- `work-item.json`의 `source_request`, `goal`, `acceptance_criteria`가 authoritative하다.
- `intent.json`은 질문 정책, scope guard, unknowns를 더 자세히 담는 sidecar다.
- 두 파일이 충돌하면 `work-item.json`을 기준으로 하고 `intent.json`을 갱신한다.

저장 위치:

```text
.ditto/work-items/<id>/intent.json
.ditto/work-items/<id>/intent.md
```

필드:

```json
{
  "source_request": "사용자 원문",
  "goal": "검증 가능한 목표",
  "in_scope": [],
  "out_of_scope": [],
  "acceptance_criteria": [
    {
      "id": "AC-1",
      "statement": "관찰 가능한 완료 조건",
      "verdict": "unverified",
      "evidence": [],
      "evidence_required": ["test", "diff", "browser", "doc", "log"]
    }
  ],
  "unknowns": [],
  "question_policy": "ask_only_if_user_only_can_answer"
}
```

규칙:

- agent가 임의로 목표를 키우면 안 된다.
- 추가 개선 아이디어는 `out_of_scope` 또는 `follow_up_candidates`에만 둔다.
- 모든 work item은 최소 1개의 acceptance criteria를 가진다(스키마가 `min(1)`로 강제). 작은 작업도 work item을 만들되, agent가 요청에서 최소 acceptance criteria 1개를 자동 도출하고 사용자에게 묻지 않는다. 따라서 모든 작업은 work item과 completion contract를 남긴다.

### 6.2 Question Gate Contract

목적: 불필요한 질문과 책임 전가형 질문을 막는다.

질문 전 판단:

```json
{
  "question": "사용자에게 하려는 질문",
  "why_needed": "왜 사용자만 답할 수 있는가",
  "self_answer_attempts": [
    {
      "source": "code|docs|repo-artifact|web|memory",
      "result": "찾은 근거 또는 실패 이유"
    }
  ],
  "decision": "ask|do_not_ask|answer_with_assumption|deep_interview",
  "risk_if_not_asked": "구현 결과가 어떻게 달라지는가"
}
```

질문 허용 조건:

- 답이 코드, 문서, 설정, 로그, 웹, 기존 지식에서 확인되지 않는다.
- 질문에 대한 답이 결과를 실질적으로 바꾼다.
- 질문이 도메인 의미, 제품 가치, 되돌리기 어려운 결정에 해당한다.
- 한 번에 1개 질문을 우선한다. deep interview mode만 예외적으로 구조화된 질문 흐름을 갖는다.

금지 질문:

- "이대로 진행할까요?"
- "다음에 무엇을 할까요?"
- "A와 B 중 무엇으로 구현할까요?" 단, 제품 가치 판단이면 허용된다.
- 코드/문서에서 확인 가능한 사실 질문
- 최초 의도 밖의 추천 작업을 진행할지 묻는 질문

### 6.3 Deep Interview Contract

목적: 사용자가 명확히 말하지 못한 의도와 실패 가능성을 필요한 만큼만 수집한다.

진입 조건:

- acceptance criteria를 만들 수 없다.
- 요구가 제품/도메인 의미에 의존한다.
- 구현 방향이 두 개 이상이고 결과가 크게 달라진다.
- premortem상 되돌리기 어려운 위험이 있다.

산출물:

```text
.ditto/work-items/<id>/interview.md
.ditto/work-items/<id>/premortem.md
```

규칙:

- 질문은 한 번에 하나씩 한다.
- 각 질문은 "답에 따라 무엇이 달라지는지"를 포함한다.
- 사용자가 답하지 않아도 되는 구현 세부사항은 agent가 판단한다.
- 인터뷰가 끝나면 `IntentContract`를 갱신하고 사용자에게 짧게 동기화한다.

### 6.4 Delegation Contract

목적: main agent context rot을 줄이고, 전문 subagent가 fresh context에서 일하게 한다.

subagent 입력:

```json
{
  "work_item_id": "wi_example1234",
  "role": "researcher|planner|implementer|reviewer|verifier|architect|e2e",
  "objective": "이 subagent가 달성할 좁은 목표",
  "allowed_files": [],
  "forbidden_files": [],
  "allowed_tools": [],
  "forbidden_actions": [],
  "context_packet": "짧은 맥락",
  "acceptance_criteria_refs": ["AC-1"],
  "output_contract": "아래 형식"
}
```

subagent 출력:

```json
{
  "status": "pass|partial|fail|blocked",
  "summary": "짧은 결론",
  "evidence": [
    {
      "type": "file|command|test|browser|doc|log",
      "ref": "path or command id",
      "result": "pass|fail|unknown"
    }
  ],
  "changed_files": [],
  "risks": [],
  "next_required_action": "none|verify|handoff|ask_user"
}
```

규칙:

- main agent는 큰 탐색/리뷰/검증을 직접 하지 않는다.
- subagent에는 최소 정보만 준다.
- subagent 결과는 summary가 아니라 evidence pointer와 함께 저장한다.
- reviewer/verifier는 Write/Edit 권한을 기본적으로 갖지 않는다.

### 6.5 One-Shot Orchestration Contract

목적: 큰 범위 작업을 "한 phase씩 처리"하지 않고 하나의 사용자 의도 안에서 끝까지 완수한다.

저장 위치:

```text
.ditto/work-items/<id>/orchestration.json
.ditto/work-items/<id>/orchestration.md
```

필드:

```json
{
  "mode": "one_shot",
  "root_goal": "사용자가 요청한 전체 목표",
  "completion_boundary": "entire_work_item",
  "approval_gate": {
    "status": "pending|approved|not_required|rejected",
    "source": "user|approved_spec|issue|prd|small_reversible_policy",
    "evidence_refs": []
  },
  "internal_checkpoints": [
    {
      "id": "CP-1",
      "name": "내부 checkpoint",
      "purpose": "왜 필요한가",
      "owner": "main|subagent role",
      "status": "pending|running|passed|failed|blocked",
      "acceptance_refs": [],
      "evidence_refs": []
    }
  ],
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
  ]
}
```

규칙:

- v0에서는 orchestration 1개가 work item 1개에 대응한다. child work item을 만들지 않으며 `completion_boundary`는 그 단일 work item이다.
- 내부 checkpoint는 plan, implement, review, fix, verify, e2e, docs, knowledge update를 포함할 수 있다.
- checkpoint 완료는 사용자에게 보고할 수 있지만, final answer의 근거가 될 뿐 final answer 자체가 아니다.
- 큰 범위 mutation은 approval gate 통과 후 시작한다.
- approval gate 통과 뒤에는 main agent가 checkpoint 사이에서 사용자의 추가 승인을 기다리지 않는다.
- blocker가 생기면 "진행할까요?"가 아니라 어떤 user-owned decision이 필요한지와 가능한 선택의 영향을 설명한다.
- context handoff가 필요해도 orchestration은 같은 `orchestration_id`로 이어진다.
- 큰 작업일수록 subagent-first와 verifier-first 원칙을 강하게 적용한다.
- "이번 turn에서 다 못했다"는 이유만으로 scope를 줄이지 않는다. handoff 또는 continuation artifact로 이어간다.

예시 수락 기준:

```text
요청: "이 설계문서를 구현 완료해줘"

완료는 다음이 모두 닫힐 때만 가능하다.
- schema/contract 구현
- Claude Code plugin skeleton 구현
- hooks manifest와 최소 hook 동작 구현
- deep-interview/verify/handoff skill skeleton 구현
- fixture와 테스트 추가
- verifier가 acceptance criteria별 evidence를 남김
- 문서와 inventory 갱신
```

### 6.6 Dialectic Deliberation Contract

목적: 결정, 검토, 제안 작성, 문서 작성, 산출물 검증에서 모델의 자기 확신을 깨고, 작은 정반합 토론으로 더 강한 합의안을 만든다.

사용 시점:

- 중요한 설계문서, 제안서, PRD, ADR, 연구보고서 작성 또는 개정
- 기존 산출물 리뷰와 승인/수정/기각 판단
- 기술/제품 결정의 대안 검토
- 사용자에게 제시할 recommendation 생성
- 큰 one-shot orchestration의 plan/checkpoint 검증
- 구현 전 architecture decision 검증
- final answer 전에 high-impact recommendation을 검증해야 할 때

기본 구조:

```text
Producer
  -> 사용자의 의도와 근거를 바탕으로 초안 또는 기존 산출물의 최선 해석을 만든다.

Opponent
  -> 초안의 약한 가정, 빠진 대안, 모호한 문장, scope creep, 검증 부족을 공격한다.

Synthesizer
  -> Producer와 Opponent를 모두 검토하고, 근거 있는 합의안/수정안/보류 판단을 만든다.
```

저장 위치:

```text
.ditto/work-items/<id>/reviews/dialectic-<n>.json
.ditto/work-items/<id>/reviews/dialectic-<n>.md
```

입력:

```json
{
  "mode": "create|review|decision|proposal|document|final-answer",
  "target_artifact": "path or inline brief",
  "question": "무엇을 합의해야 하는가",
  "intent_refs": ["intent.json"],
  "acceptance_refs": ["AC-1"],
  "evidence_refs": [],
  "constraints": {
    "scope_guard": [],
    "non_goals": [],
    "review_budget": "small|standard|thorough",
    "max_rounds": 1
  },
  "model_policy": {
    "producer": "claude-sonnet|claude-opus|current-host",
    "opponent_preferred": "codex",
    "opponent_fallback": ["claude-opus", "claude-sonnet"],
    "synthesizer": "claude-opus|claude-sonnet"
  }
}
```

단일 skill 원칙:

- canonical skill은 `/ditto:dialectic` 하나다.
- `/ditto:dialectic-review`, `/ditto:proposal-review`, `/ditto:decision-review` 같은 이름은 만들 수 있지만 모두 `/ditto:dialectic --mode <mode>`의 얇은 alias여야 한다.
- mode가 달라도 핵심 3역 구조와 산출물 schema는 같다. 도구가 늘어나면 사용자는 언제 무엇을 써야 하는지 다시 배워야 하므로 v0에서는 하나의 범용 skill을 우선한다.

Mode별 해석:

| Mode | Producer | Opponent | Synthesizer |
|---|---|---|---|
| `create` | 새 초안 작성 | 누락/약점 공격 | 최종 초안 작성 |
| `review` | 기존 산출물의 최선 해석 | 결함/위험/검증 공백 공격 | 승인/수정/기각 판단 |
| `decision` | 선호 결정과 근거 제시 | 대안과 실패 가능성 제시 | 결정, tradeoff, 조건 정리 |
| `proposal` | 제안서 작성 | 반대 논리와 채택 장애물 제시 | 사용자 제출용 제안 생성 |
| `document` | 문서 구조/초안 작성 | 독자 관점의 혼란과 빠진 근거 제시 | 최종 문서 개정안 생성 |
| `final-answer` | 답변 초안 작성 | 과장/추측/근거 부족 공격 | 사용자에게 낼 최종 답변 작성 |

모델 라우팅:

- Producer는 기본적으로 현재 Claude Code host 또는 Claude Sonnet을 사용한다. 고위험 결정이나 전략 문서는 Claude Opus를 사용할 수 있다.
- Opponent는 Codex 사용 가능 시 Codex를 우선 사용한다. 목적은 모델 다양성으로 같은 Claude 계열 context/스타일의 공통 맹점을 깨는 것이다.
- Codex CLI, 인증, 네트워크, 비용, runtime 상태 때문에 Codex를 사용할 수 없으면 Opponent는 Claude Opus, 그 다음 Claude Sonnet 순서로 fallback한다.
- Synthesizer는 Claude Opus 또는 Sonnet을 사용한다. Synthesizer는 Opponent 의견을 자동 채택하지 않고, Producer/Opponent 양쪽의 근거를 evidence 기준으로 채택/기각한다.
- 멀티 모델 disagreement는 곧바로 진실이 아니다. disagreement는 추가 evidence 수집 또는 명시적 tradeoff 기록의 trigger다.
- Opponent가 Codex로 실행된 경우 artifact에는 provider, model, command, timestamp, 실패/fallback 여부를 남긴다.
- 외부 provider 호출은 raw CLI를 직접 조립하지 않고 wrapper/bridge를 통해 실행해 `.ditto` evidence와 연결한다. 이 Opponent bridge는 격하된 `run with`(§3.3)를 재사용하지 않는 별도 v0 설계 항목이다.

Producer 출력:

```json
{
  "position": "초안 또는 기존 산출물을 지지하는 최선의 주장",
  "proposal": "구체적 제안/수정안",
  "evidence": [],
  "assumptions": [],
  "known_limits": []
}
```

Opponent 출력:

```json
{
  "objections": [
    {
      "severity": "critical|major|minor",
      "claim": "무엇이 문제인가",
      "evidence": [],
      "failure_mode": "실패하면 어떤 일이 생기는가",
      "required_fix": "합의 전에 필요한 최소 수정"
    }
  ],
  "missing_alternatives": [],
  "scope_creep_risks": [],
  "verification_gaps": []
}
```

Synthesizer 출력:

```json
{
  "verdict": "accept|revise|reject|blocked",
  "synthesis": "합의된 최종안",
  "accepted_objections": [],
  "rejected_objections": [
    {
      "objection": "반대 의견",
      "reason": "왜 채택하지 않는가",
      "evidence": []
    }
  ],
  "required_edits": [],
  "remaining_open_questions": [],
  "evidence_refs": []
}
```

규칙:

- Producer, Opponent, Synthesizer는 서로 다른 context/agent로 실행한다.
- Opponent는 예의상 반대하지 않는다. 실제 실패 가능성, 빠진 대안, 검증 부족만 제기한다.
- Synthesizer는 중간값을 내는 역할이 아니다. 근거가 약한 반론은 기각하고, 근거가 강한 반론은 반드시 최종안에 반영한다.
- 반론은 파일/라인, 문서 근거, 사용자 의도, acceptance criteria 중 하나와 연결되어야 한다.
- 한 번의 소규모 토론을 기본으로 한다. 무한 debate를 만들지 않는다.
- critical objection이 남으면 산출물은 `accept`가 될 수 없다.
- 기존 산출물 검증에서는 Producer가 "기존 산출물의 strongest defensible interpretation"을 먼저 만든다. 그래야 Opponent가 strawman을 공격하지 않는다.
- 새 제안 작성에서는 Producer가 초안을 만들고, Opponent가 공격하고, Synthesizer가 최종 제안서를 작성한다.
- 이 계약은 작성 품질 검증용이다. 실제 코드 동작 검증은 `EvidenceContract`, `Verifier`, `E2EJourneyContract`를 추가로 통과해야 한다.

DITTO에서의 기본 호출:

```text
/ditto:dialectic --mode review <artifact-or-question>
```

`/ditto:dialectic-review`는 위 호출의 alias일 뿐 별도 skill이 아니다.

적용 예:

```text
요청: "이 설계문서가 괜찮은지 검토하고 최종 제안으로 정리해줘"

1. Producer: 설계문서의 의도, 장점, 핵심 제안을 정리한다.
2. Opponent: 놓친 요구, 과한 범위, 구현 위험, 검증 공백을 찾는다.
3. Synthesizer: 채택할 반론과 기각할 반론을 나누고 최종 개정안을 만든다.
```

### 6.7 Evidence Contract

목적: 모든 주장과 완료 판정을 fresh evidence에 묶는다.

허용 evidence:

- 테스트 결과
- build 결과
- lint/typecheck 결과
- Playwright/Chromium 브라우저 결과
- 실행 로그
- 코드 diff
- 파일/라인 위치
- 공식 문서 또는 소스 링크
- reviewer/verifier report

저장 위치:

```text
.ditto/work-items/<id>/evidence/
  commands.jsonl
  tests.md
  browser.md
  reviews/
  logs/
  screenshots/
```

규칙:

- "될 것이다"는 evidence가 아니다.
- `evidence_required`의 `test|diff|browser|doc|log` 같은 어휘는 요구사항 hint다. 실제 `evidenceRef.kind`로 저장할 때는 기존 enum인 `command|file|artifact|url|note`로 접는다. 예: test/build/lint/typecheck는 `command`, screenshot/trace/browser artifact는 `artifact`, doc link는 `url`, repo file/diff/log file은 `file`, 짧은 검증 메모는 `note`.
- 과거 실행 결과는 stale로 표시한다. freshness는 `evidenceRef`를 직접 키우지 않고 sidecar `EvidenceRecord`로 감싼다(아래).
- 명령을 실행하지 못했으면 이유와 남은 위험을 남긴다.
- final answer는 evidence summary만 포함하고 큰 로그는 path로 참조한다.

Evidence freshness와 portability:

raw artifact(`.ditto/runs/`, logs, screenshots, traces, 대용량 출력)는 계속 gitignore로 둔다. 대신 **커밋 가능한 evidence ledger**와 freshness/portability metadata를 둬서 "증거가 있다"와 "이 clone/세션에서 raw를 열 수 있다"를 분리한다. evidence 전체를 커밋 대상으로 전환하지는 않는다.

- `evidenceRef`(`src/schemas/common.ts`) schema 자체는 바꾸지 않는다. freshness/portability는 이를 감싸는 sidecar `EvidenceRecord`에 둔다.
- 커밋 대상은 raw artifact가 아니라 ledger다: `.ditto/work-items/<id>/evidence-index.json` 또는 `completion.json`의 evidence refs 확장.
- raw artifact가 없으면 `artifact_available: false`와 `portability: "local-artifact"`로 명시한다. 증거의 존재와 접근 가능성은 별개다.

`EvidenceRecord` (sidecar):

```json
{
  "ref": { "kind": "command", "command": "npm test", "summary": "passed" },
  "captured_at": "2026-05-26T00:00:00.000Z",
  "freshness": "fresh|stale",
  "stale_reason": null,
  "portability": "committed|local-artifact",
  "artifact_available": true,
  "exit_code": 0,
  "key_lines": []
}
```

규칙:

- raw artifact 경로만 두지 않는다. summary, sha256/hash, 실행 명령, exit code, 중요 라인을 ledger에 남겨 raw 없이도 판단 가능하게 한다.
- 다른 clone/세션에서 raw가 없으면 `artifact_available: false`로 표시하고 ledger의 요약/hash/exit code로 판정한다.
- `freshness=stale`이면 `stale_reason`을 남기고, 재검증 전에는 완료 근거로 쓰지 않는다.

### 6.8 Completion Contract

목적: 검증 없이 완료라고 말하지 못하게 한다.

완료 판정:

```json
{
  "schema_version": "0.1.0",
  "work_item_id": "wi_example1234",
  "declared_by": "verifier",
  "declared_at": "2026-05-26T00:00:00.000Z",
  "summary": "사용자 요청 범위의 변경과 검증이 완료되었다.",
  "changed_files": ["src/example.ts"],
  "acceptance": [
    {
      "criterion_id": "AC-1",
      "verdict": "pass",
      "evidence": [
        {
          "kind": "command",
          "command": "npm test",
          "summary": "passed"
        }
      ]
    }
  ],
  "verifications": [
    {
      "command": "npm test",
      "exit_code": 0,
      "evidence": {
        "kind": "command",
        "command": "npm test",
        "summary": "passed"
      }
    }
  ],
  "unverified": [],
  "remaining_risks": [],
  "final_verdict": "pass"
}
```

`completion.json`의 evidence는 raw artifact 경로만 두지 않는다. 각 evidence에 summary, 실행 명령, exit code, sha256/hash, 중요 라인을 남겨 raw 없이도 판정 가능하게 한다. raw가 없는 환경에서는 `EvidenceRecord.artifact_available=false`로 표시한다(6.7).

verifier는 read-only이므로 완료를 **판정**만 하고, `completion.json` 기록(write)은 main agent가 대행한다. `declared_by`는 파일 작성자가 아니라 판정 주체(verifier)를 가리킨다.

Stop hook 규칙:

- `final_verdict=pass`인데 unverified criteria가 있으면 완료를 막고 handoff 또는 verify를 요구한다.
- `work-item.status=done`은 `completion.json`의 `final_verdict=pass` 뒤에만 가능하다.
- `final_verdict`가 `partial|fail|unverified`이면 `next_handoff_path`와 work item `re_entry`를 요구한다.
- 사용자가 명시적으로 scope를 줄인 경우에는 `out_of_scope`와 결정 근거를 남긴다.
- 작업이 partial이면 final answer에서 partial이라고 말해야 한다.

### 6.9 Handoff Contract

목적: context window, 세션 종료, 다른 agent 전환 이후에도 이어받게 한다.

저장 위치:

```text
.ditto/work-items/<id>/handoff.md
```

필수 내용:

- 원래 사용자 의도
- 현재 상태
- 이미 한 결정
- 변경 파일
- 검증 evidence: raw artifact가 아니라 인라인 요약/hash/실행 명령/exit code로 렌더링한다. 다음 세션이 raw artifact 없이도 판단할 수 있어야 한다.
- 실패/미검증 항목
- 다음 agent가 가장 먼저 확인할 것
- 금지할 scope creep

raw artifact가 이 clone/세션에 없으면 handoff에 `artifact_available: false`로 표시하고, ledger의 요약/hash/exit code로 대체 판단하게 한다.

Context threshold:

- 60%는 기본 휴리스틱일 뿐 계약 숫자가 아니다.
- 1차 trigger는 provider-independent signal이다: `PreCompact`, 큰 artifact 누적, 장기 작업 checkpoint 종료, handoff policy 위반 위험.
- provider가 정확한 context 사용률을 제공하면 configurable threshold의 기본값으로 60%를 사용할 수 있다.
- handoff는 완료가 아니다. `CompletionContract`와 별개다.

### 6.10 Knowledge Contract

목적: 하네스 사용 중 생긴 프로젝트 지식을 누적하고 재사용한다.

저장 위치:

```text
.ditto/knowledge/
  CONTEXT.md
  glossary.json
  decisions/
  patterns/
  project-map.md
```

규칙:

- runtime log와 durable knowledge를 섞지 않는다.
- 합의된 용어만 glossary로 승격한다.
- 기술 결정은 근거와 변경 조건을 남긴다.
- knowledge update는 `KnowledgeCurator` subagent 또는 `/ditto:knowledge-update` skill이 수행한다.
- Claude memory에는 projection만 넣고 원본은 `.ditto/knowledge`에 둔다.

## 7. Claude Code Integration

### 7.1 Plugin layout

v0 skeleton 구조 (Milestone 0~2):

```text
.claude-plugin/
  plugin.json
hooks/
  hooks.json
  user-prompt-submit.mjs
  stop.mjs
  pre-compact.mjs
  post-tool-use.mjs
skills/
  deep-interview/SKILL.md
  plan/SKILL.md
  verify/SKILL.md
  dialectic/SKILL.md
  dialectic-review/SKILL.md   # /ditto:dialectic --mode review alias
  handoff/SKILL.md
agents/
  researcher.md
  planner.md
  implementer.md
  reviewer.md
  verifier.md
  dialectic-producer.md
  dialectic-opponent.md
  dialectic-synthesizer.md
commands/
  deep-interview.md
  verify.md
  dialectic.md
  dialectic-review.md
  handoff.md
```

post-v0 placeholders (Milestone 3~6, v0 skeleton에는 빈 placeholder로만 둔다):

```text
skills/
  e2e/SKILL.md
  knowledge-update/SKILL.md
  review-architecture/SKILL.md
agents/
  architect.md
  security-reviewer.md
  playwright-e2e.md
  knowledge-curator.md
commands/
  e2e.md
  knowledge-update.md
.mcp.json          # MCP bridge는 post-v0 보조 integration
bridge/
  mcp-server.cjs
```

v0에서는 marketplace-ready packaging보다 local plugin install(`claude --plugin-dir`)과 repo-local dogfooding을 우선한다. post-v0 표면은 v0 skeleton에 실제 SKILL/agent 본문 없이 빈 placeholder 또는 미생성 상태로 두고, 해당 Milestone에서 채운다.

### 7.2 Hook design

| Hook | DITTO 역할 | 실패 정책 |
|---|---|---|
| `UserPromptSubmit` | 사용자 입력 분류, 질문 억제, deep interview 필요성 판단, work item 연결 | 구현 오류는 fail-open, 정책 판단은 advisory로 시작 |
| `SessionStart` | active work item, project context, glossary, pending handoff 요약 주입 | fail-open |
| `PreToolUse` | 위험 명령, 비밀 파일, scope 밖 파일 접근 점검 | 보안 위험은 block 가능 |
| `PostToolUse` | command/test/log evidence 수집, work item progress 갱신 | fail-open, evidence missing 경고 |
| `PostToolUseFailure` | 실패 evidence 기록, 반복 실패 감지 | fail-open |
| `SubagentStart` | delegation record 생성 | fail-open |
| `SubagentStop` | subagent output contract 검사, evidence pointer 저장 | contract 위반은 warning 또는 re-run 요구 |
| `PreCompact` | handoff/checkpoint 작성 | fail-open, 단 handoff missing 경고 |
| `Stop` | completion gate, question gate, handoff required 판정 | 완료 위반은 continue 요구 가능 |
| `SessionEnd` | knowledge projection, stale work item 상태 정리 | fail-open |

정책:

- hook implementation error는 사용자의 Claude Code session을 깨뜨리지 않는다.
- completion violation은 error가 아니라 "아직 완료가 아니다"라는 workflow signal이다.
- security/sensitive-file violation만 강하게 block할 수 있다.

### 7.3 Skill design

DITTO는 plugin으로 배포되므로 skill/command는 plugin namespace 아래 로드된다. Claude Code plugin skill은 항상 `/<plugin-name>:<skill>` 형태로 namespacing된다(공식 문서). 따라서 v0 노출 표면은 `/ditto:<command>`다.

| Skill | v0 | 목적 | 산출물 |
|---|---|---|---|
| `/ditto:deep-interview` | v0 | 의도와 premortem 수집 | `interview.md`, `premortem.md`, updated `intent.json` |
| `/ditto:plan` | v0 | acceptance criteria 기반 실행 계획 | `plan.md` |
| `/ditto:verify` | v0 | 독립 검증 | `completion.json`, `reviews/verifier.md` |
| `/ditto:dialectic` | v0 | 생성자/반대자/합의자 3역 범용 토의와 합성 | `reviews/dialectic-<n>.md`, optional revised artifact |
| `/ditto:dialectic-review` | v0 | `/ditto:dialectic --mode review` alias | `reviews/dialectic-<n>.md` |
| `/ditto:handoff` | v0 | 세션 전환용 문맥 생성 | `handoff.md` |
| `/ditto:e2e` | post-v0 | Playwright user journey 검증 | `evidence/browser.md`, screenshots |
| `/ditto:knowledge-update` | post-v0 | 프로젝트 지식 승격 | `.ditto/knowledge/*` |
| `/ditto:review-architecture` | post-v0 | Deep Module/agent-friendly code review | `reviews/architecture.md` |

Skill 작성 원칙:

- SKILL 본문은 절차와 출력 계약을 포함한다.
- 큰 설명을 항상 context에 넣지 않는다.
- command wrapper는 skill 본문을 읽으라는 얇은 shim으로 둔다.
- skill이 다른 skill을 무단으로 chain하지 않는다. 다만 one-shot orchestration 안에서는 `orchestration.json`에 내부 checkpoint로 기록하고 계속 진행한다.
- unnamespaced UX(`/deep-interview` 등)를 원하면 plugin이 아니라 standalone `.claude/commands` 표면이 필요하다. 이는 post-v0 후보로만 기록하고 v0는 plugin namespace로 통일한다.

### 7.4 Subagent design

| Agent | 기본 권한 | 책임 |
|---|---|---|
| `researcher` | read-only | 코드/문서/웹 근거 조사 |
| `planner` | read-only | plan과 risk/premortem 작성 |
| `implementer` | write allowed | 좁은 scope의 코드 변경 |
| `dialectic-producer` | read-only or docs write | 초안 작성 또는 기존 산출물의 strongest defensible interpretation 작성 |
| `dialectic-opponent` | read-only | Codex 우선 반대 의견, premortem, 빠진 대안, 검증 공백 제시 |
| `dialectic-synthesizer` | docs write allowed | producer/opponent 결과를 합성해 최종 제안/개정안 작성 |
| `reviewer` | read-only | diff와 acceptance criteria 검토 |
| `verifier` | read-only + test execution | fresh evidence 수집과 완료 판정 |
| `architect` | read-only | Deep Module, interface, dependency 방향 검토 |
| `security-reviewer` | read-only | secret, permission, injection, supply chain 검토 |
| `playwright-e2e` | browser/test execution | 실제 사용자 여정 검증 |
| `knowledge-curator` | docs write allowed | 합의된 지식 승격 |

기본 규칙:

- 구현 agent와 검증 agent는 분리한다.
- 생성자, 반대자, 합의자는 같은 agent/context가 겸임하지 않는다.
- reviewer/verifier는 Write/Edit을 기본 금지한다.
- subagent는 맡은 범위 밖 제안을 `follow_up_candidates`로만 남긴다.
- main agent는 subagent output을 그대로 믿지 않고 evidence pointer를 확인한다.

## 8. 저장 구조

DITTO 상태는 repo-local `.ditto/`에 둔다.

```text
.ditto/
  config.toml
  work-items/
    <work-id>/
      work-item.json
      intent.json
      intent.md
      interview.md
      premortem.md
      orchestration.json
      orchestration.md
      plan.md
      progress.md
      decisions.md
      handoff.md
      completion.json
      evidence-index.json
      delegations/
        <delegation-id>.json
      evidence/
        commands.jsonl
        tests.md
        browser.md
        reviews/
          dialectic-<n>.md
          dialectic-<n>.json
        logs/
        screenshots/
  knowledge/
    CONTEXT.md
    glossary.json
    decisions/
    patterns/
    project-map.md
  hooks/
    runtime-log.jsonl
```

분리 원칙:

- `work-item.json`: authoritative state
- `intent.*`: 사용자 의도와 scope
- `orchestration.*`: 큰 범위 작업의 one-shot graph와 내부 checkpoint
- `evidence-index.json`: 커밋 가능한 evidence ledger(요약/hash/exit code/freshness/portability). 다른 clone/세션에서 raw 없이 판단하게 한다.
- `evidence/*`: 완료 주장의 raw 근거. `.ditto/runs/`와 함께 gitignore 대상이며 portability는 `local-artifact`다.
- `handoff.md`: 다음 세션을 위한 view
- `knowledge/*`: work item을 넘어 재사용할 지식
- `hooks/runtime-log.jsonl`: debugging용 runtime log, knowledge가 아니다.

## 9. User Experience

사용자는 기본적으로 자연어로 작업한다. DITTO는 필요한 경우에만 skill을 드러낸다.

기본 UX 규칙:

- 작은 요청은 바로 처리한다.
- 큰 요청은 기본적으로 one-shot orchestration으로 끝까지 처리한다.
- 모호하지만 낮은 위험이면 합리적으로 판단하고 진행한다.
- 결과가 달라지는 고위험 모호함만 질문한다.
- 질문은 한 번에 하나만 한다.
- 질문에는 판단에 필요한 context와 왜 묻는지가 포함되어야 한다.
- 사용자가 답하지 않아도 되는 절차 결정은 agent가 책임진다.
- 내부 checkpoint 완료를 사용자에게 다음 단계 승인 요청으로 바꾸지 않는다.
- final answer는 완료 여부와 검증 여부를 분리한다.

노출 command는 최소화하고 plugin namespace로 통일한다.

```text
v0:
/ditto:deep-interview
/ditto:verify
/ditto:handoff
/ditto:dialectic
/ditto:dialectic-review

post-v0:
/ditto:e2e
/ditto:knowledge-update
```

나머지는 자연어와 hook routing으로 처리한다.

## 10. E2E 테스트 설계

웹 서비스 검증은 code-level test와 별도다. DITTO의 E2E 도구는 실제 브라우저에서 사용자 여정을 검증해야 한다.

초기 `playwright-e2e` agent 책임:

- dev server 실행 또는 기존 URL 확인
- Playwright/Chromium으로 사용자 스토리 수행
- screenshot, trace, console error, network failure 수집
- accessibility-critical interaction 확인
- 실패 시 재현 절차와 artifact path 기록

E2E contract:

```json
{
  "journey": "사용자 여정 이름",
  "url": "테스트 대상",
  "steps": [],
  "assertions": [],
  "result": "pass|fail|blocked",
  "artifacts": {
    "screenshots": [],
    "trace": null,
    "console": null
  }
}
```

v0의 E2E executor는 MCP가 아니다. 브라우저 검증은 직접 Playwright/Chromium command와 artifact capture로 수행한다.

MCP는 실행 경로가 아니라 후속 integration 후보로만 둔다. 예를 들어 외부 테스트 관리 도구의 metadata를 읽는 bridge는 가능하지만, 사용자 여정 검증 자체를 MCP server에 위임하지 않는다.

## 11. 코드베이스 품질 원칙

DITTO 자체 구현은 agent가 잘못된 코드를 만들기 어렵게 설계되어야 한다.

원칙:

1. public interface는 좁게 유지한다.
2. 구현은 깊게 둔다.
3. shallow abstraction과 single-use abstraction을 피한다.
4. schema와 contract를 먼저 고정한다.
5. 각 module은 agent가 이해할 수 있는 책임 이름을 가진다.
6. mutation gate를 하나로 모은다.
7. generated artifact와 source artifact를 구분한다.
8. docs inventory와 실제 plugin/skill/agent 파일 목록을 CI로 비교한다.
9. DITTO의 completion contract를 DITTO 개발에도 적용한다.

초기 core interface:

| Interface | 책임 |
|---|---|
| `WorkItemStore` | work item state 읽기/쓰기 |
| `IntentContract` | goal/scope/criteria schema |
| `QuestionGate` | 질문 필요성 판정 |
| `OrchestrationStore` | one-shot orchestration graph와 checkpoint state |
| `DialecticReviewStore` | 생성자/반대자/합의자 리뷰 결과와 최종 synthesis 저장 |
| `OpponentModelRouter` | Codex 우선 반대자 라우팅과 Claude fallback 기록 |
| `EvidenceStore` | evidence artifact 등록 |
| `DelegationStore` | subagent delegation 기록 |
| `CompletionGate` | 완료 판정 |
| `HandoffWriter` | handoff artifact 생성 |
| `KnowledgeStore` | durable project knowledge |
| `ClaudePluginBridge` | Claude hook/skill/plugin integration |

## 12. 구현 Milestone 계획

이 절의 milestone은 DITTO 자체를 개발하는 순서다. 사용자의 실제 작업을 한 단계씩 끊어 처리하겠다는 뜻이 아니다. DITTO가 실행하는 사용자 작업은 가능한 한 `OneShotOrchestrationContract`를 따른다.

v0 범위는 Milestone 0, Milestone 1, Milestone 2의 최소 skeleton까지다. Milestone 3 이후는 v0 이후 hardening/확장으로 분리한다. 따라서 "v0 완료"는 모든 hook/skill/subagent/E2E/project-management 표면의 완성을 뜻하지 않는다.

### Milestone 0: 문서와 contract

목표:

- 설계 문서 확정
- 기존 work item/completion/evidence schema 매핑 확정
- intent/question/orchestration/dialectic/handoff sidecar schema
- dialectic review schema
- opponent model routing policy
- Claude plugin skeleton 계획

완료 기준:

- contract fixture가 있다.
- 예시 work item이 있다.
- 예시 dialectic review artifact가 있다.
- verifier가 fixture를 판정할 수 있다.

### Milestone 1: Claude Code plugin skeleton

목표:

- `.claude-plugin/plugin.json`
- hooks manifest
- `/ditto:deep-interview`, `/ditto:verify`, `/ditto:handoff` skill skeleton
- `/ditto:dialectic` skill skeleton
- `/ditto:dialectic-review` alias skeleton
- `UserPromptSubmit`와 `Stop` hook 최소 동작

완료 기준:

- Claude Code session에서 plugin이 로드된다(`claude --plugin-dir`).
- `claude plugin validate`가 plugin manifest와 표면을 통과한다.
- surface inventory가 plugin root(`skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.claude-plugin/plugin.json`)까지 스캔한다. 현재 어댑터는 repo `.claude/`와 home `~/.claude/`만 보므로 plugin root 스캔을 추가한다.
- hook이 work item을 찾거나 생성한다.
- Stop hook이 unverified completion을 감지한다.

### Milestone 2: One-shot orchestration skeleton

목표:

- `orchestration.json` schema
- plan approval gate
- checkpoint graph 생성
- checkpoint 간 자동 continuation
- fixable failure 재시도 정책

완료 기준:

- approval gate를 통과한 단일 요청에서 plan -> implement -> verify checkpoint가 사용자 개입 없이 이어진다.
- approval이 필요한 큰 mutation은 gate가 `pending`이면 실행하지 않는다.
- 내부 checkpoint 완료만으로 final answer를 보내지 않는다.
- blocker가 생기면 user-owned decision인지 external/system blocker인지 구분한다.

### Milestone 3: Evidence와 verifier

목표:

- `PostToolUse` evidence capture
- verifier subagent output contract
- completion JSON 생성

완료 기준:

- 테스트/빌드/브라우저 명령 결과가 evidence로 남는다.
- verifier가 acceptance criteria별 pass/fail/unverified를 기록한다.

### Milestone 4: Context rot 방지

목표:

- subagent-first delegation packet
- `PreCompact` handoff
- active work item context injection

완료 기준:

- 큰 조사/검증은 subagent로 분리된다.
- handoff만 보고 새 세션이 이어받을 수 있다.

### Milestone 5: Playwright E2E

목표:

- `/ditto:e2e` skill
- `playwright-e2e` agent
- browser artifact capture

완료 기준:

- 실제 웹 사용자 여정을 브라우저로 검증한다.
- screenshot/trace/console 결과가 evidence에 연결된다.

### Milestone 6: Knowledge와 project management

목표:

- `.ditto/knowledge` 승격 workflow
- GitHub Issues/Projects bridge
- 문서/메신저 integration 후보 조사

완료 기준:

- 반복 지식이 work item을 넘어 재사용된다.
- backlog/issue update가 evidence와 연결된다.

## 13. 위험과 대응

| 위험 | 대응 |
|---|---|
| hook 복잡도가 커짐 | v0 hook은 UserPromptSubmit/Stop/PreCompact/PostToolUse에 제한한다. |
| 자동 질문 억제가 필요한 질문까지 막음 | `QuestionGate` decision과 risk를 evidence로 남기고 deep interview escape를 둔다. |
| one-shot orchestration이 너무 큰 작업을 무리하게 계속함 | plan approval gate, checkpoint별 budget, blocker 분류, handoff continuation을 두되 root goal은 임의 축소하지 않는다. |
| 내부 checkpoint가 다시 phase-by-phase 사용자 작업으로 변질 | checkpoint 완료는 final answer가 아니며 `CompletionContract`가 전체 work item 기준으로만 닫히게 한다. |
| persistent Stop이 사용자 종료를 방해 | explicit cancel/user abort/rate limit/auth error/context failure는 즉시 우회한다. |
| subagent가 context 없이 엉뚱한 결론 | delegation packet에 allowed scope와 output contract를 강제한다. |
| evidence ledger가 noise가 됨 | 큰 로그는 artifact로 두고 요약/path/hash만 context에 올린다. |
| knowledge base가 쓰레기 지식으로 오염 | 합의된 지식만 `knowledge-curator`가 승격한다. |
| Claude Code native 기능 변화 | doctor와 plugin inventory check를 둔다. |
| OMC처럼 문서 drift 발생 | skills/agents/hooks inventory를 자동 검증한다. |

## 14. 설계 수락 기준

이 설계가 DITTO v0 방향으로 수락되려면 다음을 만족해야 한다.

1. 사용자가 자연어로만 작업해도 work item과 completion contract가 남는다.
2. agent가 불필요한 질문을 하기 전에 self-answer 가능성을 검사한다.
3. deep interview는 필요한 경우에만 켜지고 산출물을 남긴다.
4. 구현과 검증은 분리된 agent/role로 수행된다.
5. 산출물/제안은 필요 시 생성자-반대자-합의자 3역 dialectic review를 통과한다.
6. 큰 범위 작업은 하나의 one-shot orchestration으로 계획-구현-검증-수정-완료까지 이어진다.
7. 내부 checkpoint 완료만으로 사용자-facing 완료를 선언하지 않는다.
8. 완료 판정은 acceptance criteria별 evidence와 연결된다.
9. context pressure 또는 중단 시 handoff가 생성되고 같은 orchestration으로 이어진다.
10. (post-v0) Playwright 기반 E2E 검증을 first-class evidence로 저장할 수 있다.
11. (post-v0) 프로젝트 지식은 runtime log가 아니라 durable knowledge로 승격된다.
12. Claude Code native 기능을 얕게 복제하지 않는다.
13. OMC의 강점은 차용하되, 기능 수보다 사용자의 의도 완수와 검증을 우선한다.

1~9, 12, 13은 v0(Milestone 0~2) 수락 기준이다. 10~11은 post-v0(Milestone 5~6) 수락 기준으로, v0 완료 판정에는 포함하지 않는다.

## 15. 다음 구현 후보

가장 먼저 만들 후보는 다음 다섯 개다.

1. `QuestionGate` contract와 fixture
2. `OneShotOrchestrationContract` contract와 fixture
3. `DialecticDeliberationContract` contract와 fixture
4. `CompletionContract` contract와 fixture
5. Claude Code plugin skeleton: `UserPromptSubmit`, `Stop`, `/ditto:deep-interview`, `/ditto:dialectic`, `/ditto:dialectic-review` alias, `/ditto:verify`, `/ditto:handoff`

이 다섯 개가 만들어지면 DITTO는 "Claude Code 위의 프롬프트 모음"이 아니라 "의도와 완료를 검열하는 최소 하네스"가 된다.
