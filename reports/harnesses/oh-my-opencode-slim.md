# oh-my-opencode-slim 하네스 분석 보고서

## 분석 대상 및 기준 커밋

- 대상 저장소: `https://github.com/alvinunreal/oh-my-opencode-slim`
- 로컬 분석 경로: `/private/tmp/ditto-harness-analysis/oh-my-opencode-slim`
- 기준 커밋: `24dc4b535aabf296679cabe7092f6eab815c93f3`
- 기준 커밋 시각/제목: `2026-05-20T06:45:41Z`, `docs: update contributors [skip ci]`
- 이 보고서의 모든 `repo-relative/path:line` 근거는 위 커밋 기준이다.

## 조사 방법

- 저장소를 지정 경로에 클론한 뒤 `git rev-parse HEAD`, `git show -s`, `git status --short`로 기준 커밋과 워킹트리 상태를 확인했다. 워킹트리는 분석 시점에 깨끗했다.
- README, 문서, 패키지 메타데이터, 설정 스키마, CLI, 플러그인 엔트리, 에이전트 프롬프트, 도구, 훅, MCP, 멀티플렉서, 스킬, CI/검증 스크립트를 파일 단위로 추적했다. 특히 공개 사용 의도는 `README.md:24-59`, 설치/설정 규칙은 `docs/installation.md:18-82`와 `docs/configuration.md:7-47`, 런타임 결합 방식은 `src/index.ts:1-59`, `src/index.ts:393-443`, 도구/훅 구현은 `src/tools/**`와 `src/hooks/**`, 배포 검증은 `.github/workflows/ci.yml:38-51`, `scripts/verify-release-artifact.ts:113-185`, `scripts/verify-opencode-host-smoke.ts:246-305`를 중심으로 확인했다.
- 코드 의도가 문서나 주석으로 직접 드러나지 않는 경우에는 `엄밀한 추론`이라고 명시하고, 해당 추론이 의존하는 코드 제약 또는 문서 제약을 함께 적었다.

## 핵심 특징

1. 이 저장소는 OpenCode 위에 얹는 “에이전트 오케스트레이션” 플러그인이다. README는 “specialist agents”를 두고 작업을 올바른 에이전트에 라우팅해 품질/속도/비용을 개선한다고 설명한다(`README.md:24-30`). 패키지 메타데이터도 설명을 “Zero-config AI agent orchestration plugin for OpenCode”로 둔다(`package.json:2-4`).
2. 플러그인의 기본 상호작용 모델은 사용자가 오케스트레이터와 대화하고, 오케스트레이터가 `explorer`, `librarian`, `oracle`, `designer`, `fixer`, `council`, `observer` 같은 전문 에이전트에 위임하는 형태다. README는 기본 에이전트를 Orchestrator로 설명하고(`README.md:149-184`), 오케스트레이터 프롬프트 생성 코드는 각 전문 에이전트의 역할, 사용 시점, 권한, 통계, 위임 금지 조건을 구조화한다(`src/agents/orchestrator.ts:27-93`).
3. V2 오케스트레이션은 OpenCode의 실험적 백그라운드 서브에이전트를 전제로 한다. README는 오케스트레이터가 계획을 세우고 전문 에이전트를 백그라운드로 디스패치하며 상태를 폴링한다고 쓰고, `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=1`이 필요하다고 명시한다(`README.md:48-59`).
4. 설치는 “zero-config”를 지향하지만 실제로는 OpenCode 설정, 플러그인 설정, TUI 배지, 기본 에이전트 비활성화, LSP 활성화, 번들 스킬 복사까지 수행한다. CLI 설치 코드는 OpenCode 감지, 플러그인/TUI/cache 설정, 기본 에이전트 비활성화, LSP 활성화를 순차적으로 처리한다(`src/cli/install.ts:147-214`), 이후 사용자 플러그인 설정을 쓰고 스킬을 설치한다(`src/cli/install.ts:216-268`). 설치 문서는 비파괴 동작과 `--reset` 백업을 따로 설명한다(`docs/installation.md:42-56`).
5. 런타임 기능은 플러그인 엔트리 하나에 강하게 집약되어 있다. `src/index.ts`는 에이전트, 설정, MCP, Council, 멀티플렉서, 각종 훅, 도구, TUI 상태를 모두 import한다(`src/index.ts:1-59`), 플러그인 시작 시 설정과 상태 변수를 잡고(`src/index.ts:111-180`), agents/tools/MCPs/config/event/tool/command/message transform을 한 객체로 반환한다(`src/index.ts:393-1208`).
6. 도구 설계는 “LLM이 흔히 실패하는 지점”을 런타임 훅으로 보정하는 쪽에 가깝다. 예를 들어 `apply_patch` 훅은 네이티브 실행 전에 패치를 가로채 복구 가능한 stale patch를 재작성한다고 문서화되어 있고(`docs/tools.md:5-8`), 실제 훅은 `apply_patch` 호출만 대상으로 워크트리 경계와 패치 문자열을 확인한 뒤 재작성한다(`src/hooks/apply-patch/index.ts:61-101`).
7. 외부 지식 접근은 MCP와 독립 `webfetch` 도구로 나뉜다. 문서는 Exa 기반 `websearch`, Context7, grep.app MCP를 내장한다고 설명한다(`docs/mcps.md:1-14`), MCP registry는 disabled 필터와 websearch provider override를 적용한다(`src/mcp/index.ts:9-34`). `webfetch`는 URL, 출력 형식, 타임아웃, 보조 모델 프롬프트, 본문 추출, `llms.txt` 선호, 바이너리 저장 옵션을 가진 별도 도구다(`src/tools/smartfetch/tool.ts:68-101`).
8. 멀티 모델 합의 장치인 Council은 별도 에이전트와 도구로 구현된다. 문서는 councillor들을 병렬로 실행한 뒤 결과를 합성한다고 설명한다(`docs/council.md:21-50`), Council Manager도 “parallel execution”을 책임지는 모듈로 시작하며(`src/council/council-manager.ts:1-6`), 실행 함수는 preset 검증, child session 실행, 성공 결과 포맷을 담당한다(`src/council/council-manager.ts:77-190`).

## 구조/아키텍처

### 패키지와 빌드 표면

- 패키지는 `dist/index.js`를 플러그인 main/export로, `dist/cli/index.js`를 `oh-my-opencode-slim` 실행 파일로 노출한다(`package.json:5-19`). 배포 포함 파일은 `dist`, `src/skills`, JSON schema, README, LICENSE로 제한된다(`package.json:41-48`).
- 빌드는 플러그인과 CLI를 각각 Bun으로 빌드한 뒤 스킬과 스키마를 복사/생성하는 흐름이다. `build:plugin`, `build:cli`, `copy:skills`, `generate:schema`, `verify:release`, `verify:host-smoke`가 package scripts에 정의되어 있다(`package.json:49-71`).
- TypeScript 설정은 ESNext/bundler/declaration/strict를 사용하고 `src`만 포함한다(`tsconfig.json:3-16`). Biome 설정은 2-space, single quote, 80-column formatter와 recommended linter를 둔다(`biome.json:1-47`).
- 런타임 의존성에는 OpenCode plugin/sdk, MCP SDK, `@ast-grep/cli`, Readability/jsdom/turndown, lru-cache가 포함된다(`package.json:73-101`). `@opentui/solid`는 optional dependency라서 TUI 상태 표시가 선택적임을 알 수 있다(`package.json:91-93`).

### 플러그인 조립 방식

- `src/index.ts`가 사실상 composition root다. import 목록은 agents, config, council manager, hooks, MCP, multiplexer, tools, TUI store까지 전부 포함한다(`src/index.ts:1-59`).
- 시작 시점에는 `loadPluginConfig`, runtime preset override, disabled agent 목록, agent 생성, fallback chain, multiplexer config, council tools, MCP, webfetch, auto-update, phase reminder, skill filtering, patch hook, JSON recovery, foreground fallback, todo continuation, goal, task session manager, interview, preset, divoom, subtask 도구를 차례로 초기화한다(`src/index.ts:157-334`).
- 반환 객체의 `agent`, `tool`, `mcp`, `config`, `event`, `tool.execute.before`, `command.execute.before`, `chat.message`, `messages` transform, `tool.execute.after`가 모두 이 파일에 정의된다(`src/index.ts:393-1208`). 따라서 기능 추가는 쉽지만 훅 순서와 상태 공유가 한 파일에 집중되는 구조다.
- `config` hook은 기본 에이전트를 orchestrator로 설정하고 사용자 에이전트 설정과 플러그인 에이전트를 병합한다(`src/index.ts:410-443`). startup fallback과 runtime preset override는 같은 hook 안에서 모델/프로바이더/프리셋을 재해석한다(`src/index.ts:445-646`).
- MCP 설정도 같은 hook에서 내장 MCP와 사용자 MCP를 병합하고, 에이전트별 MCP permission을 적용한다(`src/index.ts:668-720`).

### 에이전트 레지스트리

