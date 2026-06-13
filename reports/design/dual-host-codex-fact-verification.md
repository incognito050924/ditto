---
title: "Codex 공식 사실 재검증 — dual-host plan 근거 보고서"
kind: research-verification
last_updated: 2026-06-13 KST
status: verified
scope: "dual-host-surface-adapter-plan.md가 인용한 Codex 공식 사실 5개 + 추가 발견 사실의 독립 재검증"
companion_to: reports/design/dual-host-surface-adapter-plan.md
work_item: wi_26061304x
official_sources_verified:
  - "2026-06-13: https://developers.openai.com/codex/plugins/build"
  - "2026-06-13: https://developers.openai.com/codex/hooks"
  - "2026-06-13: https://developers.openai.com/codex/subagents"
  - "2026-06-13: https://developers.openai.com/codex/skills"
  - "2026-06-13: https://developers.openai.com/codex/guides/agents-md"
  - "2026-06-13: https://developers.openai.com/codex/custom-prompts"
  - "2026-06-13: https://github.com/openai/codex/pull/15076 (custom-prompts deprecation warning)"
  - "2026-06-13: https://github.com/openai/codex/issues/15972 (codex-cli 0.117.0 surface 변동)"
repo_evidence_checked:
  - "src/core/hosts/codex.ts:50 (capabilities.hooks = [])"
  - "src/hooks/io.ts:20 (repoRoot = CLAUDE_PROJECT_DIR ?? process.cwd())"
  - "tests/bridge/sync.test.ts:38-39 (codex 거부 exitCode 65)"
  - ".ditto/local/surfaces.json (32/32 host=claude-code)"
  - "tests/core/surface-inventory.plugin.test.ts:18 (toBe(32))"
  - "AGENTS.md = 14142 bytes"
---

# Codex 공식 사실 재검증 — dual-host plan 근거 보고서

## 0. 목적과 범위

`reports/design/dual-host-surface-adapter-plan.md`(이하 plan)가 근거로 든 Codex 공식 사실을 독립적으로 재검증한 기록이다. plan frontmatter는 2026-06-12 검증을 주장하지만, 본 보고서는 2026-06-13에 동일 URL을 다시 fetch하여 (a) plan의 5개 사실이 맞는지, (b) plan이 누락했거나 위험 평가가 어긋난 사실이 있는지를 분리해 기록한다.

판정 표기: ✅ 공식 문서 문구로 직접 확인 / ⚠ plan이 인용한 페이지가 아닌 다른 출처에서 확인 / ❗ plan의 평가를 바꾸는 발견.

## 1. plan 5개 사실 재검증

