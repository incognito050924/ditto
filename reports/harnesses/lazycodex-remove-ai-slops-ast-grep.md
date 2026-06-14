# LazyCodex remove-ai-slops / AST-grep / OmO 오케스트레이션 연구 보고서

## 분석 대상 및 기준 커밋

- 대상 저장소: `https://github.com/code-yeongyu/lazycodex`
- 최초 분석 경로: `/tmp/lazycodex-investigation.TXhRmD` (최초 작성 시)
- 재검증 경로: `/tmp/lazycodex-verify` (2026-06-15 fresh clone)
- LazyCodex 루트 기준 커밋:
  - 최초 작성 시: `7bbf9d78a532a57aabf23fb213d214b82eeca892`
  - **2026-06-15 재검증 시점: `245fd8f45e37fe9b412ae57c1fb7cfbd672328b7` (Codex marketplace v4.10.0)** — 루트가 전진했다.
- `src` 서브모듈: `https://github.com/code-yeongyu/oh-my-openagent.git` / `65715d1c2c35e27ccf2195ef688b0909dddb403c` (재검증 시점에도 동일 핀 — 변경 없음)
- `src/packages/lsp-tools-mcp` 서브모듈: `d1ff1681c1f558e062ac33fad4d835baaa7b5edf` (동일)
- 이 보고서의 `path:line` 근거는 위 로컬 클론과 커밋 기준이다.

> **2026-06-15 재검증 요지.** 루트 저장소는 `7bbf9d7` → `245fd8f`(v4.10.0)로 1커밋 전진했고(`chore: sync Codex marketplace v4.10.0`), 314개 파일이 변경됐다. 그러나 보고서가 인용한 핵심 파일 대부분 — `bin/lazycodex-ai.js`, 루트 `package.json`, `plugins/omo/.mcp.json`, `plugins/omo/.codex-plugin/plugin.json`, `plugins/omo/skills/remove-ai-slops/SKILL.md` — 은 이 diff에 포함되지 않아 **내용·라인 모두 불변**이다. `src/...` 인용은 서브모듈 핀이 같아 전부 유효하다. 라인이 이동한 인용은 단 두 파일(`plugins/omo/hooks/hooks.json`, `plugins/omo/components/ultrawork/directive.md`)뿐이며, 본문에서 정정했다. 동작·구조 주장 중 **틀린 것은 없었다**. DITTO ACG 절 28개 인용도 main 브랜치 현재 코드와 대조해 전부 확인했다(세부는 마지막 "검증 기록" 참조).

## 조사 질문

사용자 요청은 세 가지였다.

1. LazyCodex의 `remove-ai-slops`가 정확히 무엇이고 어떤 일을 하는지 코드 레벨에서 끝까지 확인한다.
2. `AST-grep` 기능이 무엇이고 어떻게 실행되는지 확인한다.
3. LazyCodex 내부에서 이 둘이 OmO 오케스트레이션에 어디서 어떻게 연결되는지 확인한다.

## 조사 방법

- LazyCodex 저장소를 클론하고 기본 브랜치와 커밋을 확인했다.
- `src` 서브모듈을 초기화해 실제 구현체인 `oh-my-openagent` 코드를 함께 추적했다.
- npm wrapper, plugin manifest, MCP manifest, hook manifest, skill 파일, marketplace sync script, Codex installer, AST-grep MCP server, AST-grep core runner를 정적으로 읽었다.
- 마지막에 읽기 전용 검증 명령으로 커밋, 서브모듈, plugin/MCP manifest, MCP call path를 재확인했다.
- 실제 Codex 세션에서 skill을 호출하거나 AST-grep MCP를 Codex host에 붙여 end-to-end 실행하지는 않았다. 이 보고서는 저장소 코드와 설정에 대한 정적 분석이다.

## 핵심 결론

1. `lazycodex-ai`는 독립 실행 엔진이 아니라 `oh-my-openagent`의 `omo` CLI를 호출하는 얇은 npm alias다. `install`이면 `omo install --platform=codex`로 넘기고, 그 외 인자는 `omo`로 그대로 넘긴다. 근거: `package.json:2-7`, `bin/lazycodex-ai.js:9-26`.
2. `remove-ai-slops`는 TypeScript/JavaScript 실행 코드가 아니라 OmO Codex plugin에 포함된 `SKILL.md` 절차 문서다. Codex skill loader가 이 문서를 로드하면, agent는 여기에 적힌 테스트 잠금, 범위 산정, 병렬 cleanup, 품질 게이트를 따른다. 근거: `plugins/omo/skills/remove-ai-slops/SKILL.md:2-3`.
3. `AST-grep`은 skill이 아니라 OmO plugin이 등록하는 MCP server다. Codex는 `.mcp.json`을 통해 `ast_grep` 서버를 보고, 내부 서버는 `search`와 `replace` 도구를 제공한다. 근거: `plugins/omo/.mcp.json:2-8`, `src/packages/ast-grep-mcp/src/mcp.ts:66-83`.
4. `remove-ai-slops`와 `AST-grep`은 같은 OmO plugin bundle에 들어 있지만 직접 결합되어 있지는 않다. `remove-ai-slops/SKILL.md` 안에는 `ast_grep`, `ast-grep`, `sg` 직접 호출이 없다. AST-grep은 OmO 오케스트레이션 전체에서 구조 검색과 구조 치환이 필요할 때 쓰는 공용 MCP 도구다.
5. OmO 오케스트레이션과의 연결은 plugin manifest, hook manifest, MCP manifest, 설치기의 Codex config 갱신, subagent 역할 설치를 통해 이뤄진다. 근거: `plugins/omo/.codex-plugin/plugin.json:21-23`, `plugins/omo/hooks/hooks.json:36-92`, `plugins/omo/.mcp.json:2-34`, `src/src/cli/install-codex/install-codex.ts:76-157`, `src/src/cli/install-codex/codex-config-toml.ts:20-67`.

## LazyCodex의 실제 역할

LazyCodex 루트 패키지는 다음 구조다.

- npm package name: `lazycodex-ai`
- bin: `lazycodex-ai -> bin/lazycodex-ai.js`
- wrapper target: npm package `oh-my-openagent`, command `omo`

`bin/lazycodex-ai.js`의 분기는 단순하다.

- 첫 인자가 `install`이면 `npx --yes --package oh-my-openagent omo install --platform=codex ...rest`
- 아니면 `npx --yes --package oh-my-openagent omo ...forwardedArgs`
- `--dry-run`이면 실제 실행 대신 명령을 출력한다.
- 실행은 `spawnSync("npx", commandArgs, { stdio: "inherit" })`로 한다.

근거: `bin/lazycodex-ai.js:9-26`.

따라서 LazyCodex는 "Codex용 OmO 설치 별칭"에 가깝다. 실제 skill, hook, MCP, installer 구현은 `src` 서브모듈의 `oh-my-openagent`와 루트에 복사된 `plugins/omo` bundle에 있다.

## OmO plugin bundle 구조

LazyCodex는 루트에 Codex plugin marketplace를 싣고 있다.

- marketplace: `.agents/plugins/marketplace.json`
- plugin root: `plugins/omo`
- plugin manifest: `plugins/omo/.codex-plugin/plugin.json`
- hooks: `plugins/omo/hooks/hooks.json`
- MCP servers: `plugins/omo/.mcp.json`
- skills: `plugins/omo/skills/`

`plugin.json`은 `skills`, `hooks`, `mcpServers`를 모두 Codex plugin 표면으로 노출한다. 근거: `plugins/omo/.codex-plugin/plugin.json:21-23`.

