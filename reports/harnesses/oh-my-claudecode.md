# oh-my-claudecode 참고 하네스 분석

## 분석 대상 및 기준 커밋

- 대상 저장소: `https://github.com/Yeachan-Heo/oh-my-claudecode`
- 로컬 분석 경로: `/private/tmp/ditto-harness-analysis/oh-my-claudecode`
- 기준 커밋: `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f` (이전 기준)
- **갱신 커밋**: `ed7800dd73b9ef1811b6f777b2017baabda9962a` @ 2026-06-01 (이전 기준: `1fe17f0`, 갱신 사유: 48개 신규 커밋, v4.14.4 릴리스)
- 기준 패키지/플러그인 버전: npm 패키지 `oh-my-claude-sisyphus` `4.14.4`, Claude Code 플러그인 `oh-my-claudecode` `4.14.4`. 근거: `package.json:2-4`, `.claude-plugin/plugin.json:2-4` @ `ed7800dd`.

이 보고서의 `repo-relative/path:line` 근거는 섹션별로 명시된 커밋 기준이다. 기준 커밋 이후 변경 섹션의 근거는 `ed7800dd`에서 확인했다. 갱신 이전 섹션의 근거는 원래 기준 `1fe17f0`에서 확인한 것이며, 갱신 섹션에서 수정한 내용은 별도 주기했다.

## 조사 방법

1. `gh repo clone Yeachan-Heo/oh-my-claudecode /private/tmp/ditto-harness-analysis/oh-my-claudecode`로 저장소를 클론하고 `git rev-parse HEAD`로 기준 커밋을 확인했다.
2. `README.md`, `docs/ARCHITECTURE.md`, `docs/REFERENCE.md`, `docs/TOOLS.md`, `docs/HOOKS.md`, `docs/TEAM-WORKTREE-MODE.md`, `docs/settings-schema.md`, `docs/COMPATIBILITY.md`를 중심으로 문서상 의도와 실제 구현의 대응을 확인했다.
3. 플러그인/패키지 메타데이터는 `package.json`, `.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`을 확인했다.
4. 소스는 `src/cli`, `src/hooks`, `src/mcp`, `src/tools`, `src/installer`, `src/team`, `src/features/builtin-skills`, `src/agents`, `src/config`를 중심으로 읽었다.
5. 프롬프트/스킬/명령 정의는 `skills/*/SKILL.md`, `commands/*.md`, `agents/*.md`를 조사했다. 실제 파일 수는 `find skills -maxdepth 2 -name SKILL.md | wc -l` 결과 39개, `find commands -maxdepth 1 -type f -name '*.md' | wc -l` 결과 27개, `find agents -maxdepth 1 -type f -name '*.md' | wc -l` 결과 19개로 확인했다. 플러그인 매니페스트도 39개 스킬 디렉터리를 열거한다. 근거: `.claude-plugin/plugin.json:18-58` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.

## 핵심 특징

1. OMC는 단순한 프롬프트 팩이 아니라 Claude Code 플러그인, Node 기반 훅, MCP 도구 서버, 스킬 프롬프트, 에이전트 프롬프트, CLI 런타임이 결합된 오케스트레이션 하네스다. 문서는 네 축을 Hooks, Skills, Agents, State로 정의하고, 사용자 입력이 훅 감지, 스킬 주입, 에이전트 실행, 상태 추적으로 흐른다고 설명한다. 근거: `docs/ARCHITECTURE.md:7`, `docs/ARCHITECTURE.md:39-44` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.
2. 사용자 노출면은 터미널 CLI와 Claude Code 세션 내 스킬로 분리된다. README는 `omc team`과 `/team`이 모두 존재하지만 서로 다른 런타임이라고 명시하고, Autopilot/Ralph/Ultrawork/Deep Interview는 세션 내 스킬이라고 못박는다. 근거: `README.md:105-119` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.
3. Team이 권장 병렬 실행 표면이다. README는 Team을 canonical orchestration surface로 부르고, `team-plan -> team-prd -> team-exec -> team-verify -> team-fix` 단계 파이프라인을 제시한다. 근거: `README.md:130-142`, `skills/team/SKILL.md:98-154` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.
4. 지속 실행 루프는 Stop 훅으로 강제된다. `persistent-mode`는 Stop 이벤트를 가로채 Ralph, Ultrawork, todo continuation 등을 우선순위에 따라 계속 진행시키는 훅으로 작성되어 있다. 근거: `src/hooks/persistent-mode/index.ts:1-10`, `hooks/hooks.json:172-190`, `src/hooks/persistent-mode/index.ts:2162-2175` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.
5. 과도한 자동화를 막기 위한 방어 로직이 많다. 예를 들어 Team 자연어 키워드는 무한 스폰 방지를 위해 명시적 `/team`만 허용되며, 작은 작업에서는 heavy mode가 억제되고, 불명확한 실행 요청은 `ralplan`으로 우회된다. 근거: `src/hooks/keyword-detector/index.ts:44-63`, `src/hooks/keyword-detector/index.ts:743-782`, `src/hooks/keyword-detector/index.ts:804-930` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.
6. 상태 설계는 `.omc/` 아래의 제어 평면과 데이터 평면을 분리한다. 문서는 `.omc/state/**`를 큐/세션/워커 상태, `.omc/plans`, `.omc/prompts`, `.omc/notepads` 등을 durable artifact로 분리하라고 명시한다. 근거: `docs/ARCHITECTURE.md:428-459`, `docs/ARCHITECTURE.md:461-498`, `docs/REFERENCE.md:253-290` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.
7. MCP 도구는 내부 에이전트가 사용하는 코드 지능/상태/메모리/분석 표면이다. 도구 레지스트리는 LSP, AST, Python REPL, state, notepad, memory, trace, shared memory, deepinit, wiki, skills 도구를 한 배열로 집계한다. 근거: `docs/TOOLS.md:1-20`, `src/mcp/tool-registry.ts:1-14`, `src/mcp/tool-registry.ts:48-61` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.
8. 설치/배포는 플러그인 우선을 지향하지만 npm CLI 경로도 남아 있다. README는 marketplace/plugin 설치를 권장하면서 npm CLI/runtime 설치도 안내한다. 반면 `docs/REFERENCE.md`는 plugin method만 supported라고 말해 문서 간 정책 불일치가 있다. 근거: `README.md:50-71`, `docs/REFERENCE.md:31-45` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.

## 구조/아키텍처

### 패키지/플러그인 레이어

- npm 패키지는 `bridge/cli.cjs`를 `oh-my-claudecode`, `omc`, `omc-cli` 세 bin 이름으로 노출한다. 즉 터미널 CLI 진입점은 모두 같은 bridge 엔트리로 수렴한다. 근거: `package.json:14-18` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.
- publish 대상은 `dist`, `agents`, `bridge`, `commands`, `hooks`, `scripts`, `skills`, `templates`, `docs`, `.claude-plugin`, `.mcp.json`까지 포함한다. 이는 하네스의 실제 런타임이 소스 코드뿐 아니라 프롬프트/훅/템플릿 파일에 의존함을 보여준다. 근거: `package.json:19-39` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.
- build 스크립트는 TypeScript 컴파일 뒤 skill bridge, MCP server, bridge entry, docs, runtime CLI, team server, CLI 번들을 모두 생성한다. 근거: `package.json:40-49` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.
- Node 최소 버전은 `>=20.0.0`이며, 설치 훅도 Node 20을 최소값으로 둔다. 근거: `package.json:100-102`, `src/installer/hooks.ts:65-66` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.

### Claude Code 플러그인 레이어

- `.claude-plugin/plugin.json`은 39개 스킬 디렉터리, MCP 서버 설정 파일, commands 디렉터리를 Claude Code 플러그인 표면으로 등록한다. 근거: `.claude-plugin/plugin.json:18-60` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.
- `.mcp.json`은 MCP 서버 이름 `t`를 `node ${CLAUDE_PLUGIN_ROOT}/bridge/mcp-server.cjs`로 실행하도록 정의한다. 근거: `.mcp.json:1-7` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.
- hooks 매니페스트는 플러그인 루트의 `scripts/run.cjs`를 통해 각 `.mjs` 훅을 실행한다. 예: UserPromptSubmit은 `keyword-detector.mjs`와 `skill-injector.mjs`, Stop은 `context-guard-stop.mjs`, `persistent-mode.mjs`, `code-simplifier.mjs`를 등록한다. 근거: `hooks/hooks.json:4-18`, `hooks/hooks.json:172-190` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.

### CLI 레이어

- CLI는 `commander` 기반이며 `launch`, `interop`, `ask`, `config`, `setup`, `hud`, `mission-board`, `team`, `autoresearch`, `ralphthon`, `ultragoal` 등 다수의 명령을 정의한다. 근거: `src/cli/index.ts:129`, `src/cli/index.ts:157`, `src/cli/index.ts:172`, `src/cli/index.ts:185`, `src/cli/index.ts:1235`, `src/cli/index.ts:1371`, `src/cli/index.ts:1386`, `src/cli/index.ts:1416`, `src/cli/index.ts:1430`, `src/cli/index.ts:1447`, `src/cli/index.ts:1467` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.
- `omc --plugin-dir <path>`는 플래그를 소비하지 않고 절대 경로로 해석해 `OMC_PLUGIN_ROOT`에 넣은 뒤 Claude Code로 그대로 넘긴다. 이는 HUD/훅/플러그인 로더가 같은 checkout을 보도록 하기 위한 장치다. 근거: `src/cli/launch.ts:687-712`, `docs/REFERENCE.md:294-324` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.
- launcher는 nested Claude Code 세션을 막고, `claude` CLI 존재를 preflight로 확인한다. 근거: `src/cli/launch.ts:762-773` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.

