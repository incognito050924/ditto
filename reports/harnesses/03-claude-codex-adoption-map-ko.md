---
title: "Claude Code/Codex 사용 전제 DITTO 적용 분류"
tier: 1
repo: all
last_updated: 2026-06-01
scope: "reports/harnesses/01-anthropic-engineering-survey.md와 reports/harnesses/02-managed-agents-annotated-ko.md의 제안을 Claude Code와 Codex를 기본 실행 엔진으로 쓰는 전제로 재분류한 적용 문서"
kind: ditto-design
inputs:
  - reports/harnesses/01-anthropic-engineering-survey.md
  - reports/harnesses/02-managed-agents-annotated-ko.md
sources:
  - https://www.anthropic.com/engineering/managed-agents
  - https://www.anthropic.com/engineering/harness-design-long-running-apps
  - https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
  - https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
  - https://www.anthropic.com/engineering/claude-code-auto-mode
  - https://www.anthropic.com/engineering/claude-code-sandboxing
  - https://www.anthropic.com/engineering/building-effective-agents
  - https://code.claude.com/docs/en/configuration
  - https://code.claude.com/docs/en/permissions
  - https://code.claude.com/docs/en/hooks
  - https://code.claude.com/docs/en/sub-agents
  - https://developers.openai.com/codex/cloud
  - https://developers.openai.com/codex/agent-approvals-security
  - https://developers.openai.com/codex/guides/agents-md
  - https://developers.openai.com/codex/subagents
  - https://developers.openai.com/codex/skills
  - https://developers.openai.com/codex/hooks
  - https://developers.openai.com/codex/mcp
---

# Claude Code/Codex 사용 전제 DITTO 적용 분류

## 0. 전제와 결론

이 문서는 DITTO가 초기에는 자체 coding agent runtime을 만들지 않고, Claude Code와 Codex를 기본 실행 엔진으로 사용한다는 전제로 작성한다. 즉 모델 호출, 파일 편집, shell 실행, 권한 prompt, sandbox, subagent 실행, hook lifecycle의 많은 부분은 이미 외부 제품이 제공한다.

따라서 `01-anthropic-engineering-survey.md`와 `02-managed-agents-annotated-ko.md`의 결론을 그대로 모두 구현하면 중복이 생긴다. DITTO가 먼저 구현해야 할 것은 managed-agent runtime 자체가 아니라, 여러 agent 제품 위에서 일관되게 남아야 하는 작업 상태, 검증 증거, handoff, 실행 프로필, provider-neutral contract다.

짧은 결론은 다음이다.

1. DITTO가 직접 구현할 것: task state, run manifest, evidence ledger, handoff artifact, provider profile, instruction sync, completion contract, evaluation report.
2. Claude Code/Codex에 위임하고 DITTO는 설정/검증만 할 것: sandbox, approval, hooks, subagents, skills, MCP, cloud/container execution.
3. 자체 agent loop를 만들 때까지 미룰 것: full `SessionLog` event replay, live `ContextAssembler`, custom sandbox provisioner, model-based approval classifier, full meta-harness.
4. 하지 말 것: Claude Code/Codex의 실행 엔진을 얕게 복제하는 것, 모든 로그를 context에 밀어 넣는 것, `bypassPermissions`류 모드를 기본값으로 삼는 것, 모델별 prompt hack을 core abstraction에 박는 것.

## 1. 현재 제품 경계

### 1.1 Codex가 이미 제공하는 것

2026-05-22 확인 기준 Codex는 다음 표면을 제공한다.

- Codex web은 cloud 환경에서 코드를 읽고, 수정하고, 실행하며, background/parallel task를 수행할 수 있다.
- Codex cloud는 OpenAI-managed container를 사용하고, setup phase와 agent phase를 분리한다. agent phase는 기본적으로 network off이며, cloud secret은 setup 후 제거되는 구조로 설명된다.
- Codex CLI/IDE는 OS-level sandbox를 사용하며, 기본적으로 network off와 workspace write 제한을 둔다.
- sandbox mode와 approval policy를 분리해 제어한다. 즉 "기술적으로 가능한 것"과 "사용자 승인이 필요한 것"이 별도 계층이다.
- `AGENTS.md`를 global/project/nested scope로 읽고, root에서 current directory 방향으로 병합한다.
- Codex subagents는 명시적으로 요청했을 때 specialized agents를 병렬로 spawn하고 결과를 합친다. child agent는 parent sandbox policy를 상속한다.
- Codex skills는 progressive disclosure 방식으로 `name`, `description`, path만 먼저 보고, 필요할 때 `SKILL.md` 전체를 읽는다.
- Codex hooks는 `SessionStart`, `PreToolUse`, `PostToolUse` 같은 lifecycle 지점에서 동작한다. 다만 `PreToolUse`는 guardrail이지 완전한 enforcement boundary가 아니며 intercept 범위가 제한된다.
- Codex MCP는 CLI/IDE에서 third-party tools/context를 붙이는 표면이며, config는 `config.toml`에 저장된다.

### 1.2 Claude Code가 이미 제공하는 것

2026-05-22 확인 기준 Claude Code는 다음 표면을 제공한다.

- `CLAUDE.md`, settings JSON, skills, MCP servers, plugins로 instructions와 tool behavior를 구성한다.
- permission rule은 모델이 아니라 Claude Code가 enforcement한다. prompt나 `CLAUDE.md`는 의도를 형성할 뿐 권한을 바꾸지 않는다.
- permission mode는 `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions` 등을 제공한다. `bypassPermissions`는 isolated container/VM 같은 환경에서만 써야 하는 위험 모드로 설명된다.
- `.env`, `secrets/**` 같은 민감 파일은 `permissions.deny`로 read/search를 차단할 수 있다.
- hooks는 session, turn, tool call, subagent, compaction, worktree 등 다양한 lifecycle에 붙을 수 있다.
- subagents는 별도 context, tool restriction, model, permission mode, memory, background 실행, worktree isolation 등을 가질 수 있다.
- subagent는 verbose output을 main context에서 분리하고 summary만 돌려주는 용도에 적합하다고 문서화되어 있다.
- plugin system은 skills, agents, hooks, MCP servers를 배포 단위로 묶는다.

### 1.3 DITTO가 끼어들 위치

이 제품 경계 때문에 DITTO의 초기 위치는 "agent engine"이 아니라 "agent work orchestration layer"다. DITTO는 Claude Code/Codex가 만든 결과를 감싸서 다음을 보장해야 한다.

