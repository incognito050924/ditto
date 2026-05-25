---
title: "Claude Code와 OpenAI Codex Agent Runtime 비교 연구: OMC/OMX 확장성 분석"
kind: research
last_updated: 2026-05-25 KST
scope: "Claude Code, OpenAI Codex CLI/Web, oh-my-claudecode, oh-my-codex"
evidence_level: "공식 문서 + 공개 GitHub 저장소 정적 분석"
---

# Claude Code와 OpenAI Codex Agent Runtime 비교 연구

## 초록

Claude Code와 OpenAI Codex는 둘 다 "LLM agent runtime"이다. 모델에게 단순히 프롬프트를 보내는 클라이언트가 아니라, 로컬 파일시스템, 셸, MCP 도구, 권한 정책, 지시 파일, 훅, 스킬, 서브에이전트, 백그라운드 실행을 하나의 작업 루프로 묶는 실행 환경이다. 따라서 둘의 차이는 "어느 모델이 더 좋은가"보다 "어느 런타임이 어떤 제어면을 제품 내부에 갖고 있고, 어떤 제어면을 외부 하네스가 장악할 수 있는가"에 더 가깝다.

이 연구의 결론은 다음과 같다.

1. Claude Code는 기능이 더 제품화되어 있다. hooks, skills, plugins, subagents, agent teams, memory, permission rules, IDE/web/desktop 연동이 넓고 촘촘하다. 외부 하네스는 강력한 공식 이벤트를 받지만, 런타임의 상태기계와 작업 수명주기는 Anthropic 제품이 소유한다.
2. Codex는 CLI가 공개되어 있고, `AGENTS.md`, TOML 설정, plugin, skill, hook, MCP, subagent 같은 파일 기반 표면이 비교적 직접적이다. 일부 기능은 Claude Code보다 덜 완성되어 있거나 이벤트 범위가 좁다. 그 빈 공간 때문에 OMX 같은 하네스가 자체 상태기계, 팀 런타임, 목표 장부, hook trust, native agent/prompts 설치를 더 많이 소유할 수 있다.
3. "Codex가 더 열려 있어서 확장성이 좋다"는 말은 "Codex가 모든 기능을 더 많이 제공한다"는 뜻이 아니다. 오히려 "덜 제품화된 부분과 공개/파일 기반 계약이 겹쳐서, 외부 런타임 계층이 제품 안쪽의 행위를 재구성하기 쉽다"는 뜻에 가깝다.
4. OMC와 OMX의 차이는 host 차이에서 파생된다. OMC는 Claude Code의 풍부한 native 기능 위에 workflow를 얹는 구조이고, OMX는 Codex의 열린 설정/훅/플러그인 표면과 빈 기능 공간 위에 별도의 control plane을 만드는 구조다.

## 조사 방법과 한계

기준일은 2026-05-25 KST다. 제품 기능은 최근성이 중요하므로 공식 문서를 우선했다. OMC/OMX는 공개 GitHub 저장소를 로컬로 클론하여 정적 분석했다.

분석한 저장소 스냅샷:

| 프로젝트 | 분석 커밋 | 버전/상태 |
|---|---:|---|
| `Yeachan-Heo/oh-my-codex` | `e0465fdc18bfeb67f9f114f7a37835269d35294d` | `oh-my-codex` 0.18.2, 2026-05-23 KST 커밋 |
| `Yeachan-Heo/oh-my-claudecode` | `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f` | `oh-my-claude-sisyphus` 4.14.1, 2026-05-20 KST 커밋 |

한계:

- Claude Code와 Codex의 서버 측 모델 라우팅, 내부 정책 평가, cloud worker orchestration은 공개 문서 밖의 영역이므로 내부 구현이라고 단정하지 않았다.
- "Claude Code에서 Codex로 이탈하는 움직임"은 공개 저장소와 문서의 정성 근거로만 다뤘다. 시장 점유율이나 사용자 이동량을 통계적으로 측정하지 않았다.
- 이 문서는 정적 분석 문서다. 실제 Claude/Codex 유료 세션을 실행하여 hook firing matrix를 재현한 것은 아니다.

## 1. Agent Runtime과 Harness의 작동 모델

LLM agent runtime은 다음 여섯 층으로 구성된다.

1. **Instruction loader**: 사용자 프롬프트 전에 프로젝트 지침, 전역 지침, 플러그인/스킬 설명, 정책을 수집한다.
2. **Planner / policy loop**: 모델이 다음 행동을 계획하고, 도구 호출 후보를 만든다.
3. **Tool broker**: 파일 읽기/쓰기, 셸, MCP, 웹, 이미지, 서브에이전트 같은 도구 호출을 실제 실행 환경에 연결한다.
4. **Approval / sandbox boundary**: 도구 호출이 허용되는지, 사용자 승인이나 자동 리뷰가 필요한지, OS sandbox 안에서 실행되는지 결정한다.
5. **Lifecycle event bus**: session start, prompt submit, pre/post tool, stop, compact, subagent/team event 같은 시점에 외부 코드를 실행하거나 추가 context를 주입한다.
6. **State / handoff layer**: transcript, memory, goal, task queue, worker status, compact 요약, 후속 실행용 파일을 유지한다.

Claude Code와 Codex는 모두 위 구조를 갖는다. OMC/OMX는 제품 런타임 위에 붙는 harness다. harness는 제품이 제공하는 이벤트와 설정 표면을 이용해 "모델이 어떤 절차를 따르게 할지", "언제 멈추지 말아야 할지", "어떤 worker를 띄울지", "검증 증거를 어디에 남길지"를 강제하거나 유도한다.

핵심은 control plane과 data plane의 분리다.

- **Data plane**: 실제 파일 수정, 셸 실행, MCP tool 호출, 코드 검색, 테스트 실행.
- **Control plane**: 작업 분해, 권한 결정, 상태 전이, goal persistence, worker orchestration, hook policy.

Claude Code는 control plane의 많은 부분을 제품 기능으로 제공한다. Codex는 공개 CLI와 파일 기반 설정 덕분에 외부 harness가 control plane을 더 많이 덮어쓸 수 있다.

## 2. Claude Code와 Codex의 공통 특징