등록된 MCP server는 다음 다섯 개다.

- `ast_grep`
- `grep_app`
- `context7`
- `git_bash`
- `lsp`

근거: `plugins/omo/.mcp.json:2-34`.

hook manifest는 주요 lifecycle에 OmO component를 붙인다.

- `SessionStart`: rules, telemetry, auto-update, **bootstrap provisioning** (v4.10.0에서 추가)
- `UserPromptSubmit`: rules, ultrawork, ulw-loop steering
- `PreToolUse`: Bash(git-bash) reminder, goal budget guard
- `PostToolUse`: comment checker, LSP, rules
- `PostCompact`: cache reset **3종** (git-bash reminder, project rule cache, LSP diagnostics cache)
- `Stop`, `SubagentStop`: start-work continuation

근거: `plugins/omo/hooks/hooks.json:2-192` (v4.10.0, 파일 193줄). 최초 작성 시 인용은 `:2-179`였으나 v4.10.0에서 SessionStart에 `bootstrap` 훅(`components/bootstrap/dist/cli.js hook session-start`, `hooks.json:36-44`)이 추가되고 PostCompact가 캐시 리셋 3종으로 늘면서 라인이 이동했다. 명명된 component는 모두 그대로 배선돼 있다.

## remove-ai-slops의 정체

`remove-ai-slops`는 `plugins/omo/skills/remove-ai-slops/SKILL.md`에 있는 skill이다. frontmatter의 `description` 자체가 기능을 거의 완전히 설명한다.

- AI-generated code smell, 즉 "slop" 제거
- branch diff 또는 명시 파일 목록 대상
- regression test를 먼저 잠근 뒤 cleanup
- `deep` agent를 파일 단위로 병렬 실행
- batch 크기 5
- 품질 게이트로 검증
- 10개 slop category 처리

근거: `plugins/omo/skills/remove-ai-slops/SKILL.md:2-3`.

중요한 점은 이 skill이 코드 변환 라이브러리가 아니라 "agent 운영 절차"라는 점이다. 즉 `remove-ai-slops`라는 함수가 코드를 자동 변환하는 것이 아니라, Codex agent에게 어떤 순서로 조사하고, 무엇을 제거하고, 어떤 기준으로 멈추고, 어떤 검증을 해야 하는지를 지시한다.

## remove-ai-slops 실행 절차

### 1. 범위 산정

기본 범위는 현재 브랜치의 변경 파일이다.

```sh
git diff $(git merge-base main HEAD)..HEAD --name-only
```

근거: `plugins/omo/skills/remove-ai-slops/SKILL.md:126-135`.

삭제 파일, binary, generated/vendor/lockfile은 제외하도록 되어 있다. 사용자가 명시 파일 목록을 주면 그 목록을 우선한다.

### 2. 동작 잠금

수정 전 각 파일의 observable behavior를 확인하고 관련 테스트를 찾는다. 테스트가 약하거나 없으면 먼저 좁은 regression test를 추가한 뒤 green baseline을 만들어야 한다. baseline이 green이 아니면 cleanup을 진행하지 말고 멈추라고 되어 있다.

근거: `plugins/omo/skills/remove-ai-slops/SKILL.md:136-145`.

이 지점이 핵심 안전장치다. `remove-ai-slops`는 "깔끔해 보이게 고치는" 절차가 아니라 "현재 동작을 테스트로 고정한 뒤 불필요한 인공물을 제거하는" 절차다.

### 3. cleanup plan 작성

파일별로 category, 변경 순서, 위험도를 계획한다. 권장 순서는 위험이 낮은 항목에서 높은 항목으로 간다.

1. obvious comments
2. dead code
3. over-defensive code
4. duplication
5. complexity
6. needless abstraction / boundary violations
7. performance equivalences
8. missing tests
9. oversized modules

근거: `plugins/omo/skills/remove-ai-slops/SKILL.md:147-164`.

### 4. 병렬 cleanup

`Phase 4`는 `deep` agent를 파일 단위로 병렬 실행하라고 지시한다. batch 크기는 5다. 각 child agent에는 다음 제약이 들어간다.

- behavior preserved
- public API signature 변경 금지
- type hint 제거 금지
- 새 dependency 금지
- 새 abstraction 금지
- minimal diff
- 파일별 category와 변경 근거 보고

근거: `plugins/omo/skills/remove-ai-slops/SKILL.md:165-214`.

Codex host 호환 블록도 중요하다. 원래 OmO/OpenCode 쪽 예시는 `task(...)`, `call_omo_agent(...)`, `background_output(...)` 같은 표면을 쓰는데, Codex용 skill sync 과정에서 이를 `multi_agent_v1.spawn_agent`, `multi_agent_v1.wait_agent`, `send_input`, `close_agent`로 해석하라고 안내한다.

근거: `plugins/omo/skills/remove-ai-slops/SKILL.md:6-22`, `src/packages/omo-codex/plugin/scripts/sync-skills.mjs:20-52`.

### 5. 품질 게이트

cleanup 후에는 다음을 확인해야 한다.

- regression tests
- lint
- `lsp_diagnostics`와 프로젝트 type-checker
- unit/integration tests
- static/security scan 또는 N/A 사유

근거: `plugins/omo/skills/remove-ai-slops/SKILL.md:106-117`, `plugins/omo/skills/remove-ai-slops/SKILL.md:216-239`.

실패하면 문제 hunk를 찾아 targeted revert 또는 직접 수정 후 같은 gate를 다시 실행한다. 같은 파일에서 세 번 실패하면 멈추고 사용자에게 파일, 시도한 내용, 실패 내용, 가설을 보고하라고 되어 있다.

근거: `plugins/omo/skills/remove-ai-slops/SKILL.md:240-251`.

## remove-ai-slops가 제거하려는 slop category

보고서 관점에서 category를 압축하면 다음과 같다.

| category | 제거 대상 | 유지해야 하는 것 |
| --- | --- | --- |
| obvious comments | 코드가 말하는 내용을 반복하는 주석, divider, commented-out code, 빈 TODO | 이유, ticket, regex/algorithm 설명, BDD marker |
| over-defensive code | 불필요한 null check, 넓은 catch, 실제 불가능한 fallback | 외부 입력/I/O/권한/네트워크 boundary validation |
| excessive complexity | 깊은 nesting, 복잡한 boolean, variant if/elif chain, `object` annotation | 의미 있는 타입 모델, exhaustive check |
| needless abstraction | single-use helper, pass-through wrapper, speculative interface | 실제 복잡도를 줄이는 추상화 |
| boundary violations | UI/domain/infrastructure 경계 침범 | 기존 architecture boundary |
| dead code | 미사용 함수, 변수, branch, import | public API나 reflection entrypoint |
| duplication | 같은 로직 반복 | 의도적으로 분리된 도메인 규칙 |
| performance equivalence | 명백히 동등한 O(n^2) 제거, 반복 계산 hoist | 증명이 필요한 알고리즘 변경 |
| missing tests | cleanup 전에 필요한 좁은 테스트 | 테스트 삭제/완화 금지 |
| oversized modules | 250 pure LOC 이상 모듈 | 사용자에게 split plan 제시 후 진행 |

근거: `plugins/omo/skills/remove-ai-slops/SKILL.md:39-85`, `plugins/omo/skills/remove-ai-slops/SKILL.md:87-104`.

## AST-grep의 정체

AST-grep은 OmO plugin의 MCP server로 등록된다.

```json
"ast_grep": {
  "command": "node",
  "args": ["./components/ast-grep-mcp/dist/cli.js", "mcp"]
}
```

