# oh-my-openagent 참고 하네스 분석 보고서

## 분석 대상 및 기준 커밋

- 대상 저장소: `https://github.com/code-yeongyu/oh-my-openagent`
- 로컬 분석 경로: `/private/tmp/ditto-harness-analysis/oh-my-openagent`
- 기준 브랜치/커밋: `dev` / `7afa4d08ffe9de7189a12ba871884b1023392e22` (갱신: 2026-06-01)
- 이전 기준: `94d6d5b49530a0c066bb84426fb7983132b70244`, 갱신: `7afa4d08f` @ 2026-06-01
- 이 보고서의 모든 repo-relative 경로와 라인 번호는 위 커밋 기준이다. 단, 아래 “기준 커밋 이후 변경” 절에서 명시적으로 신규 해시를 표기한 항목은 새 커밋 기준이다.
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

구현상 내장 명령은 `/ralph-loop`, `/ulw-loop`, `/cancel-ralph`, `/refactor`, `/start-work`, `/stop-continuation`, `/remove-ai-slops`, `/handoff`, `/hyperplan`이다. `/init-deep`은 커맨드에서 제거되어 스킬로 이동했다 (`src/features/builtin-skills/skills/init-deep.ts @ 7afa4d08f`). 근거: `src/features/builtin-commands/types.ts:3 @ 7afa4d08f`, `src/features/builtin-commands/commands.ts:38+ @ 7afa4d08f`.

주요 명령 성격:

- `/init-deep`: 커맨드에서 **제거됨** (7afa4d08f). 동일 기능이 `init-deep` **스킬**로 이동했다. 스킬은 `packages/shared-skills/skills/init-deep/SKILL.md`에서 로드된다. 커맨드 앵커 (`src/features/builtin-commands/templates/init-deep.ts`) 는 현재 파일이 존재하지 않으므로 무효다(삭제 확정, 검증 완료 2026-06-01 @ `7afa4d08f`). 근거: `src/features/builtin-skills/skills/init-deep.ts @ 7afa4d08f`, `src/features/builtin-skills/skill-file-loader.ts @ 7afa4d08f`.
- `/ralph-loop`, `/ulw-loop`: 완료 조건까지 계속하는 self-referential loop/ultrawork loop다. 근거: `src/features/builtin-commands/commands.ts:53-74`, `docs/reference/features.md:506-532`.
- `/refactor`: LSP, AST-grep, architecture analysis, TDD verification을 포함한 리팩터링 워크플로다. 근거: `src/features/builtin-commands/commands.ts:81-88`, `docs/reference/features.md:534-550`.
- `/start-work`: Prometheus plan에서 Atlas 또는 Sisyphus 작업 세션을 시작한다. 근거: `src/features/builtin-commands/commands.ts:89-105`, `docs/guide/orchestration.md:7-14`.
- `/handoff`: 새 세션으로 이어가기 위한 상세 컨텍스트 요약을 만든다. 근거: `src/features/builtin-commands/commands.ts:122-137`, `docs/reference/features.md:570-575`.
- `/hyperplan`: Team Mode 기반 adversarial multi-agent planning을 유도한다. 근거: `src/features/builtin-commands/commands.ts:138-144`.

### 내장 스킬

기본 내장 스킬은 browser provider에 따라 `playwright`/`agent-browser`/`dev-browser`/`playwright-cli` 중 하나, 그리고 `frontend-ui-ux`, `git-master`, `review-work`, `remove-ai-slops`, `init-deep`, `security-research`, `security-review`다. Team Mode가 켜지고 비활성화되지 않았을 때 `team-mode` 스킬이 추가된다. `ai-slop-remover` 스킬은 `remove-ai-slops`로 리네임·교체됐다 (7afa4d08f). `init-deep`과 `review-work`는 `packages/shared-skills/` 패키지 기반 파일 로더로 외부화됐다. 근거: `src/features/builtin-skills/skills.ts:28-52 @ 7afa4d08f`, `src/features/builtin-skills/skill-file-loader.ts @ 7afa4d08f`.

