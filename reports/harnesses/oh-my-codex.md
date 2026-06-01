# oh-my-codex 참고 하네스 분석 보고서

## 분석 대상 및 기준 커밋

- 대상 저장소: `https://github.com/Yeachan-Heo/oh-my-codex`
- 로컬 분석 경로: `/private/tmp/ditto-harness-analysis/oh-my-codex`
- 이전 기준 커밋: `6d438dac53da6bae9c4f5558a5b47f3661be69f9` (0.18.0)
- **갱신 기준 커밋: `ff17267baa3a69b7b3578c64edf8cc78a03e2456` @ 2026-06-01** (0.18.7, 2026-05-30)
- npm 패키지명/버전: `oh-my-codex` `0.18.7`이며, 실행 바이너리는 `omx`로 노출된다. 근거: `package.json:2-3` at `ff17267b`.
- Rust 워크스페이스도 `0.18.7`로 버전이 올랐다. edition 2021, MSRV `1.73` 유지. 근거: `Cargo.toml:14` at `ff17267b`.
- 이하 기존 분석의 `repo-relative/path:line` 근거는 기준 커밋 `6d438dac53da6bae9c4f5558a5b47f3661be69f9` 기준이다. 갱신 이후 변경된 앵커는 아래 "기준 커밋 이후 변경" 섹션에 별도 표시한다.

## 조사 방법

- GitHub 저장소를 요구 경로 `/private/tmp/ditto-harness-analysis/oh-my-codex`에 클론하고 `git rev-parse HEAD`로 기준 커밋을 확인했다.
- README, 패키지 메타데이터, TypeScript/Rust 설정, 카탈로그, 플러그인 매니페스트, setup/config/hook 코드, 팀 런타임, 탐색 하네스, 스킬, 프롬프트, 문서를 정적으로 읽었다. 조사 범위의 근거 파일은 `README.md:20-33`, `package.json:10-58`, `src/cli/index.ts:184-298`, `src/cli/setup.ts:1693-2177`, `src/config/generator.ts:79-129`, `src/config/codex-hooks.ts:5-13`, `src/team/runtime.ts:2305-2853`, `src/cli/explore.ts:31-55`, `crates/omx-explore/src/main.rs:13-43`, `skills/team/SKILL.md:8-17`, `prompts/team-orchestrator.md:1-8`, `docs/plugin-bundle-ssot.md:1-12`이다.
- 동작 테스트나 실제 Codex 모델 호출은 수행하지 않았다. README 자체도 `omx doctor`와 실제 `omx exec` 스모크 테스트의 증명 경계를 분리한다. 근거: `README.md:80-82`, `docs/codex-native-hooks.md:168-181`.

## 핵심 특징

1. **Codex CLI를 대체하지 않는 워크플로 레이어다.** README는 OMX가 OpenAI Codex CLI 위의 워크플로 레이어이며 Codex 실행 엔진을 유지한다고 설명한다. 근거: `README.md:20`, `README.md:28-33`.

2. **상태는 `.omx/`를 중심으로 지속된다.** README는 계획, 로그, 메모리, 런타임 상태가 `.omx/`에 저장된다고 설명하고, setup은 `.omx/`와 `.codex/` 관련 산출물을 `.gitignore`에 반영한다. 근거: `README.md:169-179`, `src/cli/setup.ts:221-235`.

3. **플러그인 번들과 setup은 의도적으로 분리되어 있다.** README는 플러그인이 npm 설치와 `omx setup`을 대체하지 않는다고 명시하고, 플러그인 매니페스트 설명도 skill/workflow discovery와 metadata만을 플러그인 범위로 둔다. 근거: `README.md:66-68`, `plugins/oh-my-codex/.codex-plugin/plugin.json:20-29`, `docs/plugin-bundle-ssot.md:7-12`.

4. **`$deep-interview`, `$ralplan`, `$ralph`, `$team`, `$autopilot` 같은 스킬이 절차적 워크플로를 만든다.** README는 canonical skills를 소개하고, 카탈로그는 핵심 스킬을 active/core로 검증한다. 근거: `README.md:28-33`, `src/catalog/schema.ts:28-31`, `src/catalog/manifest.json:5-290`.

5. **팀 실행은 단순 프롬프트가 아니라 tmux, 상태 파일, mailbox, worker lifecycle을 묶은 런타임이다.** `$team` 스킬은 tmux 기반 병렬 실행, 실제 Codex/Claude 세션, `.omx/state/team/...` 조정 파일을 요구한다. 근거: `skills/team/SKILL.md:8-17`, `skills/team/SKILL.md:132-158`, `src/team/runtime.ts:2305-2853`.

6. **MCP는 호환 인터페이스지만 기본 운영은 CLI-first다.** README는 wiki가 CLI-first JSON과 markdown/search-first라고 설명하고, 플러그인 MCP manifest는 `omx_state`, `omx_memory`, `omx_code_intel`, `omx_trace`, `omx_wiki`, `omx_hermes`를 모두 `enabled: false`로 둔다. 근거: `README.md:280-293`, `plugins/oh-my-codex/.mcp.json:2-50`, `src/config/omx-first-party-mcp.ts:103-127`.

7. **네이티브 Codex hook과 runtime fallback을 혼합한다.** 네이티브 hook 문서는 setup이 `.codex/config.toml`과 `.codex/hooks.json`을 소유하고 사용자 hook을 보존한다고 설명하며, 지원되는 native/fallback hook matrix를 제공한다. 근거: `docs/codex-native-hooks.md:7-21`, `docs/codex-native-hooks.md:23-59`.

8. **읽기 전용 탐색/요약 하네스는 안전 경계가 강하다.** `omx explore`는 read-only fast path, command 제한, output/process/time 제한을 문서화하고, Rust 하네스는 환경 변수 scrub, 허용 명령, timeout/process/output cap을 구현한다. 근거: `src/cli/explore.ts:31-55`, `src/cli/explore.ts:124-134`, `src/cli/explore.ts:383-419`, `crates/omx-explore/src/main.rs:13-43`, `crates/omx-explore/src/main.rs:405-428`.

## 구조/아키텍처

### 배포 및 언어 계층

- Node CLI 패키지가 주 배포 단위다. `bin.omx`가 `./src/cli/omx.ts`를 가리키고, Node 요구 버전은 `>=20`이다. 근거: `package.json:6-8`, `package.json:60-62`.
- TypeScript는 `NodeNext`, `ES2022`, `strict` 컴파일로 설정되어 있다. 근거: `tsconfig.json:3-17`.
- Rust 크레이트는 native sidecar 역할을 한다. Cargo 워크스페이스에 explore, mux, runtime, sparkshell 계열 크레이트가 있다. 근거: `Cargo.toml:1-9`.
- `package.json`의 packaged files는 `dist`, `crates`, `skills`, `prompts`, `templates`, `src/scripts`, `plugins`, `.agents/plugins/marketplace.json`를 포함한다. 이는 npm 패키지가 단순 CLI 코드만이 아니라 스킬/프롬프트/플러그인 산출물까지 배포한다는 근거다. 근거: `package.json:63-74`.

### CLI 라우터

- `src/cli/omx.ts`는 빌드된 `dist/cli/index.js`를 로드하고, 빌드되지 않았으면 오류를 낸다. 근거: `src/cli/omx.ts:1-4`, `src/cli/omx.ts:17-28`.
- `src/cli/index.ts`는 `launch`, `exec`, `imagegen`, `setup`, `update`, `uninstall`, `doctor`, `cleanup`, `ask`, `question`, `adapt`, `resume`, `explore`, `api`, `session`, `agents`, `team`, `ralph`, `ultragoal`, `performance-goal`, `autoresearch goal`, `tmux-hook`, `hooks`, `hud`, `sidecar`, `state`, `wiki`, `mcp-serve`, `sparkshell`을 단일 도움말 표면으로 묶는다. 근거: `src/cli/index.ts:184-298`.
- 인자가 없거나 `--`만 있으면 launch로 해석하고, `exec`/`team`/`state`/`wiki`/`mcp-serve` 등은 별도 command handler로 분기한다. 근거: `src/cli/index.ts:540-552`, `src/cli/index.ts:1229-1415`.

### setup/config/hook 계층

- `omx setup`은 skill, prompt, MCP server config, `AGENTS.md`를 설치하는 명령으로 정의되어 있다. 근거: `src/cli/setup.ts:1-4`.
- setup은 skill frontmatter를 직접 파싱하고 `name`, `description`이 비어 있지 않은 단일 라인인지 검증한다. 근거: `src/cli/setup.ts:407-495`.
- 설치된 skill description에는 `[OMX]` badge를 붙인다. 근거: `src/cli/setup.ts:498-518`.
- setup은 플러그인 모드일 때 legacy prompt/native-agent 파일을 정리하고, legacy 모드일 때 설치한다. 근거: `src/cli/setup.ts:1910-1935`, `src/cli/setup.ts:2013-2024`.
- `config/generator.ts`는 TOML generator에서 top-level key와 table header 순서를 직접 제어하고, OMX가 소유하는 top-level key를 `notify`, `model_reasoning_effort`, `developer_instructions`로 제한한다. 근거: `src/config/generator.ts:1-11`, `src/config/generator.ts:66-71`.
- default setup context는 frontier model, context window `250000`, auto compact `200000`을 둔다. 근거: `src/config/generator.ts:79-82`.
- native hook 설정은 `SessionStart`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `PreCompact`, `PostCompact`, `Stop` 이벤트를 관리 대상으로 둔다. 근거: `src/config/codex-hooks.ts:5-13`.
- hook merge는 기존 사용자 hook을 제거하지 않고 managed hook만 strip/merge하며, trust state hash를 생성한다. 근거: `src/config/codex-hooks.ts:423-477`, `src/config/codex-hooks.ts:594-675`.