- 기본 agent set은 constants에 `orchestrator`, `explorer`, `librarian`, `oracle`, `designer`, `fixer`, `council`, `councillor`, `observer`로 정리되어 있다(`src/config/constants.ts:1-20`). delegation rules는 오케스트레이터만 전문 에이전트를 spawn할 수 있고 전문 에이전트는 leaf라고 선언한다(`src/config/constants.ts:25-66`).
- `createAgents`는 disabled agent, council config 유무, fallback, custom prompt, custom agent를 반영해 agent factory들을 조립한다(`src/agents/index.ts:225-330`). `getAgentConfigs`는 OpenCode에 등록할 agent mode를 정하고, council/councillor 숨김/노출, orchestrator primary mode, displayName alias용 hidden agent를 만든다(`src/agents/index.ts:428-492`).
- agent override는 model string/array, variant, temperature, options, displayName을 반영한다(`src/agents/index.ts:55-89`). custom agent는 base prompt/model을 요구하고(`src/agents/index.ts:115-134`), safe name 검증과 missing model skip을 수행한다(`src/agents/index.ts:263-296`).
- 기본 permission은 question 허용, council_session은 council만 허용, skill permission은 agent별로 결정된다(`src/agents/index.ts:154-193`). councillor는 read-only advisor로 shell/edit/delegate를 막고 read/glob/grep/lsp/list/codesearch/ast_grep_search만 허용한다(`src/agents/councillor.ts:3-16`, `src/agents/councillor.ts:61-80`).

### 설정과 프롬프트 오버라이드

- 사용자/프로젝트 설정은 JSONC를 지원하며 `.jsonc`가 `.json`보다 우선한다(`docs/configuration.md:7-18`, `src/config/loader.ts:125-158`). loader는 JSONC를 읽고 `{env:VAR}` 보간 후 Zod schema로 검증하며 실패 시 경고와 fallback을 쓴다(`src/config/loader.ts:54-101`).
- 사용자 설정과 프로젝트 설정은 merge되고, preset은 agent override에 병합된다(`src/config/loader.ts:188-247`, `src/config/loader.ts:265-318`).
- 프롬프트 오버라이드는 `{agent}.md`, `{agent}_append.md`, preset-specific directory를 지원한다(`docs/configuration.md:22-47`). 실제 loader도 preset directory를 root보다 먼저 읽는다(`src/config/loader.ts:330-383`).
- schema는 agent override, multiplexer, interview, session manager, todo continuation, fallback, plugin config를 Zod로 정의한다(`src/config/schema.ts:82-340`). custom agent가 아닌 곳에서 `prompt`/`orchestratorPrompt`를 쓰면 오류를 내도록 refine한다(`src/config/schema.ts:341-351`).

### 도구/훅 계층

- OpenCode 도구 surface에는 council tool, `webfetch`, `auto_continue`, `ast_grep_search`, `ast_grep_replace`, `subtask`, `read_session`이 등록된다(`src/index.ts:393-408`).
- hook surface는 `tool.execute.before`, `tool.execute.after`, `command.execute.before`, `chat.message`, `messages`, `event` transform로 나뉜다(`src/index.ts:745-1208`). 이 구조는 OpenCode 호스트 이벤트와 메시지 변환을 이용해 agent orchestration을 보조한다.
- hook codemap은 retry, foreground fallback, todo, task-session 같은 기능이 서로 다른 hook point에 붙는다고 요약한다(`src/hooks/codemap.md:47-74`).

### 세션/멀티플렉서 계층

- child session 재사용은 기본 활성화되어 있고, stale session drop과 alias/read context를 제공한다(`docs/session-management.md:1-8`, `docs/session-management.md:28-57`). 코드상 `SessionManager`는 bounded max/TTL/read context 옵션과 state를 가진다(`src/hooks/task-session-manager/index.ts:112-129`).
- task session manager는 task 실행 전 `task_id` alias를 해석하고 pending 상태를 추적한다(`src/hooks/task-session-manager/index.ts:246-302`), task 종료 뒤 read context와 stale drop을 처리한다(`src/hooks/task-session-manager/index.ts:304-356`), messages transform에 재개 가능 세션 정보를 주입한다(`src/hooks/task-session-manager/index.ts:358-391`).
- multiplexer는 tmux/zellij pane에 child sessions를 붙이는 기능이다. 문서는 tmux/zellij live panes라고 설명한다(`docs/multiplexer-integration.md:1-4`). factory는 현재 세션 환경을 auto-detect하고 세션 밖이면 null을 반환한다(`src/multiplexer/factory.ts:18-65`).
- multiplexer session manager는 설정과 현재 세션 여부로 enabled flag를 잡고(`src/multiplexer/session-manager.ts:81-125`), `session.created`에서 health check 후 pane을 spawn하고 polling을 시작한다(`src/multiplexer/session-manager.ts:127-238`). idle/status/deleted/polling timeout에 따라 close 또는 respawn한다(`src/multiplexer/session-manager.ts:240-361`).

## 도구/명령/스크립트/프롬프트 인벤토리

### 사용자 명령

| 명령/표면 | 근거 | 기능 |
|---|---:|---|
| `oh-my-opencode-slim install` | `src/cli/index.ts:74-94`, `src/cli/install.ts:147-268` | OpenCode 설정에 플러그인, TUI badge, cache, 기본 agent 비활성화, LSP, 플러그인 설정, 번들 스킬을 설치한다. |
| `oh-my-opencode-slim doctor` | `src/cli/index.ts:74-94`, `src/cli/doctor.ts:55-144`, `src/cli/doctor.ts:205-281` | 사용자/프로젝트 설정의 빈 파일, JSON/schema/read 오류, preset 존재 여부를 검사하고 human/json 결과와 exit code를 낸다. |
| `oh-my-opencode-slim help` | `src/cli/index.ts:40-71` | 설치 예시와 preset 목록을 출력한다. |
| `/preset` | `src/tools/preset-manager.ts:19-29`, `src/tools/preset-manager.ts:42-98` | 런타임에 preset을 나열하거나 전환한다. `client.config.update`와 in-memory `activePreset`를 사용한다. |
| `/subtask` | `docs/subtask.md:5-11`, `src/tools/subtask/command.ts:17-60` | 별도 bounded worker session을 만들어 독립 작업을 수행하게 한다. |
| `/goal` | `docs/session-goal.md:1-16` | 세션 목표를 설정/표시/해제한다. 목표 자체는 작업을 실행하지 않는다(`docs/session-goal.md:38-51`). |
| `/interview` | `docs/interview.md:1-24` | 브라우저 UI로 기능 아이디어를 질문/정제하고 markdown spec을 저장한다. |
| `/auto-continue` | `docs/todo-continuation.md:9-15`, `src/hooks/todo-continuation/index.ts:444-464` | todo 자동 계속하기 기능을 on/off/status로 제어한다. |

### OpenCode 도구

| 도구 | 근거 | 기능 및 제약 |
|---|---:|---|
| `webfetch` | `docs/tools.md:11-19`, `src/tools/smartfetch/tool.ts:68-101` | URL을 가져와 markdown/text/html/json/binary 등으로 반환하고, 보조 모델 요약, main extraction, `llms.txt` probe, metadata, binary save를 지원한다. |
| `ast_grep_search` | `docs/tools.md:23-33`, `src/tools/ast-grep/tools.ts:18-71` | AST-aware 패턴 검색. 패턴은 완전한 AST node여야 한다는 설명과 empty-result hint를 제공한다. |
| `ast_grep_replace` | `src/tools/ast-grep/tools.ts:74-117` | AST-aware 치환. 기본은 dry-run이고 `dryRun === false`일 때만 전체 업데이트를 적용한다. |
| `council_session` | `src/tools/council.ts:27-42`, `src/tools/council.ts:52-69` | council agent만 호출 가능한 다중 councillor 실행 도구다. 비-council agent가 호출하면 guard가 거부한다. |
| `subtask` | `src/tools/subtask/tools.ts:48-64`, `src/tools/subtask/tools.ts:73-155` | bounded worker child session을 만들고, nested subtask와 depth를 제한하며, summary를 추출한다. |
| `read_session` | `docs/subtask.md:75-90`, `src/tools/subtask/tools.ts:267-320` | subtask worker가 source session transcript를 제한적으로 읽는 도구다. source session 외부 접근과 과도한 읽기를 막는다. |
| `auto_continue` | `src/hooks/todo-continuation/index.ts:444-464` | todo continuation 상태를 제어하는 tool surface다. |

### MCP

| MCP | 근거 | 용도 |
|---|---:|---|
| `websearch` | `docs/mcps.md:1-14`, `src/mcp/websearch.ts:4-44` | 기본 Exa 또는 Tavily 기반 웹 검색. Tavily는 `TAVILY_API_KEY`, Exa는 `EXA_API_KEY`가 필요하다. |
| `context7` | `docs/mcps.md:1-14`, `src/mcp/context7.ts:3-14` | 라이브러리 문서 질의용 remote MCP. optional key를 전달한다. |
| `grep_app` | `docs/mcps.md:1-14`, `src/mcp/grep-app.ts:3-10` | 공개 코드 검색용 remote MCP. |