근거: `plugins/omo/.mcp.json:3-8`.

source plugin에서는 MCP runtime이 `../../ast-grep-mcp/dist/cli.js` 형태로 참조되지만, LazyCodex 배포 bundle에서는 `./components/ast-grep-mcp/dist/cli.js`로 rewrite된다. 이 rewrite는 marketplace sync script와 Codex cache installer 양쪽에 있다.

근거: `src/script/sync-lazycodex-marketplace.ts:24-25`, `src/script/sync-lazycodex-marketplace.ts:49-52`, `src/script/sync-lazycodex-marketplace.ts:173-190`, `src/src/cli/install-codex/codex-cache-bundled-mcps.ts:15-18`, `src/src/cli/install-codex/codex-cache.ts:109-137`.

## AST-grep MCP server 실행 경로

AST-grep MCP package는 `src/packages/ast-grep-mcp`다.

- package name: `@oh-my-opencode/ast-grep-mcp`
- bin: `omo-ast-grep -> dist/cli.js`
- dependency: `@oh-my-opencode/ast-grep-core`, `@ast-grep/cli`

근거: `src/packages/ast-grep-mcp/package.json:1-23`.

CLI 진입점은 `mcp` command를 기본으로 보고 stdio MCP server를 실행한다. 근거: `src/packages/ast-grep-mcp/src/cli.ts:6-18`.

서버는 두 tool을 제공한다.

- `search`: AST structural search
- `replace`: AST structural replace, 기본 dry-run

근거: `src/packages/ast-grep-mcp/src/mcp.ts:66-99`.

MCP 요청 흐름은 다음과 같다.

1. Codex가 `tools/call` JSON-RPC 요청을 보낸다.
2. `handleAstGrepMcpRequest`가 `handleToolCall`로 넘긴다.
3. `handleToolCall`이 `executeAstGrepTool(params.name, params.arguments, options)`를 호출한다.
4. `search`는 `parseSearchArgs`, `replace`는 `parseReplaceArgs`를 거친다.
5. 둘 다 `runSg(...)`로 내려간다.

근거: `src/packages/ast-grep-mcp/src/mcp.ts:115-153`.

`runSg`는 MCP package의 runner에서 core runner로 위임한다. 근거: `src/packages/ast-grep-mcp/src/runner.ts:24-29`.

core runner는 실제 `sg` 인자를 만든다.

- 기본: `sg run -p <pattern> --lang <lang>`
- JSON 결과 수집: `--json=compact`
- replace: `-r <rewrite>`
- 실제 파일 수정: `--update-all`
- paths가 없으면 `-- .`

근거: `src/packages/ast-grep-core/src/runner.ts:46-75`.

`replace`는 안전하게 설계되어 있다. 먼저 JSON search pass를 돌리고, `updateAll`이 true이고 match가 있을 때만 두 번째 write pass를 실행한다. dry-run이 기본이므로 MCP tool 호출만으로 바로 파일이 바뀌지는 않는다.

근거: `src/packages/ast-grep-core/src/runner.ts:78-128`, `src/packages/ast-grep-mcp/src/mcp.ts:172-187`.

## AST-grep 안전장치

AST-grep MCP에는 workspace path guard가 있다.

- 기본 path는 `.`
- 빈 path, `-`로 시작하는 path, null byte는 거부
- 절대 경로는 realpath가 workspace 내부여야 한다
- 상대 경로도 존재하면 realpath로 workspace 내부인지 확인한다

근거: `src/packages/ast-grep-mcp/src/workspace-paths.ts:1-89`.

tool enable/disable도 있다. `OMO_AST_GREP_DISABLED_TOOLS` 환경 변수나 server option으로 `search`, `replace`를 비활성화할 수 있다.

근거: `src/packages/ast-grep-mcp/src/mcp.ts:59-63`, `src/packages/ast-grep-mcp/src/mcp.ts:217-226`.

출력도 제한된다.

- compact JSON parser
- 최대 출력 1MB (`DEFAULT_MAX_OUTPUT_BYTES = 1*1024*1024`)
- 최대 match 500개 (`DEFAULT_MAX_MATCHES = 500`)
- truncate reason 기록

근거: `src/packages/ast-grep-core/src/sg-compact-json-output.ts:1-54`, `src/packages/ast-grep-core/src/language-support.ts:1-31` (상수는 각각 `sg-compact-json-output.ts:30-31`). 최초 인용은 `:1-120`·`:1-38`로 실제 파일 길이(54줄·31줄)를 초과했으나 인용 내용은 전부 해당 파일 안에 있다.

## OmO 오케스트레이션과의 연결

### 설치 단계

`lazycodex-ai install`은 `omo install --platform=codex`로 넘어간다. OmO installer는 Codex용 plugin을 cache에 설치하고 Codex config를 갱신한다.

핵심 흐름은 다음과 같다.

1. marketplace를 읽는다.
2. plugin manifest를 읽는다.
3. plugin을 cache에 복사한다.
4. bundled MCP runtime dist를 plugin cache 안으로 복사한다.
5. `.mcp.json`의 상대 경로를 cache-local absolute path로 rewrite한다.
6. plugin agents를 `~/.codex/agents`에 연결한다.
7. hook trust state를 만든다.
8. Codex config에 marketplace, plugin, hook, MCP, multi-agent feature를 반영한다.

근거: `src/src/cli/install-codex/install-codex.ts:49-157`, `src/src/cli/install-codex/codex-cache.ts:23-38`, `src/src/cli/install-codex/codex-cache.ts:109-137`, `src/src/cli/install-codex/link-cached-plugin-agents.ts:32-63`, `src/src/cli/install-codex/codex-hook-trust.ts:19-52`, `src/src/cli/install-codex/codex-config-toml.ts:20-67`.

### hook 단계

OmO hook은 Codex lifecycle에 개입한다.

- `UserPromptSubmit`에서 `ultrawork` 또는 `ulw` 프롬프트를 감지하면 ultrawork directive를 추가 context로 넣는다. 근거: `plugins/omo/components/ultrawork/src/codex-hook.ts:31-37`.
- `UserPromptSubmit`에서 ulw-loop steering directive를 읽어 plan mutation을 적용한다. 근거: `plugins/omo/components/ulw-loop/src/codex-hook.ts:63-80`, `plugins/omo/components/ulw-loop/src/steering.ts:232-258`.
- `PreToolUse`에서 `create_goal` budget guard를 적용한다. 근거: `plugins/omo/components/ulw-loop/src/codex-hook.ts:86-99`.
- `Stop`과 `SubagentStop`에서 남은 continuation state가 있으면 stop을 block하고 다음 작업 지시를 반환한다. 근거: `plugins/omo/components/start-work-continuation/src/codex-hook.ts:6-16`, `plugins/omo/components/start-work-continuation/src/boulder-reader.ts:60-85`.

이 구조는 `remove-ai-slops` 같은 skill이 단순 문서로 끝나지 않게 한다. skill은 절차를 제공하고, hook은 세션 시작/프롬프트/도구/중단 지점에서 그 절차가 유지되도록 context와 guard를 주입한다.

### skill 단계

`remove-ai-slops`는 `plugins/omo/skills/`에 들어 있고, plugin manifest가 이 directory를 Codex에 노출한다. 근거: `plugins/omo/.codex-plugin/plugin.json:21`.

Codex host에서 사용자가 "remove ai slops", "clean AI code", "deslop" 같은 트리거를 말하면 skill description이 매칭되어 본문이 로드될 수 있다. frontmatter description에 이 trigger들이 들어 있다. 근거: `plugins/omo/skills/remove-ai-slops/SKILL.md:2-3`.