- `playwright`: Playwright MCP 기반 브라우저 자동화 스킬이며 `npx @playwright/mcp@latest`를 MCP config로 둔다. 근거: `src/features/builtin-skills/skills/playwright.ts:3-15`.
- `playwright-cli`: 에이전트가 canonical browser skill 이름 `playwright`를 하드코딩하므로 스킬 이름은 유지하고 구현만 CLI로 바꾼다고 주석에 명시한다. 근거: `src/features/builtin-skills/skills/playwright-cli.ts:3-13`.
- `team-mode`: docs-only skill이며 `team_*` 도구는 `team_mode.enabled=true`일 때 전역 등록된다고 설명한다. 근거: `src/features/builtin-skills/skills/team-mode.ts:3-9`, `src/features/builtin-skills/skills/team-mode.ts:181-182`.
- `review-work`: 구현 후 5개 병렬 sub-agent가 목표/QA/코드품질/보안/컨텍스트 누락을 검토하고 모두 통과해야 pass라고 규정한다. 7afa4d08f 이후 스킬 본문이 `packages/shared-skills/skills/review-work/SKILL.md`로 외부화됐고, `src/features/builtin-skills/skills/review-work.ts`는 `loadSharedSkillTemplate("review-work")` 래퍼만 남는다. 근거: `src/features/builtin-skills/skills/review-work.ts @ 7afa4d08f`, `src/features/builtin-skills/skill-file-loader.ts @ 7afa4d08f`.
- `security-research` / `security-review` (신규 @ 7afa4d08f): Team Mode 기반 보안 리서치 스킬. 3명의 취약점 헌터와 2명의 PoC 엔지니어를 병렬로 오케스트레이션해 코드베이스를 감사한다. `security-review`는 `security-research`의 alias 스킬이다. 스킬 본문은 `src/features/builtin-skills/security-research/SKILL.md`에서 로드된다. 근거: `src/features/builtin-skills/skills/security-research.ts @ 7afa4d08f`, `src/features/builtin-skills/skills/security-review.ts @ 7afa4d08f`.
- `init-deep` (신규 스킬 등록 @ 7afa4d08f): 커맨드에서 스킬로 이동. `packages/shared-skills/skills/init-deep/SKILL.md` 기반. 근거: `src/features/builtin-skills/skills/init-deep.ts @ 7afa4d08f`.

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
- 문서/스키마 드리프트가 일부 해소되었으나 여전히 남아 있다. `init-deep`은 커맨드에서 스킬로 이동하면서 `BuiltinCommandNameSchema`에서도 제거됐다 (7afa4d08f). 그러나 `handoff`는 여전히 `BuiltinCommandName` 타입(`src/features/builtin-commands/types.ts:3 @ 7afa4d08f`)에 있지만 `BuiltinCommandNameSchema`(`src/config/schema/commands.ts @ 7afa4d08f`)에는 없다. `disabled_commands` 설정으로 `handoff`를 비활성화할 수 없는 버그가 지속된다. `docs/reference/features.md`의 built-in command 표에도 `/remove-ai-slops`, `/hyperplan`은 여전히 누락 상태다. 근거: `src/features/builtin-commands/types.ts:3 @ 7afa4d08f`, `src/config/schema/commands.ts @ 7afa4d08f`, `docs/reference/features.md:472-484`.
- LSP MCP bootstrap은 런타임에 `git submodule update`, `npm install`, `npm run build`까지 시도할 수 있다. 엄밀한 추론: 오프라인/제한된 샌드박스/기업망에서는 LSP 도구 활성화가 예측 불가능하게 실패하거나 지연될 수 있다. 근거: `src/mcp/lsp.ts:11-33`, `src/mcp/lsp.ts:116-127`.
- 배포 경로가 두 갈래다. workflow는 11개 플랫폼과 `oh-my-opencode`/`oh-my-openagent` dual publish를 처리하지만, `script/publish.ts`의 `PLATFORM_PACKAGE_IDS`에는 `windows-x64-baseline`이 없다. 엄밀한 추론: 공식 workflow가 주 경로라면 실제 릴리스 문제는 아닐 수 있으나, 수동 publish script를 쓰면 누락 위험이 있다. 근거: `script/publish.ts:13-24`, `script/build-binaries.ts:18-30`, `.github/workflows/publish.yml:89-94`, `.github/workflows/publish-platform.yml:43-47`.
- 설치 시 star 요청이 일부 개선됐다 (7afa4d08f). `src/cli/star-request.ts`가 추가되어 `gh api`를 직접 실행하기 전에 `"Star the repos on GitHub? [y/N]"`를 묻도록 변경됐다. 그러나 `docs/guide/installation.md` 문서에서는 여전히 star 명령을 에이전트가 직접 실행하는 형태로 기술하며 LLM agent 지시에 홍보 요청이 남아 있다. 근거: `src/cli/star-request.ts @ 7afa4d08f`, `src/cli/cli-installer.ts @ 7afa4d08f`, `docs/guide/installation.md:604-611`.
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