### 카탈로그와 플러그인 번들

- skill/agent catalog는 active, alias, merged, deprecated, internal 상태를 가진다. 스키마는 required core skill set에 `ralplan`, `team`, `ralph`, `ultrawork`, `ultragoal`, `autopilot`을 요구한다. 근거: `src/catalog/schema.ts:1-3`, `src/catalog/schema.ts:28-31`, `src/catalog/schema.ts:43-138`.
- 플러그인 marketplace entry는 `oh-my-codex-local` 이름 아래 local source path `./plugins/oh-my-codex`를 가리킨다. 근거: `.agents/plugins/marketplace.json:2-18`.
- 플러그인 manifest는 skill directory, MCP metadata, app metadata를 포함하지만 setup-owned `agents`, `prompts`, `hooks`는 의도적으로 포함하지 않는다. 근거: `plugins/oh-my-codex/.codex-plugin/plugin.json:2-29`, `docs/plugin-bundle-ssot.md:11-12`, `docs/plugin-bundle-ssot.md:52`.
- `sync-plugin-mirror.ts`는 root skills와 catalog, plugin mirror, plugin manifest, MCP/app metadata의 일관성을 검증한다. 근거: `src/scripts/sync-plugin-mirror.ts:105-175`, `src/scripts/sync-plugin-mirror.ts:177-251`, `src/scripts/sync-plugin-mirror.ts:296-340`.

### 프롬프트와 에이전트 계층

- native agent 정의는 name, description, reasoning effort, posture, model class, routing role, tool posture, category를 명시한다. 근거: `src/agents/definitions.ts:7-18`.
- agent role은 build/analysis, review, domain, product, coordination lane으로 나뉜다. 예를 들어 `explore`, `analyst`, `planner`, `architect`, `debugger`, `executor`, `team-executor`, `verifier`가 build 계열이고, `code-reviewer`는 high reasoning/read-only/frontier reviewer다. 근거: `src/agents/definitions.ts:42-105`, `src/agents/definitions.ts:107-167`.
- 프롬프트 파일은 role별로 identity, scope guard, execution loop, success criteria, output contract를 담는다. 예: `executor`는 계속 진행하되 scope guard와 ask gate를 둔다. 근거: `prompts/executor.md:5-13`, `prompts/executor.md:21-31`, `prompts/executor.md:50-76`, `prompts/executor.md:78-107`.
- `team-orchestrator` 프롬프트는 supervised high-overhead, conservative staffing, bounded delegation, evidence completion을 요구한다. 근거: `prompts/team-orchestrator.md:1-8`.

### 팀 런타임 계층

- `omx team` 도움말은 `status`, `await`, `resume`, `shutdown`, `api`, dedicated worktree 기본값, tmux runtime, 작은 fanout에는 native subagent를 권장하는 점을 노출한다. 근거: `src/cli/team.ts:280-302`.
- Team API는 send/broadcast/mailbox/create/read/update/claim/transition/release/heartbeat/inbox/identity/events/await/summary/cleanup/shutdown/task approval 같은 operation을 기계 판독 가능한 JSON으로 제공한다. 근거: `src/cli/team.ts:322-356`.
- task 상태 전이는 `claimTask`, `transitionTaskStatus`, `releaseTaskClaim`, `reclaimExpiredClaim`로 나뉘며, readiness, lock, version, terminal state, lease, claim token을 검사한다. 근거: `src/team/state/tasks.ts:27-44`, `src/team/state/tasks.ts:57-114`, `src/team/state/tasks.ts:165-282`.
- runtime은 중복 active team을 막고, start/monitor/shutdown entrypoint를 제공한다. 근거: `src/team/runtime.ts:305-331`, `src/team/runtime.ts:2305-2313`, `src/team/runtime.ts:3111-3121`, `src/team/runtime.ts:3520-3523`.
- background runtime CLI는 JSON input schema를 읽고 start/monitor/shutdown을 구조화된 JSON으로 실행한다. 근거: `src/team/runtime-cli.ts:1-8`, `src/team/runtime-cli.ts:41-66`, `src/team/runtime-cli.ts:296-316`, `src/team/runtime-cli.ts:391-416`.

### 탐색/요약 하네스 계층

- `omx explore`는 prompt와 read-only 명령을 받아 local fast path, sparkshell route, native explore harness route로 분기한다. 근거: `src/cli/explore.ts:31-55`, `src/cli/explore.ts:685-777`.
- `omx sparkshell`은 command output과 tmux pane tail을 요약하는 별도 native binary wrapper다. 명령 실행, `--shell` opt-in, `--tmux-pane`, JSON mode, raw fallback을 지원한다. 근거: `src/cli/sparkshell.ts:24-34`, `src/cli/sparkshell.ts:237-308`, `src/cli/sparkshell.ts:340-393`.
- Rust `omx-sparkshell`은 입력 target을 direct/shell/tmux로 검증하고, cache와 line range evidence를 기록한다. 근거: `crates/omx-sparkshell/src/main.rs:187-412`, `crates/omx-sparkshell/src/main.rs:422-440`, `crates/omx-sparkshell/src/main.rs:516-584`.

## 도구/명령/스크립트/프롬프트 인벤토리

### npm scripts

| 항목 | 역할 | 근거 |
| --- | --- | --- |
| `build` | `dist`를 지우고 TypeScript compile 후 CLI/script 실행권한 부여 | `package.json:10-12` |
| `build:explore`, `build:full` | Rust native explore 빌드 및 전체 빌드 | `package.json:13-14` |
| `test`, `test:coverage`, `lint`, `check` | Node test runner, c8 coverage, Biome, TypeScript no-emit 검증 | `package.json:15-32` |
| `prepack` | build, native-agent verify, plugin sync/verify, clean native assets를 패키징 전에 수행 | `package.json:33-35` |
| `postinstall` | 설치 후 bootstrap script 실행 | `package.json:36` |
| `sync:plugin`, `verify:plugin-bundle`, `sync:plugin:check` | plugin mirror 갱신/검증 | `package.json:37-43`, `docs/plugin-bundle-ssot.md:13-21` |
| `verify:native-agents` | catalog/definition/prompt/TOML metadata 일관성 검증 | `package.json:44`, `docs/plugin-bundle-ssot.md:32-49` |
| native asset scripts | release/package용 native asset hydrate/verify/clean | `package.json:45-58` |

### 주요 CLI 명령

| 명령 | 역할 | 근거 |
| --- | --- | --- |
| `omx` / `omx launch` | 기본 Codex launch wrapper, tmux launch 기본값과 `--direct` 우회 제공 | `README.md:123-156`, `src/cli/index.ts:184-298`, `src/cli/index.ts:540-552` |
| `omx exec` | prompt injection 또는 overlay exec 경로 | `src/cli/index.ts:1359-1364` |
| `omx setup`, `update`, `uninstall`, `doctor`, `cleanup` | 설치, 갱신, 제거, 진단, 정리 표면 | `README.md:223-235`, `src/cli/index.ts:184-298` |
| `omx list --json` | catalog skill/agent 목록과 상태 요약 출력 | `src/cli/list.ts:4-9`, `src/cli/list.ts:17-48` |
| `omx team` | tmux/team runtime 시작, 상태, 대기, 재개, 종료, API | `README.md:212-220`, `src/cli/team.ts:280-356`, `src/cli/team.ts:1381-1726` |
| `omx ralph`, `omx ultragoal`, `omx performance-goal`, `omx autoresearch goal` | 장기 목표/완료 지향 workflow runner | `src/cli/index.ts:1372-1385` |
| `omx state`, `notepad`, `project-memory`, `trace`, `code-intel`, `wiki`, `mcp-serve` | 상태/메모리/트레이스/wiki/MCP 관련 CLI-first 표면 | `src/cli/index.ts:1396-1415`, `README.md:280-293` |
| `omx explore`, `omx sparkshell` | 읽기 전용 탐색, 출력 요약, native sidecar 활용 | `src/cli/explore.ts:31-55`, `src/cli/sparkshell.ts:24-34` |
| `omx hud`, `tmux-hook`, `hooks`, `sidecar`, `session`, `agents` | 상태 표시, hook, sidecar, session, agent 운영 표면 | `src/cli/index.ts:184-298`, `skills/hud/SKILL.md:10-25` |

### 스킬 인벤토리

- catalog상 핵심 active skill은 `autopilot`, `ralph`, `ultrawork`, `team`, `ultragoal`, `ralplan`이며, `ralplan`은 canonical `plan` 계열로도 관리된다. 근거: `src/catalog/manifest.json:5-290`, `src/catalog/schema.ts:28-31`.
- root `skills/`에는 `ai-slop-cleaner`, `analyze`, `ask`, `ask-claude`, `ask-gemini`, `autopilot`, `autoresearch`, `autoresearch-goal`, `best-practice-research`, `build-fix`, `cancel`, `code-review`, `configure-notifications`, `deep-interview`, `deepsearch`, `design`, `doctor`, `ecomode`, `frontend-ui-ux`, `git-master`, `help`, `hud`, `note`, `omx-setup`, `performance-goal`, `pipeline`, `plan`, `ralph-init`, `ralph`, `ralplan`, `review`, `security-review`, `skill`, `swarm`, `tdd`, `team`, `trace`, `ultragoal`, `ultraqa`, `ultrawork`, `visual-ralph`, `visual-verdict`, `web-clone`, `wiki`, `worker`가 존재한다. 근거: `src/catalog/manifest.json:5-290`와 root skill directory 정합성을 강제하는 `src/scripts/sync-plugin-mirror.ts:105-175`.
- `worker`는 internal required skill로 catalog에 남아 있으며, worker runtime protocol은 `skills/worker/SKILL.md`에 별도로 정의되어 있다. 근거: `src/catalog/manifest.json:285-289`, `skills/worker/SKILL.md:12-26`.