Codex 호환 block은 OpenCode식 orchestration 예시를 Codex subagent 표면으로 바꿔 해석하게 한다. 이것이 `remove-ai-slops`와 Codex multi-agent 연결의 핵심이다. 근거: `plugins/omo/skills/remove-ai-slops/SKILL.md:6-22`.

### MCP 단계

AST-grep은 `.mcp.json`으로 Codex에 노출된다. ultrawork directive는 구조 검색과 codemod에는 `ast_grep_search`를 쓰라고 명시한다. v4.10.0 directive 원문: "Structural shapes — call/function/class/import patterns, codemods → `ast_grep_search` with `$VAR` / `$$$` metavars."

근거: `plugins/omo/.mcp.json:3-8`, `plugins/omo/components/ultrawork/directive.md:223`. 최초 인용은 `:185-186`이었으나 v4.10.0에서 directive.md가 대폭 개정(254줄 변경)되며 해당 지침이 223번째 줄로 이동했다.

즉 OmO orchestration에서 AST-grep의 역할은 "정규식보다 구조를 아는 코드 검색/치환 도구"다. `remove-ai-slops`가 직접 AST-grep을 호출하지 않아도, 같은 OmO 실행 환경 안에서 agent는 구조 검색이 필요한 cleanup/refactor 작업에 AST-grep MCP를 사용할 수 있다.

## remove-ai-slops와 AST-grep의 관계

관계를 정확히 구분하면 다음과 같다.

| 항목 | remove-ai-slops | AST-grep |
| --- | --- | --- |
| 형태 | `SKILL.md` 절차 문서 | MCP server + core runner |
| 위치 | `plugins/omo/skills/remove-ai-slops/SKILL.md` | `plugins/omo/.mcp.json`, `src/packages/ast-grep-mcp`, `src/packages/ast-grep-core` |
| 주 역할 | slop 제거 작업의 운영 절차 | AST 기반 검색/치환 도구 |
| 실행 방식 | Codex가 skill 본문을 읽고 agent 행동으로 수행 | Codex MCP tool call -> node server -> `sg run` |
| 검증/안전 | 테스트 선잠금, 품질 게이트, batch failure 처리 | dry-run 기본, workspace path guard, output cap |
| OmO 연결 | plugin skill + Codex compatibility + subagent batching | plugin MCP + ultrawork structural search guidance |
| 직접 결합 | AST-grep 직접 호출 없음 | remove-ai-slops를 알지 못함 |

실무적으로는 `remove-ai-slops`가 "무엇을 고칠지, 어떤 순서로 고칠지, 어디서 멈출지"를 정하고, AST-grep은 "구조적으로 찾고 바꾸는 도구"를 제공한다. 둘은 같은 오케스트레이션 환경에서 만난다.

## LazyCodex 배포 bundle 생성 경로

루트 `plugins/omo`는 손으로만 관리되는 소스가 아니라, `oh-my-openagent` 서브모듈에서 LazyCodex 배포용으로 복사·rewrite되는 bundle이다.

`src/script/sync-lazycodex-marketplace.ts`는 다음을 수행한다.

- `packages/omo-codex/marketplace.json`을 `.agents/plugins/marketplace.json`로 복사
- `packages/omo-codex/plugin`을 `plugins/omo`로 복사
- `packages/ast-grep-mcp/dist`, `git-bash-mcp/dist`, `lsp-tools-mcp/dist`를 `plugins/omo/components/*/dist`로 복사
- `.mcp.json` 경로를 plugin-local 경로로 rewrite
- release version stamp
- bundle validation

근거: `src/script/sync-lazycodex-marketplace.ts:5-30`, `src/script/sync-lazycodex-marketplace.ts:70-103`, `src/script/sync-lazycodex-marketplace.ts:173-200`.

skill 동기화는 `src/packages/omo-codex/plugin/scripts/sync-skills.mjs`가 담당한다. shared skill을 plugin skill directory로 복사하고, OpenCode-only orchestration pattern이 있는 skill에는 Codex compatibility block을 삽입한다.

근거: `src/packages/omo-codex/plugin/scripts/sync-skills.mjs:5-18`, `src/packages/omo-codex/plugin/scripts/sync-skills.mjs:20-52`, `src/packages/omo-codex/plugin/scripts/sync-skills.mjs:61-77`.

`sync-skills.test.mjs`는 `remove-ai-slops`가 expected skill 목록에 있는지 확인한다. 근거: `src/packages/omo-codex/plugin/test/sync-skills.test.mjs:12-22`, `src/packages/omo-codex/plugin/test/sync-skills.test.mjs:93-98`.

## DITTO ACG 코드베이스 구현 분석

ACG는 DITTO 문서에서 `Agentic Change Governance`로 정의되어 있지만, 비교에서 더 중요한 것은 문서가 아니라 코드에 내려간 방식이다. DITTO 코드베이스에서 ACG는 다음 네 층으로 구현되어 있다.

1. Zod 스키마: ACG 산출물을 파싱 가능한 계약으로 고정한다.
2. producer/adapter: reviewer-output, e2eJourney, ICL, CodeQL/SARIF 같은 기존 산출물을 ACG 산출물로 투영한다.
3. runtime gate: PreToolUse와 Stop hook이 ACG ledger를 읽어 편집 또는 완료를 실제로 막는다.
4. CLI/test surface: `ditto impact`, `ditto boundary`, `ditto fitness`, `ditto acg-review`, `ditto change-map`와 `tests/acg/*`가 동작 경로를 검증한다.

즉 DITTO ACG는 "에이전트에게 잘하라고 지시하는 skill"이 아니라, 변경 산출물을 파일로 남기고 그 파일을 hook이 읽어 다음 행동을 허용/차단하는 코드 레벨 거버넌스다.

### ACG envelope와 스키마

공통 envelope는 `src/schemas/acg-common.ts`에 있다. change-time artifact는 `schema_version`, `kind`, `work_item_id`, `produced_by`, `produced_at`을 가진다. repo catalog artifact는 work item 없이 `schema_version`, `kind`, `produced_by`, `produced_at`을 가진다. 근거: `src/schemas/acg-common.ts:16-44`.

핵심 스키마는 `src/schemas/acg-*.ts`에 흩어져 있다.

| ACG 산출물 | 코드 위치 | 코드상 역할 |
| --- | --- | --- |
| `ChangeContract` | `src/schemas/acg-change-contract.ts:33-64` | 목적, 허용/금지 scope, invariant, acceptance, risk를 고정한다. `forbidden_scope`는 최소 1개가 필요하고, medium 이상 risk는 `decision_ref` 없으면 reject한다. |
| `ImpactGraph` | `src/schemas/acg-impact-graph.ts:12-75` | 영향 노드와 정적으로 해소하지 못한 `unresolved`를 기록한다. `ui_surface`/`user_journey`는 path가 아니라 `journey_id`를 요구한다. |
| `SemanticCompatibility` | `src/schemas/acg-semantic-compatibility.ts:18-112` | 타입 안전과 의미 안전을 분리한다. agent가 `semantic_safe=yes`를 선언하려면 재현성 정보와 characterization test ref가 필요하다. |
| `ReviewGraph` | `src/schemas/acg-review-graph.ts:70-81` | reviewer-output에 붙는 `acg_review` 확장 객체다. high-risk/unresolved 항목이 사람이 봐야 할 exception set이 된다. |
| `FitnessFunction` | `src/schemas/acg-fitness-function.ts:14-106` | 코드베이스가 계속 지켜야 할 성질을 deterministic, llm_judged, executed evaluator로 표현한다. |
| `JourneySpec` / `JourneyRun` | `src/schemas/acg-journey-spec.ts:18-46`, `src/schemas/acg-journey-run.ts:21-34` | 사용자 여정 명세와 실행 증거를 ACG 산출물로 둔다. |