## 기준 커밋 이후 변경 (2026-06-01 갱신)

HEAD: `7afa4d08ffe9de7189a12ba871884b1023392e22`, 이전 기준: `94d6d5b`. 기간: 약 230+ 커밋. `dev` 브랜치 유지 중.

### 1. `/init-deep` 커맨드 제거 → `init-deep` 스킬로 이동

커밋 `ab0244386` 계통. `src/features/builtin-commands/templates/init-deep.ts` 파일 삭제, `src/features/builtin-commands/commands.ts`에서 `"init-deep"` 항목 제거, `src/features/builtin-commands/types.ts:3`에서 union 타입에서 제거, `src/config/schema/commands.ts`에서 `BuiltinCommandNameSchema` enum에서도 제거됐다. 대신 `src/features/builtin-skills/skills/init-deep.ts`가 `packages/shared-skills/skills/init-deep/SKILL.md`를 로드하는 새 스킬로 등록됐다.

DITTO 영향: 보고서 내 `/init-deep` 커맨드 앵커(`src/features/builtin-commands/templates/init-deep.ts:*`)는 무효다(검증 완료 2026-06-01, `7afa4d08f`에서 파일 부재 확인 — 삭제 확정). 기능은 `src/features/builtin-skills/skills/init-deep.ts`(스킬 래퍼) + `packages/shared-skills/skills/init-deep/SKILL.md`로 이동. "수정 적용" 후보 테이블의 `/init-deep` 항목도 커맨드가 아닌 스킬로 재분류해야 한다.

근거: `src/features/builtin-commands/types.ts:3 @ 7afa4d08f`, `src/features/builtin-skills/skills/init-deep.ts @ 7afa4d08f`, `src/features/builtin-skills/skill-file-loader.ts @ 7afa4d08f`.

### 2. `ai-slop-remover` 스킬 → `remove-ai-slops`로 교체

`src/features/builtin-skills/skills/ai-slop-remover.ts` 삭제, `src/features/builtin-skills/skills/remove-ai-slops.ts`로 교체됐다. 스킬 본문도 `packages/shared-skills/skills/remove-ai-slops/SKILL.md`로 외부화됐다. features.md 스킬 표에서도 이름이 `$omo:remove-ai-slops`로 변경됐다.

근거: `src/features/builtin-skills/skills/remove-ai-slops.ts @ 7afa4d08f`, `docs/reference/features.md @ 7afa4d08f`.

### 3. 신규 스킬 추가: `security-research`, `security-review`

커밋 `2bfad4909`. 보안 리서치 특화 스킬이다. 3개 취약점 헌터 + 2개 PoC 엔지니어를 Team Mode로 병렬 실행해 코드베이스 감사, 익스플로잇 가능성 검증, 심각도 분류를 수행한다. `security-review`는 `security-research`의 alias다. `src/features/builtin-skills/security-research/SKILL.md` (198줄)에 구현체가 있고 `createBuiltinSkills`에 기본 포함됐다.

DITTO 영향: 멀티-에이전트 보안 감사 패턴이 명시적 스킬로 구체화됐다. ditto 적용 후보 테이블의 `review-work` 항목 옆에 `security-research`를 별도 "바로 적용" 후보로 추가할 수 있다.

근거: `src/features/builtin-skills/skills/security-research.ts @ 7afa4d08f`, `src/features/builtin-skills/security-research/SKILL.md @ 7afa4d08f`, `src/features/builtin-skills/skills.ts:46-47 @ 7afa4d08f`.

### 4. Atlas / Prometheus 프롬프트가 `prompts-core` 패키지로 이전

커밋 `4385~4390` 계통. `src/agents/atlas/shared-prompt.ts`, `default-prompt-sections.ts`, `gemini-prompt-sections.ts`, `gpt-prompt-sections.ts`, `kimi-prompt-sections.ts`, `opus-4-7-prompt-sections.ts` 등 Atlas 프롬프트 TypeScript 파일 전부 삭제됐다. 프롬프트 본문은 `packages/prompts-core/prompts/atlas/{default,gpt,gemini,kimi,opus-4-7}.md` markdown 파일로 이동했다. Prometheus도 동일하게 `packages/prompts-core/prompts/prometheus/{default,gpt,gemini}.md`로 이전됐다.

