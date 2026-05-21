# oh-my-openagent 참고 하네스 분석 보고서

## 분석 대상 및 기준 커밋

- 대상 저장소: `https://github.com/code-yeongyu/oh-my-openagent`
- 로컬 분석 경로: `/private/tmp/ditto-harness-analysis/oh-my-openagent`
- 기준 브랜치/커밋: `dev` / `94d6d5b49530a0c066bb84426fb7983132b70244`
- 이 보고서의 모든 repo-relative 경로와 라인 번호는 위 커밋 기준이다.
- 저장소 자체가 현재 “Multi-Harness Agent OS Refactor in Progress” 상태이며 OpenCode, Codex, Pi 등 여러 하네스를 지원하도록 재구조화 중이라고 밝힌다. 다만 현재 구현은 OpenCode 플러그인 어댑터에 강하게 묶여 있고, 순수 로직을 하네스 중립 계층으로 빼는 작업이 전제 조건이라고 명시한다. 근거: `README.md:1-4`, `README.md:138-142`, `ROADMAP.md:66-76`, `ROADMAP.md:78-88`.

## 조사 방법

- README, 로드맵, 설치/설정/CLI/오케스트레이션/Team Mode 문서를 정적으로 검토했다. 근거: `README.md`, `ROADMAP.md`, `docs/guide/installation.md`, `docs/reference/configuration.md`, `docs/reference/cli.md`, `docs/guide/orchestration.md`, `docs/guide/team-mode.md`.
- 패키지 메타데이터와 배포 스크립트/워크플로를 확인해 패키지 경계, 바이너리 배포, 릴리스 경로를 추적했다. 근거: `package.json:1-138`, `bin/oh-my-opencode.js:1-153`, `script/build-binaries.ts:18-30`, `.github/workflows/publish.yml:68-134`, `.github/workflows/publish-platform.yml:37-47`.
- OpenCode 플러그인 진입점, 플러그인 인터페이스, 매니저/도구/훅 조립 코드를 읽어 런타임 구조를 재구성했다. 근거: `src/testing/create-plugin-module.ts:77-181`, `src/plugin-interface.ts:35-91`, `src/create-managers.ts:41-161`, `src/create-tools.ts:22-52`, `src/create-hooks.ts:35-98`, `src/plugin/tool-registry.ts:177-375`.
- 내장 에이전트, 명령 템플릿, 스킬, MCP 정의를 검토했다. 근거: `src/agents/builtin-agents.ts:32-59`, `src/agents/sisyphus/gpt-5-5.ts:45-120`, `src/agents/atlas/shared-prompt.ts:12-188`, `src/features/builtin-commands/commands.ts:41-164`, `src/features/builtin-skills/skills.ts:22-47`, `src/mcp/index.ts:26-56`.
- 실행 테스트는 수행하지 않았다. 이 보고서는 저장소의 문서/소스/설정/스크립트에 대한 정적 분석 결과다.

## 핵심 특징

1. OpenCode 위에 얹힌 “에이전트 하네스”다. 사람은 목표만 주고, 에이전트가 계획/판단/실행을 끝까지 맡는 것을 목표로 한다. 근거: `ROADMAP.md:11-20`.
2. 단일 모델이 아니라 Sisyphus, Hephaestus, Prometheus, Atlas와 보조 에이전트들을 조합하는 다중 모델 오케스트레이션이다. 문서는 11개 내장 에이전트와 primary/subagent 모드를 명시한다. 근거: `docs/guide/orchestration.md:80-100`, `src/agents/builtin-agents.ts:32-59`.
3. 모델 이름 대신 `visual-engineering`, `ultrabrain`, `deep`, `quick` 같은 의미 기반 카테고리로 작업을 라우팅한다. `task(category="...")`는 Sisyphus-Junior로 들어가며, `task(subagent_type="...")`는 특정 에이전트를 직접 호출한다. 근거: `docs/guide/orchestration.md:96-100`, `docs/guide/orchestration.md:298-330`, `docs/reference/configuration.md:290-307`.
4. 병렬 탐색과 배경 에이전트를 핵심 성능 레버로 삼는다. Sisyphus 프롬프트는 독립 호출을 같은 응답에서 병렬 발사하라고 지시하고, `/init-deep` 템플릿도 여러 `explore` 에이전트를 즉시 백그라운드로 띄운다. 근거: `src/agents/sisyphus/gpt-5-5.ts:68-78`, `src/features/builtin-commands/templates/init-deep.ts:38-54`.
5. 플러그인 루프에 훅을 대량 주입해 모델 파라미터, 시스템/메시지 변환, 도구 실행 전후, 세션 이벤트, 자동 계속, 압축 복구를 제어한다. 근거: `src/plugin-interface.ts:35-91`, `src/create-hooks.ts:58-90`, `src/plugin/hooks/create-session-hooks.ts:83-303`, `src/plugin/hooks/create-continuation-hooks.ts:31-128`.
6. LSP와 AST-grep을 MCP로 노출해 코드 이해/리팩터링/구조 검색을 에이전트 도구로 제공한다. 근거: `docs/reference/configuration.md:621-658`, `src/mcp/index.ts:44-53`, `src/mcp/lsp.ts:156-167`, `src/mcp/ast-grep.ts:117-129`.
7. Team Mode는 Claude Code Agent Teams와 유사한 병렬 다중 에이전트 조율 기능이며 기본은 꺼져 있다. 활성화 시 12개 `team_*` 도구가 등록된다. 근거: `docs/guide/team-mode.md:1-32`, `docs/guide/team-mode.md:91-108`, `src/plugin/tool-registry.ts:304-334`.
8. 배포는 전환기 상태다. 루트 패키지는 `oh-my-opencode`지만 CLI bin에는 `oh-my-opencode`와 `oh-my-openagent`가 모두 매핑되고, 문서도 이중 패키지/플러그인 이름 호환성을 설명한다. 근거: `package.json:2-21`, `README.md:123-125`, `docs/reference/cli.md:3-9`, `src/shared/plugin-identity.ts:1-8`.