에이전트별 MCP 기본값은 orchestrator가 context7을 제외한 전체, librarian이 외부 research MCP 전체, 다른 agent는 없음으로 설정된다(`docs/mcps.md:17-28`, `src/config/agent-mcps.ts:8-20`). wildcard/deny syntax는 `*`, `!*`, `!name`을 지원한다(`docs/mcps.md:31-47`, `src/config/agent-mcps.ts:22-44`).

### 에이전트 프롬프트

| 에이전트 | 근거 | 역할 |
|---|---:|---|
| `orchestrator` | `src/agents/orchestrator.ts:140-264` | 작업 이해, 경로 선택, 위임, parallel split, subtask, OpenCode execution model, session reuse, auto-continue, verification, communication 규칙을 담는 기본 primary agent다. |
| `explorer` | `src/agents/explorer.ts:3-31` | 빠른 코드 탐색/검색 전담. grep/ast_grep/glob/read-only와 파일 근거 중심 출력 형식을 요구한다. |
| `librarian` | `src/agents/librarian.ts:3-23` | 문서/외부 research 전담. context7/grep_app/websearch와 출처 제시를 요구한다. |
| `oracle` | `src/agents/oracle.ts:3-25` | read-only 전략/리뷰/단순화 advisor다. |
| `designer` | `src/agents/designer.ts:3-57` | UI/UX 설계 및 구현/리뷰 agent이며 다른 기본 agent보다 높은 temperature 0.7을 쓴다(`src/agents/designer.ts:72-80`). |
| `fixer` | `src/agents/fixer.ts:3-44` | 빠르고 좁은 implementation 전담. research/delegation을 피하고 scoped output을 요구한다. |
| `observer` | `src/agents/observer.ts:3-20` | visual analysis/OCR/read-only agent다. observer는 기본 비활성화되어 있다(`src/config/constants.ts:109-111`, `README.md:449-479`). |
| `council` | `src/agents/council.ts:8-67` | 여러 councillor 결과를 반드시 합성해 결정/불확실성/다음 행동을 내는 synthesizer다. |
| `councillor` | `src/agents/councillor.ts:3-48` | council에서만 쓰는 read-only 독립 advisor다. |

### 번들 스킬

| 스킬 | 근거 | 기능 |
|---|---:|---|
| `simplify` | `docs/skills.md:13-30`, `src/skills/simplify/SKILL.md:8-73` | oracle용 단순화/리뷰 스킬. “언제 쓰지 말아야 하는지”와 다섯 원칙, 검토 프로세스를 포함한다. |
| `codemap` | `docs/skills.md:33-47`, `src/skills/codemap/SKILL.md:18-77` | orchestrator용 repository map/change tracking 스킬. state 확인, 초기화, 변경 감지, 업데이트 절차를 둔다. |
| `clonedeps` | `docs/skills.md:51-80`, `src/skills/clonedeps/SKILL.md:11-31` | orchestrator용 dependency clone workflow. 별도 helper script 없이 orchestrator/librarian/fixer 위임으로 동작한다. |

스킬 permission은 CLI registry와 agent permission 계산으로 연결된다. registry는 `simplify`, `codemap`, `clonedeps`를 agent에 매핑한다(`src/cli/custom-skills.ts:30-49`), installer는 `src/skills`에서 config skills directory로 복사한다(`src/cli/custom-skills.ts:90-109`). orchestrator는 기본적으로 모든 bundled skill을 받을 수 있고 explicit skill list가 있으면 그것을 존중한다(`src/cli/skills.ts:35-80`).

### 빌드/검증 스크립트와 CI

| 스크립트/워크플로 | 근거 | 역할 |
|---|---:|---|
| `bun run build` | `package.json:49-61` | plugin/CLI 빌드, skills 복사, schema 생성. |
| `bun run schema` / `scripts/generate-schema.ts` | `package.json:58-59`, `scripts/generate-schema.ts:3-30` | Zod config schema를 JSON schema로 생성한다. |
| `bun run verify:release` | `package.json:62-63`, `scripts/verify-release-artifact.ts:19-44`, `scripts/verify-release-artifact.ts:113-185` | suspicious path leak, required package files, `npm pack`, fresh install/import를 검사한다. |
| `bun run verify:host-smoke` | `package.json:64-65`, `scripts/verify-opencode-host-smoke.ts:161-305` | 임시 config/cache/data/workspace에서 OpenCode host를 설치/serve하고 plugin load error가 없는지 확인한다. |
| GitHub CI | `.github/workflows/ci.yml:38-51` | deps 설치 후 lint, typecheck, test, build를 수행한다. |
| package smoke | `.github/workflows/package-smoke.yml:14-40` | ubuntu/macos matrix에서 build, release verification, host smoke를 실행한다. |

## 각 도구가 왜 그렇게 작성되어야 했는지에 대한 근거 또는 엄밀한 추론

### Orchestrator와 전문 agent 분리

- 근거: README는 specialist agent에 작업을 라우팅해 품질/속도/비용을 개선한다고 설명한다(`README.md:24-30`). Orchestrator 문서는 default agent로서 “route work to specialist agents”를 담당한다고 설명한다(`README.md:149-184`). 코드에서도 각 전문 agent의 “Delegate when / Do NOT delegate” 규칙과 최근 실행 통계를 프롬프트에 포함한다(`src/agents/orchestrator.ts:27-110`).
- 엄밀한 추론: agent를 여러 개로 나눈 이유는 단순한 persona 구분이 아니라 모델 비용/성능/권한/도구 surface를 분리하기 위해서다. 이 추론은 agent별 model override와 permission 계산(`src/agents/index.ts:55-89`, `src/agents/index.ts:154-193`), agent별 MCP 기본값(`src/config/agent-mcps.ts:8-20`), README의 “quality, speed, and cost” 설명(`README.md:24-30`)에 근거한다.

### Explorer

- 근거: explorer prompt는 “fast, surgical code search”와 read-only, grep/ast_grep/glob 활용, 파일/라인 근거 중심 출력을 요구한다(`src/agents/explorer.ts:3-31`). README도 Explorer를 “Fast, focused code search and architecture reconnaissance”로 설명하고 저렴하고 빠른 모델을 권장한다(`README.md:190-224`).
- 엄밀한 추론: Explorer가 write 권한 없이 검색 도구 중심으로 작성된 이유는 오케스트레이터가 구현 전에 repo map과 변경 지점을 빠르게 얻기 위해서다. delegation prompt가 “where code lives”, “architecture reconnaissance”를 Explorer 영역으로 둔다(`src/agents/orchestrator.ts:27-43`), fixer prompt가 research/delegation을 피하라고 하기 때문에(`src/agents/fixer.ts:3-44`) 탐색과 수정 책임을 분리해야 한다.

### Librarian

- 근거: librarian prompt는 docs/research specialist이며 context7/grep_app/websearch를 쓰고 출처를 제공하라고 한다(`src/agents/librarian.ts:3-23`). MCP 기본값도 librarian에게 외부 research MCP 전체를 부여한다(`src/config/agent-mcps.ts:8-20`).
- 엄밀한 추론: Librarian을 별도 agent로 둔 이유는 외부 지식 접근을 일반 구현 agent에서 분리해 비용/프라이버시/맥락 오염을 줄이려는 설계다. MCP access는 agent별 allow/deny가 가능하고(`docs/mcps.md:31-47`), air-gapped/cost 제약에서는 MCP를 전역 비활성화할 수 있다(`docs/mcps.md:73-83`).

### Oracle

- 근거: oracle prompt는 read-only strategic advisor이며 code review, simplification, architecture tradeoff에 집중한다(`src/agents/oracle.ts:3-25`). README도 Oracle을 “Deep reasoning, architecture review, and bug analysis”로 설명하고 high-quality model을 권장한다(`README.md:231-265`).
- 엄밀한 추론: Oracle이 직접 수정하지 않도록 작성된 이유는 “판단”과 “패치 적용”을 분리해 고비용 추론 모델을 필요한 곳에만 쓰려는 의도다. oracle은 read-only prompt를 갖고(`src/agents/oracle.ts:3-25`), fixer가 scoped implementation을 담당한다(`src/agents/fixer.ts:3-44`).

### Designer

- 근거: designer prompt는 UI/UX 원칙, visual polish, interaction states, implementation/review를 다루며(`src/agents/designer.ts:3-57`), 생성 시 temperature 0.7을 사용한다(`src/agents/designer.ts:72-80`).
- 엄밀한 추론: Designer에 더 높은 temperature를 준 이유는 UI/UX에서 탐색적 대안과 표현 다양성이 필요하기 때문이라고 볼 수 있다. 다른 기본 agent는 대체로 낮은 temperature 0.1을 사용한다는 패턴이 있다(`src/agents/explorer.ts:33-56`, `src/agents/oracle.ts:27-50`, `src/agents/fixer.ts:46-69`).