| # | plan 주장 | 판정 | 공식 문구 / 출처 |
|---|---|---|---|
| 1 | plugin manifest = `.codex-plugin/plugin.json`; plugin root에 `skills/`,`hooks/`,`.mcp.json`,`assets/` | ✅ | "Every plugin has a manifest at `.codex-plugin/plugin.json`. ... Keep `skills/`, `hooks/`, `assets/`, `.mcp.json`, and `.app.json` at the plugin root." — [plugins/build](https://developers.openai.com/codex/plugins/build) |
| 2 | marketplace = `.agents/plugins/marketplace.json` | ✅ (+추가) | repo-scoped `$REPO_ROOT/.agents/plugins/marketplace.json`, personal `~/.agents/plugins/marketplace.json`, **레거시 `$REPO_ROOT/.claude-plugin/marketplace.json`도 지원** — [plugins/build](https://developers.openai.com/codex/plugins/build) |
| 3 | custom agent = `.codex/agents/*.toml`; `name`/`description`/`developer_instructions` 필수 | ✅ (+옵션 키) | 3개 필드 필수 확인. 옵션 `nickname_candidates`/`model`/`model_reasoning_effort`/`sandbox_mode`/`mcp_servers`/`skills.config`. 개인 `~/.codex/agents/`, 프로젝트 `.codex/agents/` — [subagents](https://developers.openai.com/codex/subagents) |
| 4 | hook 5종(PreToolUse/PostToolUse/PreCompact/UserPromptSubmit/Stop) 지원 | ✅ (실제 10종) | 전체 지원 이벤트: SessionStart, SubagentStart, PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, UserPromptSubmit, SubagentStop, Stop. plan의 5종 전부 포함 — [hooks](https://developers.openai.com/codex/hooks) |
| 5 | custom prompts deprecated → skills 권장 | ⚠ | plan이 인용한 skills 페이지엔 **근거 없음**. 다른 출처에서 확인: [custom-prompts 문서](https://developers.openai.com/codex/custom-prompts), [deprecation warning PR #15076](https://github.com/openai/codex/pull/15076) |

**소결:** plan의 5개 사실은 전부 참이다. 단 #5는 plan이 든 출처(skills 페이지)에 근거가 없고 별도 페이지·PR에 있으므로, plan은 출처를 `custom-prompts` 페이지로 교정해야 한다.

## 2. plan의 위험 평가를 바꾸는 발견 (❗)

검증 중 plan이 누락했거나 과대평가한 사실이 나왔다. **핵심은 Codex hook/plugin 규약이 의도적으로 Claude Code와 호환되게 설계됐다는 점이다.**

### ❗F1. `CLAUDE_PLUGIN_ROOT`는 Codex가 레거시 호환으로 직접 제공한다

[plugins/build](https://developers.openai.com/codex/plugins/build) 문구:

> "Plugin hook commands receive the Codex-specific environment variables `PLUGIN_ROOT` and `PLUGIN_DATA`. `PLUGIN_ROOT` points to the installed plugin root" — 그리고 `CLAUDE_PLUGIN_ROOT`를 호환용으로 함께 제공.

→ skill·agent·`hooks.json`에 박힌 기존 `${CLAUDE_PLUGIN_ROOT}` 문자열은 **Codex에서도 그대로 resolve된다.** plan §6이 "가장 큰 위험"으로 든 치환 작업(M1/M4)은 블로커가 아니라 선택적 정리다. plan의 위험 등급을 강등해야 한다.

### ❗F2. hook stdin 필드명이 Claude와 동일하다

[hooks](https://developers.openai.com/codex/hooks)에서 확인한 event별 stdin 필드:

| event | event-specific 필드 | DITTO 핸들러가 읽는 필드 | 일치 |
|---|---|---|---|
| UserPromptSubmit | `prompt` | `raw.prompt` | ✅ |
| PreToolUse | `tool_name`, `tool_input` | `raw.tool_name`,`raw.tool_input` | ✅ |
| PostToolUse | `tool_name`,`tool_input`,`tool_response` | `+raw.tool_response` | ✅ |
| PreCompact/PostCompact | `trigger`("manual"\|"auto") | `raw.trigger` | ✅ |
| Stop | `stop_hook_active`,`last_assistant_message` | — | (DITTO Stop 핸들러 해당 필드 미사용) |
| 공통 | `session_id`,`transcript_path`,`cwd`,`hook_event_name`,`model` | `raw.session_id`,`raw.cwd` | ✅ |

→ 핸들러 input 측은 Codex에서 거의 그대로 동작한다.

> **정정(dialectic-1 obj 1, 2026-06-13).** 위 "거의 그대로"는 prompt/Bash/session_id 필드에 한해 맞다. **파일 변경 도구 의미는 일치하지 않는다.** Codex는 편집을 `tool_name="apply_patch"` / `tool_input.command`(패치 문자열)로 보내는데, DITTO 핸들러는 `Write|Edit|MultiEdit` + `tool_input.file_path`에만 게이트·evidence를 건다(`pre-tool-use.ts:594,605`, `post-tool-use.ts:13,28`). 따라서 Codex 편집은 secret/forbidden_scope 게이트와 edit evidence를 둘 다 우회한다. 실제 divergence는 (1) repoRoot 출처(Claude `CLAUDE_PROJECT_DIR` vs Codex `cwd`)와 **(2) apply_patch 도구 의미** 둘이다. apply_patch 경로는 `tool_input.command`의 `*** Add/Update/Delete File:`·`*** Move to:` 헤더(항상 상대경로)에서 추출 가능하므로([apply_patch 문법](https://github.com/openai/codex/blob/main/codex-rs/apply-patch/apply_patch_tool_instructions.md)), M2가 이를 파싱해 게이트에 먹여야 한다.

### ❗F3. hook stdout 출력 shape도 Claude와 동일하다

[hooks](https://developers.openai.com/codex/hooks) 출력 계약:

- block: `{"decision":"block","reason":"..."}` 또는 exit code 2 — Claude와 동일
- context 주입: `{"hookSpecificOutput":{"hookEventName":"...","additionalContext":"..."}}` — Claude와 동일
- PreToolUse rewrite: `{"hookSpecificOutput":{"permissionDecision":"allow","updatedInput":{...}}}` — Claude와 동일

→ plan §6의 "Hook output shape가 미세하게 다를 수 있음" 위험과 M2의 `renderHookOutput(host, …)` per-host 분기는 증거상 거의 불필요하다. Codex가 Claude hook 프로토콜을 그대로 채택했다.

**F1~F3 종합(추론):** plan은 Codex가 Claude와 *다를 것*이라 가정하고 방어적으로 짰는데, 실측은 그 반대다. M2의 normalize/render 추상화는 헌장 4-3(미래 분기 대비 추상화 금지)에 비춰 과설계 위험이 있다.

## 3. plan이 과소평가한 진짜 갭

### G1. (중요) M4의 `tools` → Codex 매핑이 read-only 검증 계약을 깰 수 있다

Codex custom agent에는 Claude의 per-tool allowlist에 해당하는 필드가 **없다.** 있는 것은 `sandbox_mode`와 `mcp_servers`뿐이다([subagents](https://developers.openai.com/codex/subagents)). DITTO의 read-only agent(reviewer/researcher/verifier/security-reviewer는 `tools: Read,Grep,Glob,Bash`)는 "Edit/Write 불가"가 검증 모델의 핵심인데, plan M4는 이를 "advisory comment로 남긴다"고 했다. comment로 두면 Codex 측 reviewer가 파일을 쓸 수 있어 fresh-context·read-only 계약이 깨진다.

→ 올바른 projection: read-only/mutating 구분을 `sandbox_mode`(read-only vs workspace-write)에 매핑. advisory가 아니라 **보안 속성 보존**으로 다뤄야 한다.

### G2. M3 ↔ M4 데이터 의존성 역전

M3(surface inventory)는 `.codex/agents/*.toml -> agent` 스캔을 검증 대상에 넣었으나, 그 TOML을 *생성*하는 것은 M4다. M3을 M4 앞에 두면 agent-surface 스캔은 실데이터 없이 검증 불가. plugin/skill/hook 스캔(M1 산출물)은 M3에서 가능하나, agent 스캔 검증은 M4 fixture 의존임을 명시하거나 순서를 조정해야 한다.

### G3. AGENTS.md 32KiB 병합 한도 (신규 위험)

[agents-md](https://developers.openai.com/codex/guides/agents-md): Codex는 global+project `AGENTS.md`를 git root부터 합쳐 `project_doc_max_bytes`(기본 32 KiB)에서 자른다. 현재 `AGENTS.md` = 14,142 bytes로 단독은 안전하나, 사용자 global·중첩 AGENTS.md와 합산되면 DITTO charter가 잘릴 수 있다. plan C2/M5에 이 위험이 없다. 저위험이나 한 줄 기록 필요.

## 4. 경미 관찰

- Codex는 `SessionStart`/`SubagentStart`/`SubagentStop`/`PermissionRequest`/`PostCompact`도 지원. autopilot 오케스트레이션이 후속으로 쓸 수 있는 surface. 5종 한정은 합리적 scoping.
- [codex-cli 0.117.0에서 custom prompts/skills 동작 변경 이슈](https://github.com/openai/codex/issues/15972) — "Codex surface가 바뀔 수 있다"는 plan §6 위험이 실제 발생 중. 유효한 경고.
- marketplace 레거시 `.claude-plugin/marketplace.json` 지원은 divergence를 더 줄이는 방향(F1과 같은 호환 설계 패턴).

## 5. plan에 반영해야 할 수정 요약

1. **§6 위험 강등:** `${CLAUDE_PLUGIN_ROOT}` 치환을 "가장 큰 위험"에서 "선택적 정리"로 (F1).
2. **M2 축소:** hook I/O 호환 확인됨. per-host normalize/render 추상화 대신 repoRoot fallback부터. 실제 divergence 보일 때 seam 확대 (F2/F3).
3. **M4 수정(중요):** read-only agent의 도구 제한을 `sandbox_mode`로 projection (G1).
4. **M3/M4 순서:** agent-surface 검증의 M4 의존성 명시 또는 재배치 (G2).
5. **C5/#5 출처 교정:** custom prompts deprecated 근거를 `custom-prompts` 페이지로 (§1 #5).
6. **C2/M5 위험 추가:** AGENTS.md 32 KiB 병합 한도 (G3).

## 6. 미검증으로 남는 것

- Codex CLI 실제 로딩 동작 — 문서 사실만 확인, 로컬 `codex` 바이너리 실행 검증 안 함.
- 버전별 surface 변동(0.117.0류) — 시점 의존, 구현 시 재확인 필요.