| 공통 층 | Claude Code | Codex | 동작상 의미 |
|---|---|---|---|
| 터미널 agent | `claude` CLI가 코드 읽기, 수정, 명령 실행을 수행 | `codex` CLI가 로컬 디렉터리에서 코드 읽기, 수정, 명령 실행을 수행 | 두 제품 모두 "chat UI"가 아니라 로컬 작업 루프를 가진 agent runtime이다. |
| 프로젝트 지침 | `CLAUDE.md`, rules, memory | `AGENTS.md`, override/fallback filenames | 시작 시점에 repo policy를 모델 context에 올린다. 지침 파일은 사실상 lightweight governance layer다. |
| 권한과 sandbox | permission modes, allow/deny/ask, hooks와 결합 | `approval_policy`, `sandbox_mode`, OS sandbox, auto-review | 모델이 생성한 도구 호출은 곧바로 실행되지 않고 broker와 policy를 지난다. |
| hooks | 매우 많은 lifecycle event 제공 | Session/tool/prompt/compact/stop 중심 hook 제공 | 외부 하네스가 context 주입, 차단, 로깅, 상태 갱신을 수행하는 핵심 접점이다. |
| skills | `SKILL.md` 기반, `/skill-name`, progressive loading | `SKILL.md` 기반, `$skill-name`, progressive loading | 큰 절차 지침을 항상 context에 넣지 않고 필요할 때만 로드한다. |
| plugins | `.claude-plugin/plugin.json` 중심 | `.codex-plugin/plugin.json` 중심 | skills, hooks, MCP, app integration을 배포 단위로 묶는다. |
| MCP | 외부 도구와 데이터 연결 | 외부 도구와 데이터 연결 | runtime 내장 도구 바깥의 capabilities를 표준 프로토콜로 확장한다. |
| subagents | 별도 context window의 specialized worker | 별도 context/thread 기반 worker | main context pollution을 줄이고 병렬 탐색을 가능하게 한다. |
| cloud/background | web/desktop/routines/background agents | Codex web/cloud tasks, IDE delegation | 로컬 터미널 밖에서 long-running task를 수행할 수 있다. |
| compaction/session continuity | context window와 compact 관련 hooks/management | context compaction, memory, prompt state | 긴 작업을 지속하려면 요약과 재주입이 필요하다. |

공통 구조만 보면 두 제품은 같은 범주의 도구다. 그러나 "확장성"은 공통 기능의 존재 여부가 아니라, 각 기능의 소유권과 계약 안정성에서 갈린다.

## 3. 제품별 핵심 구조

### 3.1 Claude Code: 제품화된 runtime-first 구조

Claude Code는 공식 문서상 터미널, IDE, desktop, web에서 같은 Claude Code engine을 사용하는 agentic coding tool이다. `CLAUDE.md`, settings, MCP server가 여러 surface에서 공유된다. hooks 문서는 event 종류가 매우 넓고, `PreToolUse`, `PermissionRequest`, `PostToolUseFailure`, `SubagentStart/Stop`, `TaskCreated/Completed`, `TeammateIdle`, `ConfigChange`, `FileChanged`, `WorktreeCreate/Remove`, `SessionEnd` 등 세밀한 lifecycle point를 제공한다.

이 설계의 장점은 다음과 같다.

- 하네스가 굳이 모든 상태기계를 새로 만들지 않아도 된다.
- subagent, agent team, memory, plugin, skill, permission rule이 제품 안에서 서로 맞물린다.
- hook이 permission system, task/team system, skill/plugin system과 같은 vocabulary를 공유한다.

반대로 확장 한계도 명확하다.

- runtime 내부 상태는 Anthropic 제품이 소유한다.
- 외부 하네스는 문서화된 이벤트와 설정 key 밖의 동작을 안정적으로 바꾸기 어렵다.
- native team/task/goal이 이미 있으면, 외부 하네스가 별도 team semantics를 만들 때 제품 semantics와 충돌하거나 중복된다.
- hook event가 풍부한 대신, 하네스는 Claude Code의 permission precedence, skill loading, team storage, shutdown semantics에 맞춰야 한다.

즉 Claude Code는 "완성된 runtime 위에 확장"하는 모델이다.

### 3.2 Codex: 공개 CLI와 파일 기반 control surface

OpenAI Codex CLI는 공식 문서상 로컬 터미널에서 실행되는 coding agent이며, 공개 GitHub 저장소를 가진 Rust 기반 CLI다. `AGENTS.md`는 전역/프로젝트/하위 디렉터리 순서로 로드되고, `config.toml`에서 sandbox, approval, profiles, fallback instruction filename 등을 제어한다. hooks는 TOML/JSON 형태로 설정되며 `PreToolUse`가 Bash, `apply_patch`, MCP 등 일부 도구 호출을 가로챌 수 있고, OS별 sandbox는 macOS Seatbelt, Linux `bwrap`/`seccomp`, Windows sandbox 또는 WSL2 경로로 구현된다.

이 설계의 장점은 다음과 같다.

- CLI가 공개되어 behavior contract를 코드와 문서 양쪽에서 추적할 수 있다.
- TOML 설정과 `AGENTS.md` discovery가 외부 generator와 잘 맞는다.
- plugin, skill, MCP, hook, native subagent 파일을 harness가 설치/갱신/검증하기 쉽다.
- 제품 기능이 아직 덜 풍부하거나 event coverage가 좁은 부분은 외부 harness가 별도 상태기계로 보완할 수 있다.

반대로 복잡도도 커진다.

- plugin mode, setup mode, legacy fallback, runtime mirror, trusted hook hash 같은 호환 계층이 생긴다.
- hook event가 Claude Code보다 좁은 부분은 하네스가 자체 Stop gate, task state, tmux worker lifecycle로 우회해야 한다.
- OS sandbox, approval policy, `--yolo`/danger mode, network policy를 하네스가 정확히 구분해 사용자에게 설명해야 한다.

즉 Codex는 "열린 runtime 주위에 control plane을 더 많이 만들 수 있는" 모델이다.

## 4. 상세 차이점

### 4.1 소스 공개성과 확장 단위