이 구조는 LazyCodex의 `remove-ai-slops`와 성격이 다르다. `remove-ai-slops`는 skill 설명이 agent 행동을 유도하지만, ACG 스키마는 잘못된 산출물을 파싱 단계에서 거부한다.

### ChangeContract → PreToolUse 집행

ACG의 변경 계약은 `ICL`에서 컴파일될 수 있다. `src/acg/icl/compile.ts`는 `.icl` source를 `ChangeContract`와 `FitnessFunction[]`으로 만든 뒤 Zod 스키마로 검증한다. `surface`는 `public_surface`로 매핑되고, `cmd/query`는 deterministic evaluator로, `judge`는 재현성 정보를 가진 `llm_judged` evaluator로 내려간다. 근거: `src/acg/icl/compile.ts:1-47`, `src/acg/icl/compile.ts:53-92`, `src/acg/icl/compile.ts:103-179`.

컴파일된 계약은 `ChangeContractStore`가 `.ditto/local/work-items/<wi>/change-contract.json`에 저장한다. 이 저장 파일이 PreToolUse 집행의 진실원이다. 근거: `src/core/change-contract-store.ts:2-36`.

PreToolUse hook은 현재 work item의 `ChangeContract`를 읽고, 편집 대상 파일이 `forbidden_scope`에 걸리면 `exitCode: 2`로 차단한다. 경로 매칭은 `matchForbiddenScope`와 `scopeRefMatches`가 담당한다. 근거: `src/acg/scope/resolve.ts:30-60`, `src/hooks/pre-tool-use.ts:477-514`, `src/hooks/pre-tool-use.ts:719-722`.

이 지점은 OmO `remove-ai-slops`와 가장 큰 차이다. `remove-ai-slops`는 "public API signature 변경 금지" 같은 제약을 프롬프트로 child agent에게 전달한다. DITTO ACG는 금지 scope를 파일로 저장하고 hook이 실제 편집 호출을 막는다.

### ImpactGraph: user-exposed 변경의 default-deny

`ImpactGraph` producer는 `src/acg/impact/impact-graph.ts`에 있다. analyzer는 바인딩별로 주입하고, 이 파일은 거버넌스 불변식을 적용한다. 핵심 불변식은 user-exposed 변경이 `JourneySpec.id`에 매핑되지 않으면 `unresolved: journey_unknown`을 자동 추가하는 것이다. 근거: `src/acg/impact/impact-graph.ts:11-28`, `src/acg/impact/impact-graph.ts:49-76`.

CLI 표면은 `ditto impact`다. 명령은 `CodeqlImpactAnalyzer`를 만들고 `produceImpactGraph`를 호출한 뒤 `.ditto/local/work-items/<wi>/impact-graph.json`에 저장한다. `--user-exposed`와 `--journey-id`가 이 default-deny 경로의 입력이다. 근거: `src/cli/commands/impact.ts:25-29`, `src/cli/commands/impact.ts:55-56`, `src/cli/commands/impact.ts:104-140`.

Stop hook은 `impact-graph.json`의 `unresolved[]`를 읽고 continuation reason으로 바꾼다. 근거: `src/hooks/stop.ts:247-264`, `src/hooks/stop.ts:555-558`.

LazyCodex/OmO의 ultrawork directive도 구조 검색과 검증을 지시하지만, "사용자 노출 변경인데 여정 매핑이 없음"을 파일 산출물로 남겨 완료를 막는 구체 게이트는 ACG 쪽에 있다.

### ArchitectureSpec과 boundary gate

ACG의 architecture 경계는 `ArchitectureSpec`과 boundary checker로 구현된다.

- agent candidate 제안기는 관측 가능한 layer와 public surface만 제안한다. `forbidden_dependencies`와 `can_call` 규칙은 자동 박제하지 않는다. 근거: `src/acg/architecture/propose.ts:8-17`, `src/acg/architecture/propose.ts:37-50`.
- ratify는 agent candidate를 `produced_by=user` 권위 spec으로 승격하되, `forbidden_dependencies`는 사람 입력에서만 채운다. 이미 user spec이면 다시 ratify하지 못하게 한다. 근거: `src/acg/architecture/ratify.ts:5-19`, `src/acg/architecture/ratify.ts:31-43`.
- boundary core는 `forbidden_dependencies`와 `layers.can_call`을 검사한다. 근거: `src/acg/boundary/boundary.ts:75-104`.
- CLI `ditto boundary check`는 CodeQL edge analyzer로 changed file의 dependency edge를 뽑고 `checkBoundary`를 실행한다. 위반이 있으면 high-risk `acg-review.json` ledger로 기록해 기존 Stop gate가 막게 한다. 근거: `src/cli/commands/boundary.ts:23-31`, `src/cli/commands/boundary.ts:131-147`.

OmO AST-grep은 구조 검색/치환 도구다. 반면 DITTO boundary gate는 "이 변경이 architecture 규칙을 위반했는가"라는 판정을 산출물로 만들고 completion gate에 연결한다. AST-grep이 찾기 도구라면, ACG boundary는 거버넌스 판정기다.

### SemanticCompatibility: 타입 안전과 의미 안전 분리

ACG는 signature change를 자동으로 의미 안전으로 보지 않는다. `buildSemanticSeed`는 정적 탐지 결과를 `semantic_safe: unverified` 상태로 seed한다. 기본 compatibility도 conservative하게 `breaking`이다. 근거: `src/acg/semantic/semantic-produce.ts:11-18`, `src/acg/semantic/semantic-produce.ts:40-55`.

agent나 사용자가 의미 판정을 주입할 때는 `applySemanticVerdict`를 거친다. 여러 signature pair가 있으면 target을 지정해야 하고, 모호하면 throw한다. `semantic_safe=yes`는 agent 산출물인 경우 schema 차원에서 model reproducibility와 passing behavior test ref를 요구한다. 근거: `src/acg/semantic/semantic-produce.ts:74-116`, `src/schemas/acg-semantic-compatibility.ts:72-105`.

Stop hook은 `semantic_safe=unverified` 또는 의도된 breaking으로 표시되지 않은 `semantic_safe=no`를 continuation reason으로 바꾼다. 근거: `src/hooks/stop.ts:266-280`, `src/hooks/stop.ts:558`.

이것은 `remove-ai-slops`의 "regression tests first"와 같은 문제를 더 구조화한 형태다. OmO skill은 테스트를 먼저 만들라고 지시하고, ACG는 "의미가 보존됐다는 agent 주장"을 스키마와 Stop gate로 검증한다.

### ReviewGraph: Review by Exception

`src/acg/review/acg-review-adapter.ts`는 기존 `reviewer-output`을 ACG `ReviewGraph`로 투영한다. severity는 risk로 결정론 변환된다. `critical/high`는 `high`, `medium`은 `medium`, 나머지는 `low`다. `unverified[]`는 evidence kind가 아니라 `unresolved=true` flag로 들어간다. `human_review_set`은 high-risk 또는 unresolved 항목에서 파생된다. 근거: `src/acg/review/acg-review-adapter.ts:12-23`, `src/acg/review/acg-review-adapter.ts:23-35`, `src/acg/review/acg-review-adapter.ts:46-87`.

`AcgReviewStore`는 ledger를 `.ditto/local/work-items/<wi>/acg-review.json`에 저장한다. 근거: `src/core/acg-review-store.ts:1-30`.