- 어떤 목표를 처리했는지
- 어떤 agent/profile로 실행했는지
- 어떤 파일과 명령이 실제로 영향을 받았는지
- 어떤 검증을 실행했고 결과가 무엇인지
- 무엇이 미검증인지
- 다음 session이 어디서 이어받을 수 있는지
- provider가 바뀌어도 남는 공통 상태가 무엇인지

## 2. 분류 기준

| 분류 | 의미 | 판단 기준 |
|---|---|---|
| Apply now | DITTO가 직접 구현한다. | Claude Code/Codex가 제공하지 않거나, provider마다 흩어져 있어 DITTO가 소유해야 일관성이 생기는 상태/증거/계약이다. |
| Delegate and verify | Claude Code/Codex 기능을 사용하고, DITTO는 설정 생성, 점검, 결과 수집만 한다. | 외부 제품이 더 깊고 안전하게 제공하는 실행 기능이다. 다시 만들면 얕은 복제가 된다. |
| Defer | 자체 runtime이나 API-level agent loop가 필요해질 때까지 미룬다. | 지금 만들면 사용되지 않거나 vendor 기능과 충돌한다. 단, interface 방향은 문서로 남긴다. |
| Avoid | 의도적으로 하지 않는다. | 보안 위험, context rot, shallow abstraction, 운영 복잡도만 늘리는 선택이다. |

## 3. Apply now: DITTO가 직접 적용할 것

### 3.1 Provider-neutral task state와 handoff artifact

분류: Apply now.

원천 아이디어:
- `01`의 long-running harness, context reset, evaluator split, structured note-taking.
- `02`의 "session은 context window가 아니다", "장기 작업은 structured handoff다".

적용할 것:
- DITTO task마다 machine-readable state와 human-readable progress를 남긴다.
- vendor transcript를 원본으로 신뢰하지 않고, DITTO가 소유하는 최소 task ledger를 둔다.

권장 산출물:

```text
.ditto/tasks/<task-id>/
  task.json
  progress.md
  decisions.md
  evidence/
    commands.jsonl
    tests.md
    screenshots/
    logs/
  handoff.md
```

`task.json` 최소 필드:

```json
{
  "id": "2026-05-22-example",
  "goal": "사용자가 검증 가능한 말로 요청한 목표",
  "status": "planned|running|blocked|done|abandoned",
  "provider": "codex|claude-code|manual|mixed",
  "agent_profile": "default|reviewer|evaluator|explorer",
  "acceptance_criteria": [],
  "changed_files": [],
  "verification": [],
  "open_risks": [],
  "handoff": "handoff.md"
}
```

이점/효과:
- compaction, resume, provider 전환 이후에도 작업 목표와 근거가 사라지지 않는다.
- 사용자는 "대화가 길어져서 잊었다"가 아니라 `handoff.md`와 evidence를 보고 이어받을 수 있다.
- Codex와 Claude Code의 transcript 형식이 달라도 DITTO의 작업 상태는 유지된다.

왜 DITTO가 직접 해야 하는가:
- Claude Code와 Codex는 각자 transcript와 session 상태를 갖지만, cross-provider handoff contract를 보장하지 않는다.
- 장기 작업의 핵심은 대화 이어가기보다 다음 실행자가 읽을 artifact다.

왜 이 방식인가:
- full append-only event stream은 지금 과하다. 대신 task/run/evidence 단위의 얇은 ledger를 먼저 두면 실제 워크플로에서 필요한 필드가 드러난다.
- Markdown만 쓰면 기계 처리가 약하고, JSON만 쓰면 사람이 읽기 어렵다. 둘을 나누는 것이 DITTO 목적에 맞다.

### 3.2 Run manifest와 evidence ledger

분류: Apply now.

원천 아이디어:
- `01`의 agent eval, infrastructure noise, postmortem, SWE-bench scaffold 평가.
- `02`의 완료 조건: test/eval 명령, 실패 로그, risk, artifact pointer.

적용할 것:
- 각 agent 실행을 `run`으로 기록한다.
- 실행 전후 git 상태, provider, profile, cwd, command, 주요 설정, 검증 결과를 남긴다.

권장 산출물:

```text
.ditto/runs/<run-id>/
  manifest.json
  prompt.md
  stdout.log
  stderr.log
  diff.patch
  result.md
  eval.md
```

`manifest.json` 최소 필드:

```json
{
  "run_id": "uuid-or-timestamp",
  "task_id": "linked-task-id",
  "started_at": "ISO-8601",
  "finished_at": "ISO-8601",
  "provider": "codex|claude-code",
  "entrypoint": "cli|web|ide|manual",
  "model": "unknown-or-reported",
  "profile": "safe-default",
  "cwd": "/absolute/path",
  "git_head": "sha",
  "dirty_before": true,
  "dirty_after": true,
  "commands": [],
  "verification": [],
  "unverified": []
}
```

이점/효과:
- 품질 저하가 생겼을 때 model, prompt, hook, permission, sandbox, infra 중 어디가 바뀌었는지 추적할 수 있다.
- 테스트 통과/실패를 final answer의 수사로 남기지 않고 artifact로 남긴다.
- 병렬 실행과 리뷰에서 "누가 무엇을 근거로 판단했는가"가 분리된다.

왜 DITTO가 직접 해야 하는가:
- vendor transcript는 각 제품 UI와 lifecycle에 묶인다.
- DITTO의 목적은 여러 실행 엔진을 바꿔 써도 같은 품질 기준과 handoff를 유지하는 것이다.

왜 이 방식인가:
- 모든 tool event를 완전 재현하려고 시작하면 구현 비용이 커진다.
- run manifest는 낮은 비용으로 postmortem과 eval에 필요한 최소 evidence를 만든다.

### 3.3 Completion contract

분류: Apply now.

원천 아이디어:
- `01`의 Claude Code best practices, evaluator split, demystifying evals.
- `02`의 evidence-based completion.

적용할 것:
- DITTO가 종료 응답 또는 run result에 필수 필드를 요구한다.

필수 필드:

- 변경 요약
- 변경 파일
- acceptance criteria별 상태
- 실행한 검증 명령과 결과
- 검증하지 못한 항목
- 남은 risk
- 다음 session handoff 위치

이점/효과:
- "수정했다"와 "검증했다"를 분리한다.
- 사용자가 바로 판단할 수 있는 정보가 남는다.
- evaluator/reviewer agent가 같은 형식을 읽고 후속 검증을 할 수 있다.

