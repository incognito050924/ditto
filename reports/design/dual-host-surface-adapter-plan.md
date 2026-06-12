---
title: "DITTO dual-host surface adapter 근거와 구현 계획"
kind: design-plan
last_updated: 2026-06-12 KST
status: draft
scope: "Claude Code와 Codex를 모두 지원하기 위한 공통 core, host별 surface adapter, 증거 기반 구현 순서"
inputs:
  - AGENTS.md
  - CLAUDE.md
  - reports/design/ditto-claude-code-harness-design.md
  - reports/design/contracts/host-adapter-contract.md
  - reports/design/global-local-asset-boundary.md
  - src/core/hosts/types.ts
  - src/core/hosts/claude-code.ts
  - src/core/hosts/codex.ts
  - src/hooks/io.ts
  - hooks/hooks.json
  - scripts/build-plugin.mjs
  - scripts/build-bin.mjs
  - resources/managed/AGENTS.md
  - resources/managed/CLAUDE.md
official_sources_verified:
  - "2026-06-12: https://code.claude.com/docs/en/plugins"
  - "2026-06-12: https://code.claude.com/docs/en/plugin-marketplaces"
  - "2026-06-12: https://code.claude.com/docs/en/hooks"
  - "2026-06-12: https://code.claude.com/docs/en/skills"
  - "2026-06-12: https://code.claude.com/docs/en/sub-agents"
  - "2026-06-12: https://code.claude.com/docs/en/memory"
  - "2026-06-12: https://developers.openai.com/codex/plugins/build"
  - "2026-06-12: https://developers.openai.com/codex/hooks"
  - "2026-06-12: https://developers.openai.com/codex/skills"
  - "2026-06-12: https://developers.openai.com/codex/guides/agents-md"
  - "2026-06-12: https://developers.openai.com/codex/subagents"
---

# DITTO dual-host surface adapter 근거와 구현 계획

## 0. 결론

이 저장소는 Claude Code와 Codex를 모두 지원할 수 있다. 단, 한 배포물을 두 런타임에 그대로 끼우는 방식이 아니라 **공통 DITTO core + host별 surface adapter**가 맞다.

현재 저장소도 이미 그 방향으로 절반쯤 와 있다.

- 공통 core는 `src/core`, `src/schemas`, `.ditto` 상태, `src/hooks/*` handler, `bin/ditto` CLI에 있다.
- Claude Code surface는 `.claude-plugin/plugin.json`, `hooks/hooks.json`, `agents/*.md`, `skills/*/SKILL.md`, `resources/managed/CLAUDE.md`, `scripts/build-plugin.mjs`로 이미 배포된다.
- Codex host adapter는 `src/core/hosts/codex.ts`에 존재하지만, 현재는 실행 spawn과 일부 doctor scan만 있고 Codex plugin, hook, skill, custom-agent surface 생성까지 닫혀 있지 않다.

따라서 첫 목표는 대규모 추상화가 아니라 **Codex용 최소 plugin prototype과 hook smoke**다. 그 다음 중복이 실제로 보이는 부분만 공통화한다.

## 1. 판단 기준

이 문서의 주장은 세 근거로 나눈다.

| 근거 | 의미 |
|---|---|
| 공식 근거 | Claude Code 또는 Codex 공식 문서에서 확인한 host surface 사실 |
| 저장소 근거 | 현재 이 repo에 존재하는 파일, 테스트, 설계문서, 빌드 스크립트 |
| 추론 | 공식 근거와 저장소 근거를 연결한 설계 판단. 추론은 추론이라고 표시한다 |

## 2. 주장별 근거

### C1. "공통 core + host별 surface adapter"가 가능한가

판정: 가능. 그리고 이 repo에서는 그 방식이 가장 작다.

공식 근거:

- Claude Code plugin은 skills, agents, hooks, MCP 등을 담는 공유 단위다. Plugin root에는 `.claude-plugin/plugin.json`이 있고, `skills/`, `agents/`, `hooks/`, `bin/` 같은 구성요소는 plugin root에 둔다. 근거: https://code.claude.com/docs/en/plugins
- Codex plugin도 `.codex-plugin/plugin.json`을 entrypoint로 하고, `skills/`, `hooks/`, `.mcp.json`, assets 등을 plugin root에 둔다. 근거: https://developers.openai.com/codex/plugins/build

저장소 근거:

- Claude Code 배포 조립은 `scripts/build-plugin.mjs`가 담당한다. 주석과 구현 모두 `dist/plugin/`에 `.claude-plugin/plugin.json`, `hooks/`, `agents/`, `skills/`, `resources/`, `bin/ditto`를 조립한다.
- 공통 실행 계층은 이미 `HostAdapter`로 분리되어 있다. `src/core/hosts/types.ts`가 `HostAdapter`, `HostCapabilities`, `loadSurfaceInventory`, `spawnRun` 계약을 정의하고, `src/core/hosts/claude-code.ts`, `src/core/hosts/codex.ts`가 각각 구현한다.
- core 상태와 계약은 host 이름과 분리되어 있다. 예: `src/schemas/work-item.ts`, `src/schemas/completion-contract.ts`, `src/core/work-item-store.ts`, `src/core/evidence-store.ts`.

추론:

- Claude Code와 Codex 모두 plugin, skills, hooks라는 공통 개념을 갖지만 manifest 위치, agent 파일 형식, config 위치, instruction 파일 이름은 다르다.
- 따라서 DITTO의 work item, evidence, completion, memory, hook handler 판단은 공통으로 두고, plugin manifest와 설치/탐색/출력 envelope만 host별로 둬야 한다.

### C2. AGENTS.md는 정본, CLAUDE.md는 projection으로 두는가

판정: 맞다. 현재 코드도 이 방향이다.

공식 근거:

- Codex는 `AGENTS.md`를 작업 전에 읽고, global/project instruction chain을 구성한다. 근거: https://developers.openai.com/codex/guides/agents-md
- Claude Code는 `CLAUDE.md`를 세션 시작 시 읽는 persistent project instruction으로 사용한다. 근거: https://code.claude.com/docs/en/memory

저장소 근거:

- `scripts/build-bin.mjs`의 `syncManagedResources()`는 repo root `AGENTS.md`를 `resources/managed/AGENTS.md`와 `resources/managed/CLAUDE.md`로 복사한다.
- `src/core/bridge-sync.ts`는 `AGENTS.md`를 읽어 `CLAUDE.md`의 ditto managed block에 projection한다.
- `tests/bridge/sync.test.ts`는 `bridge sync --host claude-code`는 허용하고 `--host codex`는 거부한다. 즉 현재 bridge sync의 대상은 Claude projection뿐이다.
- `src/core/hosts/codex.ts`의 `loadInstructions()`는 `AGENTS.md`를 source로 읽고, `src/core/hosts/claude-code.ts`는 `CLAUDE.md`를 `AGENTS.md` projection으로 읽는다.

추론:

- Codex는 `AGENTS.md`를 직접 읽으므로 별도 projection이 필요 없다.
- Claude Code는 `CLAUDE.md`를 읽으므로 DITTO charter는 `AGENTS.md`를 정본으로 두고 `CLAUDE.md`에는 managed block으로 투영하는 구조가 맞다.

### C3. skills는 공통 원천으로 둘 수 있는가

판정: 대부분 가능하지만, command 호출 문구는 host별 치환이 필요하다.

공식 근거:

- Claude Code skills는 `SKILL.md` 기반이며 Agent Skills open standard를 따른다. Claude Code는 추가 기능으로 invocation control, subagent execution, dynamic context injection을 제공한다. 근거: https://code.claude.com/docs/en/skills
- Codex skills도 `SKILL.md` 기반이고, `name`과 `description` metadata가 필요하며 progressive disclosure로 로드된다. 근거: https://developers.openai.com/codex/skills