### 훅 레이어

- 실제 hooks 매니페스트는 UserPromptSubmit, SessionStart, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, SubagentStart, SubagentStop, PreCompact, Stop, SessionEnd를 등록한다. 근거: `hooks/hooks.json:4-211`, `docs/ARCHITECTURE.md:321-344` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.
- 훅 브리지는 `DISABLE_OMC`, `OMC_SKIP_HOOKS`를 kill switch로 처리하고, 개별 훅 처리 중 오류가 나도 실행을 막지 않고 `continue: true`로 fail-open한다. 근거: `src/hooks/bridge.ts:3020-3031`, `src/hooks/bridge.ts:3255-3262` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.
- persistent-mode는 context-limit, explicit cancel, user abort, rate limit, auth error, scheduled wakeup, oversized tool result redirect, pending async work를 continuation 강제에서 제외한다. 근거: `src/hooks/persistent-mode/index.ts:1898-2014` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.

### 에이전트 레이어

- 문서상 기본 에이전트는 19개이며 4개 lane으로 설명된다. 실제 `agents/*.md`도 19개다. 근거: `docs/ARCHITECTURE.md:52-100`, `agents/executor.md:1-6`, `agents/planner.md:1-6`, `agents/verifier.md:1-6` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.
- `docs/REFERENCE.md`의 "Agents (29 Total)"는 tier variant까지 포함한 참조표다. 예를 들어 `architect-low`, `architect-medium`, `architect`, `executor-low`, `executor`, `executor-high` 식으로 역할별 변형을 표기한다. 근거: `docs/REFERENCE.md:504-530` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.
- 소스의 기본 시스템 프롬프트는 19개 에이전트, workflow, delegation principles, completion checklist를 포함한다. 근거: `src/agents/definitions.ts:290-405` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.

### 스킬/명령 레이어

- 스킬은 사용자 명령이라기보다 "behavior injection"으로 정의된다. 문서는 Execution, Enhancement, Guarantee 레이어를 설명하고, Autopilot/Ralph/Ultrawork/Team/CCG/Ralplan을 core workflow skills로 둔다. 근거: `docs/ARCHITECTURE.md:174-268` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.
- 실제 built-in skill loader는 `skills/*/SKILL.md`를 단일 소스로 읽고, frontmatter alias, pipeline metadata, resource guidance, runtime guidance를 렌더링한다. 근거: `src/features/builtin-skills/skills.ts:1-10`, `src/features/builtin-skills/skills.ts:231-288`, `src/features/builtin-skills/skills.ts:291-360` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.
- `commands/*.md`는 대부분 compatibility shim이며, 전체 스킬 본문을 항상 세션에 로드하지 않도록 `skills/<name>/SKILL.md`를 찾아 읽고 그대로 따르라고 지시한다. 근거: `commands/ask.md:5-18`, `commands/omc-setup.md:5-18` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.

### Team 런타임

- `omc team` CLI는 tmux worker pane을 띄우는 터미널 런타임이고, `/team`은 세션 내 native team workflow다. 근거: `README.md:105-119`, `README.md:156-183` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.
- runtime v2는 기본 활성화이며 `done.json` polling을 없애고 CLI API lifecycle transition, monitor snapshot, heartbeat로 완료를 감지한다. 근거: `src/team/runtime-v2.ts:1-17` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.
- worker prompt는 `omc team api claim-task`와 `transition-task-status`를 반드시 실행하도록 만들고, `done.json` 직접 작성/태스크 파일 직접 편집을 금지한다. 근거: `src/team/runtime-v2.ts:432-473` @ `1fe17f0e19ec9e24c5964d4363a9f53aab45c73f`.

## 도구/명령/스크립트/프롬프트 인벤토리

### 패키지 및 빌드 스크립트

- npm bin: `oh-my-claudecode`, `omc`, `omc-cli` -> `bridge/cli.cjs`. 근거: `package.json:14-18`.
- 주요 build/test/lint 스크립트: `build`, `build:bridge`, `build:mcp-server` 성격의 빌드 단계, `test`, `test:run`, `test:coverage`, `lint`, `format`, release/sync 계열. 정확한 스크립트 목록은 `package.json:40-68`.
- 주요 런타임 의존성: `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, `@ast-grep/napi`, `better-sqlite3`, `commander`, `jsonc-parser`, `zod`. 근거: `package.json:70-83`.

### CLI 명령

- 최상위/운영: `launch`, `interop`, `ask`, `config`, `config-stop-callback`, `config-notify-profile`, `info`, `test-prompt`, `update`, `update-reconcile`, `version`, `install`, `wait`, `teleport`, `session`, `doctor`, `setup`, `hud`, `mission-board`, `team`, `autoresearch`, `ralphthon`, `ultragoal`. 근거: `src/cli/index.ts:129-1467`.
- `setup`은 plugin-dir mode 자동 감지, `--no-plugin` 충돌 처리, installer 호출을 담당한다. 근거: `src/cli/index.ts:1235`, `src/cli/index.ts:1262-1293`.
- `team`은 `teamCommand(args)`로 위임한다. 근거: `src/cli/index.ts:1416-1424`.
- `autoresearch` CLI는 hard-deprecated shim이고, 권위 있는 경로는 deep-interview와 stateful skill이다. 근거: `src/cli/index.ts:1430-1438`, `README.md:363-377`.
- `ultragoal` CLI는 hidden Claude `/goal` state를 직접 변경하지 못하고 artifact/handoff만 남긴다고 명시한다. 근거: `src/cli/index.ts:1457-1464`, `docs/REFERENCE.md:570-600`.

### 플러그인 훅 스크립트

- UserPromptSubmit: `keyword-detector.mjs`, `skill-injector.mjs`. 근거: `hooks/hooks.json:4-18`.
- SessionStart: `session-start.mjs`, `project-memory-session.mjs`, `wiki-session-start.mjs`, init/maintenance용 `setup-init.mjs`, `setup-maintenance.mjs`. 근거: `hooks/hooks.json:21-61`.
- PreToolUse/PermissionRequest/PostToolUse 계열: `pre-tool-enforcer.mjs`, `permission-handler.mjs`, `post-tool-verifier.mjs`, `project-memory-posttool.mjs`, `post-tool-rules-injector.mjs`, `post-tool-use-failure.mjs`. 근거: `hooks/hooks.json:63-119`.
- Subagent/Compaction/Stop/SessionEnd: `subagent-tracker.mjs`, `verify-deliverables.mjs`, `pre-compact.mjs`, `project-memory-precompact.mjs`, `wiki-pre-compact.mjs`, `context-guard-stop.mjs`, `persistent-mode.mjs`, `code-simplifier.mjs`, `session-end.mjs`, `wiki-session-end.mjs`. 근거: `hooks/hooks.json:121-210`.
- 설치 모듈은 Bash hooks가 v3.9.0에서 제거되고 Node `.mjs` 훅으로 통일되었다고 주석으로 명시한다. 근거: `src/installer/index.ts:1-9`, `src/installer/hooks.ts:1-9`.

### MCP 도구

- 레지스트리 집계: LSP, AST, Python REPL, state, notepad, project memory, trace, shared memory, deepinit manifest, wiki, skills를 `allTools`로 묶는다. 근거: `src/mcp/tool-registry.ts:16-61`.
- in-process MCP 서버는 `OMC_DISABLE_TOOLS`로 `lsp`, `ast`, `python`, `state`, `notepad`, `memory`, `skills`, `interop`, `codex`, `gemini`, `shared-memory`, `deepinit`, `wiki` 등의 그룹을 비활성화할 수 있다. 근거: `src/mcp/omc-tools-server.ts:37-59`, `src/mcp/omc-tools-server.ts:111-144`.
- LSP 도구: `lsp_hover`, `lsp_goto_definition`, `lsp_find_references`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_diagnostics`, `lsp_servers`, `lsp_prepare_rename`, `lsp_rename`, `lsp_code_actions`, `lsp_code_action_resolve`, `lsp_diagnostics_directory`. 근거: `src/tools/lsp-tools.ts:93-451`, `docs/TOOLS.md:332-445`.
- AST 도구: `ast_grep_search`, `ast_grep_replace`; replace는 dry run 우선 사용을 문서가 요구한다. 근거: `src/tools/ast-tools.ts:290`, `src/tools/ast-tools.ts:443`, `docs/TOOLS.md:456-544`.
- Python REPL: `python_repl`은 세션 내 상태가 지속되는 Python 실행 환경이다. 근거: `src/tools/python-repl/tool.ts:681`, `docs/TOOLS.md:547-628`.
- State 도구: `state_read`, `state_write`, `state_clear`, `state_list_active`, `state_get_status`. 근거: `src/tools/state-tools.ts:469-1300`, `docs/TOOLS.md:23-105`.
- Notepad 도구: `notepad_read`, `notepad_write_priority`, `notepad_write_working`, `notepad_write_manual`, `notepad_prune`, `notepad_stats`. 근거: `src/tools/notepad-tools.ts:38-315`, `docs/ARCHITECTURE.md:499-522`.
- Project memory 도구: `project_memory_read`, `project_memory_write`, `project_memory_add_note`, `project_memory_add_directive`. 근거: `src/tools/memory-tools.ts:32-220`, `docs/ARCHITECTURE.md:523-542`.
- Trace/shared memory/skills/deepinit/wiki: `trace_timeline`, `trace_summary`, `shared_memory_*`, `load_omc_skills_local`, `load_omc_skills_global`, `list_omc_skills`, `deepinit_manifest`, `wiki_*`. 근거: `src/tools/trace-tools.ts:218-300`, `src/tools/shared-memory-tools.ts:60-259`, `src/tools/skills-tools.ts:105-142`, `src/tools/deepinit-manifest.ts:411`, `src/tools/wiki-tools.ts:44-383`, `docs/TOOLS.md:631-781`.
- Interop 도구는 opt-in이며 `OMC_INTEROP_TOOLS_ENABLED=1`일 때만 in-process server에 포함된다. 도구명은 `interop_send_task`, `interop_read_results`, `interop_send_message`, `interop_read_messages`, `interop_list_omx_teams`, `interop_send_omx_message`, `interop_read_omx_messages`, `interop_read_omx_tasks`다. 근거: `src/mcp/omc-tools-server.ts:90-109`, `src/interop/mcp-bridge.ts:93-557`.