### 프롬프트 및 native agent 인벤토리

- agent 정의는 build/analysis lane의 `explore`, `analyst`, `planner`, `architect`, `debugger`, `executor`, `team-executor`, `verifier`를 포함한다. 근거: `src/agents/definitions.ts:42-105`.
- review lane은 `style-reviewer`, `quality-reviewer`, `api-reviewer`, `security-reviewer`, `performance-reviewer`, `code-reviewer`를 포함한다. 근거: `src/agents/definitions.ts:107-167`.
- domain/product/coordination lane은 `dependency-expert`, `test-engineer`, `quality-strategist`, `build-fixer`, `designer`, `writer`, `qa-tester`, `git-master`, `code-simplifier`, `researcher`, `product-manager`, `ux-researcher`, `information-architect`, `product-analyst`, `critic`, `vision`을 포함한다. 근거: `src/agents/definitions.ts:169-333`.
- `prompts/planner.md`, `prompts/executor.md`, `prompts/team-executor.md`, `prompts/code-reviewer.md`, `prompts/team-orchestrator.md` 등은 setup-owned prompt asset이다. 이 분류는 plugin bundle contract에 명시되어 있다. 근거: `docs/plugin-bundle-ssot.md:32-50`.

### 플러그인/MCP 인벤토리

- plugin manifest: `plugins/oh-my-codex/.codex-plugin/plugin.json`은 name/version, skill path, MCP/app metadata, longDescription을 둔다. 근거: `plugins/oh-my-codex/.codex-plugin/plugin.json:2-29`.
- MCP manifest: `plugins/oh-my-codex/.mcp.json`은 `omx_state`, `omx_memory`, `omx_code_intel`, `omx_trace`, `omx_wiki`, `omx_hermes` 서버를 `omx mcp-serve <target>` 형태로 정의하고 기본 비활성화한다. 근거: `plugins/oh-my-codex/.mcp.json:2-50`.
- first-party MCP canonical spec은 `src/config/omx-first-party-mcp.ts`이고, setup용 manifest는 Node entrypoint를, plugin용 manifest는 `omx mcp-serve`를 사용한다. 근거: `src/config/omx-first-party-mcp.ts:15-58`, `src/config/omx-first-party-mcp.ts:90-127`.

## 각 도구가 왜 그렇게 작성되어야 했는지에 대한 근거 또는 엄밀한 추론

| 대상 | 작성 방식 | 근거 또는 엄밀한 추론 |
| --- | --- | --- |
| `omx setup` | user/project scope의 Codex config, hooks, skills, prompts, AGENTS, HUD, MCP registry를 단계적으로 설치/정리한다. | 근거: setup 함수 인자는 `force`, `dryRun`, `installMode`, `mcpMode`, `scope`를 받으며, prompts/native agents/plugin cache/MCP/hooks/AGENTS/HUD를 단계별로 다룬다. `src/cli/setup.ts:1693-1701`, `src/cli/setup.ts:1910-2177`, `src/cli/setup.ts:2257-2545`. 엄밀한 추론: Codex 설정과 hook은 사용자 소유 파일이므로, `buildMergedConfig`가 사용자 설정을 보존하고 managed block만 교체하는 방식이 필요했다. 제약 근거: `src/config/generator.ts:2046-2142`, `src/config/codex-hooks.ts:594-675`. |
| plugin bundle | skills/MCP/apps metadata만 싣고 prompts/native agents/hooks는 setup-owned로 남긴다. | 근거: plugin manifest와 SSOT 문서가 `agents`, `prompts`, `hooks`를 official plugin에서 제외한다고 명시한다. `plugins/oh-my-codex/.codex-plugin/plugin.json:20-29`, `docs/plugin-bundle-ssot.md:7-12`, `docs/plugin-bundle-ssot.md:52`. 엄밀한 추론: 플러그인 설치만으로 hook/config/runtime wiring을 안전하게 덮어쓸 수 없으므로 discovery와 설치 권한을 분리한 구조다. |
| `sync-plugin-mirror` | catalog, root skills, plugin mirror, manifest, MCP/apps를 모두 비교하고 불일치 시 실패한다. | 근거: unlisted root dirs, active installable missing, manifest policy, MCP/apps metadata 검증을 수행한다. `src/scripts/sync-plugin-mirror.ts:105-175`, `src/scripts/sync-plugin-mirror.ts:177-251`, `src/scripts/sync-plugin-mirror.ts:296-340`. 엄밀한 추론: root skill이 canonical source이고 plugin mirror가 generated output이므로 release 직전 drift를 막는 verifier가 필요하다. SSOT 문서도 같은 계약을 둔다. `docs/plugin-bundle-ssot.md:1-12`. |
| `$deep-interview` | ambiguous request를 여러 차례 질문하고, ambiguity/readiness score와 artifact를 남긴다. | 근거: skill은 one-question-at-a-time Socratic loop, readiness 계산, artifact 저장, execution bridge를 정의한다. `skills/deep-interview/SKILL.md:29-36`, `skills/deep-interview/SKILL.md:131-188`, `skills/deep-interview/SKILL.md:271-336`, `skills/deep-interview/SKILL.md:361-423`. 엄밀한 추론: downstream `$ralplan`/`$team`/`$ralph`가 비용이 큰 실행 모드이기 때문에, 요구가 모호할 때 사전 질의 gate가 필요하다. 이 제약은 `$ralplan`의 pre-execution gate와도 일치한다. `skills/ralplan/SKILL.md:75-104`. |
| `$ralplan` | Planner, Architect, Critic을 순차적으로 돌리고 consensus plan을 만든다. | 근거: alias `$plan --consensus`, flags, Planner/Architect/Critic workflow, pre-context intake, concrete signal gate가 명시되어 있다. `skills/ralplan/SKILL.md:8-20`, `skills/ralplan/SKILL.md:31-61`, `skills/ralplan/SKILL.md:75-156`. 엄밀한 추론: planning mode에서 바로 execution으로 가지 않고 검토 루프를 두는 이유는 실행형 mode로의 전이를 allowlist로 제한하는 상태 모델과 연결된다. `docs/STATE_MODEL.md:143-169`. |
| `$ralph` | persistence loop, verification, background delegation, deslop, goal-mode completion audit를 요구한다. | 근거: Ralph는 guaranteed completion 상황에 쓰이며, pre-context, verification/deslop, goal state, stop condition, final checklist를 가진다. `skills/ralph/SKILL.md:10-19`, `skills/ralph/SKILL.md:32-90`, `skills/ralph/SKILL.md:103-132`, `skills/ralph/SKILL.md:182-201`. 엄밀한 추론: 장기 실행이 중단되거나 완료 주장이 검증되지 않는 문제를 막기 위해 Stop hook continuation과 상태 파일이 결합된다. hook matrix도 Ralph Stop handling을 native-partial로 둔다. `docs/codex-native-hooks.md:41-49`. |
| `$autopilot` | `$ralplan -> $ralph -> $code-review` strict loop로 고정한다. | 근거: skill은 strict loop contract, pre-context, execution policy, state, resume, stop/final 규칙을 명시한다. `skills/autopilot/SKILL.md:6-14`, `skills/autopilot/SKILL.md:29-65`, `skills/autopilot/SKILL.md:77-145`. 엄밀한 추론: 계획, 실행, 검토 단계를 느슨한 자연어가 아니라 stateful pipeline으로 묶기 위한 장치다. 상태 모델도 `autopilot -> ralplan` review loopback만 예외적으로 허용한다. `docs/STATE_MODEL.md:143-169`. |
| `$team` | tmux panes, worker sessions, `.omx/state/team/...`, mailbox, task DAG, claim-safe transitions를 사용한다. | 근거: skill은 native subagents와 `omx team`의 차이를 설명하고, state-first dispatch와 API operations를 요구한다. `skills/team/SKILL.md:8-17`, `skills/team/SKILL.md:236-317`. task state code는 claim token, lease, terminal guard, dependency readiness를 검사한다. `src/team/state/tasks.ts:27-114`, `src/team/state/tasks.ts:165-282`. 엄밀한 추론: 독립 Codex 세션 여러 개가 병렬로 같은 repo를 만지는 구조라서, 파일 기반 state와 claim protocol 없이는 task race와 완료 주장 충돌이 발생한다. |
| `$worker` | worker가 직접 lifecycle field를 쓰지 않고 `omx team api`로 ACK, claim, transition, mailbox를 처리한다. | 근거: worker skill은 `OMX_TEAM_WORKER` identity, startup ACK, task claim/transition, no direct lifecycle field writes를 명시한다. `skills/worker/SKILL.md:12-26`, `skills/worker/SKILL.md:27-72`. 엄밀한 추론: worker가 파일을 임의 수정하면 leader monitor와 task transition invariant가 깨지므로 API를 단일 mutation gate로 둔다. 관련 API와 task transition 제약은 `src/cli/team.ts:322-384`, `src/team/state/tasks.ts:165-246`에 있다. |
| `omx explore` | read-only command allowlist, local fast path, sparkshell route, native harness fallback을 둔다. | 근거: explore는 read-only git subcommands와 shell pattern denylist를 두고, file lookup에서 absolute/`..`/shell metachar를 거부하며, command routing도 read-only `git/find/ls/rg/grep`로 제한한다. `src/cli/explore.ts:124-134`, `src/cli/explore.ts:197-217`, `src/cli/explore.ts:383-419`. 엄밀한 추론: 탐색 하네스가 모델과 shell을 엮는 표면이라서, 분석 전용 제약을 코드 레벨에서 강제해야 한다. |
| Rust `omx-explore` | 환경 변수 scrub, timeout/process/output cap, fallback model notice를 구현한다. | 근거: env scrub와 Windows unsupported, allowed direct commands, prompt contract, fallback event/notice, read-only Codex exec invocation, env parsing이 있다. `crates/omx-explore/src/main.rs:28-43`, `crates/omx-explore/src/main.rs:124-166`, `crates/omx-explore/src/main.rs:199-222`, `crates/omx-explore/src/main.rs:287-324`, `crates/omx-explore/src/main.rs:405-428`. 엄밀한 추론: TypeScript wrapper만으로는 process tree kill/output cap 같은 OS 경계를 안정적으로 통제하기 어려워 native sidecar를 둔 것으로 보인다. |
| `omx sparkshell` | 큰 command output이나 tmux tail을 압축하되 raw fallback과 evidence hash를 남긴다. | 근거: CLI wrapper는 explicit shell opt-in과 tmux pane tail bound를 강제하고, Rust implementation은 target validation, cache, evidence line range/hash, JSON report를 제공한다. `src/cli/sparkshell.ts:24-34`, `src/cli/sparkshell.ts:237-308`, `crates/omx-sparkshell/src/main.rs:187-440`, `crates/omx-sparkshell/src/main.rs:817-895`. 엄밀한 추론: team/tmux 기반 실행에서는 pane output이 길고 반복되므로, 비용을 낮추면서도 원문 근거를 잃지 않는 요약 계층이 필요하다. |
| native hooks | managed wrapper command와 trust hash를 생성하고 기존 user hooks를 보존한다. | 근거: setup owns `.codex/hooks.json` but preserves user hook entries, trust state records trusted hash, mapping matrix separates native/fallback. `docs/codex-native-hooks.md:7-30`, `src/config/codex-hooks.ts:423-477`, `src/config/codex-hooks.ts:594-675`. 엄밀한 추론: hook은 보안/권한 경계이므로, generated wrapper만 신뢰 상태로 기록하고 user hook을 Codex normal review flow에 남기는 구조가 필요하다. |
| `omx doctor` | 설치/상태 검사를 넓게 수행하지만 실제 인증된 모델 실행 증명과 분리한다. | 근거: doctor는 Codex CLI, Node, explore harness, Codex home/config, model context, native hooks, prompts/skills, AGENTS, state dir, MCP, prompt triage를 검사한다. `src/cli/doctor.ts:138-243`. hook 문서는 real execution readiness는 `omx exec` smoke로 검증하라고 한다. `docs/codex-native-hooks.md:21`, `docs/codex-native-hooks.md:168-181`. 엄밀한 추론: 설치 정합성과 provider/auth/runtime 성공은 실패 원인이 다르기 때문에 검사 경계를 분리한 구조다. |
| `$wiki` / `omx_wiki` | markdown/search-first 저장소 wiki로 두고 vector embedding을 피한다. | 근거: README는 wiki를 CLI-first JSON, markdown/search-first, `omx_wiki`로 설명한다. `README.md:280-293`. native hook 문서는 storage를 repo `omx_wiki/`로 한정하고 session-start는 bounded context만 읽는다고 한다. `docs/codex-native-hooks.md:123-132`. 엄밀한 추론: repo-local knowledge base를 git diff/검색/리뷰 가능한 파일로 유지해 setup/runtime state와 분리하려는 선택이다. |

