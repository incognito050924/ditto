---
title: "DITTO dual-host surface adapter 근거와 구현 계획"
kind: design-plan
last_updated: 2026-06-14 KST
status: reviewed
review: ".ditto/local/work-items/wi_26061304x/reviews/dialectic-1.json (verdict=revise, required_edits 반영)"
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
  - "2026-06-13: https://developers.openai.com/codex/hooks (apply_patch=tool_input.command; matcher alias apply_patch|Edit|Write, stdin tool_name=apply_patch)"
  - "2026-06-13: https://github.com/openai/codex/blob/main/codex-rs/apply-patch/apply_patch_tool_instructions.md (apply_patch 패치 문법 — *** Add/Update/Delete File, *** Move to, 항상 상대경로)"
  - "2026-06-13: https://developers.openai.com/codex/custom-prompts (custom prompts deprecated → skills)"
companion_report: reports/design/dual-host-codex-fact-verification.md
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
- **위험(저, dialectic-1 G3): AGENTS.md 32 KiB 병합 한도.** Codex는 global+project `AGENTS.md`를 git root부터 합쳐 `project_doc_max_bytes`(기본 32 KiB)에서 자른다. 현재 repo `AGENTS.md`는 14,142 bytes로 단독은 안전하나, 사용자 global·중첩 `AGENTS.md`와 합산되면 DITTO charter가 잘릴 수 있다. M5 setup은 charter 설치 시 이 한도를 doctor에서 안내한다.

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
- `${CLAUDE_PLUGIN_ROOT}` 치환 부담은 당초 가정보다 작다. Codex는 plugin **hook command**에 `PLUGIN_ROOT`와 함께 `CLAUDE_PLUGIN_ROOT`를 레거시 호환 변수로 제공한다(2026-06-13 plugins/build 확인). 따라서 `hooks/hooks.json`의 `"${CLAUDE_PLUGIN_ROOT}/bin/ditto"`는 Codex에서도 그대로 resolve되어 치환이 **불필요**하다.
- **단 이 호환은 hook command에서만 확인됐다.** skill 본문 Bash나 custom agent instruction이 실행될 때 이 env가 주입되는지는 미증명이다(dialectic-1 obj 5). 그쪽의 `${CLAUDE_PLUGIN_ROOT}/bin/ditto`는 안정 PATH command(`ditto …`)로 두거나, env 가용성을 별도 검증한 뒤에만 의존한다.
- 지금 바로 `surfaces/common/skills`로 파일을 이동하는 것은 위험하다. 먼저 host별 build에서 현 `skills/`를 복사하고, 중복 관리 문제가 실제로 커질 때 source tree 이동을 한다.

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

- handler 판단 로직은 대부분 공통으로 유지할 수 있다. Codex의 event별 stdin 필드명(`prompt`, `tool_name`, `tool_input`, `tool_response`, `trigger`, `session_id`, `cwd`)과 stdout 출력 shape(`{"decision":"block",…}` / `hookSpecificOutput.additionalContext` / PreToolUse `permissionDecision`·`updatedInput`)는 Claude Code와 동일하다(2026-06-13 hooks 확인). 따라서 광범위한 per-host `renderHookOutput` 추상화는 현재 증거상 불필요하다(dialectic-1 scope_creep).
- **실제 divergence는 두 가지뿐이다.** (1) `repoRoot` 출처 — Claude는 `CLAUDE_PROJECT_DIR`, Codex는 `cwd`. (2) **파일 변경 도구 의미** — Codex는 편집을 `tool_name="apply_patch"` / `tool_input.command`(패치 문자열)로 보낸다(matcher alias는 `apply_patch|Edit|Write`지만 stdin `tool_name`은 `apply_patch`로 보고). 현재 핸들러는 `Write|Edit|MultiEdit` + `tool_input.file_path`에만 게이트·evidence를 건다(`pre-tool-use.ts:594,605`, `post-tool-use.ts:13,28`). 따라서 Codex 편집은 secret/forbidden_scope 게이트와 edit evidence를 **둘 다 우회한다** — 이게 normalize가 반드시 해결해야 하는 진짜 지점이다(dialectic-1 obj 1, severity high).
- 첫 구현은 `HookInput`에 host와 normalized fields를 추가하되 그 핵심은 **apply_patch → 대상 경로 추출**이다: `tool_input.command`의 `*** Add File:`·`*** Update File:`·`*** Delete File:`·`*** Move to:` 헤더에서 상대경로(들)를 파싱해, 다중 파일 패치의 모든 경로를 Write/Edit과 동일하게 게이트·기록한다. 기존 Claude handler는 raw fallback을 유지한다.