### 에이전트 프롬프트

- 실제 agent 파일은 19개: `analyst`, `architect`, `code-reviewer`, `code-simplifier`, `critic`, `debugger`, `designer`, `document-specialist`, `executor`, `explore`, `git-master`, `planner`, `qa-tester`, `scientist`, `security-reviewer`, `test-engineer`, `tracer`, `verifier`, `writer`. 근거: `docs/ARCHITECTURE.md:52-100` 및 `agents/*.md`.
- `executor`는 작은 diff, LSP diagnostics, fresh build/test, no scope creep, no single-use abstraction을 성공 기준으로 둔다. 근거: `agents/executor.md:21-40`, `agents/executor.md:43-80`, `agents/executor.md:95-120`.
- `planner`는 구현하지 않고 `.omc/plans/*.md`에 3-6단계 계획을 만들며, 사용자에게 코드베이스 사실을 묻지 말고 explore agent로 확인하라고 한다. 근거: `agents/planner.md:9-18`, `agents/planner.md:21-43`, `agents/planner.md:45-69`.
- `verifier`는 "fresh evidence" 중심의 독립 검증 pass이며, acceptance criteria별 VERIFIED/PARTIAL/MISSING 상태와 command output을 요구한다. 근거: `agents/verifier.md:9-34`, `agents/verifier.md:36-85`.
- `code-reviewer`, `security-reviewer`, `critic`은 모두 read-only 성격이며 Write/Edit이 disallowed tools로 지정되어 있다. 각각 코드 품질/보안/계획 비판의 별도 검증 lane을 구성한다. 근거: `agents/code-reviewer.md:1-7`, `agents/security-reviewer.md:1-7`, `agents/critic.md:1-7`.

### 스킬 프롬프트

- `autopilot`: idea -> spec -> plan -> execution -> QA -> validation -> cleanup의 end-to-end pipeline. ralplan plan이나 deep-interview spec이 있으면 앞 단계를 건너뛰는 연결 규칙이 있다. 근거: `skills/autopilot/SKILL.md:8-29`, `skills/autopilot/SKILL.md:39-74`, `skills/autopilot/SKILL.md:160-188`.
- `ralph`: PRD 기반 지속 루프. 모든 user story가 `passes: true`이고 reviewer verification을 통과할 때까지 계속하며, post-review `ai-slop-cleaner`와 regression re-verification을 요구한다. 근거: `skills/ralph/SKILL.md:12-40`, `skills/ralph/SKILL.md:42-60`, `skills/ralph/SKILL.md:62-141`, `skills/ralph/SKILL.md:223-236`.
- `ultrawork`: persistence가 없는 병렬 실행 레이어. Ralph와 Autopilot이 이 위에 persistence와 full lifecycle을 얹는다고 설명한다. 근거: `skills/ultrawork/SKILL.md:8-28`, `skills/ultrawork/SKILL.md:30-65`, `skills/ultrawork/SKILL.md:128-142`.
- `team`: native team workflow, staged pipeline, stage-specific agent routing, handoff document, resume/cancel semantics를 포함한다. 근거: `skills/team/SKILL.md:9-29`, `skills/team/SKILL.md:45-78`, `skills/team/SKILL.md:98-199`.
- `deep-interview`: Socratic one-question-at-a-time workflow, ambiguity threshold, topology gate, artifact path discipline, explicit approval before execution을 규정한다. 근거: `skills/deep-interview/SKILL.md:1-13`, `skills/deep-interview/SKILL.md:38-53`, `skills/deep-interview/SKILL.md:72-117`, `skills/deep-interview/SKILL.md:159-260`.
- `ccg`: `/ask codex`와 `/ask gemini`를 병렬 advisor로 사용하고 Claude가 종합한다. skill nesting이 지원되지 않으므로 직접 CLI `omc ask`를 Bash로 실행하라고 지시한다. 근거: `skills/ccg/SKILL.md:7-18`, `skills/ccg/SKILL.md:27-41`, `skills/ccg/SKILL.md:54-72`.
- `ask`: raw provider CLI를 직접 조립하지 말고 항상 `omc ask {{ARGUMENTS}}`를 사용하라고 한다. 근거: `skills/ask/SKILL.md:24-33`.
- `ultraqa`: QA cycle을 최대 5회 반복하고 같은 실패 3회면 조기 종료하며, state cleanup을 요구한다. 근거: `skills/ultraqa/SKILL.md:12-21`, `skills/ultraqa/SKILL.md:36-85`, `skills/ultraqa/SKILL.md:101-142`.
- `skillify`: 세션에서 발견한 반복 가능한 workflow를 skill draft로 추출하되, frontmatter 없는 plain markdown skill을 금지한다. 근거: `skills/skillify/SKILL.md:13-23`, `skills/skillify/SKILL.md:24-68`.
- `omc-setup`: 설치/refresh/repair용 canonical setup flow이며 setup resume, phase file delegation, HUD skill delegation을 요구한다. 근거: `skills/omc-setup/SKILL.md:7-22`, `skills/omc-setup/SKILL.md:85-188`.

## 각 도구가 왜 그렇게 작성되어야 했는지에 대한 근거 또는 엄밀한 추론

1. **Node `.mjs` 훅 통일**
   - 근거: 설치 모듈은 Bash hook scripts가 v3.9.0에서 제거되었고 Node `.mjs` 훅으로 cross-platform 지원한다고 명시한다. `hooks/hooks.json`도 `node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs ...` 형태를 사용한다. 근거: `src/installer/index.ts:1-9`, `src/installer/hooks.ts:1-9`, `hooks/hooks.json:4-210`.
   - 판단: 이는 Windows/macOS/Linux에서 같은 훅 런타임을 유지하기 위한 직접 근거가 있는 설계다.

2. **`scripts/run.cjs` + `CLAUDE_PLUGIN_ROOT` 경유 실행**
   - 근거: `.mcp.json`과 `hooks/hooks.json`은 플러그인 루트를 기준으로 bridge/scripts를 실행한다. `launch.ts`는 `--plugin-dir`를 `OMC_PLUGIN_ROOT`에 비소비 방식으로 저장해 HUD와 기타 env-aware component가 같은 plugin root를 보게 한다. 근거: `.mcp.json:1-7`, `hooks/hooks.json:4-210`, `src/cli/launch.ts:687-712`, `docs/REFERENCE.md:300-324`.
   - 엄밀한 추론: 플러그인 캐시, 로컬 checkout, marketplace install이 공존하기 때문에 "현재 활성 플러그인 루트"가 하나로 정규화되어야 한다. 이 추론은 `docs/REFERENCE.md:308-312`가 `--plugin-dir`와 setup을 함께 요구하고, `src/installer/index.ts:1745-1753`이 plugin-dir mode에서 agent/skill sync를 건너뛰는 구현 제약에서 나온다.

3. **훅 fail-open**
   - 근거: `processHook`은 kill switch를 먼저 확인하고, try/catch에서 오류를 로그만 남긴 뒤 `continue: true`를 반환한다. 근거: `src/hooks/bridge.ts:3020-3031`, `src/hooks/bridge.ts:3255-3262`.
   - 엄밀한 추론: Claude Code lifecycle hook이 실패했을 때 세션 전체를 막으면 사용자의 원래 작업을 중단시킬 수 있으므로, 보조 오케스트레이션은 기본적으로 fail-open이어야 한다. 이 추론은 위 catch 구현과 `DISABLE_OMC`/`OMC_SKIP_HOOKS` 문서화에서 나온다. 근거: `docs/ARCHITECTURE.md:414-424`.

4. **Team 키워드 자동 감지 비활성화**
   - 근거: keyword detector는 `team`을 never-match placeholder로 두고, "workers receive prompts containing team"일 때 infinite spawning을 막기 위해 Team keyword detection을 disabled했다고 주석을 남겼다. 근거: `src/hooks/keyword-detector/index.ts:44-51`, `src/hooks/keyword-detector/index.ts:650-655`, `README.md:315-337`.
   - 판단: 이는 직접 주석이 있는 설계 이유다.

5. **키워드 sanitizer와 informational context suppression**
   - 근거: detector는 HTML/markdown comments, XML, URLs, quote/table rows, file paths, code blocks를 제거하고, help/reference/question 문맥에서는 실행 모드 activation을 억제한다. 근거: `src/hooks/keyword-detector/index.ts:329-348`, `src/hooks/keyword-detector/index.ts:501-550`.
   - 엄밀한 추론: 자연어 키워드 기반 실행은 인용문, 문서 설명, 코드 예시의 단어에 오탐할 수 있으므로, "실행 지시"와 "설명/참조"를 구분해야 한다. 이 추론은 sanitizer 대상과 informational pattern 구현에서 나온다.