## 장점

- **소유권 경계가 명확하다.** plugin discovery, setup-owned prompts/native agents/hooks, runtime state, user hook preservation이 문서와 verifier로 분리되어 있다. 근거: `README.md:66-68`, `docs/plugin-bundle-ssot.md:1-12`, `src/scripts/sync-plugin-mirror.ts:195-251`.
- **상태 전이와 workflow overlap을 문서화했다.** `.omx/state/<mode>-state.json`을 authoritative state로 두고, `skill-active-state.json`은 compatibility/visibility layer로 둔다. 근거: `docs/STATE_MODEL.md:12-47`.
- **병렬 팀 실행의 동시성 문제를 파일/API 프로토콜로 다룬다.** task readiness, claim token, lease, terminal guard가 구현되어 있다. 근거: `src/team/state/tasks.ts:27-114`, `src/team/state/tasks.ts:165-282`.
- **진단 표면이 풍부하다.** doctor는 설치, config, hooks, prompts/skills, AGENTS, MCP, team runtime stale 상태까지 확인한다. 근거: `src/cli/doctor.ts:138-243`, `src/cli/doctor.ts:319-544`.
- **안전 제약이 코드에 들어 있다.** explore/sparkshell은 read-only command filtering, env scrub, output/process/time bounds, explicit shell opt-in을 둔다. 근거: `src/cli/explore.ts:124-134`, `src/cli/explore.ts:383-419`, `crates/omx-explore/src/main.rs:28-43`, `src/cli/sparkshell.ts:237-308`.
- **release drift 방지 장치가 많다.** `prepack`에서 build, native agent verify, plugin sync/verify, native asset cleanup을 실행하고, SSOT 문서가 contributor workflow를 정의한다. 근거: `package.json:33-58`, `docs/plugin-bundle-ssot.md:13-30`.

## 약한 점/리스크

- **표면적이 매우 크다.** 정적 측정 기준으로 `src/cli/index.ts` 4,785줄, `src/cli/setup.ts` 3,677줄, `src/team/runtime.ts` 5,376줄, `src/config/generator.ts` 2,202줄, `crates/omx-explore/src/main.rs` 2,972줄이다. 엄밀한 추론: 단일 CLI/setup/runtime 파일이 커질수록 변경 영향 분석과 회귀 테스트 비용이 증가한다. 구조적 근거는 각 파일이 명령 분기, 설치, 팀 orchestration, config merge, native harness 정책을 넓게 보유한다는 점이다. `src/cli/index.ts:184-298`, `src/cli/setup.ts:1693-2545`, `src/team/runtime.ts:2305-3523`, `src/config/generator.ts:2046-2142`.
- **운영 플랫폼 의존성이 있다.** README는 macOS/Linux를 best support, Windows를 secondary로 두고, tmux를 macOS/Linux runtime으로 전제한다. explore harness도 Windows unsupported 메시지를 가진다. 근거: `README.md:97-103`, `README.md:295-299`, `crates/omx-explore/src/main.rs:28-39`.
- **setup이 사용자 Codex 설정과 hook 파일을 만진다.** merge/preserve 로직은 있지만, `.codex/config.toml`, `.codex/hooks.json`, plugin cache, AGENTS, HUD config를 다루므로 잘못된 marker나 migration bug의 영향이 크다. 근거: `src/cli/setup.ts:2142-2177`, `src/cli/setup.ts:2257-2308`, `src/config/generator.ts:2046-2142`, `src/config/codex-hooks.ts:594-675`.
- **plugin mode와 legacy setup mode가 공존해 인지 부담이 있다.** README는 plugin이 setup 대체물이 아니라고 하고, setup은 plugin mode에서 legacy prompt/native agent를 정리한다. 엄밀한 추론: 사용자가 plugin 설치만으로 runtime wiring이 끝났다고 오해할 수 있다. 근거: `README.md:66-68`, `src/cli/setup.ts:1910-1935`, `src/cli/setup.ts:2013-2024`, `docs/plugin-bundle-ssot.md:52`.
- **팀 런타임은 강력하지만 운영 실패 모드가 많다.** `$team` 문서는 startup evidence, resume/status, await, shutdown gate, active leader monitoring, failure modes를 길게 요구한다. 이는 기능 성숙도의 근거이면서 동시에 조작 복잡도의 증거다. 근거: `skills/team/SKILL.md:83-119`, `skills/team/SKILL.md:202-230`, `skills/team/SKILL.md:375-437`, `skills/team/SKILL.md:508-512`.
- **문서에 destructive recovery 예시가 있다.** `$team` clean-slate recovery는 `.omx/state/team/...` 정리와 `rm -rf` 예시를 포함한다. 엄밀한 추론: DITTO가 차용할 때는 복구 명령을 dry-run/confirm/target validation으로 감싸야 한다. 근거: `skills/team/SKILL.md:446-469`.
- **native binary/hydration 경로가 추가 실패 지점이다.** explore/sparkshell wrapper는 packaged/repo/cargo fallback, hydration, cached native binary 경로를 갖는다. 엄밀한 추론: 배포 환경의 libc, PATH, 권한, cache 상태에 따라 하네스 사용성이 달라질 수 있다. 근거: `src/cli/explore.ts:568-631`, `src/cli/sparkshell.ts:106-183`, `src/cli/sparkshell.ts:340-393`.
- **doctor가 모든 readiness를 증명하지 않는다.** 문서가 hook/install evidence와 실제 authenticated Codex execution readiness를 구분하라고 명시한다. 근거: `README.md:80-82`, `docs/codex-native-hooks.md:168-181`.

## DITTO에서 차용할 점

1. **plugin discovery와 runtime setup을 분리한다.** DITTO도 스킬/프롬프트 배포 메타데이터와 사용자 환경 변경 작업을 분리해야 한다. 차용 근거: `docs/plugin-bundle-ssot.md:7-12`, `plugins/oh-my-codex/.codex-plugin/plugin.json:20-29`.

2. **카탈로그를 단일 출처로 두고 mirror 검증을 자동화한다.** active/internal/deprecated/alias/merged 상태와 required core set을 manifest/schema로 검증하는 방식은 DITTO의 하네스 목록 관리에도 적합하다. 차용 근거: `src/catalog/schema.ts:1-3`, `src/catalog/schema.ts:28-31`, `src/scripts/sync-plugin-mirror.ts:105-175`.