이에 따라 이 보고서에서 인용한 다음 앵커들은 **파일이 삭제되어 무효**다(검증 완료 2026-06-01, `7afa4d08f`에서 삭제·이동 확정):
- `src/agents/atlas/shared-prompt.ts:12-188` — 삭제됨. 본문 이동: `packages/prompts-core/prompts/atlas/{default,gemini,gpt,kimi,opus-4-7}.md`
- `src/agents/atlas/default-prompt-sections.ts`, `gemini-prompt-sections.ts`, `gpt-prompt-sections.ts`, `kimi-prompt-sections.ts`, `opus-4-7-prompt-sections.ts` — 5개 전부 삭제됨(위 markdown으로 통합)
- `src/agents/prometheus/gpt.ts:105-230` — 해당 라인 무효. 현재 파일은 7줄짜리 `loadPromptSync` 래퍼만 남고 본문은 `packages/prompts-core/prompts/prometheus/{default,gemini,gpt}.md`로 이동

Atlas 프롬프트 라우팅(모델별 variant 선택)은 `src/agents/atlas/agent.ts`의 `getAtlasPromptSource`가 담당하며 `@oh-my-opencode/prompts-core`의 `resolveVariant`를 사용한다. 위임 계약 6-section 구조 자체는 유지되지만 마크다운에 있어 직접 라인 인용이 불가능하다.

근거: `src/agents/atlas/agent.ts:1-60 @ 7afa4d08f`, `packages/prompts-core/prompts/atlas/ @ 7afa4d08f`, `packages/prompts-core/src/atlas-prompts.ts @ 7afa4d08f`.

### 5. `context-window-monitor` 훅 제거

커밋 `1432a1141`. `createContextWindowMonitorHook`이 `src/plugin/hooks/create-session-hooks.ts`에서 제거됐다. features.md 훅 목록에서도 `context-window-monitor` 행이 삭제됐다.

DITTO 영향: 보고서 훅 인벤토리에서 이 훅을 언급한 부분이 있다면 해당 항목을 삭제해야 한다.

근거: `src/plugin/hooks/create-session-hooks.ts @ 7afa4d08f`, `docs/reference/features.md:785 @ 7afa4d08f`.

### 6. `omo-codex` Light Edition 도입 (Codex CLI용 경량 버전)

커밋 `ab0244386` 계통. OpenAI Codex CLI용 경량 플러그인 패키지가 추가됐다. `rules`, `comment-checker`, `lsp`, `ultrawork`, `ulw-loop`, `start-work-continuation`, `telemetry`만 포함하며 에이전트 오케스트레이션, `team_*` 도구, 내장 웹/코드 검색 MCP는 없다. `lazycodex`라는 npm alias로 배포되며 `docs/guide/installation.md`에 별도 설치 절차가 추가됐다.

DITTO 영향: oh-my-openagent의 하네스 중립 설계 방향이 실제로 진행 중임을 나타낸다. 핵심 기능(lsp, ulw-loop, start-work-continuation)이 별도 패키지로 추출됐다는 점이 "어댑터 분리" 로드맵과 일치한다.

근거: `docs/guide/installation.md:1-65 @ 7afa4d08f`, `packages/ @ 7afa4d08f`.

### 7. 스킬 본문 외부화 (`shared-skills` 패키지)

`review-work`, `init-deep`, `remove-ai-slops` 등 대형 스킬 본문이 `packages/shared-skills/skills/{name}/SKILL.md`로 이전됐다. `src/features/builtin-skills/skill-file-loader.ts`가 런타임에 파일을 로드하는 로더 유틸리티다.

DITTO 영향: `review-work.ts:3-19`, `review-work.ts:61-68` 등 기존 TypeScript 앵커는 현재 내용이 없는 래퍼만 가리킨다. 실제 검증 규칙 라인은 `packages/shared-skills/skills/review-work/SKILL.md`에 있다.

근거: `src/features/builtin-skills/skill-file-loader.ts @ 7afa4d08f`, `src/features/builtin-skills/skills/review-work.ts @ 7afa4d08f`.

### 8. 설치 시 star 요청에 사용자 확인 추가