6. **작은 작업 heavy mode 억제 및 `ralplan` 우회**
   - 근거: `getAllKeywordsWithSizeCheck`는 small task에서 heavy mode를 제거할 수 있고, `applyRalplanGate`는 underspecified prompt에 execution keyword가 있으면 `ralplan`으로 치환한다. 근거: `src/hooks/keyword-detector/index.ts:743-782`, `src/hooks/keyword-detector/index.ts:804-930`, `src/config/loader.ts:180-195`.
   - 엄밀한 추론: Autopilot/Ralph/Team/Ultrawork는 비용과 상태 부작용이 큰 실행 모드이므로, 짧고 불명확한 입력을 곧바로 실행하지 않고 계획/명확화로 돌리는 것이 안전하다. 이 추론은 `EXECUTION_GATE_KEYWORDS`와 `WELL_SPECIFIED_SIGNALS` 구현 제약에서 나온다.

7. **Stop 훅 continuation의 강한 예외 목록**
   - 근거: persistent-mode는 critical context stop, explicit cancel, user abort, rate limit, auth failure, scheduled wakeup, oversized tool result redirect, pending async work를 모두 bypass한다. 근거: `src/hooks/persistent-mode/index.ts:1898-2014`.
   - 판단: 각 주석은 deadlock, cancel race, infinite retry loop, stale cancellation 같은 이유를 직접 설명한다. 특히 rate limit의 infinite retry loop는 `src/hooks/persistent-mode/index.ts:1940-1950`에 명시되어 있다.

8. **Workflow authority ledger**
   - 근거: persistent-mode는 active skill ledger에서 authoritative workflow root를 읽어 `autopilot -> ralph` 같은 nested workflow에서 parent authority로 stop enforcement를 bubble up한다. 근거: `src/hooks/persistent-mode/index.ts:2021-2049`, `src/hooks/persistent-mode/index.ts:2084-2132`.
   - 엄밀한 추론: 복합 스킬이 서로를 호출하는 구조에서는 child state만 보고 continuation하면 parent pipeline phase accounting이 깨질 수 있다. 이 추론은 "autopilot parent over ralph child" 주석과 priority 분기 구현에서 나온다.

9. **Control plane/Data plane 분리**
   - 근거: 문서는 control plane에 queue/session/assignment/message metadata를 두고, plans/specs/prompts/results/traces는 durable artifact로 분리하라고 한다. 큰 handoff는 descriptor/summary로 넘기라는 규칙도 있다. 근거: `docs/ARCHITECTURE.md:461-498`.
   - 판단: 상태 점검과 scheduler가 큰 payload에 의해 비대해지는 것을 막기 위한 직접 문서화된 설계다.

10. **Team runtime v2의 CLI API lifecycle 강제**
    - 근거: runtime v2는 `done.json` polling을 제거하고 CLI API lifecycle transition, monitor snapshot, heartbeat를 completion source로 쓴다. worker instruction은 `claim-task`, `transition-task-status`를 반드시 실행하고 `done.json` 직접 작성을 금지한다. 근거: `src/team/runtime-v2.ts:1-17`, `src/team/runtime-v2.ts:432-473`.
    - 엄밀한 추론: 파일 sentinel 기반 완료 표시는 worker가 파일을 잘못 쓰거나 race가 발생할 때 신뢰성이 낮다. lifecycle API로 transition을 중앙화하면 task state mutation의 단일 경로가 생긴다. 이 추론은 "NO done.json polling"과 "transition-task-status before exiting" 강제 문구에서 나온다.

11. **외부 CLI binary path 신뢰성 검사**
    - 근거: Codex/Gemini/Claude worker binary resolution은 `/tmp`, `/var/tmp`, `/dev/shm`을 untrusted로 거부하고, trusted prefix가 아니면 경고한다. 근거: `src/team/model-contract.ts:51-134`.
    - 판단: PATH hijacking 또는 임시 디렉터리의 악성 binary 실행을 막기 위한 직접 구현이다.

12. **스킬 본문 compact shim과 command wrapper**
    - 근거: Reference는 marketplace/plugin installs가 concise registry description을 Claude Code에 주고 full body는 `skill-bodies/*/SKILL.md`로 보존한다고 설명한다. commands wrapper는 full skill description을 항상 세션에 로드하지 않으려는 compatibility command라고 말한다. 근거: `docs/REFERENCE.md:603-608`, `commands/ask.md:5-18`.
    - 엄밀한 추론: 스킬이 39개이고 각각 긴 절차 프롬프트를 갖기 때문에, 모든 본문을 항상 로드하면 컨텍스트 비용이 크다. wrapper/compact 구조는 호출 시점 로드를 위한 컨텍스트 절감 장치다. 이 추론은 `src/features/builtin-skills/skills.ts:161-182`의 full-body override 제한과 `commands/*.md` dispatch 패턴에서 나온다.

13. **`omc ask` wrapper 강제**
    - 근거: `ask` 스킬은 raw `codex`, `claude`, `gemini` CLI를 직접 실행하지 말고 항상 `omc ask`를 사용하라고 지시한다. 이유로 flag selection, artifact persistence, provider-version compatibility를 든다. 근거: `skills/ask/SKILL.md:24-33`.
    - 판단: 외부 provider CLI flag 변화와 artifact 누락을 줄이기 위한 직접 문서화된 설계다.

## 장점

1. **하네스 표면이 풍부하다.** CLI, 플러그인, MCP 도구, 스킬, 에이전트, 훅, 상태 파일이 역할별로 분리되어 있다. 근거: `package.json:19-39`, `.claude-plugin/plugin.json:18-60`, `docs/ARCHITECTURE.md:7`, `src/mcp/tool-registry.ts:48-61`.
2. **지속 실행 루프의 실패 모드를 많이 반영했다.** rate limit, auth error, context compaction, cancel race, scheduled wakeup, oversized output, pending async work 같은 예외를 Stop 훅에서 별도로 다룬다. 근거: `src/hooks/persistent-mode/index.ts:1898-2014`.
3. **프롬프트가 실행 계약을 명확히 한다.** Ralph는 PRD/story acceptance criteria, reviewer verification, deslop pass, regression re-verification을 절차로 고정하고, Team은 stage handoff와 transition criteria를 강제한다. 근거: `skills/ralph/SKILL.md:62-141`, `skills/team/SKILL.md:98-199`.
4. **상태와 artifact 경계가 좋다.** `.omc/state/**`와 `.omc/plans`, `.omc/prompts`, `.omc/notepads`, `.omc/artifacts`를 분리하고 descriptor handoff를 권장해 context bloat를 줄인다. 근거: `docs/ARCHITECTURE.md:461-498`, `docs/REFERENCE.md:253-290`.
5. **외부 모델/도구 통합에서 안전장치를 둔다.** 외부 CLI binary trust check, `omc ask` wrapper 강제, interop tools opt-in, tool group disable이 있다. 근거: `src/team/model-contract.ts:51-134`, `skills/ask/SKILL.md:24-33`, `src/mcp/omc-tools-server.ts:90-144`.
6. **컨텍스트 절감을 의식한 command/skill 구조가 있다.** commands wrapper와 compact skill body 문서가 full prompt를 필요한 시점에 로드하는 구조를 만든다. 근거: `commands/ask.md:5-18`, `docs/REFERENCE.md:603-608`.
7. **검증 에이전트가 별도 lane으로 분리되어 있다.** `verifier`, `code-reviewer`, `security-reviewer`, `critic`은 작성자와 다른 검증 역할을 맡고, 일부는 Write/Edit을 금지한다. 근거: `agents/verifier.md:28-34`, `agents/code-reviewer.md:1-7`, `agents/security-reviewer.md:1-7`, `agents/critic.md:1-7`.

## 약한 점/리스크