## 구조/아키텍처

### 계층 방향

로드맵은 Core, MCP, Skills, Adapters, Platform, Web의 계층을 정의하고 “Adapters depend on Core, MCP, and Skills. Nothing depends on Adapters.”라는 DAG 규칙을 둔다. 현재 추출된 Core 패키지는 `utils`, `model-core`, `rules-engine`, `agents-md-core`, `ast-grep-core`, `comment-checker-core`, `boulder-state` 7개라고 밝힌다. 근거: `ROADMAP.md:27-49`, `package.json:8-17`, `package.json:94-102`.

엄밀한 추론: DITTO 관점에서 이 저장소는 이미 “완성된 하네스 중립 SDK”가 아니라 OpenCode 어댑터를 중심으로 하네스 중립 코어를 추출해 가는 중간 상태다. 이 추론은 로드맵의 “current codebase is strongly coupled to OpenCode”와 패키지 계층 재구조화 필요성에 근거한다. 근거: `ROADMAP.md:21-26`, `ROADMAP.md:66-76`.

### 런타임 조립

플러그인 모듈은 로딩 시 agent sort shim 설치, config context 초기화, 레거시 마이그레이션, 외부 skill plugin 충돌 감지, 서버 인증 주입, config 로드, OpenClaw 초기화, Team Mode/tmux 준비, manager/tool/hook 생성, OpenCode 훅 반환을 수행한다. 플러그인 ID는 `oh-my-openagent`다. 근거: `src/testing/create-plugin-module.ts:77-181`.

`createPluginInterface`는 OpenCode 플러그인 이벤트 표면을 한 곳에 모은다. 등록 표면은 `tool`, `chat.params`, `chat.headers`, `command.execute.before`, `chat.message`, `experimental.chat.messages.transform`, `experimental.chat.system.transform`, `config`, `event`, `tool.definition`, `tool.execute.before`, `tool.execute.after`다. 근거: `src/plugin-interface.ts:35-91`.

### 매니저

런타임 매니저는 `TmuxSessionManager`, `BackgroundManager`, `SkillMcpManager`, `ConfigHandler`, `ModelFallbackControllerAccessor`로 구성된다. tmux server-running 마킹은 `tmuxConfig.enabled`만으로 하지 않고 `ctx.serverUrl` 존재도 확인한다. 주석은 그렇지 않으면 `opencode attach`가 실패하는 issue #3894를 설명한다. 근거: `src/create-managers.ts:41-70`.

배경 세션이 생성되면 tmux 세션 매니저와 OpenClaw runtime dispatch에 session.created 이벤트를 전달하고, shutdown 시 Team Mode/tmux cleanup을 수행한다. 근거: `src/create-managers.ts:75-144`.

### 도구 조립

`createTools`는 skill context, available categories, tool registry를 조합해 filtered tools, merged skills, available skills/categories, browser provider, disabled skills, task system 상태를 반환한다. 근거: `src/create-tools.ts:22-52`.

`createToolRegistry`는 검색, 세션, 배경 작업, `call_omo_agent`, `look_at`, `task`, `skill`, `skill_mcp`, `interactive_bash`, Team Mode, task system, hashline edit 도구를 하나의 registry로 합치고 disabled/max_tools 필터를 적용한다. 근거: `src/plugin/tool-registry.ts:199-375`.

### 훅 조립

`createHooks`는 core hooks, continuation hooks, skill hooks를 합친다. core hooks는 session/tool guard/transform 계열, continuation hooks는 stop-continuation, compaction, todo continuation, babysitter, background notification 등, skill hooks는 category skill reminder와 auto slash command를 담당한다. 근거: `src/create-hooks.ts:58-90`, `src/plugin/hooks/create-core-hooks.ts:11-53`, `src/plugin/hooks/create-continuation-hooks.ts:31-128`, `src/plugin/hooks/create-skill-hooks.ts:14-50`.

### 설정 경로와 병합

설정 파일은 `oh-my-openagent.json[c]`와 레거시 `oh-my-opencode.json[c]`를 모두 인식한다. 사용자 config를 먼저 로드하고, 프로젝트 config는 working directory에서 `$HOME`까지 올라가며 가까운 config가 이긴다. `mcp_env_allowlist`는 user-only다. 근거: `docs/reference/configuration.md:44-59`, `src/plugin-config.ts:298-450`.