커밋 `799a17bc2`. `src/cli/star-request.ts`가 추가되고 `cli-installer.ts`가 `gh api`를 직접 실행하기 전에 `"Star the repos on GitHub? [y/N]"` 인터랙티브 프롬프트를 보여주도록 변경됐다. 기존 보고서의 "명시적 동의 없이 star command를 실행하지 말라는 제한만 있다"는 분석은 더 이상 정확하지 않다. 단, `docs/guide/installation.md:604-611`에서 LLM agent에게 gh star를 직접 실행하도록 지시하는 텍스트는 여전히 존재한다.

근거: `src/cli/star-request.ts @ 7afa4d08f`, `src/cli/cli-installer.ts @ 7afa4d08f`.

## 근거 목록

- 목표/방향: `README.md:1-4`, `README.md:93-125`, `README.md:138-142`, `ROADMAP.md:11-20`, `ROADMAP.md:21-49`, `ROADMAP.md:53-88`.
- 패키지/배포: `package.json:1-138`, `bin/oh-my-opencode.js:1-153`, `script/build-binaries.ts:18-30`, `script/publish.ts:13-24`, `.github/workflows/publish.yml:68-134`, `.github/workflows/publish-platform.yml:37-47`.
- 플러그인 조립: `src/testing/create-plugin-module.ts:77-181`, `src/plugin-interface.ts:35-91`, `src/create-managers.ts:41-161`, `src/create-tools.ts:22-52`, `src/create-hooks.ts:35-98`, `src/plugin/tool-registry.ts:177-375`.
- 설정: `docs/reference/configuration.md:44-59`, `docs/reference/configuration.md:172-361`, `docs/reference/configuration.md:621-960`, `docs/reference/configuration.md:962-1023`, `src/plugin-config.ts:65-450`, `src/shared/plugin-identity.ts:1-8`.
- CLI/설치: `src/cli/cli-program.ts:25-222`, `docs/reference/cli.md:1-225`, `docs/guide/installation.md:1-170`, `docs/guide/installation.md:447-499`.
- 오케스트레이션/에이전트: `docs/guide/orchestration.md:1-100`, `docs/guide/orchestration.md:104-188`, `docs/guide/orchestration.md:192-278`, `docs/guide/orchestration.md:298-383`, `docs/guide/overview.md:48-162`, `src/agents/builtin-agents.ts:32-180`, `src/agents/sisyphus/gpt-5-5.ts:45-240`, `src/agents/atlas/shared-prompt.ts:12-188 (삭제됨 @ 7afa4d08f — packages/prompts-core/prompts/atlas/*.md로 이전)`, `src/agents/prometheus/gpt.ts:105-230 (삭제됨 @ 7afa4d08f — packages/prompts-core/prompts/prometheus/*.md로 이전)`, `src/agents/explore.ts:1-100`, `src/agents/oracle.ts:1-120`.
- 명령/스킬/도구/MCP: `src/features/builtin-commands/types.ts:1-9`, `src/features/builtin-commands/commands.ts:1-164`, `src/features/builtin-commands/templates/init-deep.ts:1-270`, `src/features/builtin-skills/skills.ts:1-47`, `src/features/builtin-skills/skills/playwright.ts:1-60`, `src/features/builtin-skills/skills/playwright-cli.ts:1-50`, `src/features/builtin-skills/skills/team-mode.ts:1-184`, `src/features/builtin-skills/skills/review-work.ts:1-115`, `src/mcp/index.ts:1-56`, `src/mcp/lsp.ts:1-167`, `src/mcp/ast-grep.ts:1-129`, `src/mcp/websearch.ts:1-42`, `src/mcp/context7.ts:1-9`, `docs/reference/features.md:468-735`, `docs/guide/team-mode.md:1-151`.

## ditto 적용 정리