1. **문서와 실제 구현의 drift가 보인다.** README는 npm CLI/runtime path를 안내하지만 Reference는 direct npm/bun global installs가 not supported라고 한다. 근거: `README.md:67-71`, `docs/REFERENCE.md:31-45`.
2. **카운트/명칭 문서가 불일치한다.** Architecture는 31 skills라고 쓰지만 실제 `skills/*/SKILL.md`와 plugin manifest는 39개이고, Reference는 38 Total이라고 쓴다. 근거: `docs/ARCHITECTURE.md:174-179`, `.claude-plugin/plugin.json:18-58`, `docs/REFERENCE.md:603-608`.
3. **훅 파일명 문서가 stale이다.** 실제 hooks manifest는 `persistent-mode.mjs`를 쓰지만 Reference hook table은 `persistent-mode.cjs`라고 쓴다. 근거: `hooks/hooks.json:181-184`, `docs/REFERENCE.md:737-740`.
4. **플랫폼 설명도 일부 오래되었다.** installer/source는 Bash hooks가 제거되고 Node hooks가 기본이라고 말하지만 Reference는 Bash hooks가 macOS/Linux에서 portable하고 `OMC_USE_NODE_HOOKS=1`로 Node hooks를 쓰라고 설명한다. 근거: `src/installer/index.ts:1-9`, `src/installer/hooks.ts:1-9`, `docs/REFERENCE.md:851-859`. **부분 해소**: v4.14.3에서 Windows는 setup-time에 direct-node로 rewrite, Unix는 find-node.sh 유지로 구분이 명확해졌다(`10d32f26` @ `ed7800dd`). **Reference 문서 미반영 확인됨**(검증 완료 2026-06-01, `ed7800dd`): `docs/REFERENCE.md:846-859`는 여전히 Bash(.sh)를 macOS/Linux 기본으로 설명하나 `OMC_USE_NODE_HOOKS`는 `src/`에 구현 0건(doc-only)이고 source는 Bash hooks가 v3.9.0에서 제거됐다고 명시 — 문서가 stale 상태로 남아있다.
5. **MCP 서버 주석이 실제 tool surface와 맞지 않는다.** `src/mcp/omc-tools-server.ts` 상단 주석은 18 custom tools라고 하지만 실제 aggregate는 state/notepad/memory/trace/shared-memory/deepinit/wiki/interop까지 훨씬 많다. 근거: `src/mcp/omc-tools-server.ts:1-6`, `src/mcp/omc-tools-server.ts:96-109`.
6. **복잡도가 높다.** Stop 훅 하나가 Autopilot, Ralph, Autoresearch, Ralplan, Team, Ultrawork, skill-active-state, todo continuation을 모두 우선순위로 다루며, ledger/tombstone/session state까지 조합한다. 근거: `src/hooks/persistent-mode/index.ts:2021-2159`.
7. **외부 런타임 의존성이 크다.** `omc team`, `omc wait`는 tmux가 필요하고, Codex/Gemini worker는 별도 CLI 설치와 인증이 필요하다. 근거: `README.md:183`, `README.md:378-388`, `README.md:507-536`.
8. **권한/보안 표면이 넓다.** hooks, MCP tools, external provider CLIs, OpenClaw/webhooks, tmux worker, local state를 모두 사용한다. 신뢰 path 검사와 opt-in/disable이 있지만 운영 정책이 없으면 공격/오작동 표면이 커진다. 근거: `README.md:422-488`, `src/team/model-contract.ts:51-134`, `src/mcp/omc-tools-server.ts:37-59`.
9. **스킬 프롬프트가 내부 파일 경로와 상태 schema에 강하게 의존한다.** 예를 들어 Ralph는 session-scoped PRD path, progress, state tools, `ai-slop-cleaner` 호출 방식을 정확히 요구한다. 경로/schema가 바뀌면 프롬프트와 구현이 함께 갱신되어야 한다. 근거: `skills/ralph/SKILL.md:42-50`, `skills/ralph/SKILL.md:62-141`.

## DITTO에서 차용할 점

1. **제어 평면/데이터 평면 분리.** DITTO도 하네스 상태는 작고 기계적으로 유지하고, 큰 분석 결과/로그/리포트는 artifact descriptor로 참조하는 구조를 차용할 가치가 있다. 근거 모델: `docs/ARCHITECTURE.md:461-498`.
2. **훅/오케스트레이션 fail-open 원칙.** 보조 자동화가 실패해도 사용자의 기본 작업을 막지 않는 구조는 DITTO 하네스에도 필요하다. 근거 모델: `src/hooks/bridge.ts:3255-3262`.
3. **명시적 loop authority.** `/goal`, Ralph, Team, UltraQA를 하나의 primary authority로 제한하고 나머지를 evidence producer/handoff로 취급하는 규칙은 병렬 에이전트 하네스 충돌 방지에 유용하다. 근거 모델: `README.md:260-264`, `docs/REFERENCE.md:570-600`.
4. **작은 작업/불명확한 작업에 대한 실행 억제.** task size check와 ralplan gate는 DITTO에서도 과도한 자동 실행을 막는 안전장치로 차용할 수 있다. 근거 모델: `src/hooks/keyword-detector/index.ts:743-782`, `src/hooks/keyword-detector/index.ts:804-930`.
5. **stage handoff 문서.** Team이 각 stage 종료 전에 `.omc/handoffs/<stage>.md`를 쓰도록 하는 규칙은 컨텍스트 압축/세션 재시작/병렬 worker 재현성에 유용하다. 근거 모델: `skills/team/SKILL.md:156-181`.
6. **검증 에이전트의 read-only 분리.** code/security/critic reviewer의 Write/Edit 금지는 DITTO 분석 하네스에서도 "작성자와 검증자 분리"를 구현할 때 참고할 수 있다. 근거 모델: `agents/code-reviewer.md:1-7`, `agents/security-reviewer.md:1-7`, `agents/critic.md:1-7`.
7. **외부 도구 wrapper 강제.** provider CLI를 raw로 조립하지 않고 `omc ask` 같은 wrapper를 통해 artifact 저장과 provider 호환성을 보장하는 패턴은 DITTO의 외부 analyzer 호출에도 적합하다. 근거 모델: `skills/ask/SKILL.md:24-33`.
8. **문서/프롬프트/소스 inventory test.** OMC의 drift 사례를 반면교사로 삼아, DITTO는 skills/commands/tools count와 docs table을 CI에서 자동 비교해야 한다. 근거 반례: `docs/ARCHITECTURE.md:174-179`, `.claude-plugin/plugin.json:18-58`, `docs/REFERENCE.md:603-608`.

## 보완 계획

1. **Source-of-truth inventory 생성기 도입**
   - `skills/*/SKILL.md`, `commands/*.md`, `agents/*.md`, MCP `allTools`, hooks manifest에서 자동으로 inventory JSON/Markdown을 생성한다.
   - CI에서 문서의 count와 생성 결과를 비교한다.
   - 필요 근거: OMC는 skill count와 hook filename drift가 이미 보인다. 근거: `docs/ARCHITECTURE.md:174-179`, `hooks/hooks.json:181-184`, `docs/REFERENCE.md:737-740`.

2. **루프 권한 모델을 명문화**
   - DITTO 하네스에서 "현재 primary loop authority"를 상태에 하나만 저장하고, nested workflow는 parent authority로 bubble up하도록 한다.
   - 필요 근거: OMC persistent-mode가 ledger authority를 통해 `autopilot -> ralph` 같은 nested workflow를 처리한다. 근거: `src/hooks/persistent-mode/index.ts:2021-2049`.

3. **하네스 상태 schema 버전 관리**
   - `.ditto/state/**` 또는 이에 준하는 상태 파일에는 `schemaVersion`, `owner`, `mode`, `sessionId`, `createdAt`, `updatedAt`, `terminalState`를 넣는다.
   - 필요 근거: OMC는 session-scoped state와 legacy fallback을 병행하고 migration/bypass 로직이 복잡하다. 근거: `docs/TOOLS.md:23-40`, `docs/ARCHITECTURE.md:543-548`.

4. **Stop/continuation 예외 목록을 먼저 설계**
   - rate limit, auth failure, user abort, context compaction, scheduled wakeup, pending async work, explicit cancel은 자동 continuation에서 제외한다.
   - 필요 근거: OMC는 이 예외들을 코드 주석과 함께 강하게 처리한다. 근거: `src/hooks/persistent-mode/index.ts:1898-2014`.

5. **외부 analyzer wrapper와 artifact 저장 계약**
   - Codex/Gemini/Claude 또는 다른 analyzer를 직접 호출하지 말고 wrapper가 provider version/flags/output path를 통제하도록 한다.
   - 필요 근거: OMC `ask` 스킬이 raw CLI assembly를 금지하고 `.omc/artifacts/ask` 저장을 요구한다. 근거: `skills/ask/SKILL.md:24-50`.

6. **문서 drift 방지**
   - 설치 정책, 플랫폼 정책, 파일명, tool count, skill count는 코드에서 생성하고 문서에는 generated block으로 삽입한다.
   - 필요 근거: OMC 문서에는 npm/plugin 지원 정책, Bash/Node hooks, persistent-mode 확장자, count 차이가 존재한다. 근거: `README.md:67-71`, `docs/REFERENCE.md:31-45`, `src/installer/hooks.ts:1-9`, `docs/REFERENCE.md:851-859`.

## 기준 커밋 이후 변경 (2026-06-01 갱신)

베이스라인 `1fe17f0` → HEAD `ed7800dd` 사이에 48개 커밋이 있었고 v4.14.2, v4.14.3, v4.14.4 세 번의 릴리스가 포함되어 있다. 문서와 관련된 변경만 선별한다.

### 1. ralplan Stop continuation이 read-only 계획 루프로 강제됨

`persistent-mode/index.ts`의 ralplan continuation 메시지가 변경되었다. 이전에는 "consensus에 도달할 때까지 계속하라"는 일반 지시였지만, 이제는 "계획 루프만 계속하고 구현·수정·커밋·PR을 하지 말라, consensus 후 `pending-approval` handoff에서 멈추고 사용자 승인 후에만 실행하라"고 명시한다.

아울러 `RALPLAN_TERMINAL_PHASES` Set에 `pending approval`, `pending-approval`, `pending_approval`, `awaiting approval`, `awaiting-approval`, `awaiting_approval`, `approval-required`, `approval_required` 8개 phase 변형이 추가되었다. 이 phase에 있으면 ralplan continuation이 멈춘다.

`skills/ralplan/SKILL.md`도 동기화되어 "Approve execution after clearing context" 옵션이 "Compact then return for execution approval"로 교체되었다.

근거: `src/hooks/persistent-mode/index.ts:618-626`, `src/hooks/persistent-mode/index.ts:1703-1712`, `skills/ralplan/SKILL.md:58` @ `ed7800dd`.

**DITTO 시사점**: ralplan(계획) → 실행 전환에 명시적 사용자 승인 gate를 두는 패턴이 강화되었다. DITTO의 의도 확인 인터뷰와 실행 억제 설계에 동일한 방향의 근거가 생겼다.

### 2. ultragoal에 Stop 지속 실행 + PreToolUse /goal 검증이 추가됨

`feat: persist ultragoal and enforce Claude goal activation (#3102)` 커밋(`567e39ff`)으로 ultragoal이 ralph와 대칭적인 Stop 지속 실행 경로를 갖게 되었다.