파서는 전체 스키마 검증 실패 시에도 섹션별 부분 로드를 시도하고 invalid section을 건너뛴다. 병합은 agents/categories/team_mode/claude_code를 deep merge하고 disabled 목록을 union한다. 근거: `src/plugin-config.ts:125-218`, `src/plugin-config.ts:232-296`.

## 도구/명령/스크립트/프롬프트 인벤토리

### OpenCode 플러그인 이벤트/훅 표면

- Chat/model 계열: `chat.params`, `chat.headers`, `chat.message`, system/messages transform. 근거: `src/plugin-interface.ts:38-66`.
- Command 계열: `command.execute.before`. 근거: `src/plugin-interface.ts:48-50`.
- Tool 계열: tool registry 자체, `tool.definition`, `tool.execute.before`, `tool.execute.after`. 근거: `src/plugin-interface.ts:35-37`, `src/plugin-interface.ts:78-90`.
- Config/event 계열: `config`, `event`. 근거: `src/plugin-interface.ts:68-76`.
- Compaction 계열: `experimental.session.compacting`, `experimental.compaction.autocontinue`. 근거: `src/testing/create-plugin-module.ts:167-173`.

### 도구

- 검색: `grep`, `glob`. 근거: `docs/reference/features.md:589-595`, `src/plugin/tool-registry.ts:336-339`.
- LSP: `lsp_diagnostics`, `lsp_prepare_rename`, `lsp_rename`, `lsp_goto_definition`, `lsp_find_references`, `lsp_symbols`. 근거: `docs/reference/features.md:604-613`, `src/plugin/tool-registry.ts:142-147`.
- AST-grep: `ast_grep_search`, `ast_grep_replace`. 근거: `docs/reference/features.md:615-623`, `src/mcp/ast-grep.ts:14-17`.
- 편집: hash-anchored `edit`는 `hashline_edit`가 true일 때만 등록된다. 근거: `docs/reference/configuration.md:952-960`, `src/plugin/tool-registry.ts:299-302`.
- 위임/배경: `task`, `call_omo_agent`, `background_output`, `background_cancel`. 근거: `docs/reference/features.md:624-631`, `src/plugin/tool-registry.ts:199-261`, `src/plugin/tool-registry.ts:336-345`.
- 시각 분석: `look_at`은 `multimodal-looker`가 비활성화되지 않은 경우 등록된다. 근거: `docs/reference/features.md:633-637`, `src/plugin/tool-registry.ts:209-213`.
- 스킬: `skill`, `skill_mcp`. 근거: `docs/reference/features.md:639-645`, `src/plugin/tool-registry.ts:263-287`.
- 세션: `session_list`, `session_read`, `session_search`, `session_info`. 근거: `docs/reference/features.md:646-653`, `src/plugin/tool-registry.ts:120-124`.
- Task system: `task_create`, `task_get`, `task_list`, `task_update`는 `experimental.task_system`이 켜졌을 때만 등록된다. 근거: `docs/reference/features.md:655-726`, `src/plugin/tool-registry.ts:289-297`.
- 터미널: `interactive_bash`는 tmux binary가 있을 때 등록된다. 근거: `docs/reference/features.md:728-732`, `src/create-runtime-tmux-config.ts:20-24`, `src/plugin/tool-registry.ts:346`.
- Team Mode: `team_create`, `team_delete`, `team_shutdown_request`, `team_approve_shutdown`, `team_reject_shutdown`, `team_send_message`, `team_task_create`, `team_task_list`, `team_task_update`, `team_task_get`, `team_status`, `team_list`. 근거: `docs/guide/team-mode.md:91-108`, `src/plugin/tool-registry.ts:304-334`.

### 내장 명령

구현상 내장 명령은 `/init-deep`, `/ralph-loop`, `/ulw-loop`, `/cancel-ralph`, `/refactor`, `/start-work`, `/stop-continuation`, `/remove-ai-slops`, `/handoff`, `/hyperplan`이다. 근거: `src/features/builtin-commands/types.ts:3`, `src/features/builtin-commands/commands.ts:41-164`.

주요 명령 성격:

- `/init-deep`: 병렬 `explore`와 LSP/구조 분석으로 계층형 `AGENTS.md`를 생성한다. 근거: `src/features/builtin-commands/templates/init-deep.ts:1-23`, `src/features/builtin-commands/templates/init-deep.ts:38-54`, `src/features/builtin-commands/templates/init-deep.ts:184-257`.
- `/ralph-loop`, `/ulw-loop`: 완료 조건까지 계속하는 self-referential loop/ultrawork loop다. 근거: `src/features/builtin-commands/commands.ts:53-74`, `docs/reference/features.md:506-532`.
- `/refactor`: LSP, AST-grep, architecture analysis, TDD verification을 포함한 리팩터링 워크플로다. 근거: `src/features/builtin-commands/commands.ts:81-88`, `docs/reference/features.md:534-550`.
- `/start-work`: Prometheus plan에서 Atlas 또는 Sisyphus 작업 세션을 시작한다. 근거: `src/features/builtin-commands/commands.ts:89-105`, `docs/guide/orchestration.md:7-14`.
- `/handoff`: 새 세션으로 이어가기 위한 상세 컨텍스트 요약을 만든다. 근거: `src/features/builtin-commands/commands.ts:122-137`, `docs/reference/features.md:570-575`.
- `/hyperplan`: Team Mode 기반 adversarial multi-agent planning을 유도한다. 근거: `src/features/builtin-commands/commands.ts:138-144`.