저장소 근거:

- 현재 skills는 `skills/*/SKILL.md`에 있다.
- 다수 skill과 agent 지침이 `"${CLAUDE_PLUGIN_ROOT}/bin/ditto"`를 직접 사용한다. `rg CLAUDE_PLUGIN_ROOT skills agents hooks` 결과에서 `skills/autopilot`, `skills/deep-interview`, `skills/e2e`, `skills/tech-spec`, `agents/reviewer`, `agents/verifier` 등 여러 파일이 확인된다.

추론:

- `SKILL.md` 내용 자체는 상당 부분 공통 원천으로 유지할 수 있다.
- 그러나 `${CLAUDE_PLUGIN_ROOT}`는 Claude Code plugin envelope 변수라 Codex용 산출물에서는 `${PLUGIN_ROOT}` 또는 Codex가 제공하는 plugin-root 변수로 치환해야 한다. 이 치환은 host별 build 단계에서 하는 편이 안전하다.
- 지금 바로 `surfaces/common/skills`로 파일을 이동하는 것은 위험하다. 먼저 host별 build에서 현 `skills/`를 복사/치환하고, 중복 관리 문제가 실제로 커질 때 source tree 이동을 한다.

### C4. agents는 같은 내용을 쓰되 파일 형식 projection이 필요하다

판정: 필요하다.

공식 근거:

- Claude Code custom subagent는 Markdown 파일과 YAML frontmatter 기반이다. 근거: https://code.claude.com/docs/en/sub-agents
- Codex custom agent는 `~/.codex/agents/` 또는 `.codex/agents/` 아래 TOML 파일이고, `name`, `description`, `developer_instructions`가 필수다. 근거: https://developers.openai.com/codex/subagents

저장소 근거:

- 현재 agent 정의는 `agents/*.md`이며 YAML frontmatter에 `name`, `description`, `tools`가 있고 본문이 역할 지침이다. 예: `agents/reviewer.md`, `agents/planner.md`.
- `src/core/hosts/claude-code.ts`의 plugin-root scanner는 `agents/*.md`를 Claude Code agent surface로 읽는다.
- `src/core/hosts/codex.ts`는 아직 `.codex/agents/*.toml`을 surface로 읽지 않는다.

추론:

- `agents/*.md`를 그대로 Codex에 넣을 수 없다. Codex용 산출물은 frontmatter의 `name`/`description`과 본문을 읽어 `.codex/agents/<name>.toml`의 `developer_instructions`로 projection해야 한다.
- `tools` 필드는 1:1 대응을 주장하면 안 된다. Codex custom agent 파일은 config layer 성격이므로 sandbox/model/skills 등 지원 키만 매핑하고, 도구 제한은 가능한 것만 projection해야 한다.

### C5. hooks는 handler는 공통화 가능하지만 envelope는 분리해야 한다

판정: 공통 handler + host별 normalize/render가 필요하다.

공식 근거:

- Claude Code hook은 lifecycle event에서 JSON context를 stdin으로 넘긴다. UserPromptSubmit은 `prompt`를 포함하고, command hook은 stdin을 받는다. 근거: https://code.claude.com/docs/en/hooks
- Codex hook은 `hooks.json` 또는 `config.toml`에서 발견되고, plugin도 `hooks/hooks.json`을 bundle할 수 있다. Codex는 `PreToolUse`, `PostToolUse`, `PreCompact`, `UserPromptSubmit`, `Stop` 등을 지원한다. 근거: https://developers.openai.com/codex/hooks

저장소 근거:

- 현재 `src/cli/commands/hook.ts`는 `ditto hook <event>`로 공통 handler를 dispatch한다.
- `src/hooks/io.ts`는 `repoRoot`를 `process.env.CLAUDE_PROJECT_DIR ?? process.cwd()`로 잡는다. 즉 현재 I/O envelope는 Claude Code에 묶여 있다.
- `src/hooks/runtime.ts`의 `HookInput` 주석도 Claude Code stdin JSON을 전제한다.
- `hooks/hooks.json`은 command를 `"${CLAUDE_PLUGIN_ROOT}/bin/ditto" hook <event>`로 등록한다.
- handler 본문들은 `raw.session_id`, `raw.prompt`, `raw.tool_name`, `raw.tool_input`, `raw.tool_response`, `raw.trigger` 같은 공통적 필드를 읽는다. 예: `src/hooks/user-prompt-submit.ts`, `src/hooks/post-tool-use.ts`, `src/hooks/pre-compact.ts`.

추론:

- handler 판단 로직은 대부분 공통으로 유지할 수 있다.
- 다만 input source, repo root 계산, plugin root env, hook output JSON shape는 host adapter에서 normalize/render해야 한다.
- 첫 구현은 `HookInput`에 host와 normalized fields를 추가하고, 기존 handler는 raw fallback을 유지하는 호환 방식이 안전하다.

### C6. Codex custom command는 1차 목표가 아니다

판정: 1차 구현에서 제외한다.

공식 근거:

- Codex custom prompts는 deprecated이고, reusable instruction은 skills 사용을 권장한다. 근거: Codex manual 및 https://developers.openai.com/codex/skills
- Claude Code는 custom commands가 skills로 병합됐고 기존 `.claude/commands/*.md`도 계속 작동한다. 근거: https://code.claude.com/docs/en/skills

저장소 근거:

- 현재 repo에는 `commands/`가 optional로 취급된다. `scripts/build-plugin.mjs`도 `commands`는 `OPTIONAL_DIRS`다.
- `.ditto/local/surfaces.json`에는 command surface가 없다.

추론:

- Codex는 skills/CLI 중심으로 두고, Claude slash/custom command는 Claude surface로 남기는 게 가장 작다.
- Codex command surface를 만들려면 별도 prompting semantics와 reload/installation UX가 섞이므로 hook smoke 이후로 미룬다.

### C7. build/install은 host별 산출물로 분리해야 한다

판정: 필요하다.

공식 근거:

- Claude Code plugin manifest는 `.claude-plugin/plugin.json`이다. Marketplace는 `.claude-plugin/marketplace.json`을 사용한다. 근거: https://code.claude.com/docs/en/plugins, https://code.claude.com/docs/en/plugin-marketplaces
- Codex plugin manifest는 `.codex-plugin/plugin.json`이고, repo/personal marketplace는 `.agents/plugins/marketplace.json`을 사용한다. 근거: https://developers.openai.com/codex/plugins/build

저장소 근거:

- 현재 `scripts/build-plugin.mjs`는 Claude Code plugin만 조립한다.
- `package.json`의 `build:plugin`도 Claude Code 산출물만 가리킨다.
- `scripts/install-plugin.mjs`는 `.claude-plugin/plugin.json`, `.claude/settings.json`, `Bash(ditto:*)` allowlist를 전제한다.

추론:

- `scripts/build-plugin.mjs`를 host-neutral로 바로 일반화하면 오히려 위험하다.
- `scripts/build-claude-plugin.mjs`와 `scripts/build-codex-plugin.mjs`를 분리하고, 기존 `build:plugin`은 한동안 Claude alias로 남겨야 한다.
- 설치도 `setup --host claude-code|codex|both`로 나누되, `.ditto` state scaffold는 공통이고 surface 설치만 다르게 해야 한다.

### C8. doctor/surface inventory는 Codex surface까지 확장해야 한다

판정: 필요하다.

공식 근거:

- Codex는 skills를 `.agents/skills`, plugins를 marketplace, hooks를 `.codex/hooks.json` 또는 plugin-bundled hooks에서 읽는다. 근거: https://developers.openai.com/codex/skills, https://developers.openai.com/codex/hooks, https://developers.openai.com/codex/plugins/build