구체적으로:
- ultragoal 활성 상태가 `.omc/state/sessions/<session>/ultragoal-state.json`에 기록된다. 근거: `src/hooks/persistent-mode/__tests__/ultragoal-persistence.test.ts:32-44` @ `ed7800dd`.
- PreToolUse 훅이 active ultragoal 상태이면서 Claude `/goal` 스냅숏이 없거나 목표가 일치하지 않으면 tool 실행을 deny한다. 단, `omc ultragoal create-goals`, `omc ultragoal complete-goals` 같은 CLI 부트스트랩 명령은 `/goal` 존재 전에도 허용된다. 근거: `src/hooks/persistent-mode/__tests__/ultragoal-persistence.test.ts:72-105` @ `ed7800dd`.

**DITTO 시사점**: 에이전트 루프 권한과 외부 goal 상태를 일치시키는 enforcement 패턴이다. DITTO에서 primary authority ledger와 실행 gate를 설계할 때 "루프 상태 ↔ 외부 승인 state 매핑"의 구체적 구현 사례다.

### 3. cmux(Claude Multiplexer) Team 런타임 지원 추가

`src/team/tmux-session.ts`에 cmux 백엔드 지원이 추가되었다. `detectTeamMultiplexerContext()`가 `'cmux'`를 반환하면 tmux API 대신 `cmux` CLI를 사용한다:
- `cmuxSplitSurface`, `cmuxSendSurface`, `cmuxSendSurfaceKey`, `cmuxCaptureSurface`, `cmuxCloseSurface` 함수가 내부적으로 추가.
- 공개 API `captureTeamPane(paneId)`, `sendTeamPaneKey(paneId, key)`가 추가되어 `runtime-v2.ts`가 이를 통해 tmux/cmux를 추상화한다. 근거: `src/team/tmux-session.ts:763-778` @ `ed7800dd`.
- CMUX_SURFACE_ID 환경변수가 없으면 cmux team session 시작이 오류로 실패한다. 근거: `src/team/tmux-session.ts:580-582` @ `ed7800dd`.

**DITTO 시사점**: Team 런타임이 tmux 단일 의존성에서 cmux(Claude Multiplexer)로 확장되고 있다. "외부 런타임 의존성이 크다"는 기존 약점 항목이 더 복잡해졌다. DITTO에서 팀 실행 표면을 차용할 경우 multiplexer 추상화 레이어를 고려해야 한다.

### 4. Windows 플랫폼 Hook 호환성 수정 — 기존 문서 오류 부분 해소

기존 약점 항목 4("플랫폼 설명도 일부 오래되었다")에서 지적한 Bash hooks vs Node hooks 불일치가 이번 릴리스 사이클에서 직접 다루어졌다.

`Keep Windows plugin hooks off sh (#3118)` 커밋(`10d32f26`)은 "Unix hook 명령은 nvm/fnm Node 탐색을 위해 `find-node.sh`를 유지해야 하고, Windows는 직접 node 호출로 재작성해야 한다"고 명시한다. 즉 `hooks/hooks.json`의 sh 형식은 Unix 전용으로 의도된 것이고, Windows에서는 setup-time에 direct-node로 rewrite된다. 이는 Reference 문서가 "Bash hooks가 macOS/Linux에서 portable"이라고 쓴 것과 실제 동작이 부분적으로 일치하게 되었음을 의미한다.

근거: `src/hooks/setup/index.ts` 변경, `src/__tests__/hooks-command-escaping.test.ts` 확장 @ `ed7800dd`.

**기존 문서 항목 상태** (검증 완료 2026-06-01, `ed7800dd` 직접 대조): 약점 4의 "플랫폼 설명 일부 오래되었다" 지적은 **여전히 유효하며 모순이 유지된다**. `docs/REFERENCE.md:846-859`는 아직도 Bash(.sh)를 macOS/Linux 기본으로, `OMC_USE_NODE_HOOKS=1`을 opt-in으로 설명하지만, 소스(`src/installer/hooks.ts:8`, `src/installer/index.ts:8`)는 "Bash hooks가 v3.9.0에서 제거됨"이라고 하고 `.mjs` Node 스크립트를 cross-platform 기본으로 제공한다. 결정적으로 `OMC_USE_NODE_HOOKS`는 `src/` 전체에 구현이 0건(doc-only)이고 `*hook*` 이름의 `.sh` 템플릿도 0건이다. 즉 REFERENCE.md의 해당 섹션은 stale 상태 그대로다.

### 5. HUD payload 압력 경고 추가

새 모듈 `src/hud/payload-estimate.ts`가 추가되어 HUD에 API 요청 payload 압력 추정치를 표시한다. Anthropic API 요청 payload 한도는 32 MB로 하드코딩되어 있고, 22 MB(warning), 26 MB(critical) 임계값으로 색상 경고를 렌더링한다. HUD는 transcript JSONL 파일 크기를 보수적 추정치로 사용한다(정확한 API body 바이트가 아님). 근거: `src/hud/payload-estimate.ts:13-16`, `src/hud/elements/context-warning.ts:1-60` @ `ed7800dd`.

**DITTO 시사점**: HUD/상태 표면에 컨텍스트 크기뿐 아니라 API payload 압력을 별도 지표로 표시하는 패턴. DITTO의 Context Rot 대응 설계에 참고할 수 있다.

### 6. worktree 파괴적 삭제 안전장치 추가

`src/lib/worktree-cleanup-safety.ts`가 새로 추가되어 worktree 삭제 대상이 OMC 소유 경로 하위인지 검증한다. filesystem root, home directory, NUL 포함 경로를 모두 거부한다. `git-worktree.ts`의 `checkWorkerWorktreeRemovalSafety`와 `removeWorkerWorktree` 두 곳에서 이 검증을 호출한다. 근거: `src/lib/worktree-cleanup-safety.ts:1-118`, `src/team/git-worktree.ts:541-553`, `src/team/git-worktree.ts:629-637` @ `ed7800dd`.

**DITTO 시사점**: 파괴적 path 조작에 대한 외부 safety helper 분리 패턴. OMC의 "외부 런타임 의존성이 크다" 약점을 보완하는 방향의 변경이다.

### 7. 새 문서: model × agent 호환성 매트릭스 추가

`docs/agents/model-compatibility.md`가 추가되어 7개 에이전트(Prometheus, Hyperplan, Sisyphus, Hephaestus, Oracle, Aletheia, Hermes)별 권장 모델을 표로 정리했다. Premium/Balanced/Budget 세 가지 preset config 블록을 제공한다.

주요 설계 규칙: Planning/Review는 비싼 모델, Implementation(Sisyphus)은 저렴한 모델; Hephaestus는 GPT 계열 금지; Sisyphus가 총 token 비용의 최대 레버. 근거: `docs/agents/model-compatibility.md:1-80` @ `ed7800dd`.

**주의** (검증 완료 2026-06-01, `ed7800dd` 전수 grep): 이 문서의 에이전트 이름(Prometheus, Hyperplan, Sisyphus, Hephaestus 등 7개)은 **OMC의 19개 로컬 agent 파일과 매핑되지 않는다**. `agents/`·`skills/` 전수 검색에서 이 코드네임은 0건이며(로컬 19개는 analyst/architect/planner/executor 등 기존 이름 그대로), `docs/agents/model-compatibility.md`는 OMC가 inspired-by한 oh-my-opencode(문서가 "OMO"로 지칭) 계열 에이전트 명칭을 가져온 논리적 역할 라벨이다. "Hephaestus"는 `research/hephaestus-vs-deep-executor-comparison.md:4`에서 oh-my-opencode 에이전트로 명시된다. "Sisyphus"는 OMC의 npm 패키지명(`oh-my-claude-sisyphus`)과 철자만 겹칠 뿐 별개 용법이다. 즉 개명/내부 별칭이 아니라 **외부 하네스(OMO) 역할 라벨**이다. (약어 OMO의 정식 풀네임을 한 줄로 풀어쓴 정의는 저장소에 없음 — inspired-by/런타임 패밀리 표기에 근거한 강한 추정.)

### 8. Codex/Gemini MCP delegation 공식 deprecated 처리

`src/features/delegation-routing/resolver.ts`에서 `isDeprecatedMcpProvider()` 함수가 추출되어 codex/gemini provider를 명시적 deprecated set으로 관리한다. 이전에는 `provider === 'codex' || provider === 'gemini'` 인라인 체크였다. deprecated provider의 `route.model`은 이제 Claude subagent role로 전달되지 않고 reason 텍스트에만 diagnostic으로 포함된다. 근거: `src/features/delegation-routing/resolver.ts:17-24`, `src/features/delegation-routing/resolver.ts:81-99` @ `ed7800dd`.

**DITTO 시사점**: MCP를 통한 Codex/Gemini 위임이 deprecated되고 `/team` CLI worker 방식이 권장된다. DITTO에서 외부 analyzer wrapper 패턴을 설계할 때 MCP 경로 대신 CLI worker 경로가 OMC의 현재 방향임을 확인.

### 9. 자동 업데이트: native Claude Code 설치 탐지 추가

`src/features/auto-update.ts`에 `detectClaudeCodeFromBinary()` 함수가 추가되어 npm 메타데이터가 없는 native Windows 설치를 `installMethod: 'native'`로 식별한다. npm 복구 경로는 `installMethod === 'npm'`으로 확인된 설치에만 실행된다. 이는 native 설치가 npm restore를 잘못 트리거하는 버그를 수정한다. 근거: `src/features/auto-update.ts` @ `ed7800dd` (commit `c2e587d5`).