### Fixer

- 근거: fixer prompt는 “focused implementation specialist”이며 research/delegation을 하지 말고 작은 scoped change를 수행하라고 한다(`src/agents/fixer.ts:3-44`). README도 Fixer를 “Fast, focused code edits”로 설명한다(`README.md:437`).
- 엄밀한 추론: Fixer가 좁은 구현자 역할로 설계된 이유는 오케스트레이터가 작업을 충분히 분해한 뒤 실행만 맡기기 위해서다. 오케스트레이터 prompt는 split/delegation/verification을 담당하고(`src/agents/orchestrator.ts:140-264`), fixer는 별도 research 없이 명확한 지시를 받아 변경하는 역할로 제한된다(`src/agents/fixer.ts:3-44`).

### Observer

- 근거: observer prompt는 visual analysis/OCR/read-only를 요구한다(`src/agents/observer.ts:3-20`). observer는 기본 disabled 목록에 포함된다(`src/config/constants.ts:109-111`), README도 Observer가 기본 비활성화이며 vision model 사용 사례를 설명한다(`README.md:449-479`).
- 엄밀한 추론: Observer가 기본 비활성화된 이유는 vision-capable model과 이미지 입력이 항상 필요하지 않고 비용/호스트 지원 제약이 크기 때문이다. 메시지 transform은 observer에서 image stripping을 따로 처리한다(`src/index.ts:1059-1117`), 이는 host/model별 이미지 처리 차이를 의식한 구현이다.

### Council과 Councillor

- 근거: Council 문서는 여러 councillor가 병렬로 독립 판단을 내고 synthesizer가 합성한다고 설명한다(`docs/council.md:21-50`). 두 모델 계층, 즉 council agent model과 councillor models를 구분한다(`docs/council.md:54-72`). Council agent는 `council_session` tool을 반드시 사용하고 결과를 합성하라고 prompt에 박혀 있다(`src/agents/council.ts:8-67`).
- 엄밀한 추론: Council이 별도 tool과 hidden councillor agent를 사용하는 이유는 multi-model 토론을 일반 Task delegation으로 흉내 내면 모델 선택, timeout, retry, 실패 결과 수집, 합성 강제를 일관되게 통제하기 어렵기 때문이다. 실제 Manager는 preset validation, parallel/serial execution, retry only on empty response, failed section formatting을 구현한다(`src/council/council-manager.ts:77-190`, `src/council/council-manager.ts:318-471`).

### `webfetch`

- 근거: 문서는 `webfetch`가 cross-origin redirect를 막고 실패하면 raw content fallback을 제공한다고 설명한다(`docs/tools.md:11-19`). 구현은 permission ask, cache, `llms.txt` probe, fetch, cross-origin redirect block, binary limit/save, readability extraction, secondary model fallback을 포함한다(`src/tools/smartfetch/tool.ts:102-257`, `src/tools/smartfetch/tool.ts:259-652`, `src/tools/smartfetch/tool.ts:655-825`).
- 엄밀한 추론: `webfetch`가 MCP websearch와 별도로 구현된 이유는 검색이 아니라 특정 URL 콘텐츠의 안정적 수집, 변환, 캐싱, 보조 모델 압축, 바이너리 저장을 한 도구에서 통제하기 위해서다. 이는 URL fetch argument가 검색어가 아니라 URL/format/extraction/cache/metadata/binary save를 중심으로 구성된 점에서 드러난다(`src/tools/smartfetch/tool.ts:68-101`).

### `ast_grep_search`와 `ast_grep_replace`

- 근거: 문서는 grep과 ast-grep을 분리하고 AST-aware 패턴을 강조한다(`docs/tools.md:23-33`). search tool은 완전한 AST node requirement를 설명하고, replace tool은 dry-run 기본값으로 업데이트를 제한한다(`src/tools/ast-grep/tools.ts:18-44`, `src/tools/ast-grep/tools.ts:74-117`).
- 엄밀한 추론: AST-grep 도구가 필요한 이유는 LLM이 정규식 기반 대량 치환에서 문법 구조를 놓치기 쉽기 때문이다. 구현은 바이너리 해석/다운로드, timeout, output truncate, missing binary 친절한 오류를 따로 둔다(`src/tools/ast-grep/cli.ts:24-54`, `src/tools/ast-grep/cli.ts:115-247`), 즉 구조적 검색이 런타임 안정성까지 고려한 1급 도구로 취급된다.

### `apply_patch` 훅

- 근거: 문서는 네이티브 apply_patch 전에 stale patch를 복구하고 workspace 경계를 막으며 ambiguity에서는 실패한다고 설명한다(`docs/tools.md:5-8`). 구현은 `apply_patch` tool만 대상으로, patch text가 string인지 확인하고, root/worktree를 잡아 rewrite 결과를 tool args에 반영한다(`src/hooks/apply-patch/index.ts:61-101`). workspace 밖 쓰기는 fail-open이 아니라 안전한 오류로 처리하고, 다른 normalize 실패는 fail-closed된다(`src/hooks/apply-patch/index.ts:102-147`).
- 엄밀한 추론: 이 훅은 LLM이 파일을 읽은 뒤 사용자가 파일을 변경하거나 컨텍스트가 조금 어긋난 상황에서 patch 적용 실패를 줄이려는 보정층이다. `prefixSuffix/lcs` rescue option이 기본으로 켜져 있고(`src/hooks/apply-patch/index.ts:13-16`), docs가 stale patch rewrite를 직접 언급한다(`docs/tools.md:5-8`).

### `subtask`와 `read_session`

- 근거: 문서는 `/subtask`를 “separate bounded worker session”이라고 설명하고(`docs/subtask.md:5-11`), prepare prompt, tool call, child session with parentID, orchestrator, file context, read_session, summary, abort cleanup 흐름을 제시한다(`docs/subtask.md:31-46`). 구현은 nested subtask와 depth를 제한하고 child session을 만든 뒤 prompt를 주입하고 summary를 정규화한다(`src/tools/subtask/tools.ts:73-185`).
- 엄밀한 추론: subtask가 일반 Task보다 별도 도구로 존재하는 이유는 child session의 transcript 접근, file context 주입, summary 형식, cleanup을 강제하기 위해서다. `read_session`은 subtask worker만 source session을 제한적으로 읽도록 막는다(`src/tools/subtask/tools.ts:267-320`), 이는 독립 worker에게 필요한 맥락만 제공하려는 설계다.

### Task session manager

- 근거: 문서는 child session reuse가 기본 활성화되고 alias/read context/stale drop을 제공한다고 설명한다(`docs/session-management.md:1-57`). 코드도 task 전 hook에서 `task_id` alias를 해석하고 pending session을 추적하며(`src/hooks/task-session-manager/index.ts:246-302`), task 후 read context와 stale drop을 처리한다(`src/hooks/task-session-manager/index.ts:304-356`).
- 엄밀한 추론: session manager가 필요한 이유는 전문 agent를 반복 호출할 때 매번 cold start로 같은 코드를 다시 읽는 비용을 줄이기 위해서다. 문서가 “why exists”를 child agent context loss와 repeated setup으로 설명한다(`docs/session-management.md:12-24`), messages transform은 재개 가능한 세션을 prompt에 주입한다(`src/hooks/task-session-manager/index.ts:358-391`).

### Todo continuation

- 근거: 문서는 todo auto continuation이 opt-in이며 countdown과 injection, safety gates를 가진다고 설명한다(`docs/todo-continuation.md:1-33`). 구현은 terminal status, suppress window, config defaults, todo fetch timeout, enabled/todos/question/max gate를 둔다(`src/hooks/todo-continuation/index.ts:15-40`, `src/hooks/todo-continuation/index.ts:165-246`, `src/hooks/todo-continuation/index.ts:480-620`).
- 엄밀한 추론: 이 훅은 LLM이 todo를 만들고도 다음 항목으로 넘어가지 않는 “세션 정지”를 줄이기 위한 자동 진행 장치다. 다만 질문 대기와 max continuation을 gate로 두는 점은 무한 실행과 사용자 확인 누락을 막기 위한 안전장치로 볼 수 있다(`src/hooks/todo-continuation/index.ts:480-620`).

### Foreground fallback

- 근거: foreground fallback hook은 “interactive sessions cannot be try/catch wrapped”라서 event 기반 fallback이 필요하다고 주석으로 설명한다(`src/hooks/foreground-fallback/index.ts:1-15`). rate-limit pattern을 감지하고(`src/hooks/foreground-fallback/index.ts:27-56`), dedup, fallback chain resolve, abort, `promptAsync` requeue를 수행한다(`src/hooks/foreground-fallback/index.ts:218-335`).
- 엄밀한 추론: fallback chain이 config hook과 foreground hook 양쪽에 존재하는 이유는 startup model resolution과 실행 중 rate limit 회피가 서로 다른 시점의 문제이기 때문이다. startup fallback은 config 단계에서 모델 배열을 만든다(`src/index.ts:445-530`), foreground fallback은 event 이후 재프롬프트한다(`src/hooks/foreground-fallback/index.ts:218-335`).