### 내장 스킬

기본 내장 스킬은 browser provider에 따라 `playwright`/`agent-browser`/`dev-browser`/`playwright-cli` 중 하나, 그리고 `frontend-ui-ux`, `git-master`, `review-work`, `ai-slop-remover`다. Team Mode가 켜지고 비활성화되지 않았을 때 `team-mode` 스킬이 추가된다. 근거: `src/features/builtin-skills/skills.ts:22-47`.

- `playwright`: Playwright MCP 기반 브라우저 자동화 스킬이며 `npx @playwright/mcp@latest`를 MCP config로 둔다. 근거: `src/features/builtin-skills/skills/playwright.ts:3-15`.
- `playwright-cli`: 에이전트가 canonical browser skill 이름 `playwright`를 하드코딩하므로 스킬 이름은 유지하고 구현만 CLI로 바꾼다고 주석에 명시한다. 근거: `src/features/builtin-skills/skills/playwright-cli.ts:3-13`.
- `team-mode`: docs-only skill이며 `team_*` 도구는 `team_mode.enabled=true`일 때 전역 등록된다고 설명한다. 근거: `src/features/builtin-skills/skills/team-mode.ts:3-9`, `src/features/builtin-skills/skills/team-mode.ts:181-182`.
- `review-work`: 구현 후 5개 병렬 sub-agent가 목표/QA/코드품질/보안/컨텍스트 누락을 검토하고 모두 통과해야 pass라고 규정한다. 근거: `src/features/builtin-skills/skills/review-work.ts:3-19`, `src/features/builtin-skills/skills/review-work.ts:61-68`.

### MCP

- Built-in MCP는 `websearch`, `context7`, `grep_app`, `lsp`, `ast_grep`이며 disabled list로 제외할 수 있다. 근거: `docs/reference/configuration.md:621-627`, `src/mcp/index.ts:26-56`.
- `websearch`는 기본 Exa remote MCP를 쓰고, Tavily는 `TAVILY_API_KEY`가 없으면 skip한다. Exa는 `EXA_API_KEY`가 있으면 Authorization header를 붙인다. 근거: `src/mcp/websearch.ts:12-40`.
- `context7`은 remote MCP이며 `CONTEXT7_API_KEY`가 있으면 Authorization header를 붙인다. 근거: `src/mcp/context7.ts:1-9`.
- `lsp`는 local MCP로 `packages/lsp-tools-mcp` dist/source를 찾고, 없으면 submodule update, npm install, build를 시도하는 bootstrap command를 구성한다. 근거: `src/mcp/lsp.ts:7-33`, `src/mcp/lsp.ts:156-167`.
- `ast_grep`은 local MCP로 `packages/ast-grep-mcp`를 실행하고 workspace/disabled tools를 env로 전달한다. 근거: `src/mcp/ast-grep.ts:8-17`, `src/mcp/ast-grep.ts:117-129`.

### CLI와 스크립트

- CLI 명령은 `install`, `run`, `get-local-version`, `doctor`, `refresh-model-capabilities`, `version`, `boulder`, `mcp oauth`다. 근거: `src/cli/cli-program.ts:25-222`, `docs/reference/cli.md:20-32`.
- `run`은 일반 `opencode run`과 달리 모든 todo가 완료/취소되고 모든 background child session이 idle일 때까지 기다린다. 근거: `src/cli/cli-program.ts:74-134`, `docs/reference/cli.md:90-96`.
- 빌드 스크립트는 Bun 기반 플러그인/CLI 빌드, LSP MCP 빌드, 스키마 생성, model capabilities 생성, 플랫폼 바이너리 빌드를 포함한다. 근거: `package.json:37-55`.
- 플랫폼 바이너리는 11개 target으로 빌드된다. 근거: `package.json:110-122`, `script/build-binaries.ts:18-30`, `docs/guide/installation.md:20-25`.
- Node wrapper는 OS/arch/libc/AVX2를 감지해 플랫폼 패키지 후보를 고르고, `SIGILL`이면 fallback binary를 시도한다. 근거: `bin/oh-my-opencode.js:16-61`, `bin/oh-my-opencode.js:83-148`.

### 에이전트 프롬프트