`ditto acg-review --from <reviewer-output.json>`은 reviewer-output을 읽고 검증한 뒤 이 ledger를 쓴다. 잘못된 입력이면 non-zero exit이고 ledger를 쓰지 않는다. 근거: `src/cli/commands/acg-review.ts:1-27`, `src/cli/commands/acg-review.ts:52-93`.

Stop hook의 `acgReviewForcesContinuation`은 high-risk인데 evidence가 없는 항목을 completion blocker로 본다. 근거: `src/hooks/stop.ts:209-224`, `src/hooks/stop.ts:549`.

OmO의 `remove-ai-slops`도 final report와 critical review checklist를 요구한다. 하지만 ACG는 review 산출물을 ledger로 저장하고 Stop hook이 읽기 때문에, "리뷰가 필요하다"가 아니라 "증거 없는 high-risk면 종료 불가"가 된다.

### FitnessFunction과 AssuranceSnapshot

ACG의 지속성은 `FitnessFunction`과 `AssuranceSnapshot`으로 구현된다. `FitnessFunction`은 `architectural`, `dependency`, `semantic`, `coverage`, `consistency`, `performance`, `duplication`, `complexity`, `user_journey` kind를 가진다. evaluator는 `deterministic`, `llm_judged`, `executed` 중 하나다. `llm_judged`는 reproducibility 없으면 schema가 거부한다. 근거: `src/schemas/acg-fitness-function.ts:14-31`, `src/schemas/acg-fitness-function.ts:72-106`.

runner는 세 가지를 담당한다.

- scheduling: 어떤 함수가 이번 trigger에서 실행되는가
- identity: raw line을 제외한 stable violation id
- delta: 기존 debt와 새 violation을 분리

근거: `src/acg/fitness/fitness-runner.ts:1-18`, `src/acg/fitness/fitness-runner.ts:56-61`, `src/acg/fitness/fitness-runner.ts:79-110`, `src/acg/fitness/fitness-runner.ts:116-128`.

특히 `executed` evaluator가 `risk_tiered` 또는 `sampled`인데 risk를 모르면 실행으로 escalate한다. 즉 비용 때문에 무작정 생략하지 않고, risk input이 없으면 fail-closed에 가깝게 행동한다. 근거: `src/acg/fitness/fitness-runner.ts:93-101`.

`runFitness`는 evaluator provider를 주입받아 실행하고 `acg.assurance-snapshot.v1`을 생성한다. 근거: `src/acg/fitness/fitness-runner.ts:132-166`.

CodeQL provider는 SARIF를 stable violation identity set으로 바꾼다. line number는 key에서 제외해 line move가 새 위반으로 잡히지 않게 한다. 근거: `src/acg/fitness/codeql-provider.ts:1-19`, `src/acg/fitness/codeql-provider.ts:28-33`.

CLI `ditto fitness run`은 fitness function을 읽고 runner를 실행해 `assurance-snapshot.json`을 쓴다. 실패 결과가 있으면 runtime error exit로 끝난다. `ditto fitness drift`는 여러 work item의 snapshot을 모아 SLOP 추세를 집계한다. 근거: `src/cli/commands/fitness.ts:27-57`, `src/cli/commands/fitness.ts:117-128`, `src/cli/commands/fitness.ts:147-200`.

Stop hook은 AssuranceSnapshot에서 `outcome=fail`인 fitness result를 completion blocker로 본다. 근거: `src/hooks/stop.ts:227-242`, `src/hooks/stop.ts:552`.

이 지점이 `remove-ai-slops`와 ACG의 가장 큰 구조 차이다. `remove-ai-slops`는 이미 생긴 slop을 branch diff에서 정리하는 절차다. ACG는 `duplication`·`complexity` 같은 fitness kind를 통해 slop의 누적을 시간축으로 추적하고, 새 violation을 completion gate에 연결한다.

### JourneyRun과 Change Map

ACG는 "코드는 맞지만 제품이 틀린" 문제를 JourneySpec/JourneyRun으로 다룬다. `projectE2EJourneyToJourneyRun`은 기존 DITTO `e2eJourney`를 ACG `JourneyRun`으로 투영한다. `pass`/`fail`은 그대로, `blocked`는 `skipped`로 매핑하고, 현재 e2eJourney에는 retry/flake detection이 없으므로 `flaky`는 생성하지 않는다. 근거: `src/acg/journey/journey-run-adapter.ts:1-18`, `src/acg/journey/journey-run-adapter.ts:42-56`, `src/acg/journey/journey-run-adapter.ts:76-88`.

Change Map은 `ChangeContract`, `ImpactGraph`, `ReviewGraph`를 사람용 텍스트/mermaid로 렌더링한다. 텍스트가 정본이고 mermaid는 파생물이다. 근거: `src/acg/change-map/render.ts:6-10`, `src/acg/change-map/render.ts:82-120`, `src/acg/change-map/render.ts:134-170`, `src/cli/commands/change-map.ts:17-75`.

OmO의 report output은 skill 실행 결과를 사람이 읽는 보고서로 만든다. ACG Change Map은 계약·영향·리뷰 ledger에서 파생되는 구조화된 변경 지도다.

### ACG 테스트 표면

ACG는 별도 테스트군을 가진다.

- schema/conformance: `tests/schemas/acg-schemas.test.ts`, `tests/schemas/acg-conformance.test.ts`
- contract chain: `tests/acg/change-contract-chain.test.ts`
- impact/boundary/architecture: `tests/acg/impact-graph.test.ts`, `tests/acg/boundary.test.ts`, `tests/acg/architecture-*.test.ts`
- semantic: `tests/acg/semantic-produce.test.ts`, `tests/acg/signature-codeql*.test.ts`
- review: `tests/acg/acg-review-*.test.ts`
- fitness: `tests/acg/fitness-*.test.ts`
- stop/pre-tool hooks: `tests/hooks/stop.test.ts`, `tests/hooks/pre-tool-use.test.ts`
- change map/journey: `tests/acg/change-map-mermaid.test.ts`, `tests/acg/journey-run-adapter.test.ts`

근거: `tests/schemas/acg-schemas.test.ts:26-219`, `tests/acg/change-contract-chain.test.ts:12-48`, `tests/hooks/pre-tool-use.test.ts:442-474`, `tests/hooks/stop.test.ts:482-901`.

## LazyCodex/OmO와 DITTO ACG 비교

### 비교 요약

| 축 | LazyCodex / OmO remove-ai-slops + AST-grep | DITTO ACG |
| --- | --- | --- |
| 기본 단위 | skill, hook, MCP, subagent orchestration | work item별 ACG ledger, Zod schema, gate |
| slop 대응 | branch diff를 대상으로 사후 cleanup 절차 실행 | 변경 계약, forbidden scope, semantic, fitness로 사전/완료/지속 게이트 |
| 구조 검색 | AST-grep MCP가 `sg run`으로 구조 검색/치환 | CodeQL/TS analyzer, boundary checker, impact graph, AST-grep류 도구는 provider 후보일 뿐 핵심 계약은 ACG ledger |
| agent 제약 | skill prompt가 child agent에게 제약 전달 | PreToolUse hook이 forbidden scope 편집을 실제 block |
| 완료 제어 | skill이 테스트/lint/typecheck/final report를 요구 | Stop hook이 `acg-review.json`, `impact-graph.json`, `semantic-compatibility.json`, `assurance-snapshot.json`을 읽어 completion block |
| 의미 보존 | regression test first를 절차로 요구 | SemanticCompatibility가 type_safe와 semantic_safe를 분리하고 unverified를 blocker로 둠 |
| 사용자 여정 | ultrawork/e2e 지시로 수행 가능하지만 remove-ai-slops에 직접 결합 아님 | JourneySpec/JourneyRun이 ImpactGraph, ReviewGraph, e2eJourney와 연결됨 |
| 지속성 | skill 실행이 끝나면 주로 결과 보고서와 diff가 남음 | FitnessFunction/AssuranceSnapshot으로 이후 변경까지 성질을 계속 검사 |
| 강제력 | agent compliance 중심 | schema parse + hook exit code 중심 |