3. **상태 모델을 authoritative/compatibility 계층으로 나눈다.** `.omx/state/<mode>-state.json`과 `skill-active-state.json`의 역할 분리는 DITTO에서도 workflow state와 UI/hook visibility state를 혼동하지 않게 한다. 차용 근거: `docs/STATE_MODEL.md:12-47`.

4. **팀 실행은 state-first API를 둔다.** worker가 tmux pane에 직접 의존하지 않고 task claim/transition/mailbox API를 통하도록 하는 규칙은 병렬 에이전트 충돌을 줄인다. 차용 근거: `skills/team/SKILL.md:236-317`, `skills/worker/SKILL.md:50-72`, `src/team/state/tasks.ts:57-114`.

5. **pre-context와 ambiguity gate를 명시한다.** `$deep-interview`와 `$ralplan`의 사전 질의/구체성 gate는 모호한 요구로 대형 workflow가 바로 실행되는 문제를 줄인다. 차용 근거: `skills/deep-interview/SKILL.md:131-188`, `skills/ralplan/SKILL.md:75-104`.

6. **doctor와 smoke test의 증명 경계를 나눈다.** 설치 정합성, hook wiring, 실제 모델 실행/auth를 별도 체크로 분리해야 한다. 차용 근거: `README.md:80-82`, `docs/codex-native-hooks.md:168-181`.

7. **read-only 탐색 하네스는 allowlist와 cap을 코드로 강제한다.** shell/prompt 기반 분석 도구에는 command allowlist, env scrub, timeout, process limit, output limit, fallback notice를 넣어야 한다. 차용 근거: `src/cli/explore.ts:124-134`, `crates/omx-explore/src/main.rs:28-43`, `crates/omx-explore/src/main.rs:405-428`.

8. **hook trust state와 user hook preservation을 기본값으로 둔다.** generated hook만 관리 대상으로 삼고 기존 사용자 hook은 보존하는 방식은 하네스가 사용자 환경을 덜 깨뜨리게 한다. 차용 근거: `docs/codex-native-hooks.md:23-30`, `src/config/codex-hooks.ts:594-675`.

9. **운영 HUD는 상태 파일과 설정 preset을 분리한다.** `statusLine`과 `omx hud`의 two-layer model, `.omx/state` 기반 표시, config preset은 DITTO 운영 UI에도 참고할 수 있다. 차용 근거: `skills/hud/SKILL.md:10-25`, `skills/hud/SKILL.md:62-80`, `src/config/generator.ts:111-129`.

## 보완 계획

1. **DITTO 차용 전 최소 표면을 정한다.** oh-my-codex는 CLI/setup/team/runtime/hook/MCP/native sidecar까지 넓으므로, DITTO는 먼저 catalog, setup merge, state-first worker API, doctor 경계만 작은 MVP로 분리하는 것이 좋다. 근거가 되는 복잡도 표면: `src/cli/index.ts:184-298`, `src/cli/setup.ts:1693-2545`, `src/team/runtime.ts:2305-3523`.

2. **destructive recovery는 명령 예시가 아니라 안전한 서브커맨드로 감싼다.** `$team` 문서의 clean-slate recovery는 강력하지만 DITTO에서는 대상 검증, dry-run, 확인 프롬프트, backup을 가진 `ditto team cleanup --stale` 형태가 더 안전하다. 근거: `skills/team/SKILL.md:446-469`, `src/cli/team.ts:375-384`.

3. **plugin/setup mode를 사용자에게 한 문장으로 구분한다.** oh-my-codex는 분리가 타당하지만 오해 가능성이 있으므로, DITTO는 "plugin=발견/문서, setup=환경 변경" 같은 라벨을 CLI output과 doctor에 반복 표시해야 한다. 근거: `README.md:66-68`, `docs/plugin-bundle-ssot.md:52`.

4. **상태 전이 테스트를 먼저 만든다.** workflow overlap, auto-complete, denied rollback, compatibility sync invariant는 문서화되어 있으므로 DITTO는 구현 전에 transition table test를 작성해야 한다. 근거: `docs/STATE_MODEL.md:84-109`, `docs/STATE_MODEL.md:143-169`, `docs/STATE_MODEL.md:227-235`.

5. **native sidecar는 하드 요구가 아니라 선택 경로로 둔다.** DITTO가 explore/sparkshell을 차용한다면 Node-only fallback과 명확한 "성능 저하" 메시지를 유지해야 한다. 근거: oh-my-codex도 packaged/repo/cargo fallback과 raw fallback을 둔다. `src/cli/explore.ts:568-631`, `src/cli/sparkshell.ts:310-393`.

6. **doctor 결과를 "설치 증명", "실행 증명", "운영 증명"으로 나눈다.** oh-my-codex 문서는 hook proof와 plugin proof와 fallback proof를 구분한다. DITTO도 같은 레벨 구분을 채택해야 한다. 근거: `docs/codex-native-hooks.md:168-181`.

7. **문서/코드 SSOT를 릴리스 전에 검증한다.** skill 추가/변경 시 root skill, catalog manifest, plugin mirror, manifest/MCP metadata를 검증하는 release gate를 DITTO에도 둔다. 근거: `docs/plugin-bundle-ssot.md:13-30`, `src/scripts/sync-plugin-mirror.ts:105-175`.

## 기준 커밋 이후 변경 (2026-06-01 갱신)

> 기간: `6d438dac` → `ff17267b` (0.18.0 → 0.18.7), 226 커밋, 307 파일 변경.  
> 아래 각 항목은 해당 커밋 hash와 `path:line` 또는 파일 경로로 근거를 표시한다.

### 1. 버전 범프

- npm/Cargo 모두 `0.18.0` → `0.18.7`. 중간 릴리스: 0.18.2~0.18.7. 근거: `package.json:3 @ ff17267b`, `Cargo.toml:14 @ ff17267b`.

### 2. `$autopilot` 루프 계약 대폭 변경 — ralph 강등, ultragoal 기본화

기존 문서의 핵심 특징 4, 구조/아키텍처 "autopilot" 설명, "각 도구가 왜 그렇게 작성되어야 했는지" `$autopilot` 항목, "DITTO에서 차용할 점" 5번, ditto 적용 정리 표의 관련 셀이 영향받는다.

- **변경 전**: `$autopilot` = `$ralplan → $ralph → $code-review` 고정 loop.
- **변경 후**: `$autopilot` = `$deep-interview → $ralplan → $ultragoal (+ $team if needed) → $code-review → $ultraqa` 권장/기본 loop. Ralph는 "레거시/명시 대체 실행 경로"로 강등되었다. 근거: `skills/autopilot/SKILL.md:description @ ff17267b`.
- `$code-review` 미통과 시 phase 전이도 변경: 이전에는 `autopilot → ralplan` peer transition이었으나, 이제 `autopilot-state.json`을 유지하면서 `current_phase: "ralplan"`을 업데이트하는 방식으로 바뀌었다. State model에서도 `autopilot → ralplan` 독립 peer transition이 denied로 전환되었다. 근거: `skills/autopilot/SKILL.md:45-62 @ ff17267b`, `docs/STATE_MODEL.md:142-173 @ ff17267b`.
- **UltraQA** 단계가 새로 추가되었다. `$ultraqa`는 code-review 통과 후 런타임/CLI 동작·회귀 위험이 있을 때 실행된다. docs-only 변경이면 명시적 스킵+근거로 대체 가능하다. 근거: `skills/autopilot/SKILL.md:58-61 @ ff17267b`(검증됨 2026-06-01).
- `$ultragoal`이 autopilot의 기본 구현 실행 경로로 명시되었다. 근거: `skills/autopilot/SKILL.md:46-50, :82 @ ff17267b`(검증됨 2026-06-01).

**기존 분석 수정**: "각 도구가 왜 그렇게 작성되어야 했는지" `$autopilot` 항목의 "strict loop `$ralplan -> $ralph -> $code-review`" 표현은 현재 틀림. 권장 loop에 `$deep-interview`, `$ultragoal`, `$ultraqa`가 포함된다. Ralph는 deprecated 경로는 아니지만 default가 아님.

### 3. `$ralplan` 계약 강화 — 서브에이전트 순서 강제 및 planning/execution 경계 명시

- Architect/Critic를 "동일 parallel batch에서 동시 호출 불가"로 명시되어 있었으나, 이제 각각 `agent_type: "architect"`, `agent_type: "critic"` 서브에이전트로 순차 launch해야 하며, 임시 reviewer prompt 대체 불가 조건이 명시되었다. 근거: `skills/ralplan/SKILL.md:49-60 @ ff17267b`.
- **Durable Consensus Handoff Contract** 신설: PRD/test-spec 파일의 존재만으로 ralplan 완료 또는 execution handoff 허용이 안 된다. `ralplan_architect_review`, `ralplan_critic_review`, `ralplan_consensus_gate.complete:true` 모두 영속화해야 handoff 가능. 근거: `skills/ralplan/SKILL.md:68-94 @ ff17267b`.
- **Planning/Execution 경계** 섹션 신설: ralplan은 planning mode이며, planning artifact (`.omx/context/`, `.omx/plans/`, `.omx/specs/`, `.omx/state/` 레코드)만 작성 가능하다. 합의 완료 전에 코드 편집 금지. 근거: `skills/ralplan/SKILL.md:56-67 @ ff17267b`.
- `--interactive` approval 선택지에서 ralph가 "Explicit Ralph fallback" 항목으로 재분류되었고, `$ultragoal`이 default durable goal execution으로 승격되었다. 근거: `skills/ralplan/SKILL.md:79-91 @ ff17267b`.
- **Scholastic** advisory agent 언급 추가: ontology-heavy planning에서 자문 역할. 근거: `skills/ralplan/SKILL.md:8 @ ff17267b`.