- Sisyphus GPT-5.5 프롬프트는 “orchestrator, not direct implementer”를 기본 정체성으로 두고, intent gate, 병렬화, delegation, verification을 강제한다. 근거: `src/agents/sisyphus/gpt-5-5.ts:45-89`, `src/agents/sisyphus/gpt-5-5.ts:184-240`.
- Atlas 프롬프트는 계획 실행 전용 conductor로, 6-section delegation prompt, 병렬 기본 정책, notepad protocol, plan checkbox 업데이트 규칙을 둔다. 근거: `src/agents/atlas/shared-prompt.ts:12-188`.
- Prometheus GPT 프롬프트는 질문 전 silent exploration, `.omo/drafts` 작성, clearance checklist, Oracle verification gate, Metis gap analysis를 요구한다. 근거: `src/agents/prometheus/gpt.ts:105-126`, `src/agents/prometheus/gpt.ts:130-218`, `src/agents/prometheus/gpt.ts:220-230`.
- Explore는 쓰기/편집/위임을 제한하고 LSP/AST 검색 중심으로 구조화된 결과를 내는 codebase search specialist다. 근거: `src/agents/explore.ts:27-40`, `src/agents/explore.ts:49-100`.
- Oracle은 architecture/self-review/hard debugging을 위한 expensive read-only advisor 성격의 prompt metadata와 compact recommendation 구조를 가진다. 근거: `src/agents/oracle.ts:8-38`, `src/agents/oracle.ts:44-120`.

## 각 도구가 왜 그렇게 작성되어야 했는지에 대한 근거 또는 엄밀한 추론

- `task(category=...)`: 문서는 모델 이름이 에이전트의 자기인식/분포 편향을 만들 수 있으므로 모델명이 아니라 의도를 표현하는 semantic category로 라우팅한다고 설명한다. 따라서 category 기반 task API는 모델 선택을 사용자가 직접 다루지 않고 하네스가 라우팅하게 하려는 설계다. 근거: `docs/guide/orchestration.md:298-330`, `docs/reference/configuration.md:290-307`.
- `task(subagent_type=...)`: specialist가 정확히 맞으면 특정 agent를 직접 호출하라는 Sisyphus/Atlas 규칙이 있어 category dispatch와 별도로 필요하다. category와 subagent_type은 한 호출에서 상호 배타적이다. 근거: `docs/guide/orchestration.md:96-100`, `src/agents/sisyphus/gpt-5-5.ts:184-190`, `src/agents/atlas/shared-prompt.ts:15-33`.
- `call_omo_agent`와 `background_output/background_cancel`: Sisyphus와 `/init-deep`가 explore/librarian을 병렬 background로 띄우도록 설계되어, 결과 수집/취소를 위한 별도 표면이 필요하다. 근거: `src/agents/sisyphus/gpt-5-5.ts:68-78`, `src/agents/sisyphus/gpt-5-5.ts:231-240`, `src/features/builtin-commands/templates/init-deep.ts:42-54`, `src/plugin/tool-registry.ts:199-207`.
- `grep/glob`: 프롬프트가 `rg` 직접 사용과 빠른 검색을 강조하고, 문서도 grep/glob을 코드 검색 기본 도구로 둔다. 엄밀한 추론: 하네스가 검색 도구를 별도 제공하는 이유는 agent prompt의 “읽고 확인한 뒤 주장하라” 원칙을 안정적으로 실행시키기 위해서다. 근거: `src/agents/sisyphus/gpt-5-5.ts:55-67`, `docs/reference/features.md:589-595`.
- LSP 도구: `/refactor`와 Atlas/Sisyphus 검증 규칙은 rename, reference, diagnostics 같은 IDE급 정밀도가 필요하다. 그래서 LSP를 MCP process boundary로 둔 local tool로 제공한다. 근거: `docs/reference/features.md:604-613`, `docs/reference/features.md:544-550`, `src/mcp/lsp.ts:156-167`.
- AST-grep 도구: 문서가 구조적 검색/치환을 `ast_grep` MCP가 제공한다고 설명하고, 구현은 OpenCode tool name을 MCP tool name으로 매핑한다. 엄밀한 추론: regex로 어려운 AST 패턴 변경을 agent가 더 안전하게 수행하도록 분리한 도구다. 근거: `docs/reference/features.md:615-623`, `src/mcp/ast-grep.ts:14-17`, `src/mcp/ast-grep.ts:117-129`.
- Hashline `edit`: 문서가 stale-line edit 방지를 위해 `LINE#ID` hash anchor를 사용한다고 직접 설명한다. 기본 disabled인 것은 기존 Edit tool 교체의 동작 영향이 커서 opt-in으로 둔 것으로 해석된다. 근거: `docs/reference/configuration.md:952-960`, `src/plugin/tool-registry.ts:299-302`.
- `skill`과 `skill_mcp`: 로드맵은 표현 계층 우선순위를 Skill > MCP > Tool > Hook으로 둔다. 스킬은 정적 지식이라 런타임 비용이 낮고, skill-embedded MCP는 session/skill/server composite key로 격리해 상태 bleed를 막는다. 근거: `ROADMAP.md:53-64`, `docs/guide/orchestration.md:331-360`, `src/plugin/tool-registry.ts:263-287`.
- `look_at`: multimodal-looker agent가 비활성화되지 않은 경우에만 등록된다. 엄밀한 추론: 이미지/PDF 분석은 일반 텍스트 모델 경로와 비용/능력이 달라 별도 agent/tool 경로로 분리했다. 근거: `docs/reference/features.md:633-637`, `src/plugin/tool-registry.ts:209-213`.
- `interactive_bash`: tmux binary가 있을 때만 활성화된다. 엄밀한 추론: OpenCode 플러그인 내부에서 TUI/interactive command를 안정적으로 다루려면 tmux 세션이라는 외부 상태 경계가 필요하므로 capability detection으로 guard했다. 근거: `src/create-runtime-tmux-config.ts:20-24`, `docs/reference/features.md:728-732`.
- `session_*`: Sisyphus prompt는 continuation session ID와 background task ID를 구분하고 follow-up은 같은 session ID로 이어가라고 한다. 엄밀한 추론: background/subagent를 많이 쓰는 하네스에서는 과거 session을 읽고 검색하는 기능이 검증과 continuity 비용 절감에 필요하다. 근거: `src/agents/sisyphus/gpt-5-5.ts:219-240`, `docs/reference/features.md:646-653`.
- Task system 도구: 문서는 파일 기반 `.omo/tasks/` 저장, dependency, restart persistence를 TodoWrite와 차이점으로 든다. 따라서 장기/병렬/다중 subagent 작업에서는 session memory todo보다 task 파일이 필요하다. 단, Claude Code 내부 Task tool 관찰에 기반한 자체 구현이라고 문서가 경고한다. 근거: `docs/reference/features.md:655-726`.
- Team Mode 도구: Team Mode는 off-by-default, bounded parallel multi-agent coordination이고 team spec, mailbox, shared task list, shutdown flow, bounds를 갖는다. 따라서 단일 `team` 도구가 아니라 lifecycle/messaging/query/tasks 도구군으로 나뉜다. 근거: `docs/guide/team-mode.md:5-32`, `docs/guide/team-mode.md:83-108`, `docs/guide/team-mode.md:133-147`, `src/plugin/tool-registry.ts:304-334`.