### 같은 문제를 보는 방식

둘 다 agent가 만든 코드의 slop과 회귀를 문제로 본다. 하지만 해법의 층이 다르다.

OmO의 `remove-ai-slops`는 "작업 방식"을 잘 설계한다. 먼저 테스트를 잠그고, 낮은 위험 cleanup부터 처리하고, child agent를 batch로 돌리고, quality gate를 실행하라고 지시한다. AST-grep은 그 작업 중 구조 검색/치환이 필요할 때 쓸 수 있는 도구다. 이 방식의 강점은 가볍고 host에 잘 얹힌다는 점이다. 기존 Codex 세션의 skill/hook/MCP 표면을 크게 바꾸지 않고도 agent 행동을 꽤 구체적으로 유도한다.

DITTO ACG는 "변경의 계약과 완료 조건"을 코드베이스 안에 세운다. `ChangeContract`가 무엇을 건드릴 수 없는지 고정하고, PreToolUse가 그 파일 편집을 막고, `ImpactGraph`가 영향 미해소를 남기고, `SemanticCompatibility`가 의미 미검증을 남기고, `ReviewGraph`가 high-risk evidence 부재를 남기고, `FitnessFunction`이 누적 품질을 본다. Stop hook은 이 ledger들을 읽어 작업 종료를 막는다.

따라서 OmO는 **agent orchestration harness**에 가깝고, DITTO ACG는 **change governance runtime**에 가깝다.

### AST-grep과 ACG analyzer의 관계

AST-grep은 "구조를 찾고 바꾸는 실행 도구"다. pattern과 rewrite를 받아 `sg run`으로 내려간다. 도구 자체는 변경 의도, forbidden scope, user journey, semantic compatibility를 알지 못한다.

ACG analyzer들은 "변경이 계약을 위반했는지 판단하기 위한 산출물 생산기"다. `ImpactAnalyzer`, `CodeqlEdgeAnalyzer`, `SemanticCompatibility` producer, SARIF provider는 모두 ACG schema와 Stop gate로 이어진다. 그래서 ACG 입장에서 AST-grep은 provider 또는 helper로 들어올 수는 있지만, ACG를 대체하지 않는다.

실제 차이는 다음 문장으로 요약된다.

- AST-grep: "이 코드 구조가 어디 있는가, 어떻게 바꿀 수 있는가?"
- ACG: "이 변경이 허용된 변경인가, 의미와 영향과 적합성 증거가 닫혔는가?"

### remove-ai-slops와 ACG의 결합 가능성

DITTO가 OmO의 `remove-ai-slops` 패턴을 흡수한다면, 단순 skill 복제가 아니라 ACG ledger와 연결하는 쪽이 맞다.

가능한 매핑은 다음과 같다.

| remove-ai-slops 단계 | DITTO ACG로 내리는 방식 |
| --- | --- |
| scope 산정 | `ChangeContract.allowed_scope` / `forbidden_scope` 생성 또는 확인 |
| regression tests first | `SemanticCompatibility.characterization`과 acceptance evidence로 기록 |
| cleanup category | `FitnessFunction.fitness_kind` 중 `duplication`, `complexity`, `semantic`, `coverage`로 일부 승격 |
| child agent batch cleanup | autopilot node 또는 work item subtask로 실행하되, PreToolUse scope gate 유지 |
| quality gates | Stop hook이 ACG ledger를 읽어 completion block |
| final report | Change Map + CompletionContract evidence로 대체 또는 보강 |

이렇게 하면 OmO의 장점인 실용적인 cleanup 절차는 유지하면서, DITTO의 장점인 "증거 없는 완료 주장 차단"과 "미래 변경까지 이어지는 fitness"를 붙일 수 있다.

### DITTO 기준의 평가

DITTO 관점에서 OmO `remove-ai-slops`는 좋은 운영 skill이지만 governance primitive는 아니다. 이유는 두 가지다.

1. slop category와 quality gate가 markdown 지시로 존재한다. agent가 지시를 어기면 host hook이 자동으로 알 수 없다.
2. cleanup 결과가 미래 변경의 적합성 함수로 승격되지 않는다. 다음 agent가 같은 slop을 다시 만들면 같은 skill을 다시 호출해야 한다.

반대로 ACG는 무겁다. ChangeContract, ImpactGraph, SemanticCompatibility, ReviewGraph, FitnessFunction을 모두 요구하면 작은 수정에는 비용이 크다. 그래서 ACG 방법론도 단계 생략 규칙을 둔다. 단, codebase-critical 변경, public surface 변경, 리팩토링, agent가 대량 수정한 cleanup에는 ACG 쪽이 더 강한 안전 모델이다.

결론적으로 두 접근은 경쟁 관계가 아니다.

- OmO `remove-ai-slops`: cleanup 실행 전술.
- AST-grep: 구조 검색/치환 도구.
- DITTO ACG: 변경 계약, 증거, 완료 차단, 지속 적합성 관리 체계.

DITTO에 흡수할 때는 `remove-ai-slops`를 ACG 위에서 도는 cleanup workflow로 해석하는 것이 가장 자연스럽다.

## 장점

- `remove-ai-slops`는 행동 변경을 막기 위해 regression test를 먼저 요구한다. 코드 정리 skill로서는 올바른 기본값이다.
- cleanup category가 비교적 구체적이다. 단순 주석 제거부터 module split까지 범위를 넓게 보되, risk order와 stop condition을 둔다.
- Codex compatibility block이 들어 있어 OpenCode 기반 원문 skill이 Codex multi-agent 표면에서도 해석 가능하다.
- AST-grep MCP는 dry-run 기본, workspace guard, output cap, disabled tool 환경 변수 등 안전장치가 있다.
- LazyCodex 배포 bundle은 source plugin의 MCP runtime 경로를 plugin-local 경로로 rewrite하고 validation한다. 설치 후 cache path에서도 다시 rewrite한다.
- OmO plugin은 skill, hook, MCP, agent role을 한 bundle로 묶어 "지침만 있는 skill"이 아니라 실제 Codex 세션 lifecycle에 붙는 오케스트레이션을 만든다.

## 약한 점과 리스크

- `remove-ai-slops`는 skill 문서이므로 실제 품질은 agent가 문서를 얼마나 잘 따르는지에 의존한다. 코드 레벨에서 slop category를 자동 판정하는 deterministic engine은 아니다.
- `remove-ai-slops`와 AST-grep 사이에는 직접 호출 경로가 없다. 구조 검색이 필요한 cleanup에서 AST-grep을 쓰는 것은 OmO directive와 agent 판단의 영역이다.
- `remove-ai-slops`는 "oversized modules >250 pure LOC" 같은 강한 규칙을 포함한다. 실제 프로젝트 convention과 다를 수 있으므로 실행 전 사용자에게 split plan을 제시하라는 guard가 붙어 있다.
- AST-grep replace는 dry-run 기본이지만 `dryRun=false`면 실제 파일을 수정한다. workspace guard가 있더라도 rewrite pattern 자체의 의미 안전성은 별도 테스트로 검증해야 한다.
- LazyCodex 루트 `plugins/omo`와 `src/packages/omo-codex/plugin`은 동기화/배포 과정에서 내용이 달라질 수 있다. 분석할 때 source와 배포 bundle 중 무엇을 기준으로 하는지 명시해야 한다.
- Codex hook과 multi-agent 표면은 host 기능에 의존한다. `multi_agent_v1` 또는 `multi_agent_v2` 제공 여부에 따라 compatibility block의 실제 실행 형태가 달라질 수 있다.