Claude Code는 제품 문서와 plugin/skill/hook API를 통해 확장된다. CLI 자체의 핵심 구현은 공개 저장소 중심으로 분석하는 구조가 아니다. 확장자는 `.claude/`, `.claude-plugin/`, settings, MCP, hooks, skills를 통해 제품이 허용한 방식으로 들어간다.

Codex는 CLI가 공개되어 있고, 공식 문서도 `config.toml`, `AGENTS.md`, hooks, plugins, skills, subagents를 파일 기반으로 설명한다. 외부 하네스는 이 파일들을 생성하고 merge하고, feature flag와 hook trust를 다루고, 사용자의 기존 설정과 충돌하지 않게 조정할 수 있다.

전문가 관점에서 이것은 "extension API"와 "runtime-adjacent integration"의 차이다. Claude Code 확장은 제품 API를 타고 들어간다. Codex 확장은 제품 API와 파일/소스 관찰을 함께 사용한다.

### 4.2 지시 파일 계층

Claude Code의 중심 파일은 `CLAUDE.md`다. 공식 문서는 프로젝트 root의 `CLAUDE.md`가 세션 시작 시 로드되며, auto memory가 세션을 넘겨 학습한 내용을 유지한다고 설명한다. skills와 commands는 절차성 지침을 별도 파일로 분리해 필요 시 로드한다.

Codex의 중심 파일은 `AGENTS.md`다. 공식 문서에 따르면 전역 `~/.codex/AGENTS.md` 또는 override 파일, 프로젝트 root부터 현재 working directory까지의 `AGENTS.md`/override/fallback 파일이 계층적으로 로드된다. `project_doc_max_bytes`와 fallback filename도 설정할 수 있다.

차이는 지시 파일의 사회적 의미다.

- Claude Code의 `CLAUDE.md`는 제품 memory와 skills와 함께 동작하는 "프로젝트 지식 파일"에 가깝다.
- Codex의 `AGENTS.md`는 harness가 orchestration policy를 심기에 더 적합하다. OMX가 `AGENTS.md`를 "orchestration brain/control surface"로 취급하는 이유가 여기에 있다.

### 4.3 권한과 sandbox

Claude Code는 permissions 설정에서 allow/deny/ask rule을 사용하고, `PreToolUse` hook과 permission rule의 precedence가 문서화되어 있다. deny rule은 allow보다 우선하고, blocking hook은 tool call을 멈출 수 있다. Claude Code의 권한 체계는 제품 내부의 tool vocabulary와 강하게 결합되어 있다.

Codex는 `approval_policy`와 `sandbox_mode`가 핵심이다. 예를 들어 `read-only`, `workspace-write`, `danger-full-access`와 `on-request`, `never`, `untrusted` 조합이 있고, 자동 승인 리뷰도 설정할 수 있다. sandbox는 OS별 구현에 내려간다. 이는 하네스 입장에서 장점이자 위험이다. 장점은 설정을 TOML로 seed하거나 profile로 제어하기 쉽다는 점이고, 위험은 `--dangerously-bypass-approvals-and-sandbox` 같은 모드가 하네스 UX에 섞일 때 실제 보안 경계를 사용자가 오해할 수 있다는 점이다.

### 4.4 Hook event model

Claude Code의 hook surface는 매우 넓다. prompt, setup, instruction load, tool pre/post/failure/batch, permission request/denied, subagent start/stop, task create/complete, teammate idle, config change, cwd/file/worktree change, compact, session end까지 포함한다. `PreToolUse`는 Bash, Edit, Write, Read, Glob, Grep, Agent, WebFetch, WebSearch, AskUserQuestion, ExitPlanMode, MCP tool 등을 matcher로 다룰 수 있다.

Codex hooks는 성장 중인 표면이다. 공식 문서는 `PreToolUse`가 Bash, `apply_patch`, MCP tool call 등을 가로챌 수 있지만 guardrail이지 완전한 enforcement boundary는 아니라고 설명한다. 일부 shell path, WebSearch 등은 제한이 있다. `PostToolUse`는 계속/중단 신호와 context 추가를 지원하지만 이벤트 폭은 Claude Code보다 좁다.

OMX 문서가 "proof boundary"를 반복해서 강조하는 이유가 여기 있다. Codex에서 hook 증거, plugin hook 증거, fallback hook 증거, 실제 execution readiness는 서로 다르다. hook 설치가 되었다고 실제 작업 실행이 검증된 것은 아니다.

### 4.5 Skills와 plugins

두 제품 모두 Agent Skills 표준에 가까운 `SKILL.md`를 사용한다. 공통 핵심은 progressive disclosure다. 처음부터 모든 절차 문서를 context에 넣지 않고, 이름/설명/path만 노출한 뒤 관련성이 있을 때 본문을 로드한다.

차이는 invocation vocabulary와 packaging semantics다.

- Claude Code skills는 `/skill-name` 형태가 기본이고, 기존 `.claude/commands`와 통합된다. plugin skill은 namespace를 가진다.
- Codex skills는 공식 문서상 CLI/IDE에서 `/skills`나 `$` mention을 통해 직접 호출할 수 있고, plugin이 installable distribution unit이 된다.

OMC는 Claude Code plugin marketplace와 `.claude-plugin/plugin.json`에 잘 맞춘다. OMX는 `.codex-plugin/plugin.json`을 사용하되, plugin만으로는 부족한 Codex native agent/prompts/config를 `omx setup`이 별도로 설치한다.

### 4.6 Subagents, teams, parallelism

Claude Code subagent는 별도 context window, custom system prompt, tool access, independent permission을 가진 specialized assistant다. agent teams는 실험 기능으로, 여러 Claude Code instance가 shared task list와 mailbox를 통해 협업한다. 공식 문서상 team config와 tasks는 `~/.claude/teams/{team-name}/`와 `~/.claude/tasks/{team-name}/`에 저장된다. 이 기능은 제품 내부 control plane이다.

Codex subagents도 별도 agent workflow를 병렬로 spawn하고 결과를 모으는 구조다. 공식 문서는 subagent가 명시 요청에 의해 spawn되고, sandbox/approval override를 상속한다고 설명한다. 하지만 Claude Code의 agent team처럼 제품화된 shared task list와 mailbox를 외부 하네스가 그대로 제어하는 구조는 아니다.