## 장점

- 설계 목표가 명확하다. “사람이 계속 개입하지 않고 큰 작업을 맡기는 하네스”라는 목표가 로드맵, 오케스트레이션 문서, Sisyphus/Atlas/Prometheus 프롬프트에 일관되게 반영된다. 근거: `ROADMAP.md:11-20`, `docs/guide/orchestration.md:1-14`, `src/agents/sisyphus/gpt-5-5.ts:79-89`.
- delegation prompt contract가 구체적이다. Sisyphus와 Atlas가 6개 섹션, expected outcome, required tools, must/must-not, context, post-delegation verification을 반복해서 강제한다. 근거: `src/agents/sisyphus/gpt-5-5.ts:204-216`, `src/agents/atlas/shared-prompt.ts:45-86`.
- 병렬 작업을 단순한 권장이 아니라 시스템 성능 원리로 설계했다. Sisyphus, Atlas, `/init-deep`, `review-work` 모두 병렬 fan-out을 명시한다. 근거: `src/agents/sisyphus/gpt-5-5.ts:68-78`, `src/agents/atlas/shared-prompt.ts:88-127`, `src/features/builtin-commands/templates/init-deep.ts:42-54`, `src/features/builtin-skills/skills/review-work.ts:61-68`.
- 모델/프로바이더 장애에 대비한 fallback 계층이 넓다. 설정은 agent/category별 fallback_models, runtime_fallback, model capability normalization, provider fallback chain을 제공한다. 근거: `docs/reference/configuration.md:232-361`, `docs/reference/configuration.md:663-789`.
- config loader가 부분 실패를 견딘다. 전체 config 검증 실패 시에도 유효 섹션만 로드해 사용자가 한 섹션 오류로 전체 하네스를 잃지 않게 한다. 근거: `src/plugin-config.ts:125-218`.
- 보안 경계 의식이 있다. `mcp_env_allowlist`를 user-only로 유지해 clone-and-load attack을 막는 주석과 구현이 있다. 근거: `docs/reference/configuration.md:56-58`, `src/plugin-config.ts:430-437`.
- 배포/설치 경험을 독립 바이너리로 보강한다. 11개 플랫폼 바이너리와 wrapper fallback이 있어 Bun/Node 런타임 의존을 설치 후 줄인다. 근거: `docs/guide/installation.md:20-25`, `package.json:110-122`, `bin/oh-my-opencode.js:83-148`.

## 약한 점/리스크