왜 DITTO가 직접 해야 하는가:
- Claude Code와 Codex는 좋은 final answer를 만들 수 있지만, repository-level invariant로 강제하지 않는다.
- DITTO의 차별점은 agent의 말투가 아니라 완료 주장의 증거화다.

왜 이 방식인가:
- natural language final answer만으로는 자동 평가와 handoff가 어렵다.
- 너무 복잡한 report schema는 agent가 지키기 어렵다. 위 필드가 최소선이다.

### 3.4 Instruction bridge: AGENTS.md, CLAUDE.md, project rules 동기화

분류: Apply now.

원천 아이디어:
- `01`의 skills, best practices, prompt/policy drift.
- `02`의 stable interface와 model별 보정 versioning.

적용할 것:
- DITTO의 canonical project guidance를 한 곳에서 관리하고, Codex/Claude Code가 읽는 형태로 투영한다.
- Codex는 `AGENTS.md`를 읽는다.
- Claude Code는 `CLAUDE.md`, `.claude/rules/`, settings, skills, plugins를 읽는다.

권장 방식:

```text
AGENTS.md                         # repo-wide canonical working charter
CLAUDE.md                         # Claude Code adapter, AGENTS.md의 핵심만 반영
.claude/settings.json             # 공유 가능한 최소 permission/plugin 설정
.claude/agents/ditto-reviewer.md  # 선택적 reviewer/evaluator agent
.codex/config.toml                # trusted project에서만, 최소 설정
```

이점/효과:
- Codex와 Claude Code가 서로 다른 instruction 파일을 읽어도 같은 작업 기준을 갖는다.
- instruction drift를 `ditto doctor instructions` 같은 검사로 잡을 수 있다.
- 새 agent session마다 사용자가 같은 운영 규칙을 반복 설명하지 않아도 된다.

왜 DITTO가 직접 해야 하는가:
- Codex와 Claude Code의 instruction discovery 규칙은 다르다.
- repository의 행동 헌장과 작업 규칙은 DITTO가 관리해야 하는 제품 contract다.

왜 이 방식인가:
- runtime prompt injection으로 매번 넣는 것보다 native instruction discovery를 쓰는 편이 안정적이다.
- 단, 각 제품별 adapter 파일에는 전체 철학 문서를 복붙하지 않는다. provider가 실제로 지켜야 할 짧은 규칙만 둔다.

### 3.5 Provider profile과 wrapper

분류: Apply now.

원천 아이디어:
- `01`의 postmortem, sandboxing, auto mode, infrastructure noise.
- `02`의 provider보다 상위 interface가 먼저라는 주장.

적용할 것:
- raw `codex`/`claude` 호출을 DITTO wrapper로 감싼다.
- wrapper는 provider-specific flag를 숨기기 위한 목적이 아니라, 실행 전후 상태와 evidence를 남기기 위한 목적이다.

권장 profile:

| Profile | 용도 | Codex/Claude 설정 방향 |
|---|---|---|
| `read-only` | 조사, 리뷰, 계획 | no write, no network 기본 |
| `workspace-write` | 일반 구현 | workspace write, network off 기본 |
| `networked` | dependency/docs 필요 작업 | domain allowlist 또는 명시적 approval |
| `reviewer` | 독립 검증 | read-only 우선, write/edit 금지 |
| `isolated` | 위험 작업 | container, worktree, VM, cloud task |

이점/효과:
- 같은 "리뷰해줘" 요청이 provider마다 다른 권한으로 실행되는 문제를 줄인다.
- run manifest에 profile이 남아 postmortem이 쉬워진다.
- DITTO는 model provider가 아니라 작업 mode를 중심으로 UX를 만들 수 있다.

왜 DITTO가 직접 해야 하는가:
- Codex와 Claude Code는 각각 권한 설정을 갖지만, DITTO의 task type과 acceptance criteria를 알지 못한다.
- provider별 flag를 사용자가 기억하게 만들면 DITTO의 인지 비용 절감 목표와 충돌한다.

왜 이 방식인가:
- DITTO가 sandbox를 직접 만들지 않고 native permission/sandbox를 호출하면 깊은 보안 구현을 재사용할 수 있다.
- wrapper는 얇아야 한다. 실행 엔진을 재작성하지 않는다.

### 3.6 Evaluator lane과 reviewer subagent contract

분류: Apply now.

원천 아이디어:
- `01`의 generator/evaluator split, self-evaluation 과신 문제.
- `02`의 evaluator를 generator와 분리하라는 결론.

적용할 것:
- DITTO는 구현 agent와 검증 agent를 분리하는 role contract를 제공한다.
- Claude Code에서는 custom subagent나 `--agent`를 활용한다.
- Codex에서는 명시적 subagent 요청과 profile prompt를 활용한다.
- reviewer/evaluator는 기본적으로 read-only 또는 제한된 permission을 쓴다.

Reviewer output contract:

```text
Verdict: pass|partial|fail|unverified
Evidence:
- command/result or file/path reference
Findings:
- severity, file, reason
Unverified:
- what was not checked and why
Recommended next action:
- concrete next step
```

이점/효과:
- 작성자가 자기 산출물을 과하게 좋게 평가하는 문제를 줄인다.
- main context에 긴 로그를 넣지 않고 evaluator가 필요한 증거만 요약해 돌려줄 수 있다.
- frontend/UX 작업에서는 screenshot, DOM, browser automation evidence를 별도 lane에 남길 수 있다.

왜 DITTO가 직접 해야 하는가:
- subagent 실행 자체는 제품이 제공하지만, 어떤 role이 어떤 evidence를 남겨야 하는지는 DITTO의 품질 계약이다.

왜 이 방식인가:
- 처음부터 full multi-agent scheduler를 만들 필요가 없다.
- native subagent를 쓰면 context isolation과 permission restriction을 바로 얻는다.

### 3.7 Context packet generator

분류: Apply now, 단 live `ContextAssembler`가 아니라 handoff용 context packet으로 제한.

원천 아이디어:
- `01`의 effective context engineering, structured notes, MCP/code execution.
- `02`의 context는 append가 아니라 selection이라는 결론.

적용할 것:
- DITTO가 새 agent run을 시작하기 전에 필요한 context packet을 만든다.
- 이 packet은 provider prompt에 들어갈 짧은 작업 설명과 artifact pointer를 포함한다.

권장 구성:

```text
context-packet.md
  1. Current goal
  2. Acceptance criteria
  3. Current git state
  4. Relevant files
  5. Last failure
  6. What not to touch
  7. Evidence and artifact pointers
  8. Expected output contract
```

이점/효과:
- "최근 N개 메시지"가 아니라 작업에 필요한 최신 evidence만 전달한다.
- agent가 오래된 가정과 최신 실패 로그를 혼동할 가능성을 줄인다.
- provider가 달라도 시작 context의 모양이 일정해진다.

왜 DITTO가 직접 해야 하는가:
- Claude Code/Codex 내부 context assembly는 제품 내부 정책이다.
- DITTO는 적어도 작업 단위의 handoff context를 통제해야 한다.

왜 이 방식인가:
- full token-level ContextAssembler는 자체 model loop가 있어야 의미가 크다.
- 지금은 provider prompt에 넣을 context packet을 만드는 정도가 비용 대비 효과가 좋다.

### 3.8 Skill과 tool catalog의 공통 원천

분류: Apply now.

원천 아이디어:
- `01`의 Agent Skills, Advanced tool use, Writing effective tools.
- Codex skills와 Claude Code plugin/skills 표면.

적용할 것:
- DITTO가 재사용 workflow를 skill 형태로 정의하되, provider별 adapter를 생성한다.
- skill은 progressive disclosure 원칙을 따른다.

권장 구조:

```text
ditto/skills/<skill-name>/
  SKILL.md
  references/
  scripts/
  adapters/
    codex.md
    claude.md
```

이점/효과:
- 반복 workflow가 ad hoc prompt로 흩어지지 않는다.
- provider마다 skill packaging이 달라도 본문 지식은 하나의 원천에서 관리할 수 있다.
- script와 reference를 묶어 deterministic helper를 제공할 수 있다.

왜 DITTO가 직접 해야 하는가:
- DITTO의 작업 방식은 provider보다 오래 살아야 한다.
- provider-specific marketplace나 plugin format에 바로 종속되면 배포와 테스트가 갈라진다.

왜 이 방식인가:
- skills를 runtime core에 넣지 않고 문서/스크립트 package로 두면 유지보수와 검토가 쉽다.
- `description`은 routing metadata로만 쓰고, 실제 절차는 본문에 둔다.

### 3.9 MCP inventory와 tool permission audit

분류: Apply now.

원천 아이디어:
- `01`의 MCP/code execution, tool design, sandboxing.
- Codex/Claude Code의 MCP config와 permission/hook 표면.

적용할 것:
- DITTO는 MCP 서버를 직접 실행하는 proxy부터 만들지 않는다.
- 대신 어떤 MCP가 켜져 있고, 어떤 tool이 side effect를 갖고, 어떤 permission이 필요한지 inventory를 만든다.

권장 doctor checks:

- Codex MCP config 위치와 enabled tools 확인.
- Claude Code MCP servers와 plugin-provided MCP 확인.
- network access가 켜진 profile 탐지.
- destructive tool이 approval 없이 열려 있는지 경고.
- secrets 관련 env var가 MCP child process에 전달되는지 점검.

이점/효과:
- agent가 외부 시스템에 접근하는 표면을 한 곳에서 감사할 수 있다.
- "도구가 많아져서 context와 권한이 모두 흐려지는" 문제를 줄인다.

왜 DITTO가 직접 해야 하는가:
- MCP는 provider별 설정과 설치가 흩어지기 쉽다.
- DITTO의 안전성과 재현성은 tool inventory를 알아야 확보된다.

왜 이 방식인가:
- MCP proxy/vault는 큰 작업이다. 먼저 inventory와 policy audit으로 실제 위험 표면을 본다.

### 3.10 Light parallel coordination

분류: Apply now, 단 명시적 병렬 작업에 한정.

원천 아이디어:
- `01`의 parallel Claudes, multi-agent research, evaluator 분리.
- `02`의 many brains, many hands.

적용할 것:
- 병렬 agent를 항상 켜지 않는다.
- 사용자가 명시하거나 task가 명확히 독립된 경우에만 DITTO가 task split과 result merge contract를 제공한다.

최소 contract:

- parent task id
- child task id
- assigned scope
- forbidden scope
- expected output
- evidence path
- merge owner
- budget/time cap

이점/효과:
- 큰 조사나 독립 리뷰를 빠르게 처리할 수 있다.
- parent context는 child transcript가 아니라 evidence summary만 받는다.

왜 DITTO가 직접 해야 하는가:
- native subagent는 실행을 도와주지만, repository 전체의 task ownership과 merge policy를 보장하지 않는다.

왜 이 방식인가:
- 처음부터 distributed scheduler를 만들면 과하다.
- 파일 기반 task ownership과 git/worktree policy만으로도 많은 충돌을 줄일 수 있다.

## 4. Delegate and verify: native 기능에 위임할 것

### 4.1 Model/tool loop

분류: Delegate and verify.

하지 않을 것:
- DITTO v0에서 Claude Code/Codex의 agent loop를 재구현하지 않는다.
- model response parsing, tool routing, retry loop를 자체 구현하지 않는다.

적용 방식:
- provider wrapper는 `codex` 또는 `claude`를 실행하고 run manifest/evidence를 수집한다.
- DITTO는 exit status, diff, logs, final response, verification result를 기록한다.

이유:
- Claude Code/Codex는 이미 agentic coding loop에 맞춘 UX와 tool integration을 갖고 있다.
- DITTO가 얕게 복제하면 품질, 보안, 유지보수 모두 손해다.

### 4.2 Sandbox와 approval enforcement

분류: Delegate and verify.

하지 않을 것:
- DITTO v0에서 자체 sandbox/container runtime을 만들지 않는다.
- native sandbox를 끄고 DITTO policy만으로 보호하지 않는다.

적용 방식:
- Codex는 sandbox mode, approval policy, network access, network proxy 설정을 사용한다.
- Claude Code는 permission modes, `permissions.deny`, managed settings, PreToolUse hook을 사용한다.
- DITTO는 profile별 기대 설정을 검사하고 위험 조합을 경고한다.

이유:
- sandbox는 OS와 제품 구현의 깊은 영역이다.
- DITTO의 역할은 "이 작업에는 어떤 안전 profile을 써야 하는가"를 정하고 검증하는 것이다.

왜 이렇게 해야 하는가:
- prompt 지시만으로 권한을 통제할 수 없다.
- Claude Code 문서도 permission rule은 모델이 아니라 Claude Code가 enforce한다고 설명한다.