**기존 분석 수정**: "각 도구가 왜 그렇게 작성되어야 했는지" `$ralplan` 항목의 "alias `$plan --consensus`" 설명은 여전히 유효하나, handoff 조건에 consensus gate 영속화가 추가되었다는 점을 보완해야 한다.

### 4. 신규 스킬/에이전트: `$prometheus-strict` (Metis / Momus / Oracle)

기존 분석의 스킬 인벤토리와 catalog 목록이 영향받는다.

- `skills/prometheus-strict/SKILL.md`가 새로 추가되었다. clean-room interview-driven planner로, Metis(요구 명확화), Momus(가정/리스크 비판), Oracle(handoff 준비 검증)의 세 역할이 순차적으로 동작한다. 출력은 실행 스킬이 아닌 계획 전용 artifact(`.omx/plans/prometheus-strict/`)다. 근거: `skills/prometheus-strict/SKILL.md @ ff17267b`.
- 대응 native agent 3종 신설: `prometheus-strict-metis`, `prometheus-strict-momus`, `prometheus-strict-oracle`. metis/momus는 frontier·high reasoning, **oracle은 `modelClass:'standard'`**(검증됨 2026-06-01: `definitions.ts:345`). 근거: `src/agents/definitions.ts:320-349 @ ff17267b`.
- catalog에 active 비-core 스킬로 등록. 근거: `src/catalog/manifest.json @ ff17267b`.
- **Scholastic** native agent 신설: 온톨로지 우선 추론 리뷰어. category mistake, 숨겨진 가정, modality 분리, scholastic critique, minimal-repair 제안 역할. read-only tools, frontier, high reasoning. 근거: `src/agents/definitions.ts @ ff17267b`, `src/catalog/manifest.json @ ff17267b`.
- DITTO 함의: `$deep-interview`와 유사한 목적이나, prometheus-strict는 Metis/Momus/Oracle 역할 분리가 명시적이고 planning artifact가 별도 경로에 남는다. `$deep-interview` 대안 또는 보완 경로로 검토할 수 있다.

### 5. 경량 팀 조정 프로토콜 (Team Big Five / ATEM-inspired) 추가

기존 분석의 팀 런타임 계층 설명이 영향받는다.

- `docs/team-coordination-protocol.md` 신설: 독립 fan-out은 기존 가벼운 프로토콜(ACK, claim-safe lifecycle) 유지. 의존성/공유 파일/cross-boundary ownership/handoff/통합작업이 있을 때는 Team Big Five + ATEM 조정 게이트 활성화. 근거: `docs/team-coordination-protocol.md @ d2100490`.
- `skills/team/SKILL.md`에 동일 프로토콜 체크리스트 추가: shared mental model (task JSON/inbox/mailbox가 canonical), closed-loop ACK handoff, mutual performance monitoring, backup/reassignment 보고, adaptability checkpoint, team orientation (통합 결과 최적화). 근거: `skills/team/SKILL.md @ d2100490`.
- `skills/worker/SKILL.md`에 조정 프로토콜 안내 추가: 14줄 추가. 근거: `skills/worker/SKILL.md @ d2100490`.
- 런타임 상태 파일 지원: `src/team/coordination-protocol.ts` 신설(351줄), `src/team/state.ts` 45줄 추가. 근거: `src/team/coordination-protocol.ts @ d2100490`.
- DITTO 함의: 단순 fan-out과 복잡 상호의존 작업 구분 기준이 생겼다. "차용할 점" 4번(state-first team API)에 이 조정 프로토콜 계층을 추가로 검토해야 한다.

### 6. `OMX_LORE_COMMIT_GUARD` 기본값 변경 — opt-out → opt-in

기존 분석의 native hooks 설명("각 도구가 왜 그렇게 작성되어야 했는지" native hooks 항목)과 `docs/codex-native-hooks.md` 앵커가 영향받는다.

- **변경 전**: Lore commit guard는 기본 활성화, `OMX_LORE_COMMIT_GUARD=0`으로 비활성화.
- **변경 후**: Lore commit guard는 기본 비활성화, `OMX_LORE_COMMIT_GUARD=1`로 명시적 활성화(opt-in). 근거: `docs/codex-native-hooks.md:74-90 @ ff17267b`.
- inline git commit 차단이 "opted in일 때만" 작동한다는 점으로 PreToolUse hook 설명도 변경. 근거: `docs/codex-native-hooks.md:45 @ ff17267b`.

**기존 분석 수정**: 기존 분석에는 이 동작이 명시적으로 언급되지 않았지만, 향후 DITTO hook 설계에서 참고 시 opt-in 기본값을 전제해야 한다.

### 7. 플러그인 범위 hook 지원 추가 (plugin_hooks feature)

기존 분석의 "핵심 특징 7", "setup/config/hook 계층", `docs/plugin-bundle-ssot.md` 앵커가 영향받는다.

- Codex가 `[features].plugin_hooks`를 보고할 경우, hook 등록 표면이 `.codex/hooks.json`에서 `plugins/oh-my-codex/hooks/hooks.json`(+ `${PLUGIN_ROOT}`)으로 이동한다. 기존 `.codex/hooks.json` 경로는 legacy/fallback 설치로 재분류. 근거: `docs/codex-native-hooks.md:6-24 @ ff17267b`, `docs/plugin-bundle-ssot.md:8 @ ff17267b`.
- `plugin-bundle-ssot.md`의 공식 plugin manifest 제약도 갱신: `agents`와 `prompts`는 여전히 plugin에서 제외하지만, `hooks`는 이제 plugin 범위 hook(`./hooks/hooks.json`)으로 공식 포함. 근거: `docs/plugin-bundle-ssot.md:52 @ ff17267b`.
- DITTO 함의: "차용할 점" 8번(hook trust state, user hook preservation)에서 plugin_hooks 지원 환경과 legacy 환경을 구분해야 한다.

### 8. `omx auth` 명령 신설 — auth slot hot-swap

- `src/cli/auth.ts` 신설(93줄): `omx auth add <slot>`, `omx auth list [--json]`, `omx auth use <slot>`으로 named auth slot 등록/전환 지원. `~/.omx/auth/<slot>.json`에 owner-only 권한으로 저장. 근거: `src/cli/auth.ts @ 7f0a3fa1`.
- Ultragoal의 auth blocker 재시도 루프 수정과 연동되어 있다. 근거: `38fa4847`.
- DITTO 함의: DITTO가 멀티 provider/session 환경을 지원할 경우 참고.

### 9. hook payload 크기 제한 신설

- `src/scripts/hook-payload-guard.ts` 신설(113줄): notify argv JSON 최대 64KB, native stdin JSON 최대 1MB, raw field scan 최대 64KB. hook event name 타입 열거도 포함. 근거: `src/scripts/hook-payload-guard.ts:1-3 @ 34bef2bc`.
- Stop hook payload 과부하 차단, malformed Stop hook input Codex teardown 방지 패치와 함께 적용. 근거: `0d19e5e5`, `be45c48b`.

### 10. `$deep-interview` 설정 파일 지원 추가

- `src/config/deep-interview.ts` 신설(230줄): profile(`quick` / `standard` / `deep`), threshold, maxRounds, enableChallengeModes를 TOML 설정 파일에서 읽는 런타임 설정 계층 추가. project-omx > project-root > user 우선순위. 근거: `src/config/deep-interview.ts @ ff17267b`.
- `deep-interview` plan_then_execute downstream-authority를 binding gate로 강제하는 패치도 포함. 근거: `38b41f32`.

### 11. `$ultragoal` dynamic steering API 추가

- `omx ultragoal steer`가 명시적 구조화 지시문(`OMX_ULTRAGOAL_STEER`, `omx.ultragoal.steer` 형태)으로만 story decomposition을 변경한다. 허용 mutation: `add_subgoal`, `split_subgoal`, `reorder_pending`, `revise_pending_wording`, `annotate_ledger`, `mark_blocked_superseded`. 모든 시도는 `ledger.jsonl`에 감사 기록. 근거: `skills/ultragoal/SKILL.md @ ff17267b`.
- Aggregate Codex goal은 stable pointer 방식으로 변경: 최초 brief 제약을 유지하면서 `.omx/ultragoal/goals.json`과 `ledger.jsonl`을 가리키는 stable pointer. 열거식 objective 레거시 포맷은 read 시 마이그레이션. 근거: `skills/ultragoal/SKILL.md @ ff17267b`.
- UserPromptSubmit hook에서 ultragoal steering 지시문 처리 추가. 근거: `docs/codex-native-hooks.md:48 @ ff17267b`.

### 12. HUD 관련 다수의 안정화 패치

- HUD watch pane 중복 spawn, cwd 소실, dead-leader pane 정리, ownership 보존, authority tick 실패 표시, autopilot session mirror fallback 등 10개 이상의 HUD 버그픽스. 근거: `ec850b7a`, `b58ab34f`, `5e9892d7`, `8bc492d4`, `a9c2ae8e`, `7658ad84`, `a1f8507b`, `33f622ba`.
- 기존 분석(약한 점/리스크의 "팀 런타임 운영 실패 모드" 관련)에서 HUD가 복잡한 실패 모드를 가진다고 언급한 점이 이번 패치군으로 일부 개선되었으나, 패치 수 자체가 복잡도를 시사한다.

### 앵커 드리프트 점검 (검증 완료 2026-06-01, `ff17267b` 직접 대조)