- 현재 OpenCode 플러그인 API에 강하게 결합되어 있다. 로드맵도 이를 인정하며, prompt injection race, duplicate work, infinite loop, state corruption, frequent breaking changes를 이유로 OpenCode-native 접근을 경계한다. 근거: `ROADMAP.md:66-88`.
- 이름 전환이 복잡하다. 패키지/CLI는 여전히 `oh-my-opencode`가 중심이고, plugin/config는 `oh-my-openagent`를 선호하며 레거시 config가 같은 디렉터리에 있으면 legacy가 이긴다는 문서가 있다. 근거: `README.md:123-125`, `docs/reference/configuration.md:56-59`, `src/shared/plugin-identity.ts:1-8`.
- 문서/스키마 드리프트가 보인다. 구현 타입과 명령 등록에는 `handoff`, `remove-ai-slops`, `hyperplan`이 모두 있지만, `docs/reference/features.md`의 built-in command 표에는 `/remove-ai-slops`와 `/hyperplan`이 없고, config schema의 `BuiltinCommandNameSchema`에는 `handoff`가 빠져 있다. 이 스키마는 `disabled_commands`에 사용된다. 근거: `src/features/builtin-commands/types.ts:3`, `src/features/builtin-commands/commands.ts:112-144`, `docs/reference/features.md:472-484`, `src/config/schema/commands.ts:3-13`, `src/config/schema/oh-my-opencode-config.ts:12`, `src/config/schema/oh-my-opencode-config.ts:45`.
- LSP MCP bootstrap은 런타임에 `git submodule update`, `npm install`, `npm run build`까지 시도할 수 있다. 엄밀한 추론: 오프라인/제한된 샌드박스/기업망에서는 LSP 도구 활성화가 예측 불가능하게 실패하거나 지연될 수 있다. 근거: `src/mcp/lsp.ts:11-33`, `src/mcp/lsp.ts:116-127`.
- 배포 경로가 두 갈래다. workflow는 11개 플랫폼과 `oh-my-opencode`/`oh-my-openagent` dual publish를 처리하지만, `script/publish.ts`의 `PLATFORM_PACKAGE_IDS`에는 `windows-x64-baseline`이 없다. 엄밀한 추론: 공식 workflow가 주 경로라면 실제 릴리스 문제는 아닐 수 있으나, 수동 publish script를 쓰면 누락 위험이 있다. 근거: `script/publish.ts:13-24`, `script/build-binaries.ts:18-30`, `.github/workflows/publish.yml:89-94`, `.github/workflows/publish-platform.yml:43-47`.
- 설치 문서가 LLM agent에게 마케팅/스타 요청까지 지시한다. 명시적 동의 없이 star command를 실행하지 말라고 제한하지만, 설치 UX와 하네스 기술 설정이 홍보 지시와 섞여 있다. 근거: `docs/guide/installation.md:447-481`.
- 익명 telemetry가 기본 enabled다. 문서는 opt-out 환경변수를 제공하지만, 하네스 평가/도입 시 기본 네트워크 이벤트 정책을 별도로 검토해야 한다. 근거: `README.md:125`, `docs/reference/cli.md:61`, `docs/guide/installation.md:28`.
- Team Mode는 기능 범위가 크고 상태 저장/메일박스/라이브 delivery reservation이 복잡하다. 문서는 dotfile reservation, TTL reclaim, processed 이동까지 설명한다. 엄밀한 추론: crash recovery와 중복 주입 방지 테스트가 충분하지 않으면 state corruption이 발생하기 쉬운 영역이다. 근거: `docs/guide/team-mode.md:133-147`, `src/create-managers.ts:75-96`.

## DITTO에서 차용할 점

- 하네스 중립 코어와 어댑터 분리 원칙을 차용하되, OpenCode 전용 이벤트명은 DITTO 어댑터 경계 안에만 가둔다. 근거가 되는 원칙: `ROADMAP.md:27-40`, `ROADMAP.md:66-76`.
- delegation prompt contract를 DITTO 표준으로 가져온다. 특히 `TASK`, `EXPECTED OUTCOME`, `REQUIRED TOOLS`, `MUST DO`, `MUST NOT DO`, `CONTEXT` 6개 섹션과 post-delegation verification은 품질 통제에 직접 유용하다. 근거: `src/agents/sisyphus/gpt-5-5.ts:204-216`, `src/agents/atlas/shared-prompt.ts:45-86`.
- category 기반 라우팅을 차용한다. 모델명을 프롬프트에 드러내지 않고 작업 의도와 비용/능력 프로파일로 라우팅하면 DITTO에서도 모델 교체와 fallback을 쉽게 할 수 있다. 근거: `docs/guide/orchestration.md:298-330`, `docs/reference/configuration.md:290-341`.
- 병렬 탐색/검증 패턴을 차용한다. 초기 context acquisition은 `explore`/`librarian` 병렬 fan-out, 구현 후는 파일 재읽기 + diagnostics + 테스트로 닫는 구조가 적합하다. 근거: `src/agents/sisyphus/gpt-5-5.ts:68-78`, `src/agents/sisyphus/gpt-5-5.ts:215-240`.
- 스킬 우선 구조를 차용한다. 정적 지식은 Skill, 외부 프로세스는 MCP, 런타임 기능은 Tool, 루프 개입은 Hook 순서로 두면 비용과 결합도를 낮출 수 있다. 근거: `ROADMAP.md:53-64`.
- config merge와 user-only allowlist 정책을 차용한다. 프로젝트 config보다 사용자 보안 config를 우선 보호하는 방식은 DITTO의 repo-supplied config 공격면을 줄인다. 근거: `docs/reference/configuration.md:44-59`, `src/plugin-config.ts:430-437`.
- hashline edit의 stale-write 방지 아이디어를 차용한다. DITTO의 편집 도구가 line-number 기반이면 hash anchor 또는 content precondition을 넣는 것이 안전하다. 근거: `docs/reference/configuration.md:952-960`.
- CLI `run`의 완료 조건을 참고한다. 단순 프로세스 종료가 아니라 todo/task와 background child session idle 상태를 종료 조건으로 보는 방식은 에이전트 하네스에 적합하다. 근거: `src/cli/cli-program.ts:110-113`, `docs/reference/cli.md:90-96`.