### Phase reminder와 post-file-tool nudge

- 근거: phase reminder는 latest user message 뒤에 단계 reminder를 붙인다고 설명한다(`src/hooks/phase-reminder/index.ts:1-12`), orchestrator만 대상으로 하고 internal initiator를 건너뛴다(`src/hooks/phase-reminder/index.ts:30-90`). post-file-tool nudge는 inspect/edit anti-pattern을 잡아 phase reminder를 주입한다고 설명한다(`src/hooks/post-file-tool-nudge/index.ts:1-8`, `src/hooks/post-file-tool-nudge/index.ts:24-61`).
- 엄밀한 추론: 두 훅은 오케스트레이터가 탐색 없이 구현하거나 구현 후 검증 없이 멈추는 패턴을 줄이려는 prompt-time guardrail이다. 이 추론은 오케스트레이터 prompt가 understand/delegate/verify workflow를 강하게 요구하는 점(`src/agents/orchestrator.ts:140-264`)과 post-file-tool nudge가 read/write 이후 reminder를 건다는 점(`src/hooks/post-file-tool-nudge/index.ts:24-61`)에 근거한다.

### Multiplexer

- 근거: 문서는 tmux/zellij live pane으로 background agents를 보여준다고 설명한다(`docs/multiplexer-integration.md:1-4`). factory는 tmux/zellij 환경을 감지하고 세션 밖에서는 null을 반환한다(`src/multiplexer/factory.ts:18-65`). tmux 구현은 `opencode attach`로 pane을 띄우고 layout을 적용한다(`src/multiplexer/tmux/index.ts:42-120`, `src/multiplexer/tmux/index.ts:173-245`).
- 엄밀한 추론: 멀티플렉서는 기능 수행에 필수라기보다 observability/operability 계층이다. session manager는 multiplexer가 비활성화되어도 agent session 자체는 계속 관리하고, multiplexer 설정/세션 존재 여부로 enabled flag를 둔다(`src/multiplexer/session-manager.ts:81-125`).

### Auto-update checker

- 근거: auto-update hook은 top-level `session.created`에서 한 번 체크하고 autoUpdate 기본값을 true로 취급한다(`src/hooks/auto-update-checker/index.ts:21-55`). latest version 비교, pinned/manual mode, package update 준비, `bun install` 실행을 포함한다(`src/hooks/auto-update-checker/index.ts:62-160`, `src/hooks/auto-update-checker/index.ts:173-201`). 문서는 manual mode와 pinned entries가 version lock이 된다고 설명한다(`docs/configuration.md:157-174`).
- 엄밀한 추론: 자동 업데이트는 하네스 사용자가 별도 maintenance 없이 최신 plugin을 받게 하려는 편의 기능이다. 반면 runtime session 시작 시 네트워크와 패키지 매니저 side effect가 발생할 수 있으므로, DITTO 같은 재현성 중심 하네스에서는 기본 off 또는 명시 승인 방식이 더 적합하다. 이 판단은 hook이 session event에서 `bun install`까지 수행한다는 구현 근거에 기반한다(`src/hooks/auto-update-checker/index.ts:125-201`).

## 장점

1. 권한과 역할 경계가 비교적 명확하다. delegation rules가 오케스트레이터만 spawn 가능하고 전문 agent를 leaf로 둔다(`src/config/constants.ts:25-66`). councillor는 read-only permission만 갖는다(`src/agents/councillor.ts:61-80`), council_session도 council agent guard가 있다(`src/tools/council.ts:52-69`).
2. 설정 표면이 넓지만 schema와 doctor가 있다. Zod schema가 plugin config 전반을 검증하고(`src/config/schema.ts:303-351`), doctor가 JSON/schema/preset 문제를 검사해 human/json 출력과 exit code를 제공한다(`src/cli/doctor.ts:55-144`, `src/cli/doctor.ts:205-281`).
3. 설치가 비파괴 동작을 고려한다. 설치 문서는 non-destructive behavior와 `--reset` backup을 설명한다(`docs/installation.md:42-56`), config IO는 atomic write와 backup을 구현한다(`src/cli/config-io.ts:321-343`, `src/cli/config-io.ts:438-469`).
4. 외부 지식 접근을 통제 가능한 표면으로 분리했다. MCP는 agent별 allow/deny와 전역 disable이 가능하다(`docs/mcps.md:31-47`, `docs/mcps.md:73-83`), webfetch는 permission ask, cache, redirect policy, content limit를 별도로 구현한다(`src/tools/smartfetch/tool.ts:102-320`, `src/tools/smartfetch/network.ts:88-104`, `src/tools/smartfetch/network.ts:198-236`).
5. LLM 실패 모드를 하네스 차원에서 보완한다. stale patch rewrite(`docs/tools.md:5-8`), delegate failure retry guidance(`src/hooks/delegate-task-retry/hook.ts:5-21`), foreground rate-limit fallback(`src/hooks/foreground-fallback/index.ts:27-56`, `src/hooks/foreground-fallback/index.ts:218-335`), todo continuation gates(`src/hooks/todo-continuation/index.ts:480-620`)가 대표적이다.
6. 고비용 기능을 명시적으로 분리한다. Council은 config가 있을 때만 tool/agent 등록된다(`src/index.ts:247-259`, `docs/council.md:407-437`), README도 Council을 의도적으로 strict/expensive한 multi-model synthesis로 설명한다(`README.md:275-314`).
7. 배포 품질 검증이 실제 host load까지 포함한다. release verification은 npm pack/fresh install/import를 검사하고(`scripts/verify-release-artifact.ts:113-185`), host smoke는 임시 환경에서 OpenCode serve를 띄워 plugin load error를 확인한다(`scripts/verify-opencode-host-smoke.ts:246-305`).
8. codemap 스킬은 장기 세션에서 유용한 repo memory를 제공한다. 스킬 문서는 core file만 포함하고 tests/docs/build를 제외하며 state/templates를 만들고 fixer에게 update를 위임하라고 한다(`src/skills/codemap/SKILL.md:30-54`). change detection script는 gitignore와 include/exclude, hash, state migration/update를 구현한다(`src/skills/codemap/scripts/codemap.mjs:60-145`, `src/skills/codemap/scripts/codemap.mjs:161-197`, `src/skills/codemap/scripts/codemap.mjs:311-427`).

## 약한 점/리스크

1. Composition root의 책임이 매우 크다. `src/index.ts`가 대부분의 기능을 import하고 초기화하며(`src/index.ts:1-59`, `src/index.ts:157-334`), config/event/tool/command/message transform 전체를 반환한다(`src/index.ts:393-1208`). 엄밀한 추론: 기능이 늘수록 hook 순서, mutable state, preset 재설정, cleanup의 회귀 위험이 커진다. 이 추론은 시작부 state variable이 많고(`src/index.ts:111-153`) 후반 hook들이 같은 상태를 공유하는 구조에 근거한다(`src/index.ts:745-1208`).
2. OpenCode host의 실험적/비공개적 동작에 강하게 결합되어 있다. README는 background subagents에 `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=1`이 필요하다고 한다(`README.md:48-59`). foreground fallback은 interactive session을 try/catch로 감쌀 수 없어 event 기반이라고 설명한다(`src/hooks/foreground-fallback/index.ts:1-15`), `promptAsync`도 런타임에 존재하는 API로 다뤄 requeue한다(`src/hooks/foreground-fallback/index.ts:218-335`). 엄밀한 추론: OpenCode 내부 event/API가 바뀌면 핵심 orchestration이 깨질 수 있다.
3. 자동 업데이트는 재현성과 보안 관점에서 민감하다. hook은 session 시작 때 latest version을 확인하고 필요하면 `bun install`을 실행한다(`src/hooks/auto-update-checker/index.ts:21-55`, `src/hooks/auto-update-checker/index.ts:125-201`). 문서상 manual/pinned 설정은 있지만(`docs/configuration.md:157-174`), 기본 autoUpdate가 true라는 구현은 air-gapped, regulated, deterministic 환경에서 위험하다.
4. 외부 네트워크 표면이 넓다. 내장 MCP는 Exa/Tavily/Context7/grep.app endpoint를 사용한다(`docs/mcps.md:1-14`, `src/mcp/websearch.ts:4-44`, `src/mcp/context7.ts:3-14`, `src/mcp/grep-app.ts:3-10`), `webfetch`도 URL fetch와 optional secondary model을 가진다(`src/tools/smartfetch/tool.ts:68-101`, `src/tools/smartfetch/tool.ts:655-825`). 전역 disable이 가능하다는 완화책은 있다(`docs/mcps.md:73-83`).
5. Council은 비용/지연/복잡도가 크다. 문서는 여러 councillor를 병렬 실행한 뒤 합성한다고 설명하고(`docs/council.md:21-50`), 기본 timeout은 180초 범위를 갖는 설정이다(`docs/council.md:109-136`). 실패/timeout/retry 처리가 있지만(`docs/council.md:338-362`, `src/council/council-manager.ts:397-471`), DITTO에서 기본 경로로 쓰기에는 비싼 옵션이다.
6. prompt-time guardrail이 많아질수록 모델 입력이 복잡해질 수 있다. orchestrator prompt 자체가 workflow/delegation/verification을 길게 포함하고(`src/agents/orchestrator.ts:140-264`), phase reminder와 post-file-tool nudge가 추가 메시지를 주입한다(`src/hooks/phase-reminder/index.ts:30-90`, `src/hooks/post-file-tool-nudge/index.ts:24-61`). 엄밀한 추론: 장기 세션에서는 유용한 reminder와 불필요한 prompt noise 사이의 균형이 중요하다.
7. 멀티플렉서는 터미널 환경 의존성이 있다. 문서는 tmux/zellij와 port workaround를 다룬다(`docs/multiplexer-integration.md:16-31`), factory도 세션 밖이면 null을 반환한다(`src/multiplexer/factory.ts:18-65`). 따라서 CI나 headless harness에서는 이 기능을 observability enhancement로만 취급해야 한다.
8. AST-grep과 webfetch는 편리하지만 추가 실패 모드가 있다. AST-grep은 binary resolution/download와 timeout을 처리해야 한다(`src/tools/ast-grep/cli.ts:24-54`, `src/tools/ast-grep/cli.ts:115-173`), webfetch는 cross-origin redirect, binary limit, readability extraction, secondary model fallback 등 많은 분기 경로를 갖는다(`src/tools/smartfetch/tool.ts:259-652`, `src/tools/smartfetch/tool.ts:655-825`).