## 근거 목록

### 메타데이터/배포

- `package.json:2-18`: npm 패키지명, 버전, bin entry.
- `package.json:19-39`: publish files.
- `package.json:40-68`: build/test/lint/release scripts.
- `package.json:70-83`: runtime dependencies.
- `package.json:100-102`: Node engine.
- `.claude-plugin/plugin.json:18-60`: skill directories, MCP server file, commands directory.
- `.mcp.json:1-7`: MCP server `t` command.

### README/사용자 표면

- `README.md:50-91`: quick start, plugin/npm/setup, plugin-dir mode note.
- `README.md:105-119`: CLI vs in-session skills distinction.
- `README.md:130-183`: Team canonical mode, staged pipeline, tmux CLI workers.
- `README.md:187-197`: npm package naming note.
- `README.md:227-279`: selling points, orchestration modes, loop authority guidance.
- `README.md:315-398`: in-session shortcuts, ask/autoresearch/wait/HUD utilities.
- `README.md:422-536`: OpenClaw, docs, requirements, tmux, optional Codex/Gemini CLIs.

### 아키텍처/참조 문서

- `docs/ARCHITECTURE.md:7`, `docs/ARCHITECTURE.md:39-44`: four systems and flow.
- `docs/ARCHITECTURE.md:52-150`: 19 agents, model tiers, delegation guide.
- `docs/ARCHITECTURE.md:174-318`: skills, layers, magic keywords.
- `docs/ARCHITECTURE.md:321-424`: hooks, lifecycle, system-reminder, disabling.
- `docs/ARCHITECTURE.md:428-610`: `.omc` state, control/data plane, artifact descriptors, notepad, memory, verification protocol.
- `docs/REFERENCE.md:31-45`: plugin-only supported statement.
- `docs/REFERENCE.md:253-380`: runtime storage root and plugin-dir flags.
- `docs/REFERENCE.md:504-650`: agents and skills reference/counts.
- `docs/REFERENCE.md:570-600`: `/goal`/Ralph/Team/UltraQA/Ultragoal authority model.
- `docs/TOOLS.md:1-20`: MCP tool categories.
- `docs/TOOLS.md:23-105`, `docs/TOOLS.md:332-445`, `docs/TOOLS.md:456-628`, `docs/TOOLS.md:631-781`: state/LSP/AST/Python/session/trace/shared-memory/skills/deepinit tools.

### 훅/상태/런타임 소스

- `hooks/hooks.json:4-211`: actual plugin hook manifest.
- `src/hooks/bridge.ts:3020-3263`: hook routing, kill switches, fail-open behavior.
- `src/hooks/keyword-detector/index.ts:44-63`: keyword patterns, Team disabled.
- `src/hooks/keyword-detector/index.ts:329-348`: sanitizer.
- `src/hooks/keyword-detector/index.ts:501-550`: informational context suppression.
- `src/hooks/keyword-detector/index.ts:623-710`: explicit slash detection and conflict resolution.
- `src/hooks/keyword-detector/index.ts:743-930`: task size suppression and ralplan gate.
- `src/hooks/persistent-mode/index.ts:1-10`: Stop continuation priority.
- `src/hooks/persistent-mode/index.ts:92-99`: loop/cancel/stale constants.
- `src/hooks/persistent-mode/index.ts:400-435`: repeated tool error retry guidance.
- `src/hooks/persistent-mode/index.ts:1865-2175`: bypass invariants, authority ordering, mode priority, hook output.

### CLI/설치/스킬 로더

- `src/cli/index.ts:129-1467`: CLI command inventory.
- `src/cli/launch.ts:687-784`: plugin-dir parsing, env capture, preflight, launch config.
- `src/installer/index.ts:1-55`: installer purpose, Node hooks, command install disabled.
- `src/installer/index.ts:1720-2060`: plugin context, plugin-dir mode, agent/skill sync, CLAUDE.md, HUD, settings.
- `src/installer/hooks.ts:1-75`: hook script design, Node `.mjs`, Node 20.
- `src/features/builtin-skills/skills.ts:1-100`: built-in skill single source and safe names.
- `src/features/builtin-skills/skills.ts:161-360`: full-body override, runtime rendering, alias/pipeline/resource guidance, cache.

### MCP/tool 소스

- `src/mcp/tool-registry.ts:1-14`, `src/mcp/tool-registry.ts:48-61`, `src/mcp/tool-registry.ts:117-161`: standalone MCP tool registry.
- `src/mcp/omc-tools-server.ts:37-59`, `src/mcp/omc-tools-server.ts:90-144`: in-process MCP server, disabled groups, SDK tool names.
- `src/tools/lsp-tools.ts:93-451`: LSP tool names.
- `src/tools/ast-tools.ts:290`, `src/tools/ast-tools.ts:443`: AST tool names.
- `src/tools/state-tools.ts:469-1300`: state tool names.
- `src/tools/notepad-tools.ts:38-315`: notepad tool names.
- `src/tools/memory-tools.ts:32-220`: project memory tool names.
- `src/tools/trace-tools.ts:218-300`: trace tools.
- `src/tools/shared-memory-tools.ts:60-259`: shared memory tools.
- `src/tools/wiki-tools.ts:44-383`: wiki tools.
- `src/tools/skills-tools.ts:105-142`: skill management tools.
- `src/tools/deepinit-manifest.ts:411`: deepinit manifest tool.
- `src/tools/python-repl/tool.ts:681`: Python REPL tool.

### Team/외부 provider 소스

- `src/team/runtime-v2.ts:1-17`: runtime v2 design.
- `src/team/runtime-v2.ts:432-473`: worker lifecycle command contract.
- `src/team/model-contract.ts:51-134`: CLI binary trust checks.
- `src/cli/commands/team.ts:25-30`, `src/cli/commands/team.ts:664-980`: worker count/agent type constraints and team command dispatch.

### 프롬프트/스킬/에이전트

- `skills/autopilot/SKILL.md:8-188`: Autopilot lifecycle and integration.
- `skills/ralph/SKILL.md:12-141`, `skills/ralph/SKILL.md:223-236`: Ralph PRD/persistence/review/deslop/checklist.
- `skills/ultrawork/SKILL.md:8-142`: parallel execution layer.
- `skills/team/SKILL.md:9-260`: Team workflow and staged pipeline.
- `skills/deep-interview/SKILL.md:1-260`: Socratic interview and ambiguity gate.
- `skills/ccg/SKILL.md:7-104`: tri-model advisor workflow.
- `skills/ask/SKILL.md:24-50`: `omc ask` wrapper and artifacts.
- `skills/ultraqa/SKILL.md:12-142`: QA cycling.
- `skills/skillify/SKILL.md:13-68`: learned skill extraction.
- `skills/omc-setup/SKILL.md:7-188`: setup workflow.
- `commands/ask.md:5-18`, `commands/omc-setup.md:5-18`: compatibility command wrapper pattern.
- `agents/executor.md:21-120`: executor prompt contract.
- `agents/planner.md:9-140`: planner prompt contract.
- `agents/verifier.md:9-107`: verifier prompt contract.
- `agents/code-reviewer.md:1-181`: code reviewer prompt contract.
- `agents/security-reviewer.md:1-185`: security reviewer prompt contract.
- `agents/critic.md:1-220`: critic prompt contract.

## ditto 적용 정리

1. **단계형 오케스트레이션과 stage handoff**
   - 적용할 기능/가치: OMC의 Team 파이프라인(`team-plan -> team-prd -> team-exec -> team-verify -> team-fix`)과 stage handoff 문서를 ditto의 문제 정의/현황 파악/개발 완료/자동 회고 흐름에 맞춘다.
   - 적용 방식: ditto의 각 단계에 진입 조건, 출력 문서, 소유자를 둔다. 한 단계의 산출물은 다음 단계가 참조만 하게 하고, 변경이 필요하면 새 handoff나 후속 결정 기록으로 남긴다.
   - 적용 이후 제공 가치: 장기 작업을 세션 재시작이나 병렬 worker 분리 후에도 이어갈 수 있고, 사용자는 전체 대화나 소스코드를 다시 읽지 않아도 현재 단계와 근거를 파악할 수 있다.
   - 리스크/선행 조건: handoff schema와 단계별 수정 권한을 먼저 고정해야 한다. OMC처럼 문서와 구현의 count/명칭 drift가 생기면 오히려 인지 비용이 늘어난다.
   - 근거: PURPOSE.md는 모든 액션 감사 기록, 핸드오프, 정규화된 단계 interface, 장기 작업 완수를 요구한다(`PURPOSE.md:15`, `PURPOSE.md:29-32`). 보고서는 Team을 canonical orchestration surface로 보고 `skills/team/SKILL.md:98-199`, stage handoff 규칙은 `skills/team/SKILL.md:156-181`에 근거를 둔다.