저장소 근거:

- `src/core/hosts/codex.ts`의 현재 `capabilities.hooks`는 `[]`다.
- 같은 파일의 `loadSurfaceInventory()`는 현재 `.codex/plugins`만 local/user plugin surface로 본다.
- `.ditto/local/surfaces.json`은 전부 `host: "claude-code"`이다.
- `tests/core/surface-inventory.plugin.test.ts`도 현재 Claude Code plugin surface 32개를 기준으로 검증한다.

추론:

- Codex plugin/hook/skill/agent surface를 생성해도 doctor가 보지 못하면 drift를 잡을 수 없다.
- Codex build prototype 다음 단계에서 `src/core/hosts/codex.ts`의 capability와 surface scanner를 확장하고, surface catalog generator를 다시 돌려야 한다.

### C9. 큰 "모든 runtime 추상화"는 지금 만들지 않는다

판정: 만들지 않는다.

저장소 근거:

- 이미 `HostAdapter`가 존재하고, 구현체는 두 개뿐이다.
- 기존 설계문서 `reports/design/contracts/host-adapter-contract.md`도 "모든 provider가 spawn 가능한 척하지 않는다"와 optional `spawnRun`을 명시한다.
- 현재 gap은 추상화 부재가 아니라 Codex용 산출물과 envelope 미구현이다.

추론:

- 지금 필요한 것은 `RuntimeFramework`가 아니라 `claude-code`와 `codex` 두 adapter의 구체 구현이다.
- 공통화는 두 concrete build target과 hook envelope를 만든 뒤 중복이 확실할 때 한다.

## 3. 현재 repo 상태 요약

| 영역 | 현재 상태 | gap |
|---|---|---|
| 공통 core | `src/core`, `src/schemas`, `.ditto` 상태, `src/hooks/*` handler 존재 | 없음. dual-host 계획의 anchor |
| Claude plugin build | `scripts/build-plugin.mjs`가 `dist/plugin` 생성 | 이름이 generic이라 나중에 `build-claude-plugin.mjs`로 alias 정리 필요 |
| Codex adapter | `src/core/hosts/codex.ts` 존재, spawn/profile test 존재 | plugin build, hook capability, surface scan 부족 |
| instruction bridge | `AGENTS.md` source, `CLAUDE.md` projection 구현 | Codex는 sync 거부가 맞지만 setup host 옵션에는 AGENTS install 경로를 반영해야 함 |
| hooks | handler는 공통, registration은 Claude env 변수 | `HookInput` normalize/render, Codex hooks manifest 필요 |
| skills | `skills/*/SKILL.md` 공통 후보 | `${CLAUDE_PLUGIN_ROOT}` 치환 필요 |
| agents | `agents/*.md` Claude 형식 | Codex `.toml` projection 필요 |
| doctor/surface | Claude plugin root scan 구현 | Codex `.codex-plugin`, `.agents/plugins`, `.codex/agents`, plugin-bundled hooks scan 필요 |
| install | Claude settings allowlist와 PATH placement 중심 | `setup --host codex|both`와 Codex marketplace/config 설치 필요 |

## 4. 목표 구조

초기 목표는 source tree 대이동이 아니라 산출물 분리다.

```text
repo root
  src/core/                 # 공통 DITTO engine
  src/hooks/                # 공통 hook 판단 로직
  skills/                   # 당분간 공통 원천, host별 build에서 치환
  agents/                   # 당분간 Claude 원천, Codex TOML로 projection
  hooks/hooks.json          # Claude hook manifest 원천 또는 Claude target
  .claude-plugin/           # Claude manifest/marketplace
  .codex-plugin/            # Codex manifest source, 새로 추가
  scripts/
    build-claude-plugin.mjs # 기존 build-plugin 분리
    build-codex-plugin.mjs  # 새 target
  dist/
    claude-plugin/
    codex-plugin/
```