## DITTO에서 차용할 점

1. **명시적 agent registry와 delegation contract**: agent별 역할, 위임 조건, 금지 조건, 권한, 모델을 구조화해 오케스트레이터 프롬프트에 넣는 방식은 DITTO에서도 유용하다. 근거는 `AGENT_DESCRIPTIONS`와 routing examples(`src/agents/orchestrator.ts:27-110`), agent permission 계산(`src/agents/index.ts:154-193`)이다.
2. **전문 agent를 leaf로 제한하는 권한 모델**: 오케스트레이터만 분해/위임하고 전문 agent는 leaf로 유지하는 규칙은 병렬 작업에서 책임 확산을 줄인다(`src/config/constants.ts:25-66`). DITTO도 subagent가 다시 subagent를 무제한 호출하지 못하게 해야 한다.
3. **per-agent MCP/skill allowlist와 deny syntax**: MCP와 skill을 agent별로 좁히는 방식은 데이터 유출과 비용을 줄인다(`docs/mcps.md:31-47`, `src/config/agent-mcps.ts:22-44`, `src/cli/skills.ts:35-80`).
4. **bounded subtask worker**: `/subtask`처럼 child session, parentID, file context, summary, abort cleanup, source transcript 제한을 명확히 둔 별도 worker는 DITTO의 분석/검증 하위 작업에 적합하다(`docs/subtask.md:31-46`, `src/tools/subtask/tools.ts:73-185`, `src/tools/subtask/tools.ts:267-320`).
5. **session reuse with caps**: child session 재사용은 반복 분석 비용을 줄일 수 있지만 max sessions, TTL, read context cap이 필요하다(`docs/session-management.md:79-138`, `src/hooks/task-session-manager/index.ts:112-129`).
6. **tool-specific safety shim**: apply_patch rescue, AST-grep dry-run 기본값, webfetch redirect/content limit처럼 실패 모드별 보정 계층은 DITTO 하네스의 안정성을 높일 수 있다(`docs/tools.md:5-33`, `src/hooks/apply-patch/index.ts:61-147`, `src/tools/ast-grep/tools.ts:74-117`, `src/tools/smartfetch/network.ts:88-104`).
7. **doctor와 schema generation**: Zod schema에서 JSON schema를 만들고 doctor로 설정을 검사하는 패턴은 사용자 설정이 많은 DITTO에 그대로 적용 가능하다(`src/config/schema.ts:303-351`, `scripts/generate-schema.ts:3-30`, `src/cli/doctor.ts:55-144`).
8. **release artifact + host smoke**: 단순 unit test를 넘어 실제 host serve에서 plugin load를 확인하는 검증은 하네스 신뢰도에 중요하다(`scripts/verify-release-artifact.ts:113-185`, `scripts/verify-opencode-host-smoke.ts:246-305`, `.github/workflows/package-smoke.yml:14-40`).
9. **codemap skill**: repo atlas와 change detection을 유지하는 스킬은 DITTO의 장기 분석 세션에서 파일 탐색 비용을 줄인다(`docs/codemap.md:1-49`, `src/skills/codemap/SKILL.md:18-77`).
10. **고비용 합의 기능의 opt-in화**: Council처럼 config가 있을 때만 등록되는 multi-model 기능은 DITTO에서도 기본 경로가 아니라 명시 opt-in이어야 한다(`src/index.ts:247-259`, `docs/council.md:407-437`).

## 보완 계획

1. DITTO에 차용할 때는 `src/index.ts`식 대형 composition root 대신 기능 registry를 나누고, hook ordering을 테스트 가능한 manifest로 선언한다. 근거: 현재 저장소는 `src/index.ts`가 초기화와 hook 반환 대부분을 담당한다(`src/index.ts:157-334`, `src/index.ts:393-1208`).
2. 자동 업데이트는 기본 off 또는 explicit approval 방식으로 바꾼다. 근거: 현재 구현은 top-level session event에서 version check 후 `bun install`까지 실행할 수 있다(`src/hooks/auto-update-checker/index.ts:21-55`, `src/hooks/auto-update-checker/index.ts:125-201`).
3. 외부 네트워크 도구는 provider별 privacy/cost labels와 run-level audit log를 둔다. 근거: websearch/context7/grep_app MCP와 webfetch가 외부 요청을 수행한다(`docs/mcps.md:1-14`, `src/tools/smartfetch/tool.ts:102-320`), 현재는 disable과 permission 중심이다(`docs/mcps.md:73-83`).
4. Subtask/session reuse는 DITTO 작업 단위에 맞게 “작업 디렉터리 경계, 출력 파일 단일성, parent transcript read limit”을 더 강하게 검증한다. 근거: 이 저장소의 `read_session`은 source session 접근을 제한하지만(`src/tools/subtask/tools.ts:267-320`), DITTO는 병렬 에이전트가 같은 repo에서 다른 출력 파일을 만지는 운영 조건이 추가된다.
5. Council류 multi-model 기능은 비용 상한, timeout 상한, 실패 시 partial result 정책을 config와 로그에 명확히 드러낸다. 근거: Council은 parallel/serial, timeout, retries, failure formatting이 이미 있으나(`docs/council.md:109-136`, `docs/council.md:338-362`, `src/council/council-manager.ts:318-471`), 기본 사용자에게는 비용과 지연이 숨겨질 수 있다.
6. Prompt reminder는 품질 메트릭으로 조정한다. phase reminder와 post-file-tool nudge는 유용하지만(`src/hooks/phase-reminder/index.ts:30-90`, `src/hooks/post-file-tool-nudge/index.ts:24-61`), DITTO에서는 token overhead와 실제 오류 감소를 측정해 주입 빈도를 제한한다.
7. Host API coupling은 compatibility shim과 smoke matrix로 관리한다. 근거: background subagents는 실험 flag가 필요하고(`README.md:48-59`), host smoke는 현재도 한 host load 경로를 검증한다(`scripts/verify-opencode-host-smoke.ts:246-305`). DITTO에서는 host version matrix를 추가하는 편이 안전하다.
8. 멀티플렉서는 core logic과 분리된 observability plugin으로 둔다. 근거: multiplexer factory는 환경에 따라 null이 되고(`src/multiplexer/factory.ts:18-65`), tmux/zellij 구현은 terminal layout과 attach command에 의존한다(`src/multiplexer/tmux/index.ts:42-120`, `src/multiplexer/zellij/index.ts:51-97`).

## 근거 목록

### 최상위 문서와 메타데이터

- `README.md:24-30`: 플러그인 목적과 specialist agent routing 설명.
- `README.md:32-46`: quick/manual install 명령.
- `README.md:48-59`: V2 background orchestration, experimental flag 필요.
- `README.md:63-107`: installer가 OpenAI/OpenCode Go preset과 기본 모델을 생성하는 예시.
- `README.md:81-83`: orchestrator prompt의 delegation rules와 수동 `@agentName` 언급.
- `README.md:112-120`: custom providers/custom agents.
- `README.md:122-141`: 설치 검증 절차.
- `README.md:149-184`: Orchestrator 역할/기본 모델 권장.
- `README.md:190-224`: Explorer 역할/모델 가이드.
- `README.md:231-265`: Oracle 역할/모델 가이드.
- `README.md:275-314`: Council의 strict/expensive multi-model synthesis 성격.
- `README.md:449-479`: Observer 기본 비활성화와 vision 사용.
- `README.md:488-523`: feature docs index.
- `package.json:2-19`: 패키지 이름, 설명, main/export/bin.
- `package.json:41-71`: 배포 파일과 scripts.
- `package.json:73-101`: runtime/dev/optional dependencies.
- `tsconfig.json:3-16`: TypeScript target/module/strict/include.
- `biome.json:1-47`: formatter/linter 설정.
- `bunfig.toml:1-2`: test root.