## 보완 계획

1. DITTO 적용 전, 도구/명령 이름과 config schema를 단일 source-of-truth에서 생성하게 한다. 이 저장소의 `/handoff` schema 누락과 features 문서 누락을 반면교사로 삼는다. 근거: `src/features/builtin-commands/types.ts:3`, `src/config/schema/commands.ts:3-13`, `docs/reference/features.md:472-484`.
2. LSP/AST MCP는 런타임 bootstrap 대신 설치/doctor 단계에서 선검증하고, 오프라인이면 명확한 degraded mode로 떨어지게 한다. 근거: `src/mcp/lsp.ts:11-33`, `docs/reference/cli.md:65-87`.
3. OpenCode류 host hook race를 추상화할 때 “hook injection은 가장 마지막 수단”으로 두고, 상태 전이는 durable queue/lock 기반으로 설계한다. 근거: `ROADMAP.md:78-88`, `docs/guide/team-mode.md:147`.
4. Team Mode 차용은 바로 전체 복제하지 말고, 1단계는 bounded background delegation과 shared task file만 구현한다. mailbox live delivery, tmux visualization, worktree orchestration은 별도 feature flag로 둔다. 근거: `docs/guide/team-mode.md:83-127`, `docs/guide/team-mode.md:133-147`.
5. telemetry/홍보/설치 프롬프트는 기술 설치와 분리한다. DITTO는 기본값을 no-telemetry 또는 first-run consent로 두고, star/광고 요청은 하네스 문서에서 제외한다. 근거: `README.md:125`, `docs/guide/installation.md:447-481`.
6. 모델 capability/fallback은 차용하되, fallback chain을 문서/코드/doctor가 모두 같은 데이터를 보게 만든다. 근거: `docs/reference/configuration.md:331-361`, `docs/reference/configuration.md:663-789`, `src/cli/cli-program.ts:185-198`.
7. 배포 스크립트는 workflow와 수동 script가 같은 platform manifest를 import하도록 한다. 이 저장소처럼 `build-binaries.ts`와 `publish.ts`가 별도 플랫폼 목록을 갖는 구조는 피한다. 근거: `script/build-binaries.ts:18-30`, `script/publish.ts:13-24`, `.github/workflows/publish-platform.yml:43-47`.

## 근거 목록

- 목표/방향: `README.md:1-4`, `README.md:93-125`, `README.md:138-142`, `ROADMAP.md:11-20`, `ROADMAP.md:21-49`, `ROADMAP.md:53-88`.
- 패키지/배포: `package.json:1-138`, `bin/oh-my-opencode.js:1-153`, `script/build-binaries.ts:18-30`, `script/publish.ts:13-24`, `.github/workflows/publish.yml:68-134`, `.github/workflows/publish-platform.yml:37-47`.
- 플러그인 조립: `src/testing/create-plugin-module.ts:77-181`, `src/plugin-interface.ts:35-91`, `src/create-managers.ts:41-161`, `src/create-tools.ts:22-52`, `src/create-hooks.ts:35-98`, `src/plugin/tool-registry.ts:177-375`.
- 설정: `docs/reference/configuration.md:44-59`, `docs/reference/configuration.md:172-361`, `docs/reference/configuration.md:621-960`, `docs/reference/configuration.md:962-1023`, `src/plugin-config.ts:65-450`, `src/shared/plugin-identity.ts:1-8`.
- CLI/설치: `src/cli/cli-program.ts:25-222`, `docs/reference/cli.md:1-225`, `docs/guide/installation.md:1-170`, `docs/guide/installation.md:447-499`.
- 오케스트레이션/에이전트: `docs/guide/orchestration.md:1-100`, `docs/guide/orchestration.md:104-188`, `docs/guide/orchestration.md:192-278`, `docs/guide/orchestration.md:298-383`, `docs/guide/overview.md:48-162`, `src/agents/builtin-agents.ts:32-180`, `src/agents/sisyphus/gpt-5-5.ts:45-240`, `src/agents/atlas/shared-prompt.ts:12-188`, `src/agents/prometheus/gpt.ts:105-230`, `src/agents/explore.ts:1-100`, `src/agents/oracle.ts:1-120`.
- 명령/스킬/도구/MCP: `src/features/builtin-commands/types.ts:1-9`, `src/features/builtin-commands/commands.ts:1-164`, `src/features/builtin-commands/templates/init-deep.ts:1-270`, `src/features/builtin-skills/skills.ts:1-47`, `src/features/builtin-skills/skills/playwright.ts:1-60`, `src/features/builtin-skills/skills/playwright-cli.ts:1-50`, `src/features/builtin-skills/skills/team-mode.ts:1-184`, `src/features/builtin-skills/skills/review-work.ts:1-115`, `src/mcp/index.ts:1-56`, `src/mcp/lsp.ts:1-167`, `src/mcp/ast-grep.ts:1-129`, `src/mcp/websearch.ts:1-42`, `src/mcp/context7.ts:1-9`, `docs/reference/features.md:468-735`, `docs/guide/team-mode.md:1-151`.