장기적으로 중복이 커지면 그때 `surfaces/common/*`를 도입한다. 처음부터 도입하지 않는 이유는 현재 skill/agent 내부에 Claude-specific command 문자열이 많아 이동과 추상화가 한 번에 섞이기 때문이다.

## 5. 구현 계획

### M0. 문서와 acceptance freeze

목표:

- 이 문서를 기준으로 dual-host의 claim, gap, 구현 순서를 고정한다.

변경 대상:

- `reports/design/dual-host-surface-adapter-plan.md`

검증:

- 문서가 공식 source와 repo file evidence를 분리해 적고 있는지 확인한다.
- `git diff --check`로 문서 whitespace 문제를 확인한다.

완료 기준:

- 각 주요 주장에 공식 근거 또는 저장소 근거가 붙어 있다.
- 구현 milestone마다 변경 대상과 검증 방법이 있다.

### M1. Codex plugin prototype build

목표:

- Codex가 load할 수 있는 최소 plugin 산출물 `dist/codex-plugin`을 만든다.
- 아직 source tree 이동은 하지 않는다.

변경 대상:

- `.codex-plugin/plugin.json`
- `scripts/build-codex-plugin.mjs`
- `package.json` scripts: `build:codex-plugin`, `build:claude-plugin`, `build:plugin` alias 유지
- 필요 시 `scripts/build-claude-plugin.mjs`를 만들고 기존 `scripts/build-plugin.mjs`는 compatibility wrapper로 둔다.

구현:

- `buildBinInto()`는 기존 `scripts/build-bin.mjs`를 재사용한다.
- `skills/`, `hooks/`, `resources/`를 `dist/codex-plugin/`으로 복사한다.
- `.codex-plugin/plugin.json`에는 최소 `name`, `version`, `description`, `skills`, `hooks`를 둔다.
- `hooks/hooks.json`은 Codex target에서 plugin-root env에 맞게 command를 치환한다.
- Codex marketplace는 repo 테스트용으로 `dist/codex-plugin/.agents/plugins/marketplace.json` 또는 별도 fixture에 생성한다. 실제 설치 위치는 M5에서 닫는다.

검증:

- `bun run build:codex-plugin`
- `test -f dist/codex-plugin/.codex-plugin/plugin.json`
- `test -f dist/codex-plugin/bin/ditto`
- `test -f dist/codex-plugin/hooks/hooks.json`
- JSON parse test 추가

완료 기준:

- Codex plugin 산출물이 self-contained로 생성된다.
- Claude build 결과와 서로 덮어쓰지 않는다.

### M2. Hook envelope normalize/render

목표:

- `src/hooks/*` handler는 공통으로 유지하고, Claude/Codex stdin/env/output 차이를 adapter에서 처리한다.

변경 대상:

- `src/hooks/runtime.ts`
- `src/hooks/io.ts`
- 새 파일 후보: `src/hooks/envelope.ts`
- `src/cli/commands/hook.ts`
- `tests/hooks/runtime.test.ts`, 각 hook test에 Codex fixture 추가

구현:

- `ditto hook <event>`에 optional `--host claude-code|codex`를 추가한다. default는 현재 호환을 위해 `claude-code`.
- `normalizeHookInput(host, raw, env, cwd)`를 만든다.
- normalized fields:
  - `sessionId`
  - `prompt`
  - `toolName`
  - `toolInput`
  - `toolResponse`
  - `compactTrigger`
  - `repoRoot`
- `renderHookOutput(host, event, HookOutput)`를 만든다.
- 기존 handler는 처음에는 `input.raw` fallback을 유지한다. 다음 단계에서 normalized field 사용으로 좁힌다.
- `repoRoot` 계산은 host별로 분리한다.
  - Claude Code: `CLAUDE_PROJECT_DIR ?? raw.cwd ?? process.cwd()`
  - Codex: `raw.cwd ?? process.cwd()`를 시작점으로 하되, 필요하면 `findRepoRoot`로 Git root를 찾는다.