## DITTO에서 차용할 점

1. **cleanup skill은 테스트 선잠금을 필수로 둔다.** `remove-ai-slops`처럼 cleanup 전 behavior lock을 요구하면 "정리"가 회귀로 바뀌는 위험을 줄인다.
2. **절차 문서와 실행 도구를 분리한다.** slop 제거 절차는 skill로, 구조 검색/치환은 AST-grep MCP로 분리한 구조는 DITTO에도 맞다.
3. **host별 compatibility block을 생성물로 관리한다.** OpenCode 예시를 Codex surface로 바꾸는 내용을 손으로 흩뿌리지 않고 sync script에서 삽입하는 방식은 drift를 줄인다.
4. **MCP runtime은 배포 bundle 내부로 vendoring하고 경로를 rewrite한다.** 설치 환경에서 source tree 상대 경로를 기대하지 않는 점은 플러그인 배포 안정성에 중요하다.
5. **긴 작업 child agent에는 liveness contract를 둔다.** `WORKING:`과 `BLOCKED:`를 구분하고 wait timeout을 failure로 보지 않는 규칙은 병렬 agent orchestration에 필요하다.
6. **구조 검색은 regex와 별도 도구로 둔다.** AST-grep의 `$VAR`, `$$$` 메타변수 기반 검색은 refactor/cleanup 작업에서 grep보다 안전한 선택지를 제공한다.

## 검증 기록

### 2026-06-15 재검증 (fresh clone + code-level 대조)

이 보고서의 모든 `path:line` 인용을 fresh clone(`/tmp/lazycodex-verify`, 루트 `245fd8f` / v4.10.0)과 DITTO `main` 브랜치 현재 코드에 대조했다. 병렬 read-only 검증 에이전트 4기로 LazyCodex 루트·remove-ai-slops(15개 주장), AST-grep·번들 sync(17개), OmO 오케스트레이션 배선(10개), DITTO ACG(28개)를 각각 확인했다.

판정 요약:

- **동작·구조 주장 중 틀린 것은 없었다.** LazyCodex/OmO 쪽 정정은 라인 이동 2건뿐이다.
  - `plugins/omo/hooks/hooks.json`: `:2-179` → `:2-192` (bootstrap 훅 추가, PostCompact 캐시리셋 3종).
  - `plugins/omo/components/ultrawork/directive.md`: `:185-186` → `:223` (directive 전면 개정으로 이동).
  - 부수 정정: `sg-compact-json-output.ts`(`:1-120`→실제 54줄), `language-support.ts`(`:1-38`→실제 31줄) — 내용은 모두 존재.
- LazyCodex 루트 wrapper `package.json` 버전은 `0.2.2`, OmO Codex plugin 버전은 `4.10.0`다(서로 다른 버전 축). `bin`·`name`·wrapper 분기 로직은 불변.
- DITTO ACG 28개 인용은 전부 CONFIRMED. 라인 미세 드리프트만 있었다(claim 8 `cmd/query`→deterministic 매핑은 `compile.ts:104`, continuation 함수 정의 종료선이 인용 상한보다 몇 줄 앞 — 단 Stop hook 배선 라인 `stop.ts:549/552/555/558`은 정확). ACG 파일 이동·리네임 없음.
- DITTO ACG 테스트 fresh 재실행: `bun test`(보고서 인용 14개 파일) → **330 pass, 0 fail** (2026-06-15, `bun v1.3.14`). 최초 작성 시 수치와 동일.

직접 확인한 핵심 사실(서브에이전트 보고에만 의존하지 않고 main agent가 재실행):

- `git -C /tmp/lazycodex-verify rev-parse HEAD` → `245fd8f45e37fe9b412ae57c1fb7cfbd672328b7`
- 서브모듈: `src`=`65715d1c...`, `src/packages/lsp-tools-mcp`=`d1ff168...` (보고서와 동일)
- wrapper 버전 `0.2.2`, plugin 버전 `4.10.0`, `hooks.json` 193줄, bootstrap 훅 `hooks.json:39-42`, PostCompact 캐시리셋 3종, directive `ast_grep_search` 지침 `directive.md:223`
- `sg-compact-json-output.ts` 54줄, `language-support.ts` 31줄

### 최초 작성 시 검증

최초 보고서 작성 전 다음 읽기 전용 검증을 실행했다.

- `git -C /tmp/lazycodex-investigation.TXhRmD rev-parse HEAD`
  - 결과: `7bbf9d78a532a57aabf23fb213d214b82eeca892`
- `git -C /tmp/lazycodex-investigation.TXhRmD submodule status --recursive`
  - 결과: `src`는 `65715d1c2c35e27ccf2195ef688b0909dddb403c`, `src/packages/lsp-tools-mcp`는 `d1ff1681c1f558e062ac33fad4d835baaa7b5edf`
- Node 기반 manifest 검사
  - `lazycodex-ai` bin이 `bin/lazycodex-ai.js`
  - plugin name이 `omo`
  - skills path가 `./skills/`
  - hooks path가 `./hooks/hooks.json`
  - MCP server 목록에 `ast_grep` 포함
  - `ast_grep` args가 `./components/ast-grep-mcp/dist/cli.js mcp`
  - `remove-ai-slops` skill 존재와 `batches of 5` 문구 확인
- Node 기반 AST-grep 코드 경로 검사
  - MCP tool이 `search`, `replace`
  - `tools/call` 처리 확인
  - `executeAstGrepTool` 호출 확인
  - `parseSearchArgs`, `parseReplaceArgs` 확인
  - core `runSg` 위임 확인
  - marketplace sync와 installer의 ast-grep bundling/rewrite 확인
- `rg -n "ast_grep|AST-grep|ast-grep|\\bsg\\b" plugins/omo/skills/remove-ai-slops/SKILL.md`
  - 결과: 직접 참조 없음
- DITTO ACG 코드베이스 검증
  - 명령: `bun test tests/schemas/acg-schemas.test.ts tests/schemas/acg-conformance.test.ts tests/acg/impact-graph.test.ts tests/acg/boundary.test.ts tests/acg/acg-review-adapter.test.ts tests/acg/acg-review-producer.test.ts tests/acg/fitness-runner.test.ts tests/acg/fitness-codeql-provider.test.ts tests/acg/semantic-produce.test.ts tests/acg/change-contract-chain.test.ts tests/acg/journey-run-adapter.test.ts tests/acg/change-map-mermaid.test.ts tests/hooks/stop.test.ts tests/hooks/pre-tool-use.test.ts`
  - 결과: 14개 파일, 330 pass, 0 fail
  - 검증 범위: ACG 스키마, conformance, ChangeContract→PreToolUse, ImpactGraph default-deny, boundary gate, ReviewGraph adapter/store/Stop gate, FitnessFunction runner/CodeQL provider, SemanticCompatibility, JourneyRun adapter, Change Map renderer, Stop/PreToolUse hook

위 검증은 정적 구조와 연결 경로를 뒷받침한다. 실제 Codex runtime에서 skill trigger와 MCP tool call을 수행하는 end-to-end 검증은 하지 않았다.