### 4.3 Hooks lifecycle

분류: Delegate and verify.

하지 않을 것:
- 별도 hook framework를 처음부터 만들지 않는다.

적용 방식:
- Claude Code hooks와 Codex hooks를 사용해 session start, pre-tool, post-tool, stop 단계에 DITTO script를 붙인다.
- DITTO hook은 보조 guardrail과 evidence capture로 시작한다.

주의:
- Codex `PreToolUse`는 완전한 enforcement boundary가 아니라고 문서화되어 있다.
- hook을 보안의 유일한 경계로 삼지 않는다.

이유:
- hook은 각 제품 lifecycle에 붙어야 실제 tool call 전후 정보를 얻을 수 있다.
- DITTO가 외부에서 polling하는 방식은 늦고 불완전하다.

### 4.4 Subagent 실행

분류: Delegate and verify.

하지 않을 것:
- DITTO v0에서 자체 subagent process manager를 만들지 않는다.

적용 방식:
- Claude Code custom subagent, background subagent, worktree isolation을 활용한다.
- Codex subagent는 명시적 요청을 통해 사용하고, parent sandbox policy 상속을 전제로 profile을 맞춘다.
- DITTO는 child task contract와 result format만 제공한다.

이유:
- context isolation과 permission inheritance는 native runtime이 더 정확히 안다.
- DITTO는 어떤 일을 어떤 role에게 맡길지, 결과를 어떻게 검증할지를 관리한다.

### 4.5 Skills, plugins, MCP launch

분류: Delegate and verify.

하지 않을 것:
- DITTO v0에서 모든 skill/plugin/MCP loading을 자체 구현하지 않는다.

적용 방식:
- 공통 skill source를 두고 Codex/Claude adapter를 생성한다.
- provider가 지원하는 skill/plugin/MCP mechanism으로 설치한다.
- `ditto doctor`가 활성화 상태, drift, permission, missing dependency를 확인한다.

이유:
- provider-native discovery를 쓰면 agent가 실제 사용할 수 있는 형태와 일치한다.
- DITTO가 직접 tool list를 prompt에 주입하면 context budget을 낭비한다.

## 5. Defer: 자체 runtime까지 미룰 것

### 5.1 Full append-only SessionLog와 replay

분류: Defer.

미루는 이유:
- `02`의 이상적인 session은 원본 event stream이다.
- 하지만 Claude Code/Codex를 실행 엔진으로 쓰는 동안 DITTO가 모든 내부 event를 안정적으로 재현하기 어렵다.

지금 할 것:
- task ledger와 run manifest만 먼저 둔다.
- vendor transcript path나 exported log는 artifact pointer로 남긴다.

나중에 할 조건:
- DITTO가 API-level model loop를 소유하거나, provider transcript schema에 안정적인 public contract가 생길 때.

### 5.2 Live ContextAssembler

분류: Defer.

미루는 이유:
- Claude Code/Codex 내부 context assembly를 DITTO가 직접 통제하지 않는다.
- token-level selection policy를 구현해도 provider runtime에 넣을 방법이 제한적이다.

지금 할 것:
- `context-packet.md`를 생성해 run prompt에 붙인다.
- artifact pointer와 최신 evidence를 정리한다.

나중에 할 조건:
- DITTO가 직접 model call을 수행하거나, provider가 context injection API를 안정적으로 제공할 때.

### 5.3 Custom sandbox provisioner

분류: Defer.

미루는 이유:
- Codex cloud/CLI와 Claude Code가 이미 sandbox, worktree, permission, network control 표면을 제공한다.
- 자체 sandbox는 보안과 플랫폼 호환성이 큰 작업이다.

지금 할 것:
- native sandbox/profile을 검사한다.
- 위험 작업은 provider의 cloud/container/worktree 경로를 사용한다.

나중에 할 조건:
- DITTO가 장기 실행 background workers를 직접 띄우거나, local/remote worker fleet을 운영할 때.

### 5.4 Model-based approval classifier

분류: Defer.

미루는 이유:
- Claude Code auto mode와 Codex approvals가 이미 존재한다.
- DITTO가 별도 classifier를 만들면 "모델이 모델을 감독하는" 구조가 하나 더 생긴다.

지금 할 것:
- deterministic deny rule, native approval, native auto mode, sandbox를 조합한다.
- hook은 obvious destructive command 차단과 evidence capture에 쓴다.

나중에 할 조건:
- DITTO가 enterprise policy product가 되거나, native approval만으로 product requirement를 충족하지 못할 때.

### 5.5 Full meta-harness

분류: Defer.

미루는 이유:
- many brains/many hands 구조는 DITTO가 agent lifecycle을 직접 소유할 때 가치가 크다.
- 지금 만들면 native Codex/Claude lifecycle과 충돌한다.

지금 할 것:
- task id, run id, child task id, result contract만 만든다.

나중에 할 조건:
- 여러 background agents를 DITTO가 직접 queueing, scheduling, budget control, cancellation해야 할 때.

### 5.6 Large benchmark platform

분류: Defer.

미루는 이유:
- `01`은 eval의 중요성을 강하게 말하지만, repo 초기 단계에서 pass@k/pass^k, contamination control, infra normalization까지 갖춘 platform은 과하다.

지금 할 것:
- acceptance criteria별 eval report와 smoke/regression suite만 둔다.
- run manifest에 infra 정보와 provider profile을 남긴다.

나중에 할 조건:
- DITTO 자체 기능이 늘어나고 harness 변경의 품질 영향을 비교해야 할 때.

## 6. Avoid: 적용하지 않을 것

### 6.1 "context를 더 많이 넣으면 해결된다"

피해야 할 이유:
- `01`과 `02` 모두 context를 저장소가 아니라 예산으로 본다.
- 모든 로그와 문서를 parent context에 넣으면 context rot과 attention 분산이 생긴다.

대신:
- artifact pointer, summary, latest evidence만 넣는다.
- 큰 로그 분석은 subagent에게 맡기고 결론/근거/불확실성만 돌려받는다.

### 6.2 `bypassPermissions` 또는 no-sandbox 기본값

피해야 할 이유:
- Claude Code 문서는 `bypassPermissions`를 isolated container/VM 같은 환경에서만 쓰라고 한다.
- Codex도 sandbox mode와 approval policy를 분리해 안전 계층으로 설명한다.