### 설치/설정 문서

- `docs/installation.md:18-40`: 설치 명령과 flags.
- `docs/installation.md:42-56`: non-destructive behavior와 reset backup.
- `docs/installation.md:58-82`: 설치 후 검증.
- `docs/installation.md:95-161`: LLM agent installation flow와 automatic installer effects.
- `docs/configuration.md:7-18`: config 파일과 JSONC precedence.
- `docs/configuration.md:22-47`: prompt override 규칙.
- `docs/configuration.md:82-148`: config option reference.
- `docs/configuration.md:149-155`: council model vs councillor model.
- `docs/configuration.md:157-174`: autoUpdate manual/pinned mode.
- `docs/configuration.md:241-247`: session management defaults.
- `docs/configuration.md:249-275`: displayName alias.
- `docs/configuration.md:277-299`: custom agents.

### 도구/기능 문서

- `docs/tools.md:5-8`: apply_patch rescue.
- `docs/tools.md:11-19`: webfetch redirect/fallback.
- `docs/tools.md:23-33`: grep/ast_grep.
- `docs/tools.md:37-54`: subtask/read_session.
- `docs/tools.md:68-88`: todo continuation과 session goal 명령.
- `docs/subtask.md:5-46`: `/subtask` 목적과 workflow.
- `docs/subtask.md:54-114`: bounded worker, read_session, summary format.
- `docs/skills.md:1-100`: skills 개념, bundled skills, assignment syntax.
- `docs/mcps.md:1-83`: built-in MCP, per-agent defaults, wildcard/deny, disable.
- `docs/council.md:21-99`: Council 병렬 합의, 모델 계층, quick setup.
- `docs/council.md:109-160`: Council config와 synthesizer model.
- `docs/council.md:190-198`: councillor model 선택 제약.
- `docs/council.md:244-261`: serial mode.
- `docs/council.md:302-362`: usage/output/failure behavior.
- `docs/council.md:365-437`: deprecated fields와 troubleshooting.
- `docs/multiplexer-integration.md:1-31`: tmux/zellij live panes와 port workaround.
- `docs/multiplexer-integration.md:46-193`: quick start, defaults, layout.
- `docs/session-management.md:1-138`: child session reuse, scope/safety, config.
- `docs/todo-continuation.md:1-49`: opt-in continuation, countdown, safety gates, config.
- `docs/session-goal.md:1-51`: goal command와 다른 기능 관계.
- `docs/interview.md:1-199`: interview browser UI, workflow, output, modes.
- `docs/codemap.md:1-49`: codemap skill 목적과 명령.

### 플러그인 엔트리/에이전트/설정

- `src/index.ts:1-59`: plugin composition imports.
- `src/index.ts:84-104`: health check와 jsdom probe.
- `src/index.ts:111-334`: plugin start state와 기능 초기화.
- `src/index.ts:393-443`: plugin return, agent/tool/MCP/config hook.
- `src/index.ts:445-720`: model fallback, runtime preset, MCP merge/permission.
- `src/index.ts:722-1208`: command/event/tool/message hooks.
- `src/agents/index.ts:55-89`: override 적용.
- `src/agents/index.ts:115-193`: custom agent와 permissions.
- `src/agents/index.ts:205-330`: agent factory 생성과 custom agent discovery.
- `src/agents/index.ts:334-526`: orchestrator 생성, displayName, OpenCode agent config.
- `src/agents/orchestrator.ts:27-264`: agent descriptions, routing examples, orchestrator prompt.
- `src/agents/explorer.ts:3-56`: Explorer prompt와 생성.
- `src/agents/librarian.ts:3-48`: Librarian prompt와 생성.
- `src/agents/oracle.ts:3-50`: Oracle prompt와 생성.
- `src/agents/designer.ts:3-80`: Designer prompt와 생성.
- `src/agents/fixer.ts:3-69`: Fixer prompt와 생성.
- `src/agents/observer.ts:3-45`: Observer prompt와 생성.
- `src/agents/council.ts:8-174`: Council prompt와 councillor result formatting.
- `src/agents/councillor.ts:3-80`: Councillor prompt와 read-only permission.
- `src/config/constants.ts:1-111`: agent names, delegation rules, default models, timeouts, observer disabled.
- `src/config/agent-mcps.ts:8-69`: agent MCP defaults와 allow/deny parser.
- `src/config/schema.ts:23-351`: provider/model regex와 plugin schema.
- `src/config/loader.ts:54-412`: JSONC/env/preset/prompt loader.
- `src/config/council-schema.ts:14-215`: council schema와 defaults.
- `src/mcp/index.ts:9-34`, `src/mcp/types.ts:3-14`, `src/mcp/websearch.ts:4-44`, `src/mcp/context7.ts:3-14`, `src/mcp/grep-app.ts:3-10`: MCP registry와 built-in MCP 정의.

### 도구/훅/세션 구현

- `src/tools/codemap.md:1-107`: tools directory map.
- `src/tools/ast-grep/tools.ts:18-117`: AST-grep search/replace tool.
- `src/tools/ast-grep/cli.ts:24-247`: AST-grep binary/run/parse/truncate.
- `src/tools/smartfetch/tool.ts:68-825`: webfetch schema, cache, fetch, extraction, binary, secondary model fallback.
- `src/tools/smartfetch/network.ts:19-236`: HTTPS upgrade, redirect policy, body limit.
- `src/tools/subtask/command.ts:17-87`: `/subtask` command와 state propagation.
- `src/tools/subtask/tools.ts:48-185`, `src/tools/subtask/tools.ts:267-320`: subtask/read_session tools.
- `src/tools/council.ts:27-121`: council_session tool와 guard.
- `src/tools/preset-manager.ts:19-339`: `/preset` command와 runtime switch.
- `src/hooks/codemap.md:1-74`: hook directory map.
- `src/hooks/apply-patch/codemap.md:3-27`, `src/hooks/apply-patch/index.ts:13-147`: apply_patch preprocessor.
- `src/hooks/filter-available-skills/index.ts:1-154`: available_skills filtering.
- `src/hooks/todo-continuation/index.ts:15-620`: todo continuation.
- `src/hooks/task-session-manager/index.ts:62-433`: session reuse manager.
- `src/hooks/delegate-task-retry/hook.ts:5-21`: task failure retry guidance.
- `src/hooks/post-file-tool-nudge/index.ts:1-61`: file tool 후 phase nudge.
- `src/hooks/foreground-fallback/index.ts:1-385`: foreground fallback.
- `src/hooks/phase-reminder/index.ts:1-90`: phase reminder injection.
- `src/hooks/auto-update-checker/index.ts:21-201`: auto-update checker.
- `src/council/council-manager.ts:1-471`: Council 실행 관리자.
- `src/multiplexer/codemap.md:3-77`, `src/multiplexer/types.ts:19-99`, `src/multiplexer/factory.ts:18-97`, `src/multiplexer/session-manager.ts:81-572`: multiplexer abstraction/session manager.
- `src/multiplexer/tmux/index.ts:42-324`, `src/multiplexer/zellij/index.ts:1-280`: tmux/zellij 구현.

### 스킬/CLI/검증

- `src/cli/custom-skills.ts:30-109`: bundled skill registry와 설치.
- `src/cli/skills.ts:20-80`: skill permission 계산.
- `src/skills/codemap/SKILL.md:1-163`, `src/skills/codemap/scripts/codemap.mjs:16-427`: codemap skill과 helper script.
- `src/skills/simplify/SKILL.md:1-138`: simplify skill.
- `src/skills/clonedeps/SKILL.md:1-237`: clonedeps skill.
- `src/cli/index.ts:7-94`: CLI argument parsing/subcommands/help.
- `src/cli/install.ts:147-326`: install workflow와 option mapping.
- `src/cli/config-io.ts:275-612`: JSONC parsing, atomic writes, OpenCode config mutation, detection.
- `src/cli/providers.ts:8-149`: generated presets와 provider mappings.
- `src/cli/system.ts:117-192`: OpenCode detection과 npm latest lookup.
- `src/cli/doctor.ts:55-281`: doctor checks/output.
- `.github/workflows/ci.yml:38-51`: CI lint/typecheck/test/build.
- `.github/workflows/package-smoke.yml:14-40`: package smoke matrix.
- `scripts/generate-schema.ts:3-30`: schema generation.
- `scripts/verify-release-artifact.ts:19-203`: release artifact verification.
- `scripts/verify-opencode-host-smoke.ts:161-333`: OpenCode host smoke.

## ditto 적용 정리