OMX의 `omx team`은 이 빈 공간에 들어간다. tmux pane, worker CLI 선택, `.omx/state/team`, task claim, lease, mailbox, trigger queue를 자체 구현한다. 그래서 Codex worker뿐 아니라 Claude worker를 섞을 수 있다. 이는 Claude Code native team과 다른 방향의 확장이다. 제품 내부 team을 사용하는 것이 아니라, 제품 CLI들을 worker process로 취급하는 별도 orchestration layer다.

### 4.7 Memory와 durable state

Claude Code는 `CLAUDE.md`와 auto memory가 공식 기능이다. auto memory는 프로젝트별 memory 파일에 학습 내용을 저장하고 `/memory`로 열람/수정할 수 있다. OMC는 여기에 `.omc/` state, notepad, project-memory, plans, research, logs, handoffs를 얹는다.

Codex는 `AGENTS.md`, memories, session context, compaction을 제공한다. OMX는 `.omx/`를 더 적극적으로 사용한다. goal ledger, team state, wiki, trace, memory MCP, task lease 같은 runtime state가 여기에 들어간다. Codex 제품의 state와 별도로 "OMX가 판단 가능한 상태"를 파일로 남기는 구조다.

## 5. "Claude Code에서 Codex로 넘어가는" 이유의 기술적 해석

공개 증거만으로 사용자 이동을 수치화할 수는 없다. 다만 OMC README가 Codex 사용자를 OMX로 안내하고, OMC가 Codex/Gemini MCP server 내장 방식을 제거하고 CLI-first team runtime을 권장한 흔적은 있다. OMX 저장소는 최근 커밋에서 plugin-scoped hooks, strict reviewer/pipeline/ultragoal, setup/doctor/config/hook proof boundary가 크게 확장되어 있다.

기술적으로 이 이동은 다음 이유로 설명된다.

### 5.1 기능이 적어서 더 크게 만들 수 있다

Claude Code는 이미 native 팀, subagent, goal, memory, hooks가 많다. OMC는 이 위에 올라타야 한다. 제품이 team storage와 task semantics를 정하면 OMC는 이를 활용하거나 우회해야 한다.

Codex는 일부 lifecycle과 팀 orchestration이 덜 제품화되어 있다. OMX는 이 빈 공간에 직접 상태기계를 만든다. 이때 하네스가 소유하는 것은 단순한 prompt bundle이 아니라 다음이다.

- Codex config generator
- hook trust/hash/merge policy
- plugin-scoped hook과 fallback hook 이중 경로
- native agent TOML과 prompt 설치/정리
- tmux worker lifecycle
- `.omx/state/team` task lease와 claim token
- goal artifact와 Stop/UserPromptSubmit steering
- first-party MCP server registry

이것이 "Codex는 갖춰진 기능이 없어서 확장성이 좋다"는 말의 기술적 의미다. 완제품 기능이 부족한 만큼, 외부 하네스가 runtime 일부를 다시 구현할 수 있다.

### 5.2 공개 CLI와 파일 기반 설정이 하네스에 유리하다

Codex의 `config.toml`, `AGENTS.md`, `.codex/agents`, `.codex/prompts`, `.codex-plugin/plugin.json`, hooks JSON/TOML은 generator가 다루기 쉬운 표면이다. OMX는 사용자의 기존 설정을 보존하면서 자신이 소유한 block만 merge하고, stale legacy prompt/native-agent 파일을 archive하고, plugin hook 지원 여부에 따라 `.codex/hooks.json`을 제거하거나 fallback으로 남긴다.

Claude Code도 plugin과 settings가 있지만, 제품 기능이 더 많아 외부 하네스가 "runtime shape"를 바꾸기보다는 "제품이 제공한 shape 안에서 workflow를 강화"하는 쪽이 된다.

### 5.3 복잡해지는 이유

Codex/OMX의 자유도는 곧 operational complexity다.

- plugin 설치와 `omx setup` 설치가 다르다.
- 공식 plugin은 skills/MCP/hooks를 배포하지만, setup은 native agents/prompts/config/fallback hooks를 쓴다.
- Codex hook 지원 여부에 따라 plugin-scoped hook, native hook, fallback wrapper가 달라진다.
- hook 설치 증거와 실제 Codex 실행 readiness는 다르다.
- team runtime은 tmux, worker CLI, worktree, mailbox, task locks, lease expiry를 모두 관리해야 한다.
- unsafe mode(`--madmax`, `--yolo` 계열)를 쓰면 sandbox/approval 설명 책임이 하네스에 넘어온다.

따라서 OMX는 더 열려 있지만 더 단순하지 않다. 기능을 제품에 맡기지 않고 하네스가 소유하기 때문에 복잡하다.

## 6. OMC 구조 분석

OMC는 Claude Code를 host로 하는 workflow/plugin/hook 집합이다. 패키지명은 `oh-my-claude-sisyphus`, CLI entry는 `omc`, `omc-cli`, `oh-my-claudecode`로 노출된다. `.claude-plugin/plugin.json`은 다수의 skills, `.mcp.json`, commands를 포함한다.

### 6.1 Hook 중심 workflow injection

OMC의 `hooks/hooks.json`은 Claude Code의 풍부한 lifecycle event를 활용한다.

- `UserPromptSubmit`: keyword detector, skill injector
- `SessionStart`: session start, project memory, wiki startup, setup maintenance
- `PreToolUse`: pre-tool enforcer
- `PermissionRequest`: permission handler
- `PostToolUse`: verifier, memory, rules
- `PostToolUseFailure`: failure handling
- `SubagentStart/Stop`: subagent tracker
- `PreCompact`: compact 전 상태 정리
- `Stop`: context guard, persistent mode, code simplifier
- `SessionEnd`: session/wiki end

이 구조는 OMC가 Claude Code의 native event bus를 깊게 사용한다는 뜻이다. 특히 `Stop` hook의 persistent mode는 "모델이 멈추려 할 때 아직 끝나지 않은 workflow인지"를 검사하고, 계속 작업할지 판단한다.