1. 하네스 중립 코어와 어댑터 경계를 ditto의 기본 구조로 둔다.
   - 적용할 기능/가치: OpenCode 전용 이벤트와 도구 조립을 그대로 복제하지 않고, 작업 정의, 에이전트 호출, 도구 등록, 훅 결과, 감사 기록, 핸드오프 기록은 하네스 중립 코어 계약으로 둔다. 이는 ditto가 범용 coding agent harness를 목표로 하고, 단계 간 상태 전이를 정규화된 interface 또는 문서 양식으로 연결해야 한다는 PURPOSE.md의 목적/핵심 기능과 맞다.
   - 적용 방식: Codex, OpenCode, Claude Code 같은 호스트별 이벤트명과 lifecycle 처리는 어댑터 안에서만 번역하고, 코어는 좁은 interface 위에 깊은 구현을 둔다. oh-my-openagent의 Core/MCP/Skills/Adapters DAG 원칙은 참고하되, 현재 구현처럼 OpenCode plugin surface가 코어로 새지 않게 한다.
   - 적용 이후 제공 가치: ditto의 오케스트레이션, 감사 기록, 핸드오프, 지식 영속화가 특정 하네스 교체에 흔들리지 않는다. 사용자는 호스트별 세부 차이를 몰라도 같은 작업 언어와 같은 상태 전이로 이어서 작업할 수 있어 인지 비용이 줄어든다.
   - 주의할 리스크나 선행 조건: 이 보고서는 oh-my-openagent가 아직 OpenCode에 강하게 결합되어 있고 hook injection race, duplicate work, infinite loop, state corruption 위험을 로드맵에서 인정한다고 정리했다. 따라서 ditto는 어댑터 계약과 상태 전이 테스트를 먼저 만들고, hook은 마지막 통합 지점으로 제한해야 한다.
   - 근거: PURPOSE.md의 범용 coding agent harness, 정규화된 interface, Deep Module 지향. 보고서의 `ROADMAP.md:27-49`, `ROADMAP.md:66-88`, `src/plugin-interface.ts:35-91`, `src/create-hooks.ts:58-90`.

2. delegation prompt contract와 의미 기반 category 라우팅을 ditto 표준 작업 계약으로 채택한다.
   - 적용할 기능/가치: 모델명이나 provider명이 아니라 `visual-engineering`, `ultrabrain`, `deep`, `quick` 같은 의미 기반 category로 작업을 라우팅하고, 위임 요청은 `TASK`, `EXPECTED OUTCOME`, `REQUIRED TOOLS`, `MUST DO`, `MUST NOT DO`, `CONTEXT` 같은 명시 섹션을 갖게 한다. 이는 PURPOSE.md의 Ubiquitous Language, 사용자 의도 이탈 방지, 불필요한 사용자 질문 금지와 직접 연결된다.
   - 적용 방식: ditto의 task/subagent 호출 interface에 목표, 기대 산출물, 허용 도구, 금지 사항, 필요한 컨텍스트, 완료 후 검증 조건을 필수 필드로 둔다. category dispatch와 특정 subagent 호출은 한 요청에서 상호 배타적으로 처리하고, fallback 모델 선택은 설정/doctor가 관리하게 한다.
   - 적용 이후 제공 가치: 사용자는 모델 세부를 판단하지 않고 작업 의미만 말하면 되고, subagent는 같은 계약을 받아 범위 밖 작업과 추측을 줄인다. parent agent도 post-delegation verification을 같은 형식으로 수행할 수 있다.
   - 주의할 리스크나 선행 조건: category 이름, agent 이름, config schema, 문서가 어긋나면 oh-my-openagent의 `/handoff` schema 누락처럼 실제 disable/config 동작이 깨질 수 있다. ditto는 명령, category, schema, 문서의 single source-of-truth가 필요하다.
   - 근거: PURPOSE.md의 사용자 인지 비용 최소화, 의도 파악/모호성 해결, 정제된 출력 메시지. 보고서의 `docs/guide/orchestration.md:96-100`, `docs/guide/orchestration.md:298-330`, `docs/reference/configuration.md:290-307`, `src/agents/sisyphus/gpt-5-5.ts:204-216`, `src/agents/atlas/shared-prompt.ts:45-86`.