### C6. Codex custom command는 1차 목표가 아니다

판정: 1차 구현에서 제외한다.

공식 근거:

- Codex custom prompts는 deprecated이고, reusable instruction은 skills 사용을 권장한다. 근거: https://developers.openai.com/codex/custom-prompts, deprecation warning PR https://github.com/openai/codex/pull/15076 (skills 페이지에는 이 deprecation 진술이 없다 — 출처 교정, dialectic-1 §1 #5).
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

> **정정 (2026-06-13, OBJ-2).** 위 4줄은 작성 시점 스냅샷이며 코드가 앞서갔다. 현재: `capabilities.hooks`는 검증된 5개 event로 채워졌고(M2), `loadSurfaceInventory()`는 비공식 `.codex/plugins` 스캔을 제거하고 `scanCodexPluginRoot`(공식 plugin-root)만 본다(OBJ-5). 권위 있는 현재 상태는 문서 끝 "## 9. 진행 상태 / 잔여" 참조.

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
| skills | `skills/*/SKILL.md` 공통 후보 | hook command는 `${CLAUDE_PLUGIN_ROOT}` 호환으로 무치환; skill 본문 명령은 PATH command 권장 |
| agents | `agents/*.md` Claude 형식 | Codex `.toml` projection 필요 + read-only는 `sandbox_mode` 매핑 + 프로젝트 `.codex/agents/` 설치 |
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
  - `mutatedPaths` — 파일 변경 도구가 건드리는 대상 경로 목록(정규화 산출). Claude는 `tool_input.file_path` 단일, Codex `apply_patch`는 패치에서 추출한 다중 경로.
- **apply_patch 경로 추출 (이 슬라이스의 핵심, dialectic-1 obj 1).** host=codex이고 `tool_name="apply_patch"`이면, `tool_input.command`의 `*** Add File: <path>`·`*** Update File: <path>`·`*** Delete File: <path>`·`*** Move to: <path>` 헤더에서 상대경로(들)를 파싱해 `mutatedPaths`로 채운다. PreToolUse 게이트(secret/forbidden_scope)와 PostToolUse edit evidence가 이 `mutatedPaths`를 돌게 해서, Claude의 `Write|Edit|MultiEdit` 단일 `file_path` 경로(`pre-tool-use.ts:605`, `post-tool-use.ts:13`)와 동일하게 **모든** 변경 경로를 검사·기록한다. 다중 파일 패치는 한 경로라도 forbidden_scope에 들면 block.
- `renderHookOutput`은 **defer**한다 — Codex/Claude 출력 shape가 동일(F3)하므로 per-host render layer는 지금 만들지 않는다(헌장 4-3). 실제 출력 divergence가 관측될 때 도입.
- 기존 handler는 처음에는 `input.raw` fallback을 유지한다. 다음 단계에서 normalized field 사용으로 좁힌다.
- `repoRoot` 계산은 host별로 분리한다.
  - Claude Code: `CLAUDE_PROJECT_DIR ?? raw.cwd ?? process.cwd()`
  - Codex: `raw.cwd ?? process.cwd()`를 시작점으로 하되, 필요하면 `findRepoRoot`로 Git root를 찾는다.

검증:

- Claude fixture로 기존 tests/hooks 통과.
- Codex fixture로 UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, Stop smoke 추가.
- **apply_patch fixture 필수**: Codex PreToolUse `tool_name="apply_patch"`로 forbidden_scope 경로를 담은 패치가 **block**되는지, PostToolUse가 그 변경을 `evidence/edits.jsonl`에 **기록**하는지 검증한다. 단일·다중 파일 패치, `*** Move to:` 리네임을 모두 포함. 이 fixture가 없으면 §7 첫 증분은 false-green(게이트·evidence 무력화)으로 닫힌다.
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
  - `.codex/agents/*.toml` -> agent **(M4 의존, dialectic-1 obj 4)**: 이 TOML은 M4가 생성한다. 따라서 M3에서는 scanner capability만 추가하고, agent-surface가 실제로 잡히는지의 **검증은 M4 fixture가 생긴 뒤**에 한다(또는 M4를 이 검증 앞으로 당긴다). M3 단독 완료 기준에서 agent-surface 검증은 제외한다.
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
- `tools`는 **advisory comment로 두지 않는다 (dialectic-1 obj 3, severity high).** Codex custom agent에는 Claude식 per-tool allowlist가 없고 `sandbox_mode`/`mcp_servers`만 있다. read-only 역할(reviewer/researcher/verifier/security-reviewer 등 `tools`에 Edit/Write가 없는 agent)은 `sandbox_mode = "read-only"`로 매핑해 "파일 변경 불가"를 실제 강제하고, mutating 역할(implementer/refactorer)은 `workspace-write`로 둔다. comment로 남기면 Codex agent가 파일을 써서 read-only 검증 계약이 깨진다.
  - 단 `sandbox_mode="read-only"`도 **per-tool 충실 매핑은 아니다**: Bash 자체는 여전히 가능하고 runtime override가 agent default를 덮을 수 있다. 따라서 per-tool allowlist fidelity는 `unverified`/unsupported로 명시한다(이 사실을 산출 TOML 주석 또는 문서에 남긴다).
- agent 본문 안의 `${CLAUDE_PLUGIN_ROOT}/bin/ditto`는 안정 PATH command(`ditto …`)로 치환한다 — custom agent instruction 실행 시 이 env가 주입된다는 보장이 없다(dialectic-1 obj 5; C3 참조).
- **설치 위치 (dialectic-1 obj 2).** Codex 공식 문서는 custom agent를 standalone `~/.codex/agents/`·`.codex/agents/`에만 둔다고 명시하고, plugin **번들** agent 경로는 문서화돼 있지 않다. 따라서 생성 TOML은 plugin 안에 넣지 말고 **setup(M5)이 프로젝트 `.codex/agents/`에 설치**한다. plugin-bundled agent 경로가 공식 확인되면 그때 번들로 옮긴다.

검증:

- 샘플 agent projection snapshot test.
- Codex TOML parse test.
- generated TOML이 setup(M5)이 설치하는 프로젝트 `.codex/agents/*.toml` 위치에 놓이는지 확인(plugin 번들 아님 — 위 설치 위치 결정 참조).

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
  - `AGENTS.md` managed resource 설치 또는 source 확인. 설치 시 32 KiB 병합 한도(C2 G3)를 doctor에서 안내한다.
  - `.agents/plugins/marketplace.json` 등록.
  - M4 산출 custom agent TOML을 프로젝트 `.codex/agents/`에 설치(plugin 번들 아님).
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
| `${CLAUDE_PLUGIN_ROOT}` (강등) | hook command는 Codex가 레거시 호환 제공으로 그대로 동작; skill body·agent instruction만 미증명 | hook은 치환 불필요. skill/agent는 안정 PATH command(`ditto …`) 사용 |
| **Codex `apply_patch` 편집이 Claude 게이트를 우회 (high)** | secret/forbidden_scope 차단·edit evidence가 Codex 편집에 무력화 → 첫 증분 false-green | M2에서 `tool_input.command` 경로 추출 + apply_patch fixture (block + evidence 검증) |
| Claude agent `tools`와 Codex custom agent config가 1:1 아님 (high) | read-only agent를 advisory로 두면 Codex가 파일 쓰기 가능 → 검증 계약 붕괴 | read-only=`sandbox_mode:read-only` 강제; per-tool fidelity는 `unverified`/unsupported 명시 |
| Codex plugin-bundled agent 경로 미문서화 (high) | M4가 로드 안 되는 위치에 TOML 생성 → false-green | setup이 프로젝트 `.codex/agents/`에 설치; 번들 경로 확인 후 이동 |
| M3 agent-scan이 M4 생성물 의존 | 순서상 M3 단독 검증 불가 | M3는 scanner capability만, agent-surface 검증은 post-M4 |
| Codex project-local hooks는 trust 필요 | setup 후 즉시 실행된다고 과장할 위험 | doctor에서 trusted config 상태를 별도 안내. 완료 주장에는 실제 hook smoke 필요 |
| install이 사용자 home을 수정함 | 되돌리기와 범위가 중요 | setup은 idempotent, backup, dry-run/check 옵션 우선 |