2. **제어 평면/데이터 평면 분리와 작은 상태 저장**
   - 적용할 기능/가치: OMC의 `.omc/state/**`와 durable artifact 분리를 ditto의 감사 기록, 결정 영속화, Context Rot 대응 구조로 가져온다.
   - 적용 방식: ditto의 실행 상태에는 queue/session/assignment/status 같은 작은 기계 상태만 두고, 큰 분석 결과, 로그, 검증 결과, 프롬프트는 artifact로 저장한 뒤 descriptor와 요약만 상태에서 참조한다.
   - 적용 이후 제공 가치: 컨텍스트에 큰 산출물을 반복 주입하지 않아 token 비용을 줄이고, 다음 세션이나 subagent가 필요한 근거만 찾아 재개할 수 있다.
   - 리스크/선행 조건: 상태 schema version, owner, terminal state, artifact path 규약이 필요하다. schema 변경 시 프롬프트와 도구가 함께 갱신되지 않으면 OMC의 stale 문서 사례처럼 신뢰도가 떨어진다.
   - 근거: PURPOSE.md는 감사 기록, 주요 결정/변경사항 영속화, Context Rot 해결, token 비용 절감을 요구한다(`PURPOSE.md:10`, `PURPOSE.md:12`, `PURPOSE.md:15-17`). 보고서는 control plane/data plane 분리와 descriptor handoff를 `docs/ARCHITECTURE.md:461-498`, 런타임 저장소를 `docs/REFERENCE.md:253-290`에 연결한다.

3. **실행 권한 gate와 의도 확인 인터뷰**
   - 적용할 기능/가치: OMC의 작은 작업 heavy mode 억제, 불명확한 실행 요청의 `ralplan` 우회, deep-interview식 ambiguity gate를 ditto의 의도 이탈 방지 장치로 쓴다.
   - 적용 방식: 자동 실행 키워드는 인용문, 코드 블록, 도움말/참조 문맥을 제거한 뒤 판정한다. 짧거나 불명확한 요청은 곧바로 Autopilot/Team류 실행으로 보내지 않고, 근거 수집 또는 필요한 최소 질문으로 전환한다.
   - 적용 이후 제공 가치: 사용자의 말과 다른 대형 workflow가 시작되는 일을 줄이고, 답할 수 있는 내용을 사용자에게 다시 묻지 않는 규칙을 도구 차원에서 강제할 수 있다.
   - 리스크/선행 조건: 한국어/영어 혼합 입력에서 오탐과 미탐이 생길 수 있으므로 실행 gate에는 명시적 override, 감사 로그, dry-run 성격의 판정 출력이 필요하다.
   - 근거: PURPOSE.md는 사용자 의도 이탈을 구조적으로 제한하고, 필요한 경우에만 의도 확인 질문을 하라고 한다(`PURPOSE.md:8`, `PURPOSE.md:22-28`). 보고서는 Team 키워드 자동 감지 비활성화(`src/hooks/keyword-detector/index.ts:44-63`), sanitizer와 informational suppression(`src/hooks/keyword-detector/index.ts:329-348`, `src/hooks/keyword-detector/index.ts:501-550`), small task/ralplan gate(`src/hooks/keyword-detector/index.ts:743-930`), deep-interview 규칙(`skills/deep-interview/SKILL.md:38-117`)을 근거로 든다.

4. **primary loop authority와 continuation 예외 목록**
   - 적용할 기능/가치: OMC의 workflow authority ledger와 Stop 훅 continuation 예외 목록을 ditto의 장기 실행 완수 장치로 차용한다.
   - 적용 방식: 한 세션에는 primary loop authority를 하나만 둔다. nested workflow는 parent authority로 bubble up하고, explicit cancel, user abort, rate limit, auth failure, context compaction, scheduled wakeup, oversized output, pending async work는 자동 continuation에서 제외한다.
   - 적용 이후 제공 가치: 목표 달성 전 임의 중단을 줄이면서도, 취소/인증/레이트리밋 같은 실패를 무한 재시도하지 않는다. 병렬 subagent가 서로 다른 완료 기준으로 같은 작업을 끌고 가는 문제도 줄일 수 있다.
   - 리스크/선행 조건: Stop 훅이 모든 workflow를 직접 알면 OMC처럼 복잡도가 급격히 커진다. ditto에서는 authority interface를 좁게 만들고, 각 workflow가 자신의 완료/중단 사유만 표준 상태로 보고해야 한다.
   - 근거: PURPOSE.md는 처음 의도한 목적대로 장기간 작업을 완수하고, 오케스트레이션이 목표 달성 전 멋대로 중단하지 않아야 한다고 한다(`PURPOSE.md:11`, `PURPOSE.md:29-32`). 보고서는 Stop 훅 continuation과 예외 목록을 `src/hooks/persistent-mode/index.ts:1898-2014`, authority ledger를 `src/hooks/persistent-mode/index.ts:2021-2132`에 연결한다.

5. **독립 검증 lane과 외부 analyzer wrapper**
   - 적용할 기능/가치: OMC의 read-only reviewer/verifier lane, `omc ask` wrapper, artifact 저장 계약을 ditto의 할루시네이션 방지와 멀티 모델 정반합 검토에 맞춘다.
   - 적용 방식: 구현 agent와 검증 agent를 권한으로 분리하고, 검증 agent는 acceptance criteria별 fresh evidence만 남기게 한다. Codex/Gemini/Claude 같은 외부 analyzer는 raw CLI 호출을 금지하고, ditto wrapper가 provider, flag, 출력 artifact, 버전 호환성을 통제한다.
   - 적용 이후 제공 가치: 완료 주장이 테스트/빌드/리뷰 산출물에 묶이고, 외부 모델 의견도 추적 가능한 artifact로 남아 사용자가 근거 부족 답변과 검증된 결론을 구분할 수 있다.
   - 리스크/선행 조건: 외부 CLI 인증, PATH 신뢰성, wrapper 버전 정책, artifact 보존 기간이 필요하다. 검증 lane을 항상 강제하면 작은 작업의 비용이 커지므로 task size gate와 함께 적용해야 한다.
   - 근거: PURPOSE.md는 모든 출력과 추론에 확실한 근거가 있어야 하며 멀티 모델 기반 적대적 검토 도구를 요구한다(`PURPOSE.md:7`, `PURPOSE.md:33`). 보고서는 verifier의 fresh evidence 계약(`agents/verifier.md:9-107`), read-only reviewer 권한(`agents/code-reviewer.md:1-7`, `agents/security-reviewer.md:1-7`, `agents/critic.md:1-7`), `omc ask` wrapper와 artifact 저장(`skills/ask/SKILL.md:24-50`), 외부 binary trust check(`src/team/model-contract.ts:51-134`)를 근거로 든다.

## ditto 적용 요소 후보 (skills/agents/commands/hooks)

| 우선순위 | 종류 | 요소 | DITTO 적용안 | 효과/주의 |
| --- | --- | --- | --- | --- |
| 바로 적용 | skill | `deep-interview` | 모호한 목표나 제품 판단이 필요한 요청에서 한 질문씩 진행하는 DITTO interview skill로 둔다. 코드/문서로 확인 가능한 질문은 먼저 조사하고, 실행 전에는 artifact path와 승인 기준을 남긴다. | 사용자가 의도를 반복 설명하지 않아도 된다. 자동 실행을 막는 gate로 쓰되, trivial task에는 켜지지 않아야 한다. |
| 바로 적용 | agent | `verifier`, `code-reviewer`, `security-reviewer`, `critic` | 구현 agent와 분리된 read-only 검증 lane으로 가져온다. verifier는 acceptance criteria별 fresh evidence, reviewer는 버그/보안/품질 risk만 보고한다. | 자기 확신과 완료 과장을 줄인다. 항상 full review를 돌리면 비용이 크므로 변경 규모 gate가 필요하다. |
| 바로 적용 | command/skill | `ask`, `ccg` | Codex/Gemini/Claude 등 외부 analyzer 호출을 raw CLI가 아니라 DITTO wrapper로 제한한다. provider, prompt, flags, 출력 artifact, version을 기록한다. | 멀티 모델 검토를 추적 가능하게 만든다. 인증/PATH 실패와 비용 제한을 명확히 보여줘야 한다. |
| 수정 적용 | hook | `keyword-detector` | 자동 workflow trigger 전에 인용문, 코드 블록, 도움말 문맥을 제거하고 small-task/heavy-mode gate를 적용한다. 결과는 dry-run 판정으로 감사 기록에 남긴다. | 사용자 의도와 다른 대형 workflow 실행을 줄인다. 한국어/영어 혼합 입력에 대한 오탐 테스트가 필요하다. |
| 수정 적용 | hook | `persistent-mode` Stop continuation | DITTO 장기 작업 loop에 primary authority ledger와 자동 continuation 예외 목록을 둔다. user abort, auth/rate limit, oversized output, compaction, pending async work는 자동 재시도하지 않는다. | 목표 전 임의 중단과 무한 반복을 동시에 줄인다. workflow별 완료/중단 사유 표준화가 선행되어야 한다. |
| 수정 적용 | MCP/tool | `state_*`, `notepad_*`, `project_memory_*`, `trace_*` | 세션 상태, 우선순위 메모, 프로젝트 지식, 실행 trace를 별도 tool surface로 나눈다. DITTO에서는 repo-local audit store와 연결하고, 큰 artifact는 descriptor만 state에 둔다. | Context Rot과 handoff에 효과적이다. 오래된 memory가 stale decision이 되지 않도록 freshness/owner를 가져야 한다. |
| 수정 적용 | skill | `ultraqa`, `ralph` | 반복 QA와 user story completion loop를 DITTO의 opt-in long-run skill로 차용한다. 같은 실패 3회 조기 종료, regression re-verification, cleanup을 필수로 둔다. | 장기 작업 완수에 맞다. 일반 작업의 기본 경로로 두면 token과 시간이 과해진다. |
| 수정 적용 | skill | `skillify` | 반복 가능한 성공 workflow를 skill draft로 추출하는 회고 단계에 둔다. frontmatter, trigger, 검증, references/scripts 분리를 강제한다. | DITTO가 스스로 행동 교정을 축적할 수 있다. 자동 등록은 금지하고 review 후 활성화해야 한다. |