아래 앵커는 2026-06-01에 `ff17267b` 체크아웃을 직접 읽어 핵심 claim을 확인했다. 확정된 정확한 위치를 함께 적는다(보고서 본문 인용은 위 각 항목에서 정정됨).

| 앵커 | 검증 결과 | 확정 위치 |
|---|---|---|
| `skills/autopilot/SKILL.md` 권장 loop·ralph 강등·UltraQA | VERIFIED | loop `:7-13`, ralph 강등 `:13,:88`, ultraqa `:58-61`, ultragoal `:46-50,:82` |
| `skills/ralplan/SKILL.md` Durable Consensus·planning 경계·architect/critic 순차 | VERIFIED | consensus `:79-90`, 경계 `:67-77`, 순차 `:52-53,:65` |
| `docs/codex-native-hooks.md` Lore guard opt-in·plugin_hooks | VERIFIED | opt-in `:49,:80-91`, plugin_hooks `:9-14,:33` |
| `docs/STATE_MODEL.md` autopilot→ralplan transition denied | VERIFIED | `:162, :170-173` |
| `src/catalog/manifest.json` prometheus-strict/scholastic 등록 | VERIFIED | `:449-471` |
| `src/agents/definitions.ts` prometheus-strict-*/scholastic | VERIFIED(정정) | metis/momus/oracle `:320-349`, scholastic `:361-369`. oracle=standard |
| `skills/prometheus-strict/SKILL.md` Metis/Momus/Oracle | VERIFIED | `:3, :13-16` |
| `docs/team-coordination-protocol.md` Big Five/ATEM | VERIFIED | `:3, :7, :9, :13-22` (+ `src/team/coordination-protocol.ts` 실재) |
| `src/scripts/hook-payload-guard.ts` payload 가드 | VERIFIED | `:1-13` (64KB/1MB/64KB) |
| `src/cli/doctor.ts`, `src/cli/setup.ts` doctor 경계·plugin_hooks 분기 | VERIFIED | doctor `:182-260`, smoke `:1216`; setup 분기 `:1488,:1502-1535` |

`ff17267b` 기준 BROKEN 앵커는 없었다. 유일한 내용 정정은 prometheus-strict `oracle`의 modelClass(frontier→standard, 위 §4 반영).

## 근거 목록

- `README.md:20-33`: OMX의 정체성, Codex engine 유지, canonical skills와 `.omx/` 상태 설명.
- `README.md:57-82`: 설치/실행 권장 흐름과 doctor/exec smoke test 경계.
- `README.md:97-156`: Node/Codex/tmux 요구사항, tmux launch 기본 정책과 `--direct`.
- `README.md:169-179`: Codex, roles, skills, `.omx/` mental model.
- `README.md:212-242`: team runtime CLI, setup/doctor/HUD/operator surface, native hooks lifecycle.
- `README.md:280-299`: wiki CLI-first, MCP/markdown/search-first, platform support.
- `package.json:2-107`: 패키지명, 버전, bin, scripts, engines, package files, dependencies.
- `Cargo.toml:1-18`: Rust workspace 구성과 버전/edition/MSRV.
- `tsconfig.json:3-17`, `biome.json:3-12`: TypeScript/Biome 설정.
- `.agents/plugins/marketplace.json:2-18`: local plugin marketplace 등록.
- `plugins/oh-my-codex/.codex-plugin/plugin.json:2-29`: plugin manifest와 setup/plugin 분리 설명.
- `plugins/oh-my-codex/.mcp.json:2-50`: first-party MCP plugin metadata와 기본 disabled 상태.
- `docs/plugin-bundle-ssot.md:1-52`: plugin bundle SSOT, canonical roots, native agent/prompt ownership.
- `docs/codex-native-hooks.md:7-59`: setup-owned hook/config, ownership split, native/fallback matrix.
- `docs/codex-native-hooks.md:123-181`: wiki lifecycle, terminal stop model, verification guidance.
- `docs/STATE_MODEL.md:12-47`: authoritative mode state와 compatibility layer.
- `docs/STATE_MODEL.md:84-109`: transition/reconciliation flow.
- `docs/STATE_MODEL.md:143-169`: allowlisted handoff와 denied rollback.
- `docs/STATE_MODEL.md:227-235`: state transition invariant.
- `src/cli/index.ts:184-298`: CLI 도움말과 command/flag 표면.
- `src/cli/index.ts:540-552`, `src/cli/index.ts:1229-1415`: command resolution과 dispatch.
- `src/cli/setup.ts:221-235`: `.gitignore` policy.
- `src/cli/setup.ts:407-518`: skill frontmatter validation과 description badge rewrite.
- `src/cli/setup.ts:1693-2545`: setup 함수와 prompts/native agents/plugin cache/MCP/hooks/AGENTS/HUD 단계.
- `src/config/generator.ts:1-11`, `src/config/generator.ts:66-129`, `src/config/generator.ts:2046-2142`: TOML generator, owned keys, default context, merged config.
- `src/config/codex-hooks.ts:5-13`, `src/config/codex-hooks.ts:423-477`, `src/config/codex-hooks.ts:594-675`: managed hook events, trust state, hook merge.
- `src/config/omx-first-party-mcp.ts:15-127`: first-party MCP canonical specs와 setup/plugin manifest 차이.
- `src/catalog/schema.ts:1-153`, `src/catalog/manifest.json:5-452`: catalog status, required core skills, skill/agent rows.
- `src/scripts/sync-plugin-mirror.ts:105-340`: root skill/catalog/plugin mirror/manifest/MCP/apps verification.
- `src/agents/definitions.ts:7-333`: agent metadata schema와 역할 목록.
- `prompts/executor.md:5-107`, `prompts/planner.md:5-95`, `prompts/team-executor.md:5-57`, `prompts/code-reviewer.md:5-138`, `prompts/team-orchestrator.md:1-8`: 주요 프롬프트 계약.
- `skills/deep-interview/SKILL.md:29-460`: ambiguity/readiness 기반 인터뷰 workflow.
- `skills/ralplan/SKILL.md:8-156`: plan consensus workflow와 concrete signal gate.
- `skills/ralph/SKILL.md:10-284`: Ralph persistence, verification, goal mode, background execution.
- `skills/autopilot/SKILL.md:6-145`: ralplan/ralph/code-review strict loop.
- `skills/team/SKILL.md:8-512`: team runtime contract, state-first dispatch, API, worker protocol, failure modes.
- `skills/worker/SKILL.md:12-106`: team worker identity, ACK, task claim/transition, mailbox protocol.
- `skills/hud/SKILL.md:10-80`: HUD two-layer model, commands, state/config files.
- `skills/wiki/SKILL.md:11-57`: wiki operation과 storage constraints.
- `src/cli/team.ts:280-384`, `src/cli/team.ts:1344-1726`: team CLI help, API operations, start/status/await/resume/shutdown dispatch.
- `src/team/runtime.ts:180-212`, `src/team/runtime.ts:305-331`, `src/team/runtime.ts:2305-2853`, `src/team/runtime.ts:3111-3523`, `src/team/runtime.ts:4154-4978`: team snapshot, duplicate guard, start/monitor/shutdown, worker notification/dispatch.
- `src/team/runtime-cli.ts:1-66`, `src/team/runtime-cli.ts:127-211`, `src/team/runtime-cli.ts:296-506`: background runtime CLI JSON protocol.
- `src/team/state/tasks.ts:27-354`: task readiness, claim, transition, release, reclaim, listing.
- `src/cli/explore.ts:31-55`, `src/cli/explore.ts:124-265`, `src/cli/explore.ts:383-777`: explore CLI contract, read-only constraints, local/native routing.
- `crates/omx-explore/src/main.rs:13-43`, `crates/omx-explore/src/main.rs:124-222`, `crates/omx-explore/src/main.rs:287-428`: native explore env/model/fallback/process controls.
- `src/cli/sparkshell.ts:24-393`: sparkshell wrapper, native resolution, fallback, explicit shell/tmux handling.
- `crates/omx-sparkshell/src/main.rs:24-27`, `crates/omx-sparkshell/src/main.rs:84-160`, `crates/omx-sparkshell/src/main.rs:187-440`, `crates/omx-sparkshell/src/main.rs:516-895`: sparkshell parsing, evidence, cache, JSON report.

## ditto 적용 정리