### 6.2 Keyword detector와 skill routing

OMC의 keyword detector는 단순 문자열 매칭이 아니다. 코드블록, URL, 파일 경로, 인용, 표, XML comment 같은 구조적 noise를 제거하고, keyword가 설명 목적으로 쓰였는지 실행 의도인지 판별한다. `ralph`, `autopilot`, `team`, `ultrawork` 같은 heavy workflow는 작업이 작거나 요구사항이 불충분하면 억제하거나 `ralplan`으로 전환한다.

이것은 하네스가 "사용자 발화를 workflow activation event로 변환"하는 계층이다. Claude Code 자체가 자연어 prompt를 받지만, OMC는 특정 mode를 안전하게 켜기 위해 별도 intent classifier를 둔다.

### 6.3 MCP tool server

OMC는 MCP server에 LSP, AST, Python REPL, trace, state, notepad, memory, shared memory, deepinit, wiki, skills, interop tools를 묶는다. `OMC_DISABLE_TOOLS` 같은 환경 변수로 tool group을 끌 수 있고, interop tools는 opt-in이다.

이것은 Claude Code의 기본 toolset을 domain-specific 도구로 확장하는 data plane이다. hook은 control plane, MCP는 data plane이다.

### 6.4 Team 구조

OMC의 `/team` skill은 Claude Code native agent teams를 전제로 한다. 팀 lead가 `TeamCreate`, `TaskCreate`, `TaskUpdate`, `Task(...)`, `TeamDelete` 같은 Claude Code team affordance를 사용하고, 팀 저장소는 Claude Code가 관리하는 `~/.claude/teams`와 `~/.claude/tasks`가 중심이다.

동시에 README는 `omc team` CLI를 별도 runtime으로 설명한다. 특히 Codex/Gemini/Claude를 실제 tmux worker로 띄우는 mixed worker 전략은 Claude Code native team과 다른 층이다. OMC가 후기에 CLI-first team runtime을 권장한 이유는 Claude Code 내부 팀만으로는 다른 agent runtime을 같은 worker로 자연스럽게 넣기 어렵기 때문이다.

## 7. OMX 구조 분석

OMX는 Codex CLI를 host로 하는 workflow layer다. README는 "Codex가 실제 agent work를 하고, OMX는 role keywords/skills, `.omx/`, setup/runtime을 제공한다"는 mental model을 제시한다. 패키지명은 `oh-my-codex`, CLI는 `omx`다.

### 7.1 Plugin과 setup의 의도적 분리

OMX는 공식 plugin bundle과 `omx setup`을 분리한다.

- plugin: skills, MCP manifest, app metadata, plugin-scoped hooks
- setup: `AGENTS.md` scaffolding/merge, `.codex/config.toml`, native agent TOML, native prompts, fallback hooks, trusted hash, stale artifact cleanup

이 분리는 Codex의 plugin 표면만으로 모든 native surface를 안정적으로 소유하기 어렵기 때문에 생긴다. 공식 plugin은 배포 단위이고, setup은 로컬 Codex runtime shape를 조정하는 installer다.

### 7.2 Codex native hooks와 proof boundary

OMX의 `docs/codex-native-hooks.md`는 hook 지원 범위를 매우 조심스럽게 정리한다. plugin-scoped hook이 가능하면 `.codex-plugin/plugin.json`의 hooks를 사용하고, legacy/fallback 경로에서는 `.codex/hooks.json`과 `[features].hooks` 또는 legacy flag를 사용한다. setup은 trust hash를 기록하고, 사용자 hook을 보존하며, OMX가 소유한 wrapper만 관리한다.

OMX가 밝히는 event gap도 중요하다.

- Bash 중심의 `PreToolUse`/`PostToolUse` 처리
- non-Bash interception 제한
- `PostToolUseFailure`, `SubagentStop`, 별도 ask-user-question event 등은 Claude Code만큼 직접적이지 않음
- `Stop`은 Ralph/autopilot/ultrawork/team/deep-interview/ralplan 일부 workflow에 대해 부분 지원

이 때문에 OMX는 "native Codex hook proof", "OMX plugin proof", "fallback proof", "real execution readiness"를 구분한다. 좋은 하네스 설계다. 설치 증거와 실행 증거를 혼동하지 않는다.

### 7.3 Config generator

OMX의 config generator는 TOML ordering, owned top-level keys, `[features]`, status line preset, MCP server block, default context window, auto compact token limit 등을 관리한다. README에 따르면 fresh GPT-5.5 config seed는 context window 250000, auto compact 200000을 포함한다.

이는 단순 설정 파일 생성이 아니다. Codex runtime의 behavior envelope를 재현 가능하게 만드는 작업이다. 예를 들어 `developer_instructions`에 "AGENTS.md가 orchestration brain/control surface"라는 의미를 넣고, native subagents와 skills discovery 위치를 정리한다.

### 7.4 Team runtime

OMX의 `$team` skill은 "tmux-based parallel mode"다. `omx team`은 팀 config, manifest, task JSON, worker `AGENTS.md`, tmux split, worker CLI launch, readiness wait, inbox/trigger, optional worktree를 생성한다. worker CLI는 Codex, Claude, 또는 map/auto mode로 선택될 수 있다.

상태 저장소는 `.omx/state/team/<team>`이다. task claim은 dependency readiness, worker validation, expected version, lock, claim token, lease expiry를 검사한다. 완료 전이는 allowed transition, claim token, lease, required delegation evidence를 검증한다. 즉 OMX team은 file-backed distributed state machine이다.

이것이 Claude Code native team과 가장 큰 차이다. Claude Code team은 제품 내부 state machine이고, OMC는 그것을 사용한다. OMX team은 제품 CLI를 worker process로 보고, 외부 파일 상태기계로 조정한다.

### 7.5 Workflow chain: deep-interview, ralplan, prometheus-strict, ultragoal

OMX README는 표준 흐름을 `$deep-interview` -> `$ralplan` -> optional `$prometheus-strict` -> `$ultragoal`로 제시한다. 이 흐름은 Codex 모델을 바로 "구현해"로 밀어 넣기보다, 요구사항 명확화, 계획, 엄격 리뷰, 지속 실행을 분리한다.