## 7. 권장 착수 단위

첫 구현 단위는 **M1 + M2 일부**가 적당하다.

구체적으로는 `dist/codex-plugin`을 만들고, UserPromptSubmit/Stop/PreToolUse/PostToolUse/PreCompact 5개 hook을 Codex fixture로 통과시키는 것까지다. **단, 이 5개 fixture 통과만으로는 Codex 파일 변경 집행을 증명하지 못한다** — PreToolUse/PostToolUse가 Claude `Edit/Write`에만 반응하므로 Codex `apply_patch` 편집은 게이트·evidence를 우회한다(dialectic-1 obj 1). 따라서 첫 증분은 **M2의 apply_patch 경로 추출(§M2 구현)과 그 fixture(forbidden_scope block + edit evidence 기록)를 반드시 포함**해야 하며, 그래야 "core는 공통, surface는 host별"이 *안전 게이트를 보존한 채* 증거로 닫힌다. apply_patch 매핑 없이 닫으면 false-green이다.

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

## 9. 진행 상태 / 잔여 (2026-06-14 갱신, 권위 있는 현재 상태)

> §3 현재상태표·§5 milestone 서술보다 이 절이 우선한다. dialectic-1(`wi_260613afv/reviews/dialectic-1.json`)·verify·dogfooding 결과를 추적되는 위치로 승격(#7).

**구현·검증됨**
- M1~M4 Codex surface: `codexHostAdapter`, host-aware `io`(repoRoot), apply_patch 경로 추출(`envelope`), PreToolUse 게이트/PostToolUse evidence, agent→TOML projection(15개).
- **OBJ-1 [critical] 수정** — 배포 `dist/codex-plugin/hooks/hooks.json`의 `ditto hook` 명령에 `--host codex` 부착(build-codex-plugin `injectCodexHost`). 이전엔 미부착으로 apply_patch 안전게이트가 실 Codex에서 미발화(false-green). repo `hooks/hooks.json`(Claude)은 byte-identical. seam 테스트 `tests/host/codex/applypatch-deploy-seam.surface.test.ts`.
- **OBJ-5 [high] 수정** — `loadSurfaceInventory`가 비공식 `.codex/plugins` 스캔 제거, 공식 plugin-root만. 공식 발견 경로는 `.agents/plugins/marketplace.json`(+ `~/.agents/plugins/` + legacy `.claude-plugin/marketplace.json`).
- **OBJ-7 [med] 수정** — agent name 중복 시 build가 fail-loud(silent overwrite 방지).
- **OBJ-9 [med] 수정** — PreCompact `from_context`가 host-aware(claude-code 하드코딩 제거).
- **OBJ-2/3/6 [doc] 해소** — §3 현재상태표 정정(위 정정 박스), 본 절로 동기화.

**M5 setup 수정·검증**
- **M5 source-mode 버그 수정** — source tree 자체에도 `.codex-plugin/plugin.json`이 있어 `ditto setup --host codex`가 `dist/codex-plugin` 대신 repo root 전체를 plugin으로 복사하던 문제를 수정했다. `resolveCodexPluginRoot`는 sibling/build artifact(`dist/codex-plugin`)를 우선하고, source root는 `.codex/agents`가 있는 빌드 산출물일 때만 plugin root로 본다.
- **M5 fail-loud 추가** — Codex plugin artifact에 `.codex/agents/*.toml`이 없으면 `agentsInstalled=0`으로 조용히 통과하지 않고 `codex custom agents not found ...; run build:codex-plugin first`로 실패한다.
- **M5 positional target 수정** — `ditto setup --host codex <target>`가 `<target>`을 무시하고 cwd를 대상으로 삼던 문제를 수정했다. `--dir`와 positional target 모두 지원한다.
- 검증: `tests/cli/setup-command.test.ts`, `tests/core/setup.test.ts`, 실제 임시 repo source-mode 설치. 실제 설치 결과는 project `.codex/agents` 15개, plugin copy 35 files.

**Codex 트랙 (실 바이너리 검증 결과 — 2026-06-14 Codex CLI 0.139.0)**
- **환경** — `codex update` 후 `codex-cli 0.139.0`; `codex doctor`는 17 ok, 1 idle, 0 warn/fail. features는 hooks/multi_agent/plugins enabled.
- **OBJ-10 plugin·skill load 통과** — `codex plugin list --json`에서 `ditto@ditto-local` installed/enabled 확인. `codex debug prompt-input`에서 11개 DITTO skill(`ditto:autopilot`, `ditto:deep-interview`, `ditto:dialectic`, `ditto:dialectic-review`, `ditto:e2e`, `ditto:e2e-author`, `ditto:handoff`, `ditto:knowledge-update`, `ditto:memory-graph`, `ditto:tech-spec`, `ditto:verify`)이 실제 prompt surface에 로드됨.
- **OBJ-10 hook 발화: TUI 통과 / `exec` 불발** — `codex exec` 0.139.0은 user-level·project-local 최소 echo hook(`UserPromptSubmit`, `PreToolUse`)과 plugin-bundled DITTO hook을 모두 발화하지 않았다. 반면 interactive TUI에서는 같은 최소 echo hook이 발화했고, DITTO plugin-bundled PreToolUse가 `apply_patch config/.env` secret 편집을 차단했다. transcript: `~/.codex/sessions/2026/06/14/rollout-2026-06-14T00-07-38-019ec186-34bd-7a93-a69f-a31bc746e9f5.jsonl`; 대상 파일은 생성되지 않음.
- **OBJ-8 custom-agent 로드 통과** — project `.codex/agents/*.toml` 15개 모두 interactive TUI runtime spawn으로 확인했다. 각 agent는 `CUSTOM_AGENT_OK <name>`을 반환했다. transcript: `~/.codex/sessions/2026/06/14/rollout-2026-06-14T01-17-42-019ec1c6-5b37-7ac0-84e3-25ecc6e930b0.jsonl`. 단, project trust와 model config가 실제 config에 있어야 하며, file existence만으로는 통과 증거가 아니다.
- **층위④ skill dogfooding 완료** — Codex 호스트에서 11개 skill을 발화했다. PASS: `dialectic`, `dialectic-review`, `autopilot`, `deep-interview`, `verify`, `tech-spec`, `knowledge-update`, `memory-graph`, `handoff`. PARTIAL: `e2e-author`(digest 결정론성은 PASS, web journey authoring은 web UI 부재로 미수행). N/A: `e2e`(web UI 없음). `memory-graph`는 `code_drift` freshness caveat를 동반한다.
- **OBJ-4 정리** — plugin hook command의 plugin-root env 경로는 TUI hook 실발화로 검증됐다. skill/agent 본문은 실제 plugin cache/project 파일에서 로드되어 `ditto` CLI를 PATH로 실행했으므로, skill text 안의 `${CLAUDE_PLUGIN_ROOT}` 리터럴 확장을 일반 보장으로 주장하지 않는다.
- **남은 분류** — DITTO repo 체크리스트의 미검증 항목은 닫혔다. 단, `codex exec` hook 비발화는 Codex 0.139.0 런타임 모드별 실패로 재현됐으므로 hook 실증 수단은 interactive TUI로 제한한다.

**참고**: 재현 방법은 `reports/design/dual-host-test-methods.md`.