검증:

- Claude fixture로 기존 tests/hooks 통과.
- Codex fixture로 UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, Stop smoke 추가.
- malformed stdin은 fail-open, malformed gate artifact는 fail-closed라는 기존 경계 유지.

완료 기준:

- 같은 handler가 두 host fixture에서 동작한다.
- Claude 기존 hook tests가 regress 하지 않는다.

### M3. Codex surface inventory and doctor

목표:

- Codex surface가 생성되면 doctor가 drift를 잡는다.

변경 대상:

- `src/core/hosts/codex.ts`
- `src/core/hosts/types.ts` 필요 시 `SurfaceKind` 확장 없음 확인
- `scripts/gen-surfaces.ts`
- `.ditto/local/surfaces.json`
- `tests/doctor/surface.test.ts`
- `tests/core/surface-inventory.plugin.test.ts`

구현:

- `codexHostAdapter.capabilities.hooks`를 실제 지원 event로 채운다. 최소 M2에서 검증한 5개 event만 선언한다.
- Codex surface scan:
  - `.codex-plugin/plugin.json` -> plugin
  - `skills/*/SKILL.md` 또는 `.agents/skills/*/SKILL.md` -> skill
  - `.codex/agents/*.toml` -> agent
  - `hooks/hooks.json` -> hook
  - `.agents/plugins/marketplace.json` -> plugin marketplace entry는 별도 kind를 늘리지 않고 plugin evidence로만 시작한다.
- generator output에 `host: "codex"` surface가 포함되도록 한다.

검증:

- `bun run surfaces:gen`
- `bun test tests/doctor/surface.test.ts tests/core/surface-inventory.plugin.test.ts tests/core/capability-inventory.test.ts`

완료 기준:

- Codex plugin surface 누락/추가/rename이 doctor에서 잡힌다.
- Claude surface catalog도 계속 통과한다.

### M4. Agent projection

목표:

- `agents/*.md`를 Codex custom agent TOML로 projection한다.

변경 대상:

- 새 generator 후보: `src/core/agent-projection.ts`
- `scripts/build-codex-plugin.mjs`
- `tests/core/agent-variants.test.ts` 또는 신규 `tests/core/agent-projection.test.ts`

구현:

- Markdown frontmatter를 파싱한다.
- `name`, `description`은 그대로 TOML 필드로 둔다.
- Markdown body는 `developer_instructions = """..."""`로 넣는다.
- `tools`는 바로 강제하지 않는다. 매핑 가능한 경우만 advisory metadata 또는 comment로 남기고, sandbox/tool restriction 강제는 후속으로 둔다.
- 본문 안의 `${CLAUDE_PLUGIN_ROOT}`는 host-neutral command placeholder로 치환한다.

검증:

- 샘플 agent projection snapshot test.
- Codex TOML parse test.
- generated `dist/codex-plugin/.codex/agents/*.toml` 또는 plugin-supported 위치 확인.

완료 기준:

- reviewer/planner/verifier 같은 핵심 agent가 Codex custom agent 형식으로 생성된다.
- 생성 TOML이 Codex 필수 필드를 모두 가진다.

### M5. Setup/install host option

목표:

- `.ditto` state는 공통으로 초기화하고, host surface만 분리 설치한다.

변경 대상:

- `src/cli/commands/setup.ts`
- `src/core/setup.ts`
- `scripts/install-plugin.mjs`
- `docs/install.md`, `docs/install.ko.md`
- tests: `tests/core/setup.test.ts`, 신규 Codex setup fixture

구현:

- `ditto setup --host claude-code|codex|both` 추가.
- `claude-code`:
  - 기존 behavior 유지: `CLAUDE.md` projection, `.claude/settings.json` allowlist.
- `codex`:
  - `AGENTS.md` managed resource 설치 또는 source 확인.
  - `.agents/plugins/marketplace.json` 등록.
  - `.codex/config.toml`은 필요한 최소 hook/plugin 설정만 쓴다. 프로젝트 trust가 필요한 항목은 doctor에서 안내한다.