`$ultragoal`은 Codex native goal 기능을 단순히 대체하는 것이 아니라 `.omx` artifact와 Stop/UserPromptSubmit steering을 조합한 durable workflow다. 문서상 aggregation edit, constraint hard delete, silent mutation 같은 위험한 자동변경을 피하고 구조화된 지시만 반영한다.

## 8. OMC와 OMX의 핵심 차이

| 축 | OMC | OMX |
|---|---|---|
| host runtime | Claude Code | OpenAI Codex CLI |
| 기본 전략 | Claude Code native 기능을 적극 활용 | Codex의 열린 파일/설정 표면 위에 control plane 구성 |
| 배포 | `.claude-plugin/plugin.json`, marketplace 친화 | `.codex-plugin/plugin.json` + `omx setup` 이중 구조 |
| 주 호출 문법 | `/skill`, 자연어 mode trigger | `$skill`, 명시 workflow chain |
| 지시 중심 | `CLAUDE.md`, `.claude/skills`, `.omc/` | `AGENTS.md`, `.codex/skills`, `.omx/` |
| hook 활용 | Claude Code의 매우 넓은 event surface 사용 | Codex hook gap을 fallback/state machine으로 보완 |
| persistent loop | Stop hook persistent-mode가 Claude lifecycle에 깊게 결합 | Stop/UserPromptSubmit/goal artifacts와 `.omx` state로 지속성 구성 |
| team | Claude native agent teams + CLI team runtime 혼재 | `omx team` 자체 tmux/file-state runtime이 중심 |
| MCP | OMC tools server에 LSP/AST/Python/state/memory 등 집약 | `omx_state`, `omx_memory`, `omx_code_intel`, `omx_trace`, `omx_wiki`, `omx_hermes` 등 first-party MCP registry |
| 복잡도 원천 | Claude event와 native workflow에 맞추는 복잡도 | plugin/setup/hook/config/team state를 직접 소유하는 복잡도 |
| 확장성의 성격 | 제품이 제공한 rich API 안에서 확장 | 제품 바깥에 runtime-adjacent layer를 세우는 확장 |

정리하면 OMC는 "Claude Code를 더 똑똑하게 쓰는 layer"이고, OMX는 "Codex 옆에 별도 operator runtime을 세우는 layer"다.

## 9. "Claude Code로는 못하고 Codex에서는 할 수 있다"의 구체적 의미

절대적으로 Claude Code에서 불가능하다는 뜻으로 이해하면 부정확하다. 외부 CLI, tmux, 파일 상태기계를 만들면 Claude Code에서도 많은 것을 우회 구현할 수 있다. 정확한 의미는 다음에 가깝다.

### 9.1 Codex runtime shape를 파일 생성기로 재구성

OMX는 `.codex/config.toml`, `.codex/agents/*.toml`, `.codex/prompts/*.md`, `.codex/hooks.json`, `.codex-plugin/plugin.json`, `AGENTS.md`를 조합해 Codex runtime의 시작 상태를 재구성한다. Claude Code에서도 `.claude/` 설정을 만들 수 있지만, Claude Code의 richer native 기능은 제품 내부 상태와 연결되어 있어 외부 generator가 같은 수준으로 runtime shape 전체를 장악하기 어렵다.

### 9.2 Plugin hook과 setup fallback의 이중 경로

OMX는 Codex가 plugin-scoped hooks를 지원하면 plugin 경로를 쓰고, 아니면 setup-managed fallback hook을 쓴다. 그리고 신뢰 hash와 소유권 marker로 user hook을 보존한다. 이 방식은 제품 feature maturity에 따라 하네스가 runtime integration 전략을 바꾸는 구조다.

Claude Code는 hook surface가 더 성숙하지만, 그만큼 "Claude가 정한 hook semantics"에 종속된다. OMX는 미성숙/변동 표면을 직접 흡수하면서 더 많은 compatibility layer를 갖는다.

### 9.3 Native team이 아니라 CLI들을 worker로 취급

OMX team은 Codex/Claude worker를 같은 tmux/file-state protocol 아래 놓을 수 있다. worker는 꼭 Codex일 필요가 없고, task claim/lease/result evidence는 `.omx/state/team`이 판단한다. Claude Code native team은 Claude Code instances를 중심으로 설계되어 있으며, task list와 mailbox도 Claude 제품 state다.

따라서 "Claude Code로 못한다"는 말은 "Claude Code native team 안에서 Codex를 동등한 worker로 넣거나, 팀 상태기계를 외부에서 완전히 소유하는 것이 자연스럽지 않다"는 뜻으로 해석하는 것이 정확하다.

### 9.4 Artifact-first goal ownership

OMX의 ultragoal은 goal을 제품 내부 세션 상태가 아니라 artifact와 hook steering으로 다룬다. 이 구조에서는 장기 목표를 `.omx` 상태로 남기고, 세션/compact/worker 전환 이후에도 하네스가 goal authority를 복원할 수 있다.

Claude Code에도 goal 기능과 memory가 있지만, 제품 내부 goal semantics를 외부 하네스가 직접 mutate하거나 완전히 대체하는 것은 조심스럽다. OMC 쪽 문서도 artifact-only Ultragoal 같은 표현을 사용한다. 즉 OMC는 Claude의 `/goal`을 직접 장악하기보다 별도 artifact를 둔다.

## 10. 위험과 검증 기준

OMC/OMX류 하네스의 품질은 "멋진 프롬프트가 많다"로 판단하면 안 된다. 다음을 검증해야 한다.

1. **Hook firing evidence**: 원하는 lifecycle event가 실제로 발생했는가.
2. **Execution readiness**: hook 설치가 아니라 실제 Codex/Claude 세션에서 명령이 실행 가능한가.
3. **State transition integrity**: task claim, lease, completion, cancellation이 race 없이 동작하는가.
4. **Permission boundary**: allow/deny/sandbox와 hook 차단이 어떤 precedence로 적용되는가.
5. **User state preservation**: setup이 기존 `.codex`, `.claude`, MCP, hooks를 덮어쓰지 않는가.
6. **Compaction/resume safety**: 긴 작업 후에도 acceptance criteria와 검증 증거가 유지되는가.
7. **Worker cleanup**: tmux/session/worktree가 orphan으로 남지 않는가.