대신:
- default는 read-only 또는 workspace-write + network off.
- network와 destructive action은 명시 profile 또는 approval을 요구한다.

### 6.3 Vendor 제품의 얕은 복제

피해야 할 이유:
- Claude Code/Codex의 hook, subagent, skill, MCP, sandbox를 DITTO가 얕게 복제하면 유지보수 면적만 커진다.
- 제품 기능은 빠르게 바뀐다.

대신:
- native feature를 쓰고, DITTO는 cross-provider contract와 evidence를 소유한다.

### 6.4 모델별 prompt hack을 core abstraction에 넣기

피해야 할 이유:
- `01`의 postmortem과 `02`의 stale harness assumption은 prompt/policy 변경도 품질 회귀를 만든다는 점을 보여준다.

대신:
- prompt와 policy는 versioned file로 두고 run manifest에 기록한다.
- core interface는 provider-neutral하게 유지한다.

## 7. 구현 로드맵

### Phase 0: Contract 먼저 고정

목표:
- 코드를 크게 쓰기 전에 DITTO가 소유할 contract를 정한다.

산출물:
- task schema
- run manifest schema
- completion contract
- reviewer/evaluator output contract
- provider profile matrix

검증:
- 샘플 task/run/eval artifact를 만들고, 사람이 이어받을 수 있는지 확인한다.

왜 먼저인가:
- contract 없이 wrapper부터 만들면 로그와 상태가 곧바로 흩어진다.

### Phase 1: Doctor와 instruction bridge

목표:
- Codex/Claude Code가 같은 작업 규칙을 읽고 있는지 확인한다.

산출물:
- `ditto doctor instructions`
- `ditto doctor permissions`
- `ditto doctor mcp`
- `AGENTS.md`와 `CLAUDE.md` drift check

검증:
- Codex가 active `AGENTS.md`를 인식하는지 확인한다.
- Claude Code `/status`와 settings source를 확인한다.
- dangerous mode, network-on, secrets-read 가능성을 경고한다.

왜 이 순서인가:
- 실행 전 configuration drift를 잡는 것이 postmortem보다 싸다.

### Phase 2: Provider wrapper와 evidence capture

목표:
- raw provider 실행을 DITTO run으로 감싼다.

산출물:
- `ditto run --provider codex --profile workspace-write`
- `ditto run --provider claude --profile reviewer`
- `.ditto/runs/<run-id>/manifest.json`
- stdout/stderr/diff/eval artifact

검증:
- 실행 전후 git state와 changed files가 기록되는지 확인한다.
- 실패한 명령도 evidence에 남는지 확인한다.

왜 이 순서인가:
- wrapper가 있어야 이후 hook, subagent, evaluator 결과를 같은 run id에 묶을 수 있다.

### Phase 3: Evaluator lane과 subagent templates

목표:
- 구현과 검증을 분리한다.

산출물:
- Claude Code `ditto-reviewer` subagent template
- Codex reviewer prompt/profile
- frontend/e2e evaluator checklist
- evidence-only reviewer output format

검증:
- 일부러 결함 있는 diff를 주고 reviewer가 file/line/evidence를 남기는지 확인한다.
- reviewer가 write permission 없이 동작하는지 확인한다.

왜 이 순서인가:
- DITTO의 "완료는 증거로만 말한다"는 가치가 여기서 실제 효과를 낸다.

### Phase 4: Hooks를 통한 guardrail과 자동 기록

목표:
- native lifecycle에 붙어 더 안정적으로 evidence를 수집하고 위험 작업을 차단한다.

산출물:
- PreToolUse policy hook
- PostToolUse evidence hook
- SessionStart context pointer hook
- Stop completion contract checker

검증:
- block해야 하는 command가 차단되는지 확인한다.
- hook이 실패해도 사용자 작업을 불필요하게 망가뜨리지 않는지 확인한다.

왜 이 순서인가:
- hook은 실행 흐름에 깊이 붙으므로, task/run contract가 먼저 있어야 한다.

### Phase 5: Full runtime 여부 재평가

목표:
- DITTO가 자체 agent loop를 가져야 하는지 evidence로 판단한다.

진입 조건:
- native provider로는 context selection, event replay, scheduling, budget control 요구를 만족하지 못한다.
- 여러 provider를 동시에 돌리는 장기 background workflow가 핵심 product가 된다.
- 현재 wrapper/handoff/evaluator만으로는 반복적인 실패가 남는다.

그때 구현할 것:
- append-only `SessionLog`
- live `ContextAssembler`
- custom scheduler/meta-harness
- sandbox provisioner
- policy classifier
- eval platform

## 8. 적용 요약표

| 항목 | 분류 | 적용 방식 | 기대 효과 |
|---|---|---|---|
| Task state/handoff | Apply now | `.ditto/tasks/<id>/task.json`, `progress.md`, `handoff.md` | provider와 context가 바뀌어도 작업 지속 |
| Run manifest/evidence | Apply now | `.ditto/runs/<id>/manifest.json`, logs, diff, eval | 완료 주장과 postmortem 근거 확보 |
| Completion contract | Apply now | 필수 final fields와 Stop/eval checker | 검증/미검증 구분 |
| Instruction bridge | Apply now | `AGENTS.md`, `CLAUDE.md`, drift doctor | Codex/Claude Code 행동 기준 일관화 |
| Provider wrapper | Apply now | safe profiles, env scrub, logs, timeout | raw CLI 실행의 추적성 확보 |
| Evaluator lane | Apply now | reviewer/evaluator subagent contract | 자기평가 과신 감소 |
| Context packet | Apply now | latest evidence 중심 handoff prompt | context rot 감소 |
| Skill catalog | Apply now | 공통 skill source + provider adapter | 반복 workflow 재사용 |
| MCP inventory | Apply now | doctor/audit | tool 권한 표면 가시화 |
| Sandbox/approval | Delegate and verify | native Codex/Claude controls 사용 | 깊은 보안 구현 재사용 |
| Hooks lifecycle | Delegate and verify | native hooks에 DITTO scripts 연결 | lifecycle 기반 evidence capture |
| Subagent execution | Delegate and verify | native subagents 사용 | context isolation 재사용 |
| Full SessionLog replay | Defer | task/run ledger 후 필요 시 확장 | 과잉 구현 방지 |
| Live ContextAssembler | Defer | context packet으로 시작 | provider 내부 정책과 충돌 방지 |
| Custom sandbox | Defer | native sandbox/profile 점검 | 보안 구현 중복 방지 |
| Model approval classifier | Defer | deterministic rule + native approval | 모델 감독 중복 방지 |
| Full meta-harness | Defer | child task contract로 시작 | scheduler 과잉 구현 방지 |