| 적용할 기능/가치 | 어떻게 적용할지 | 적용 이후 제공 가치 | 리스크나 선행 조건 | 근거 |
| --- | --- | --- | --- | --- |
| Codex CLI를 대체하지 않는 **워크플로 레이어** | DITTO도 coding agent harness라는 목적에 맞춰 실행 엔진 자체를 갈아끼우기보다, 계획/실행/검증/리뷰의 오케스트레이션과 상태 관리 계층을 우선 구현한다. 각 단계의 진입 조건, 출력 양식, 다음 단계 참조 계약을 정규화한다. | 사용자는 모델/CLI 세부 동작보다 "현재 목표, 다음 단계, 검증 증거"를 보게 되어 인지 비용이 줄고, 장기 작업이 목적에서 벗어나 중단되는 위험이 낮아진다. | oh-my-codex처럼 CLI/setup/team/runtime 표면이 한꺼번에 커지면 변경 영향 분석 비용이 커진다. DITTO는 먼저 최소 워크플로 계약과 상태 파일부터 고정해야 한다. | PURPOSE.md는 DITTO를 coding agent harness로 정의하고, 문제 정의부터 개발 완료와 자동 회고까지의 오케스트레이션 및 정규화된 interface/문서 양식을 핵심 기능으로 둔다. 보고서는 OMX가 Codex CLI 위의 워크플로 레이어라고 정리한다. 근거: `README.md:20`, `README.md:28-33`, `src/cli/index.ts:184-298`. |
| **상태 영속화와 감사 가능한 handoff** | `.omx/state/<mode>-state.json`과 `skill-active-state.json`처럼 authoritative state와 표시/호환 계층을 분리한 구조를 DITTO의 세션 상태, 감사 기록, handoff 기록에 맞게 설계한다. 주요 결정, 변경, 검증 결과는 다음 세션이나 다른 agent가 읽을 수 있는 repo-local 산출물로 남긴다. | Context Rot을 줄이고, 새 세션이나 다른 PC에서 이어받을 때 "무엇을 왜 했고 어디까지 검증했는지"를 재구성할 수 있다. 완료 주장을 fresh evidence와 연결하기 쉬워진다. | 상태 전이 규칙이 없으면 오래된 상태와 현재 작업이 충돌한다. 구현 전에 terminal state, rollback, compatibility sync invariant를 테스트 가능한 전이표로 만들어야 한다. | PURPOSE.md는 모든 액션의 감사 기록, 새 세션 handoff, 주요 결정 및 변경사항 영속화, Context Rot 해결을 핵심 기능으로 둔다. 보고서는 `.omx/`에 계획/로그/메모리/런타임 상태가 저장되고 authoritative/compatibility state가 분리된다고 정리한다. 근거: `README.md:169-179`, `docs/STATE_MODEL.md:12-47`, `docs/STATE_MODEL.md:84-109`, `docs/STATE_MODEL.md:227-235`. |
| 병렬 작업용 **state-first team API** | DITTO의 서브에이전트는 파일을 임의 갱신하지 않고 task claim, transition, release, mailbox, heartbeat 같은 단일 API를 통해 상태를 바꾸게 한다. parent/worker 출력 계약에는 수행 범위, 근거, 변경 파일, 검증 결과를 필수로 둔다. | 병렬 agent가 같은 저장소에서 작업해도 claim token, lease, terminal guard로 충돌을 줄일 수 있다. 사용자는 여러 작업자의 진행 상태를 별도 대화 맥락 없이 판단할 수 있다. | tmux 기반 런타임은 macOS/Linux 의존성과 운영 실패 모드가 있다. DITTO는 먼저 파일/API 프로토콜과 작은 fanout 기준을 정하고, destructive recovery는 dry-run/대상 검증/확인 절차를 거치는 명령으로 감싸야 한다. | PURPOSE.md는 Context Rot 해결을 위해 서브 에이전트를 적극 사용하고, 장기간 실행되는 작업을 처음 의도대로 완수해야 한다고 한다. 보고서는 `$team`이 tmux, `.omx/state/team/...`, mailbox, worker lifecycle을 묶고 task readiness, claim token, lease, terminal guard를 검사한다고 정리한다. 근거: `skills/team/SKILL.md:8-17`, `skills/team/SKILL.md:236-317`, `skills/worker/SKILL.md:12-72`, `src/team/state/tasks.ts:27-114`, `src/team/state/tasks.ts:165-282`. |
| **근거 보존형 read-only 탐색/요약 하네스** | 조사 전용 명령은 read-only allowlist, shell metacharacter 차단, env scrub, timeout/process/output cap, fallback notice를 코드로 강제한다. 큰 명령 출력이나 tmux tail은 요약하되 line range/hash 같은 원문 근거를 함께 남긴다. | 할루시네이션 방지와 token 비용 절감을 동시에 얻는다. 모델이 긴 출력 전체를 들고 있지 않아도 검증 가능한 근거를 따라가며 결론을 낼 수 있다. | native sidecar를 필수로 만들면 배포 환경, 권한, cache 상태가 실패 지점이 된다. DITTO에서는 Node-only fallback 또는 성능 저하 메시지를 유지하고, read-only 범위를 테스트로 고정해야 한다. | PURPOSE.md는 모든 출력과 추론에 확실한 근거가 있어야 하며 token 비용을 낭비하지 않아야 한다고 한다. 보고서는 `omx explore`와 `omx sparkshell`이 read-only command filtering, env scrub, timeout/process/output cap, evidence line range/hash, raw fallback을 둔다고 정리한다. 근거: `src/cli/explore.ts:31-55`, `src/cli/explore.ts:124-134`, `src/cli/explore.ts:383-419`, `crates/omx-explore/src/main.rs:28-43`, `crates/omx-explore/src/main.rs:405-428`, `src/cli/sparkshell.ts:237-308`, `crates/omx-sparkshell/src/main.rs:187-440`, `crates/omx-sparkshell/src/main.rs:817-895`. |
| **설치/발견/검증 경계 분리** | plugin discovery는 스킬/MCP/메타데이터 발견으로 제한하고, 사용자 환경을 바꾸는 setup은 별도 명령으로 둔다. doctor 결과는 설치 증명, hook/config 증명, 실제 모델 실행 smoke test, 운영 증명으로 나눠 표시한다. | 사용자가 플러그인 설치만으로 runtime wiring이 끝났다고 오해하는 일이 줄고, 검증하지 않은 항목을 완료처럼 말하지 않게 된다. 사용자 hook과 설정을 보존하면 하네스가 사용자 의도 밖으로 환경을 덮어쓰는 위험도 낮아진다. | setup이 `.codex/config.toml`, `.codex/hooks.json`, AGENTS, HUD, MCP registry를 만지는 순간 영향 범위가 크다. managed block marker, trust hash, user hook preservation, dry-run이 선행되어야 한다. | PURPOSE.md는 사용자의 의도와 벗어나 LLM이 멋대로 작업하는 것을 구조적으로 제한하고, 사용자 인지 비용을 줄이며, 검증 가능한 근거 위에서 완료를 말해야 한다는 가치를 둔다. 보고서는 plugin bundle이 setup을 대체하지 않고, native hook merge가 사용자 hook을 보존하며, doctor와 실제 `omx exec` smoke test의 증명 경계를 분리한다고 정리한다. 근거: `README.md:66-68`, `README.md:80-82`, `plugins/oh-my-codex/.codex-plugin/plugin.json:20-29`, `docs/plugin-bundle-ssot.md:7-12`, `docs/plugin-bundle-ssot.md:52`, `docs/codex-native-hooks.md:23-30`, `docs/codex-native-hooks.md:168-181`, `src/config/codex-hooks.ts:594-675`. |

## ditto 적용 요소 후보 (skills/agents/commands/hooks)

| 우선순위 | 종류 | 요소 | DITTO 적용안 | 효과/주의 |
| --- | --- | --- | --- | --- |
| 바로 적용 | command | `omx explore`, `omx sparkshell` | DITTO의 read-only evidence collector로 차용한다. shell metacharacter 차단, env scrub, timeout/output cap, line range/hash를 기본으로 하고 native sidecar는 선택 경로로 둔다. | 조사 결과에 원문 근거를 붙일 수 있다. Node-only fallback과 host별 path handling 테스트가 필요하다. |
| 바로 적용 | command | `omx doctor`, `omx list --json` | 설치/설정/skill/agent/MCP 로딩 상태를 human/json으로 보여주는 DITTO doctor와 inventory 명령으로 둔다. | 검증하지 않은 설치를 완료처럼 말하지 않게 한다. 실제 host smoke와 분리된 증명 경계를 표시해야 한다. |
| 바로 적용 | agent | `explore`, `planner`, `executor`, `verifier`, `code-reviewer`, `security-reviewer` | DITTO core agent set의 최소 후보로 사용한다. explorer/planner는 read-only, executor는 scoped write, verifier/reviewer는 fresh evidence를 요구한다. | 구조가 아니라 실제 역할 프롬프트 후보가 된다. 권한은 prompt가 아니라 runtime에서 강제해야 한다. |
| 수정 적용 | skill | `ralplan`, `tdd`, `git-master`, `code-review`, `security-review`, `frontend-ui-ux` | DITTO 기본 skill pack 후보로 분류한다. `ralplan`은 구현 전 계획, `tdd`는 behavior 검증, `git-master`는 안전한 git workflow, UI skill은 browser/E2E와 연결한다. | 바로 가치가 크지만 전체 catalog를 가져오면 token 비용이 커진다. profile별 progressive disclosure가 필요하다. |
| 수정 적용 | MCP/CLI | `state`, `notepad`, `project-memory`, `trace`, `wiki` | DITTO의 audit/handoff/knowledge store 도구군으로 합친다. state에는 작은 기계 상태만, memory/wiki에는 durable knowledge만, trace에는 실행 증거만 둔다. | Context Rot과 재개성에 효과적이다. 각 store의 owner, TTL, stale 처리 규칙이 필요하다. |
| 수정 적용 | command/agent | `omx team` + `worker` skill | 병렬 작업 API 후보로 삼되 tmux 런타임은 나중으로 미룬다. 먼저 task claim/lease/mailbox/heartbeat/terminal guard를 파일/API 프로토콜로 구현한다. | subagent 병렬화를 안전하게 만든다. 운영 복잡도가 크므로 작은 fanout부터 시작해야 한다. |
| 수정 적용 | hook/setup | Codex native hook merge와 managed block | DITTO setup이 사용자 hook/config를 덮어쓰지 않고 managed block marker, trust hash, dry-run, rollback report를 사용하게 한다. | 설치 신뢰도를 높인다. setup은 plugin discovery와 분리해야 한다. |
| 수정 적용 | packaging/script | plugin bundle sync/verify, native agent metadata verify | 여러 host plugin bundle을 단일 원본에서 생성하고, skill/agent/prompt/TOML metadata 정합성을 CI에서 확인한다. | 문서/manifest drift를 줄인다. DITTO 자체 구조가 안정된 뒤 적용하는 편이 낫다. |