OMX는 이 중 1, 2를 문서에서 명시적으로 분리한다는 점이 강점이다. OMC는 Claude Code의 넓은 hook event와 persistent Stop gate를 활용한다는 점이 강점이다.

## 11. 결론

Claude Code와 Codex는 같은 종류의 agent runtime이지만, 확장성의 방향이 다르다.

Claude Code는 제품이 제공하는 native 기능이 많다. 그래서 OMC는 Claude Code가 제공하는 풍부한 event bus, skills, plugins, subagents, teams, memory, permissions 위에 workflow를 얹는다. 이 구조는 빠르게 강력해지지만, 런타임의 핵심 상태기계는 제품이 소유한다.

Codex는 공개 CLI와 파일 기반 설정 표면이 강하다. 일부 기능은 Claude Code보다 덜 풍부하거나 더 최근에 추가된 상태다. 그래서 OMX는 Codex의 빈 공간에 별도 control plane을 만든다. 이것이 더 열려 있고, Claude Code보다 못 갖춘 기능 때문에 오히려 확장성이 좋아 보이는 이유다. 대가는 복잡도다. plugin/setup/hook/config/team/MCP/state가 모두 하네스의 책임이 된다.

OMC와 OMX를 비교할 때 가장 중요한 질문은 "어느 쪽이 기능이 더 많은가"가 아니다. 질문은 "누가 control plane을 소유하는가"다. OMC에서는 Claude Code가 더 많이 소유한다. OMX에서는 하네스가 더 많이 소유한다.

## 부록 A. 차이점 인벤토리

아래 표는 공개 문서와 저장소 정적 분석으로 확인 가능한 차이를 기능 축별로 정리한 것이다. 제품 내부 구현은 추론으로 단정하지 않았다.

| 축 | Claude Code | Codex | OMC/OMX에 미치는 영향 |
|---|---|---|---|
| CLI 구현 공개성 | 핵심 CLI/runtime 구현은 제품 배포물 중심 | CLI 공개 저장소 존재 | OMX는 source-adjacent integration과 config generation을 더 과감하게 쓴다. |
| 설정 파일 | JSON/settings 중심, `.claude/` 생태계 | TOML 중심, `.codex/` 생태계 | TOML block ownership과 merge marker가 OMX 설계의 핵심이 된다. |
| 프로젝트 지침 discovery | `CLAUDE.md`, memory, skills | `AGENTS.md`, fallback/override filename, 계층 discovery | OMX는 `AGENTS.md`를 orchestration brain으로 삼기 쉽다. |
| permission vocabulary | allow/deny/ask rule과 tool matcher | approval policy + sandbox mode + auto review | OMC는 product permission event에 기대고, OMX는 launch profile과 config seed에 기대는 비중이 크다. |
| sandbox 구현 노출 | product permission model 중심으로 설명 | OS sandbox와 mode 조합이 문서화됨 | OMX는 danger/madmax 같은 launch mode의 실제 위험을 별도 UX로 설명해야 한다. |
| hook event 폭 | prompt, setup, tool, permission, subagent, task, team, compact, session 등 폭넓음 | prompt/tool/compact/stop 중심, 일부 tool/event gap 존재 | OMC는 native hook orchestration, OMX는 fallback/state machine 보완. |
| hook enforcement 성격 | permission system과 강하게 결합 | guardrail 성격이 강하고 일부 path 제한 | OMX가 hook proof와 execution readiness를 분리한다. |
| plugin 역할 | marketplace/plugin이 skills/commands/MCP/hook을 자연스럽게 묶음 | plugin이 있지만 setup이 runtime shape까지 별도 조정 | OMX는 plugin-only 설치와 setup 설치를 의도적으로 나눈다. |
| skill 호출 문화 | `/skill`, natural language trigger와 잘 결합 | `$skill`, explicit workflow chain이 강함 | OMC는 자동 감지/억제 classifier가 중요하고, OMX는 명시 단계 체인이 중요하다. |
| subagent state | Claude Code product state와 연동 | Codex subagent는 독립 workflow/결과 수집 중심 | OMC는 native subagent lifecycle hook을 활용하고, OMX는 external worker/team state를 더 쓴다. |
| team abstraction | native agent teams 존재 | 동등한 mature native team surface는 약함 | OMC는 native team을 활용, OMX는 tmux/file-state team runtime 구현. |
| 다른 agent runtime 혼합 | native team 안에서는 Claude 중심 | CLI process로 취급하면 Codex/Claude 혼합 가능 | OMX team은 Codex/Claude worker map을 자연스럽게 지원한다. |
| MCP 배치 | Claude Code MCP와 OMC tool server 결합 | Codex MCP + OMX first-party MCP registry | 양쪽 모두 MCP를 쓰지만, OMC는 product hook 풍부성, OMX는 setup/config ownership과 결합한다. |
| memory | Claude auto memory와 `CLAUDE.md` 중심 | memories와 `AGENTS.md`/session state 중심 | OMC는 `.omc` 보조 기억, OMX는 `.omx` durable ledger 성격이 강하다. |
| goal persistence | Claude `/goal`/native state와 충돌 가능성 고려 | artifact-first goal steering을 만들기 쉬움 | OMX ultragoal이 더 독립 control plane처럼 동작한다. |
| compaction | `PreCompact` 등 hook coverage가 넓음 | compaction은 있으나 hook event 폭이 상대적으로 좁음 | OMC는 compact 직전 보강, OMX는 artifact와 Stop/UserPromptSubmit 조합을 중시한다. |
| long-running task | Claude product lifecycle과 background 기능 | Codex cloud/local task, external team runtime | OMX는 tmux와 lease/claim으로 장기 실행을 외부화한다. |
| UI/IDE/cloud | Claude Code web/desktop/IDE/terminal 통합 | Codex CLI/web/cloud/IDE delegation | 둘 다 다중 surface지만, 하네스는 주로 CLI/filesystem surface를 쓴다. |
| model routing | Claude 모델 계층과 Anthropic runtime | OpenAI 모델/profile/reasoning 설정 | OMC는 Claude role tiers, OMX는 Codex model/reasoning/profile seed에 집중한다. |
| 상태 관찰 | Claude transcript/team/task state + OMC logs | Codex transcript/config + `.omx` state | OMX는 관찰 가능한 file state를 더 크게 만든다. |
| 설치 검증 | plugin/commands/hooks/MCP registration 확인 | plugin/setup/native hook/fallback/readiness를 분리 확인 | OMX `doctor`가 "설치 shape"와 "실제 exec readiness"를 구분한다. |
| 사용자 설정 보존 | Claude plugin/settings merge 정책 | TOML/JSON hook merge와 stale artifact archive | OMX는 소유 block과 user block을 엄격히 나눠야 한다. |
| 실패 모드 | product event 변화, native feature precedence, hook policy 변화 | feature flag 변화, hook gap, config merge drift, tmux/process drift | OMC는 product coupling risk, OMX는 operator complexity risk가 크다. |
| 학습 곡선 | native 기능이 많아 진입이 상대적으로 낮음 | setup/runtime 개념이 많아 진입이 높음 | 사용자가 말한 "복잡하다"는 지점이 주로 OMX에 해당한다. |