## 9. 결정 이유

이 분류의 기준은 단순하다. Claude Code와 Codex가 이미 깊게 구현한 실행 기능은 재구현하지 않는다. DITTO가 직접 소유해야 할 것은 그 실행 기능 위에 남는 작업의 의미와 증거다.

`01`과 `02`의 핵심은 모델이 아니라 harness가 품질을 만든다는 점이다. 하지만 Claude Code/Codex를 쓰는 동안 DITTO는 harness 전체가 아니다. DITTO는 상위 작업 contract, 상태, 검증, handoff를 맡는 meta-workflow layer다. 이 위치를 지키면 DITTO는 작게 시작하면서도 장기 작업과 cross-provider 운영에 필요한 토대를 남길 수 있다.

반대로 지금 full managed-agent runtime을 만들면 두 문제가 생긴다. 첫째, native provider가 이미 제공하는 기능을 덜 안전하고 덜 깊게 복제하게 된다. 둘째, 실제 사용으로 검증되지 않은 abstraction이 먼저 생긴다. DITTO의 초기 구현은 `boring where possible`, `explicit where it matters`, `recoverable after failure`에 맞아야 한다.

따라서 우선순위는 다음 한 문장으로 정리된다.

DITTO는 Codex/Claude Code를 더 똑똑하게 만드는 것이 아니라, 그들이 한 일을 잃어버리지 않고, 검증 없이 완료라고 말하지 않게 하며, 다음 실행자가 바로 이어받을 수 있게 만드는 계층부터 구현한다.

---

## 최신 확인 / 변경 (2026-06-01 갱신)

### 검토 범위

이 섹션은 2026-06-01 기준으로 upstream 두 저장소를 fresh clone하여 점검한 결과다. Claude Code와 Codex product claim은 단일 pinnable repo가 없어 버전 검증이 불가하므로 별도 처리한다.

| 저장소 | 스냅샷 기준 (문서 작성 시) | 2026-06-01 HEAD | 신규 커밋 수 |
|---|---|---|---|
| `Yeachan-Heo/oh-my-claudecode` (OMC) | 2026-05-22 `f28516c9` (v4.14.x 이전) | `ed7800dd` (v4.14.4) | 28개 |
| `Yeachan-Heo/oh-my-codex` (OMX) | 2026-05-22 `02efaa7b` (v0.18.1 근방) | `ff17267b` (v0.18.7) | 137개 |

### 유지된 사실 (hold)

아래 항목은 이번 검토에서 upstream 변경으로 훼손되지 않았음을 확인했다.

**OMC (oh-my-claudecode v4.14.4)**