3. 병렬 탐색, 배경 작업, 구현 후 적대적 검토를 context rot 대응 경로로 적용한다.
   - 적용할 기능/가치: 초기 현황 파악은 읽기 전용 explore/librarian류 subagent를 병렬로 사용하고, 구현 후에는 목표 적합성, QA, 코드 품질, 보안, 컨텍스트 누락을 분리 검토한다. 이는 PURPOSE.md의 subagent 적극 사용, 멀티 모델 정반합 기반 적대적 검토, 장기 실행 작업 완수, 할루시네이션 방지와 맞다.
   - 적용 방식: 복잡한 작업의 첫 단계에서 독립적인 조사 단위를 background session으로 fan-out하고, parent agent는 결과를 병합해 최소 변경 계획을 만든다. 구현 후에는 파일 재읽기, diagnostics, 테스트, review subagent 결과를 acceptance criteria별로 묶어 통과/부분 통과/미검증을 기록한다.
   - 적용 이후 제공 가치: 한 agent의 좁아진 컨텍스트나 자기 확신에 작업 전체가 끌려가지 않는다. 긴 작업에서도 조사 근거, 구현 결과, 검증 결과가 분리되어 남기 때문에 이어받는 세션의 인지 비용과 재조사 비용이 줄어든다.
   - 주의할 리스크나 선행 조건: 병렬화는 duplicate work와 state corruption을 만들 수 있다. Team Mode 전체를 바로 복제하기보다 bounded background delegation, 소유 파일/출력 범위, 취소/idle 상태, durable task record를 먼저 구현해야 한다.
   - 근거: PURPOSE.md의 Context Rot 해결, subagent 사용, 멀티 모델 적대적 검토, 장기 실행 완수. 보고서의 `src/agents/sisyphus/gpt-5-5.ts:68-78`, `src/features/builtin-commands/templates/init-deep.ts:38-54`, `src/features/builtin-skills/skills/review-work.ts:61-68`, `docs/guide/team-mode.md:83-147`, `src/plugin/tool-registry.ts:199-261`.

4. 감사 기록, durable task, handoff, run 종료 조건을 하나의 연속성 기능으로 묶는다.
   - 적용할 기능/가치: 모든 액션의 감사 기록, 주요 결정 및 변경사항 영속화, 새 세션/다른 기기에서 이어서 작업을 ditto의 작업 상태 모델로 구현한다. oh-my-openagent의 task system, session 도구, `/handoff`, `run`의 background idle 대기 조건이 이 요구에 대응된다.
   - 적용 방식: 각 action record에는 의도, 입력, 사용 도구, 변경 파일, 근거, 검증 결과, 미검증 항목을 저장한다. task/todo가 완료 또는 취소되고 background child session이 idle일 때만 run을 종료하며, handoff는 다음 agent가 바로 판단할 수 있게 남은 위험과 필요한 fresh evidence를 포함한다.
   - 적용 이후 제공 가치: ditto는 장기 작업을 중간에 잃지 않고, 완료 주장을 감사 가능한 증거 위에 올릴 수 있다. 사용자는 이전 대화나 소스 전체를 다시 읽지 않아도 현재 상태와 다음 검증 대상을 파악할 수 있다.
   - 주의할 리스크나 선행 조건: 보고서의 task system은 `.omo/tasks/` 파일 저장과 restart persistence를 설명하지만 Claude Code 내부 Task tool 관찰에 기반한 자체 구현이라고 경고한다. ditto는 저장 포맷, lock, crash recovery, 중복 실행 방지를 먼저 정해야 한다.
   - 근거: PURPOSE.md의 감사 기록, 핸드오프 지원, 주요 결정 영속화, 장기간 실행 완수. 보고서의 `docs/reference/features.md:646-726`, `src/cli/cli-program.ts:74-134`, `docs/reference/cli.md:90-96`, `src/features/builtin-commands/commands.ts:122-137`.

5. 근거 기반 코드 도구와 안전한 설정 경계를 기본값으로 삼는다.
   - 적용할 기능/가치: LSP diagnostics/rename/reference, AST-grep 구조 검색/치환, hashline edit의 stale-write 방지, user-only `mcp_env_allowlist`, Playwright CLI 계열 브라우저 검증을 ditto의 evidence path로 채택한다. 이는 PURPOSE.md의 할루시네이션 방지, E2E 테스트 도구 필요, 사용자 의도 밖 작업 제한과 맞다.
   - 적용 방식: 코드 이해와 리팩터링은 grep/glob만으로 닫지 않고 LSP와 AST 구조 검색을 연결한다. 편집 도구에는 line number만이 아니라 content hash나 precondition을 넣고, 프로젝트 config가 비밀 환경변수 allowlist를 확장하지 못하게 한다. 브라우저 검증은 MCP 의존만 두지 않고 CLI 실행 경로를 제공한다.
   - 적용 이후 제공 가치: agent의 주장은 실제 diagnostics, reference, structural match, browser run 같은 fresh evidence로 닫힌다. stale line edit과 repo-supplied config 공격면이 줄어 사용자의 코드와 비밀값을 덜 위험하게 다룰 수 있다.
   - 주의할 리스크나 선행 조건: 보고서의 LSP MCP는 런타임에 `git submodule update`, `npm install`, `npm run build`까지 시도할 수 있어 오프라인/기업망/샌드박스에서 예측 불가능하다. ditto는 설치 또는 doctor 단계에서 선검증하고, 실패 시 degraded mode와 미검증 항목을 명확히 표시해야 한다.
   - 근거: PURPOSE.md의 할루시네이션 방지, E2E 테스트 도구, 사용자 의도 밖 작업 제한. 보고서의 `docs/reference/features.md:604-623`, `src/mcp/lsp.ts:7-33`, `src/mcp/ast-grep.ts:117-129`, `docs/reference/configuration.md:56-58`, `src/plugin-config.ts:430-437`, `docs/reference/configuration.md:952-960`, `src/features/builtin-skills/skills/playwright-cli.ts:3-13`.