- `both`:
  - `.ditto` scaffold는 한 번만.
  - instruction은 `AGENTS.md` source와 `CLAUDE.md` projection을 모두 맞춘다.

검증:

- temp home/temp project setup tests.
- idempotency: 두 번 실행해도 managed block 중복 없음.
- corrupted marker refusal 유지.

완료 기준:

- `setup --host both`가 두 host surface를 설치하되 `.ditto` 상태를 중복 생성하지 않는다.

### M6. End-to-end smoke

목표:

- "양쪽 지원 가능"을 주장할 수 있는 최소 smoke evidence를 만든다.

검증:

- Claude Code:
  - `bun run build:claude-plugin`
  - 기존 hook/unit/surface tests
- Codex:
  - `bun run build:codex-plugin`
  - Codex hook fixture tests
  - Codex surface inventory tests
  - 가능할 때만 로컬 CLI smoke: `codex plugin marketplace list` 또는 `codex --help` 계열은 환경 의존이므로 skip 가능 test로 둔다.

완료 기준:

- 두 산출물 모두 생성된다.
- 두 host의 hook fixture가 같은 core handler를 통과한다.
- doctor가 두 host surface를 모두 inventory한다.

## 6. 위험과 보류 항목

| 위험 | 영향 | 대응 |
|---|---|---|
| Codex plugin/hook surface가 바뀔 수 있음 | build output이 stale해질 수 있음 | 공식 문서 기준으로 구현하고, doc source verified date를 남긴다 |
| `${CLAUDE_PLUGIN_ROOT}`가 skill/agent에 넓게 박혀 있음 | Codex 산출물이 그대로는 깨짐 | M1/M4에서 build-time 치환. source 이동은 후순위 |
| Claude agent `tools`와 Codex custom agent config가 1:1 아님 | tool restriction을 과장할 위험 | 지원 가능한 필드만 projection하고, 미지원은 `unverified` 또는 문서 gap으로 남김 |
| Hook output shape가 미세하게 다를 수 있음 | context injection/blocking이 host별로 다르게 동작 | `renderHookOutput(host, event, result)`와 fixture tests로 분리 |
| Codex project-local hooks는 trust 필요 | setup 후 즉시 실행된다고 과장할 위험 | doctor에서 trusted config 상태를 별도 안내. 완료 주장에는 실제 hook smoke 필요 |
| install이 사용자 home을 수정함 | 되돌리기와 범위가 중요 | setup은 idempotent, backup, dry-run/check 옵션 우선 |

## 7. 권장 착수 단위

첫 구현 단위는 **M1 + M2 일부**가 적당하다.

구체적으로는 `dist/codex-plugin`을 만들고, UserPromptSubmit/Stop/PreToolUse/PostToolUse/PreCompact 5개 hook을 Codex fixture로 통과시키는 것까지다. 이 단위가 통과하면 "core는 공통, surface는 host별"이라는 구조적 가능성이 증거로 닫힌다.

반대로 처음부터 하지 말 것:

- `skills/`와 `agents/`를 바로 `surfaces/common/`으로 이동
- 모든 host를 위한 generic runtime framework 도입
- Codex custom command surface 선도입
- Claude installer를 Codex까지 억지로 parameterize

## 8. 완료 주장 기준

다음 evidence 없이는 "Claude Code/Codex 둘 다 지원한다"고 말하지 않는다.

- `dist/claude-plugin`과 `dist/codex-plugin` 둘 다 생성됨.
- 두 plugin manifest가 각 host 공식 구조에 맞음.
- 두 host 모두 최소 hook fixture가 통과함.
- `ditto doctor surface --host claude-code`와 `--host codex`가 각 surface를 scan함.
- setup/install 문서가 host별로 분리되어 있음.
- Codex에서 미검증인 부분은 `unverified`로 남아 있음.