- `AGENTS.md`를 global/project scope로 읽고 병합하는 구조: 유지. OMC의 plugin-mode `omx setup`이 symlinked user-scope `AGENTS.md`를 보존하도록 수정되었으나(PR #2477 대응, `92a37bb7`), 이는 기존 discovery 구조가 유지되면서 user 소유 파일을 덮어쓰지 않도록 안전성이 강화된 것이다. DITTO 문서의 주장(3.4절 instruction bridge)에 반하지 않는다.
- `PreToolUse`는 보조 guardrail이며 완전한 enforcement boundary가 아니라는 주장: 유지. OMC docs/HOOKS.md 현행 기준으로도 `pre-tool-enforcer.mjs`는 "Validates rules before tool use"로 기술되며, permission enforcement는 Claude Code runtime이 담당한다는 구조가 변하지 않았다.
- hooks lifecycle이 `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop` 등 주요 지점을 커버한다는 구조: 유지.
- skills progressive disclosure 원칙: 유지. OMC skills 목록(40개)과 OMX skills 목록(46개)이 존재하며 각각 `SKILL.md`로 분리된 구조다.
- `bypassPermissions` 위험 모드 경고: 제품 문서 claim이므로 별도 pin 불가. 아래 참조.

**OMX (oh-my-codex v0.18.7)**

- Codex subagent가 parent sandbox policy를 상속한다는 구조: OMX team/worker 구조에서 유지 확인.
- `AGENTS.md`를 global/project/nested scope로 읽는 구조: 유지 (OMX templates/AGENTS.md 현행 확인).
- skills/hooks가 native Codex lifecycle에 붙는 구조: 유지. `codex-native-hooks.md`의 mapping matrix가 현행 실제 구현과 일치.

### 변경된 사실 (changed)

#### OMC: `ultragoal` 모드가 Stop-blocking 및 PreToolUse enforcement에 추가됨

- 커밋: `567e39ff` (2026-05-25, OMC v4.14.x)
- 변경 내용: `.omc/state/` 기반 Stop continuation 목록에 `ralph`, `autopilot`, `ultrawork` 등 기존 모드에 더해 `ultragoal`이 공식 추가되었다. 더 나아가 `ultragoal` 활성 상태에서는 `PreToolUse` hook이 matching Claude `/goal` snapshot 없이 도구 사용을 차단한다(`pre-tool-enforcer.mjs`).
- DITTO 문서 영향: 4.3절("Codex `PreToolUse`는 완전한 enforcement boundary가 아니라고 문서화되어 있다")은 여전히 Codex product 수준에서 유효하다. 그러나 OMC 수준에서 `$ultragoal` 모드는 PreToolUse를 실질적 blocking gate로 쓰는 패턴이 추가된 것을 인지해야 한다. 이는 "hook을 보안의 유일한 경계로 삼지 않는다"는 DITTO의 원칙과 충돌하지 않지만, OMC의 PreToolUse가 단순 advisory가 아닌 blocking enforcement로도 쓰인다는 구체적 사례다.
- 채택 권고 변화: 없음. DITTO의 "Delegate and verify" 분류는 유지된다. 단, Phase 4 hook 구현 시 OMC `pre-tool-enforcer.mjs`의 blocking 패턴(ultragoal PreToolUse guard)을 참고 구현 사례로 활용할 수 있다는 점을 추가한다.
- 근거: `Yeachan-Heo/oh-my-claudecode` @ `567e39ff` `docs/HOOKS.md`, `scripts/persistent-mode.mjs`, `scripts/pre-tool-enforcer.mjs`

#### OMC: `ralplan` 스킬이 read-only/planning 전용 경계로 강화됨

- 커밋: `b007dfb0` (2026-05-26, OMC v4.14.3)
- 변경 내용: `/ralplan` 실행 시 compact continuation 이후 구현, 파일 편집, 커밋, PR 생성으로 자동 진행하지 않도록 Stop hook이 강화되었다. pending-approval 상태가 terminal phase로 처리된다.
- DITTO 문서 영향: 직접적인 영향 없음. 이는 evaluator lane(3.6절)의 reviewer를 read-only로 제한하는 DITTO 방향과 일치하는 변화다.

#### OMX: `omx explore` 명령이 deprecated 처리됨

- 커밋: `bfbc2cab` (2026-05-25, OMX v0.18.3)
- 변경 내용: `omx explore` 명령이 deprecated 처리되어, 신규 lookup에는 normal Codex repository inspection 또는 `omx sparkshell`을 사용하도록 안내가 변경되었다. 기존 호환성은 유지되나 기본 진입점에서 제거되었다.
- DITTO 문서 영향: 직접 언급 없음. OMX skill catalog 참고 시 `explore` 대신 일반 tool 사용을 전제로 해야 한다.

#### OMX: plugin-scoped Codex hooks 구조 공식화

- 커밋: `92a37bb7` (2026-05-23, OMX v0.18.2)
- 변경 내용: Plugin-mode OMX는 Codex plugin cache를 통해 hooks를 등록하며(`plugins/oh-my-codex/.codex-plugin/plugin.json` → `./hooks/hooks.json`), setup-owned `hooks.json`은 legacy/fallback 경로가 되었다. `omx doctor`가 plugin cache를 먼저 확인한 후 missing OMX coverage를 판단하도록 변경되었다.
- DITTO 문서 영향: 4.3절(Hooks lifecycle: Delegate and verify) 및 4.5절(Skills/plugins/MCP: Delegate and verify) 방향과 일치. DITTO의 `ditto doctor` 구현 시 OMX의 plugin-scoped hook validation 패턴을 참고할 수 있다.
- 근거: `Yeachan-Heo/oh-my-codex` @ `92a37bb7` `src/cli/doctor.ts`, `src/config/generator.ts`, `docs/codex-native-hooks.md`

#### OMX: OMX `$team` 스킬에 lightweight coordination protocol 추가

- 커밋: `d2100490` (2026-05-28, OMX v0.18.7)
- 변경 내용: `$team` 스킬이 Task Big Five + ATEM-inspired coordination gate를 도입했다. 독립 fan-out은 기존 경량 프로토콜을 유지하되, 의존성/공유 파일/handoff가 있는 경우 coordinated protocol(shared mental model, closed-loop ACK, 경계 감시, backup 행동, 적응 체크포인트)을 활성화한다.
- DITTO 문서 영향: 3.10절(Light parallel coordination) "parent context는 child transcript가 아니라 evidence summary만 받는다"는 주장과 일치. OMX의 coordination protocol이 DITTO의 parallel coordination contract 설계 시 참고 구현으로 유효하다.

#### OMX: PreToolUse hook의 Bash-only 제한이 명문화됨

- 문서: `docs/codex-native-hooks.md` (현행 기준, 2026-05-22 이후 갱신)
- 내용: OMX `pre-tool-use` native hook의 현행 scope는 "Bash-only"로 명시되어 있다. 비-Bash tool interception은 `runtime-fallback`으로 분류되어 있다.
- DITTO 문서 영향: 4.3절의 "Codex `PreToolUse`는 완전한 enforcement boundary가 아니다" 주장이 OMX 공식 문서에 의해 추가로 뒷받침됨. Bash 이외 tool에 대한 hook enforcement는 현재도 제한적이다. 이 사실은 DITTO Phase 4(Hooks를 통한 guardrail) 구현 시 범위 제한 근거로 명시해야 한다.

### Claude Code / Codex 제품 claim 처리

아래 항목은 단일 pinnable repo가 없는 제품 수준 claim이라 이전엔 미검증으로 남겼으나, **2026-06-01 공식 문서로 검증 완료**했다(repo commit이 아닌 공식 문서 기준이므로 향후 제품 버전 변경 시 재확인 필요).

- `bypassPermissions` 모드 (1.2절): **검증됨** — "full, autonomous system access without approval prompts. 단 deny rule이 매칭되면 그 도구는 bypassPermissions에서도 차단". 출처: `docs.claude.com/en/docs/claude-code/settings`.
- Claude Code permission mode 목록 (1.2절): **검증됨** — 공식 모드는 `default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`(미승인 시 deny), `auto`(model classifier로 승인/거부)로 보고서 목록과 일치. 출처: `docs.claude.com/en/docs/claude-code/sdk/sdk-permissions`.
- Codex cloud의 setup/agent phase 분리, network off 기본값, cloud secret 제거 (1.1절): **검증됨** — "Setup scripts run with internet access. Agent internet access is off by default" + "Secrets are only available to setup scripts. For security reasons, secrets are removed before the agent phase starts". 출처: `developers.openai.com/codex/cloud/environments`.
- Codex CLI/IDE의 OS-level sandbox, network off 기본값 (1.1절): **검증됨** — workspace-write에서 network는 기본 off(`[sandbox_workspace_write].network_access=true`로만 허용), 기본값은 no network + workspace 한정 write, OS-level sandbox. 출처: `developers.openai.com/codex/concepts/sandboxing`, `developers.openai.com/codex/agent-approvals-security`.

이 항목들은 DITTO의 "Delegate and verify" 전략적 분류 근거로 쓰이는 것이고, 위 공식 문서 검증으로 그 전제가 뒷받침된다.

### 채택 권고 변화 요약

이번 갱신으로 Apply now / Delegate and verify / Defer / Avoid 분류가 바뀐 항목은 없다.

추가된 구현 참고사항:

- **Phase 4 (Hooks)**: OMC `pre-tool-enforcer.mjs`의 ultragoal PreToolUse blocking 패턴을 참고 가능. 단, Bash-only 제한을 인지하고 적용 범위를 명시할 것.
- **Phase 3 (Evaluator lane)**: OMC의 `ralplan` read-only 경계 강화(`b007dfb0`) 패턴이 DITTO reviewer subagent의 write-block 구현 참고가 된다.
- **3.10절 (Light parallel coordination)**: OMX `$team` coordination protocol(`d2100490`)이 DITTO child task contract 설계 시 검증된 참고 구현으로 활용 가능하다.