## ditto 적용 요소 후보 (skills/agents/commands/hooks)

| 우선순위 | 종류 | 요소 | DITTO 적용안 | 효과/주의 |
| --- | --- | --- | --- | --- |
| 바로 적용 | skill | `review-work` | 구현 후 목표 적합성, QA, 코드 품질, 보안, 컨텍스트 누락을 병렬 read-only review로 나누는 DITTO skill로 둔다. 결과는 acceptance criteria별 pass/partial/missing으로 합친다. | 멀티 관점 검증에 즉시 효과가 있다. 작은 diff에는 lightweight 모드가 필요하다. |
| 바로 적용 | skill | `playwright-cli` | E2E/브라우저 검증은 MCP에만 의존하지 않고 CLI 실행 경로를 기본으로 둔다. canonical skill 이름은 `playwright`로 유지하고 구현 provider만 교체 가능하게 한다. | PURPOSE.md의 E2E 테스트 요구에 맞다. 브라우저 설치/환경 실패는 미검증으로 명시해야 한다. |
| 바로 적용 | command | `/handoff` | 세션 종료/전환/compaction 전 DITTO handoff command로 차용한다. 현재 목표, 변경 파일, 결정, 검증 결과, 미검증, 다음 fresh evidence를 구조화한다. | 새 세션 재개 품질이 좋아진다. 민감정보 제거와 artifact 경로 정책이 필요하다. |
| 바로 적용 | agent | `Explore` | 초기 코드베이스 탐색용 read-only subagent로 둔다. LSP/AST/grep 결과와 파일 근거를 요약해 parent에 반환한다. | context rot과 탐색 비용을 줄인다. 작성 권한과 재위임은 금지해야 한다. |
| 수정 적용 | command | `/init-deep` | 대규모 repo 진입 시 병렬 explore로 계층형 `AGENTS.md`나 codemap을 만드는 command로 축소 적용한다. DITTO에서는 기존 AGENTS를 덮지 않고 제안/patch artifact로 남긴다. | onboarding과 repo map 생성에 유용하다. 자동 지침 파일 수정은 위험하므로 승인/검증이 필요하다. |
| 수정 적용 | agent | `Sisyphus`, `Atlas`, `Prometheus` | 이름은 그대로 쓰지 않더라도 역할을 DITTO `orchestrator`, `plan-executor`, `planner/interviewer`로 나눈다. 6-section delegation prompt와 silent exploration/clearance checklist를 계약화한다. | 구조 추상화가 아니라 구체 agent contract 후보가 된다. category와 agent 이름 drift를 schema로 막아야 한다. |
| 수정 적용 | tool | `task`, `background_output`, `session_*`, task system | background subagent handle, session read/search, durable task 파일을 DITTO subagent 실행 단위에 적용한다. task id, source session, readable range, cancel 상태를 감사 기록에 연결한다. | 긴 작업 재개성과 병렬 탐색에 효과적이다. 중복 실행과 stale session 강화 리스크가 있다. |
| 수정 적용 | hook | continuation, compaction, todo continuation, babysitter, skill reminder | 자동 계속하기는 todo/background 상태와 primary authority가 있을 때만 허용한다. compaction 전 handoff와 skill reminder는 context가 줄어든 시점에만 넣는다. | 장기 작업 중단을 줄인다. hook 주입이 많아지면 prompt noise가 생기므로 빈도 제한이 필요하다. |
| 수정 적용 | tool/MCP | LSP, AST-grep, hashline edit | diagnostics/reference/rename/structural search를 code evidence path로 둔다. hashline edit은 stale write 방지용 precondition으로만 사용한다. | 리팩터링 안전성이 좋아진다. 런타임 npm install/build를 자동 실행하지 말고 doctor에서 선검증해야 한다. |