oh-my-opencode-slim에서 ditto에 적용할 핵심은 “범용 coding agent harness”라는 목적을 강화하되, 사용자의 인지 비용 감소, 근거 기반 출력, Context Rot 완화, 장기 작업 완수, token 비용 절감을 직접 돕는 기능으로 좁힌다. 아래 항목은 보고서 본문에서 확인된 구현/문서 근거와 PURPOSE.md의 목적 및 핵심기능에 연결되는 것만 추렸다.

1. **명시적 agent registry와 delegation contract**
   - 적용할 기능/가치: orchestrator가 작업을 이해하고, `explorer`, `librarian`, `oracle`, `designer`, `fixer`, `council`, `observer` 같은 전문 agent에 역할별로 위임하는 구조를 차용한다. 단, ditto에서는 전문 agent가 다시 위임하지 않는 leaf 규칙과 권한 범위를 계약으로 고정한다.
   - 적용 방법: agent별 역할, 사용 시점, 금지 조건, 허용 도구, 산출물 형식을 registry에 선언하고, 오케스트레이션 단계의 정규화된 interface로 노출한다. 이는 PURPOSE.md의 “각 단계의 진입과 출력은 반드시 정규화된 interface 또는 문서 양식”이어야 한다는 핵심기능과 맞는다.
   - 적용 이후 제공 가치: 사용자는 어떤 agent가 왜 호출됐는지 감사 기록으로 추적할 수 있고, LLM이 사용자 의도와 벗어나 임의로 작업하는 범위를 줄일 수 있다.
   - 리스크/선행 조건: registry가 prompt 문장으로만 존재하면 실제 권한 통제가 약해진다. agent permission과 위임 가능 여부를 런타임에서 함께 검증해야 한다.
   - 근거: 보고서는 오케스트레이터가 전문 agent 역할, 권한, 통계, 위임 금지 조건을 구조화한다고 설명한다(`src/agents/orchestrator.ts:27-93`). 기본 agent set과 delegation rules는 constants로 정리되어 있고(`src/config/constants.ts:1-66`), agent permission 계산도 별도 구현되어 있다(`src/agents/index.ts:154-193`).

2. **bounded subtask와 session reuse**
   - 적용할 기능/가치: `/subtask`, `read_session`, task session manager의 child session, parentID, file context, transcript read limit, summary, stale drop, TTL/cap을 ditto의 서브 에이전트 실행 단위에 적용한다.
   - 적용 방법: ditto subagent는 작업 디렉터리, 수정 가능 파일, 읽기 가능한 parent transcript 범위, 출력 요약 형식을 실행 전에 받게 한다. session reuse는 동일한 목적의 반복 분석에만 허용하고, max sessions/TTL/read context cap을 기본값으로 둔다.
   - 적용 이후 제공 가치: PURPOSE.md가 요구하는 Context Rot 해결과 장기 작업 완수에 직접 기여한다. 같은 코드를 반복해서 다시 읽는 비용을 줄이고, 새 세션에서 이어서 작업할 때 필요한 핸드오프 품질도 좋아진다.
   - 리스크/선행 조건: 재사용 세션이 오래된 판단을 유지하면 오히려 잘못된 가설을 강화할 수 있다. stale drop, 변경 감지, read context cap, 요약 갱신 조건이 선행되어야 한다.
   - 근거: 보고서는 `/subtask`가 별도 bounded worker session을 만들고 parentID, file context, read_session, summary, abort cleanup 흐름을 갖는다고 정리한다(`docs/subtask.md:31-46`, `src/tools/subtask/tools.ts:73-185`). child session reuse는 alias/read context/stale drop을 제공하고(`docs/session-management.md:1-57`), 코드상 max/TTL/read context 옵션을 가진다(`src/hooks/task-session-manager/index.ts:112-129`).

3. **도구별 안전 보정층**
   - 적용할 기능/가치: stale `apply_patch` 복구, AST-aware search/replace의 dry-run 기본값, `webfetch`의 redirect/content limit 같은 tool-specific safety shim을 ditto의 액션 실행 계층에 둔다.
   - 적용 방법: 모든 액션 감사 기록과 연결해 “무엇을 보정했는지, 왜 실패시켰는지, 어떤 근거로 재시도했는지”를 남긴다. 패치, 구조적 검색/치환, 외부 URL fetch처럼 LLM 실패 빈도가 높은 도구부터 좁게 적용한다.
   - 적용 이후 제공 가치: PURPOSE.md의 “할루시네이션 방지”, “사용자의 의도와 벗어난 추론 및 작업 제한”, “모든 출력과 추론에는 확실한 근거”라는 가치에 맞춰 실행 실패와 잘못된 변경을 하네스 차원에서 줄인다.
   - 리스크/선행 조건: 자동 복구가 너무 공격적이면 사용자가 의도하지 않은 변경을 만들 수 있다. ambiguity에서는 실패하고, workspace 경계와 dry-run 기본값을 강제해야 한다.
   - 근거: 보고서는 `apply_patch` 훅이 네이티브 실행 전에 stale patch를 복구하되 workspace 밖 쓰기와 모호한 경우를 안전하게 처리한다고 설명한다(`docs/tools.md:5-8`, `src/hooks/apply-patch/index.ts:61-147`). AST-grep replace는 기본 dry-run이고(`src/tools/ast-grep/tools.ts:74-117`), `webfetch`는 permission, cache, redirect policy, content limit를 가진다(`src/tools/smartfetch/tool.ts:102-320`, `src/tools/smartfetch/network.ts:88-104`).

4. **설정 schema, doctor, host smoke 검증**
   - 적용할 기능/가치: JSONC 설정, schema generation, `doctor`, release artifact 검증, 실제 host load smoke를 ditto의 기본 검증 표면으로 삼는다.
   - 적용 방법: 사용자/프로젝트 설정을 schema로 검증하고, doctor는 human/json 결과와 exit code를 제공한다. 배포 검증은 패키지 구성뿐 아니라 ditto가 실제 harness host에서 로드되는지 확인하는 smoke test를 포함한다.
   - 적용 이후 제공 가치: PURPOSE.md의 “사용자의 인지 비용 최소화”, “완료를 증거 위에 올려두는” 운영 방식, “새 세션에서 이어서 작업할 때를 위한 핸드오프”에 맞게 설정 오류를 조기에 드러내고 검증 가능한 완료 증거를 남길 수 있다.
   - 리스크/선행 조건: schema와 doctor가 실제 런타임 로딩 규칙과 어긋나면 가짜 안정감을 준다. 설정 loader, schema, doctor, smoke test가 같은 계약을 공유해야 한다.
   - 근거: 보고서는 JSONC 설정과 Zod schema 검증, prompt override, preset 병합을 확인했다(`docs/configuration.md:7-47`, `src/config/loader.ts:54-101`, `src/config/schema.ts:303-351`). doctor는 설정 오류를 검사해 human/json 결과와 exit code를 내고(`src/cli/doctor.ts:55-144`, `src/cli/doctor.ts:205-281`), release/host smoke는 npm pack/fresh install/import와 OpenCode host load error를 확인한다(`scripts/verify-release-artifact.ts:113-185`, `scripts/verify-opencode-host-smoke.ts:246-305`).

5. **고비용 합의와 외부 지식 접근의 opt-in/allowlist화**
   - 적용할 기능/가치: Council 같은 multi-model 정반합 검토와 MCP/webfetch 기반 외부 지식 접근을 기본 경로가 아니라 명시 opt-in 기능으로 둔다. agent별 MCP/skill allowlist와 deny syntax도 함께 차용한다.
   - 적용 방법: ditto의 multi-model 검토는 비용 상한, timeout, 실패 시 partial result 정책, 모델/도구 사용 감사 기록을 필수로 둔다. 외부 네트워크 도구는 agent별 허용 목록, 전역 disable, provider별 privacy/cost label을 갖는다.
   - 적용 이후 제공 가치: PURPOSE.md가 말하는 멀티 모델 정반합 기반 검토, 할루시네이션 방지, token 비용 절감, 불필요한 사용자 질문 감소를 동시에 지원한다. 필요한 때만 깊은 검토를 쓰고, 일반 구현 경로는 가볍게 유지할 수 있다.
   - 리스크/선행 조건: Council은 비용과 지연이 크고, 외부 MCP/webfetch는 네트워크/프라이버시 표면을 넓힌다. 기본 비활성, 명시 승인, 비용/지연 가시화, 로그가 선행되어야 한다.
   - 근거: 보고서는 Council이 여러 councillor를 병렬 실행한 뒤 합성하고, config가 있을 때만 tool/agent로 등록되는 expensive 기능이라고 정리한다(`docs/council.md:21-50`, `src/index.ts:247-259`, `docs/council.md:407-437`). MCP는 agent별 allow/deny와 전역 disable을 지원하고(`docs/mcps.md:31-47`, `docs/mcps.md:73-83`, `src/config/agent-mcps.ts:22-44`), `webfetch`는 URL fetch, 본문 추출, cache, 보조 모델 fallback을 가진 별도 도구다(`src/tools/smartfetch/tool.ts:68-101`, `src/tools/smartfetch/tool.ts:655-825`).