## 부록 B. OMC/OMX 근거 맵

OMC에서 확인한 핵심 근거:

- `README.md`: Claude Code plugin 설치, `omc team`, Codex/Gemini MCP server 제거 후 CLI-first team runtime 권장, Team/Autopilot/Ralph/Ultrawork/UltraQA/Pipeline 설명.
- `.claude-plugin/plugin.json`: plugin bundle이 39개 skill, MCP, commands를 포함.
- `hooks/hooks.json`: Claude Code lifecycle event를 폭넓게 사용.
- `docs/ARCHITECTURE.md`: Hooks/Skills/Agents/State 구조, lifecycle event 설명, `.omc/` state 구조.
- `src/hooks/keyword-detector/index.ts`: keyword noise 제거, activation intent 판별, heavy mode gate.
- `src/hooks/persistent-mode/index.ts`: Stop hook에서 workflow continuation/cancel/exception을 판단.
- `src/mcp/*`: OMC MCP tool registry와 tool group disable/interop 정책.
- `skills/team/SKILL.md`: Claude Code native team 중심의 `/team` workflow.

OMX에서 확인한 핵심 근거:

- `README.md`: Codex는 execution engine, OMX는 workflow/setup/runtime layer라는 mental model, `$deep-interview` -> `$ralplan` -> `$prometheus-strict` -> `$ultragoal` 흐름.
- `plugins/oh-my-codex/.codex-plugin/plugin.json`: Codex plugin bundle이 skills, MCP, app metadata, hooks를 포함.
- `docs/plugin-bundle-ssot.md`: plugin mirror와 root skills, native agents/prompts, setup-owned artifact의 소유권 분리.
- `docs/codex-native-hooks.md`: plugin-scoped hooks, fallback hooks, trust hash, event gap, proof boundary.
- `src/config/generator.ts`: Codex TOML ordering, owned key, feature flags, status line, context/compact seed, MCP block generation.
- `src/config/codex-hooks.ts`: managed hook events, trust state, runtime hook mirror, merge/preserve logic.
- `src/config/omx-first-party-mcp.ts`: `omx_state`, `omx_memory`, `omx_code_intel`, `omx_trace`, `omx_wiki`, `omx_hermes` registry.
- `src/team/state/tasks.ts`와 `skills/team/SKILL.md`: task claim, lease, status transition, tmux worker, Codex/Claude mixed worker strategy.

## 출처

공식 문서:

- OpenAI, Codex CLI: https://developers.openai.com/codex/cli
- OpenAI, Codex `AGENTS.md`: https://developers.openai.com/codex/guides/agents-md
- OpenAI, Codex hooks: https://developers.openai.com/codex/hooks
- OpenAI, Codex subagents: https://developers.openai.com/codex/subagents
- OpenAI, Codex plugins: https://developers.openai.com/codex/plugins
- OpenAI, Codex skills: https://developers.openai.com/codex/skills
- OpenAI, Codex approvals and security: https://developers.openai.com/codex/agent-approvals-security
- OpenAI, Codex web/cloud: https://developers.openai.com/codex/cloud
- Anthropic, Claude Code overview: https://code.claude.com/docs/en/overview
- Anthropic, Claude Code hooks: https://code.claude.com/docs/en/hooks
- Anthropic, Claude Code permissions: https://code.claude.com/docs/en/permissions
- Anthropic, Claude Code skills: https://code.claude.com/docs/en/skills
- Anthropic, Claude Code plugins: https://code.claude.com/docs/en/plugins
- Anthropic, Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Anthropic, Claude Code agent teams: https://code.claude.com/docs/en/agent-teams
- Anthropic, Claude Code memory: https://code.claude.com/docs/en/memory

분석 저장소:

- OMC, `Yeachan-Heo/oh-my-claudecode`, commit `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`: https://github.com/Yeachan-Heo/oh-my-claudecode/tree/1fe17f0e19ec9e24c5964d4363a9f53aab45c73f
- OMX, `Yeachan-Heo/oh-my-codex`, commit `e0465fdc18bfeb67f9f114f7a37835269d35294d`: https://github.com/Yeachan-Heo/oh-my-codex/tree/e0465fdc18bfeb67f9f114f7a37835269d35294d
- OMC architecture, hooks, team, MCP, persistent-mode, keyword-detector: 위 커밋의 `README.md`, `.claude-plugin/plugin.json`, `hooks/hooks.json`, `docs/ARCHITECTURE.md`, `src/hooks/*`, `src/mcp/*`, `skills/team/SKILL.md`
- OMX architecture, plugin/setup split, hooks, team, config, MCP: 위 커밋의 `README.md`, `plugins/oh-my-codex/.codex-plugin/plugin.json`, `plugins/oh-my-codex/hooks/hooks.json`, `docs/codex-native-hooks.md`, `docs/plugin-bundle-ssot.md`, `src/config/*`, `src/team/*`, `skills/team/SKILL.md`
