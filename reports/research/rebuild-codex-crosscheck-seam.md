# Codex 교차검증을 단일-host seam에 붙이는 in-repo 선택지 조사

Ticket: GitHub #54 (Part of #52). 재구축의 의도적 단일-host seam에 Codex 교차검증(maker=Claude ≠ checker=Codex)을 붙이는 세 가지 형태 — (a) 2nd HostAdapter, (b) out-of-band 호출, (c) 별도 verifier seam — 을 코드베이스 사실로 조사한다. 조사만, 커밋 없음.

---

## 1. 오늘의 Codex 통합 실체 (invocation mechanism)

Codex는 이 repo에서 **CLI 프로세스**로 호출된다. MCP도 상시 broker 서버도 아니다. 서로 다른 두 경로가 공존한다.

### 경로 A — dialectic 모델-다양성 (codex 플러그인 표면, subagent forwarder → CLI)
- dialectic Opponent는 Claude Code host에서 **Codex 플러그인 표면(`codex:rescue` / adversarial-review)** 을 통해 이종 모델로 도달한다. `agents/dialectic-opponent.md:8` (frontmatter 아래 본문): "on a **Claude Code host**, Codex may be reached through the Claude-only Codex plugin surface (`codex:rescue` / adversarial-review) for model diversity; on a **Codex host**, do not call Claude Code."
- 실제 실행은 subagent forwarder다. 설치된 codex 플러그인의 `codex-cli-runtime` 스킬(`~/.claude/plugins/marketplaces/openai-codex/plugins/codex/skills/codex-cli-runtime/SKILL.md`)이 계약을 정의한다: "Use this skill only inside the `codex:codex-rescue` subagent. Primary helper: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task "<raw arguments>"`". 즉 `codex:codex-rescue` subagent가 `codex-companion.mjs`(Codex CLI를 감싸는 얇은 Node 래퍼)를 **한 번** 호출하고 stdout을 그대로 반환하는 forwarder다. [VERIFIED]
- 이 경로는 ditto 코어 밖 — Claude Code 플러그인 확장점(subagent + companion script) 위에 있다. ditto `src/`는 이 플러그인을 직접 호출하지 않는다.

### 경로 B — ditto 자체 provider spawn (직접 CLI)
- `src/core/hosts/codex.ts:202` `codexHostAdapter.spawnRun` → `spawnProviderProcess({ binary: 'codex', ... })` (`codex.ts:203-212`). Codex 바이너리를 직접 spawn한다.
- 호출자: `src/core/run-with.ts:170-231` (`ditto run-with` — 범용 provider-run seam)와 `src/core/setup.ts:295` (호스트 인벤토리). [VERIFIED grep]
- 이 어댑터(`src/core/hosts/types.ts` `HostAdapter`)는 host **인벤토리/설정** 용도(loadInstructions/loadPermissions/loadMcpServers/loadSurfaceInventory + spawnRun)이지 교차검증 verdict 채널이 아니다.

### 경로 C — 정책 해소만 (호출 아님)
- `src/core/opponent-router.ts` — 어느 Opponent를 쓸지 **결정론적 정책 해소 + provenance**만. 호출 glue가 아니다(`opponent-router.ts:9-13`: "Deterministic policy resolution + provenance, NOT the call glue. The actual CLI invocation is a separate thin layer the skill drives").
- `src/core/prism/opponent.ts:32-40` — ADR-0001 경계: "this module NEVER spawns a provider or shells out ... The actual invocation is host-delegated ... surfaced here as the `OpponentDelegate` callback; this module only CONSUMES the structured output it returns". 즉 ditto 코어는 provider를 직접 부르지 않고, host가 위임 실행하고 **구조화 출력만** 소비한다.

**요약**: 오늘의 Codex 호출 = CLI (경로 A는 subagent+companion 래퍼 경유, 경로 B는 직접 spawn). ditto 코어는 provider를 직접 부르지 않는다 — 정책만 해소하고(opponent-router) delegate 콜백이 반환하는 구조화 출력을 소비한다(prism/opponent). 이는 ADR-0001 경계다.

---

## 2. 재구축 seam과 checker의 반환 형태

- `rebuild/seam/host-adapter.ts` — 새 seam. 표면: `driveStep`, `stopGate`, `fanout`, `readSidecar` (`host-adapter.ts:36-45`). **cross-model 표면 없음**. Codex/provider/모델 개념 자체가 없다. [VERIFIED]
- `fanout(tasks): Promise<AgentText[]>` (`host-adapter.ts:42`). `AgentText`는 **의도적으로 opaque**: `type AgentText = string & { readonly __opaque: 'subagent-free-text' }` (`host-adapter.ts:18`), 주석(`:15-17`): "Subagent free text is OPAQUE — nominally sealed so it can never be used as the queue oracle." → **fanout 반환은 구조화 oracle이 될 수 없다.** Codex-as-checker는 refutation/verdict을 구조로 반환해야 하는데 fanout으로는 불가.
- 구조화 반환 경로는 seam에 이미 있다: `readSidecar<T>(path, schema)` (`host-adapter.ts:44`, fail-closed 검증) + `driveStep`의 `--json-schema` 강제 `boundaryEnvelope`(`host-adapter.ts:7-13`). 즉 Codex verdict을 **sidecar JSON으로 쓰게 하고 스키마로 읽는** 패턴이 seam 표면 확장 없이 이미 가능하다.
- checker가 반환할 것(verdict/refutation)이 맞는 스키마:
  - `rebuild/schemas/verdict.ts` — enum `pass|fail|partial|unverified`만(`verdict.ts:3`). 반박 근거를 담기엔 빈약.
  - rebuild에는 reviewer-output 스키마가 **없다**(`rebuild/schemas/index.ts` 미포함). [VERIFIED]
  - 기존 `src/schemas/reviewer-output.ts`가 정확히 이 형태다: `verdict` + `findings[]`(maps_to/severity/reason) + `evidence[]` + **`different_provider_than_generator: boolean`**(`reviewer-output.ts:47-49`)와 그 refine "cross-provider claim must be backed by evidence"(`reviewer-output.ts:84-92`). 즉 **maker≠checker 교차검증을 명시적으로 표현하도록 이미 설계된 계약**이다. rebuild에 아직 포팅 안 됨.
  - dialectic Opponent 반환 형태(`dialecticOpponent.objections[]` with `maps_to` oracle)도 refutation 채널로 존재(`agents/dialectic-opponent.md` "You return").

---

## 3. 초안·이슈 의도

- 초안 §7.4(`docs/redesign/ditto-rebuild-draft.md`): "single-host-first이므로 seam 뒤 구현은 하나뿐이다. 나중에 다른 host가 필요하면 seam 뒤에 두 번째 어댑터를 *가산*으로 추가(ADR-0008 패턴). **seam을 무너뜨려 Claude Code를 코어에 baked-in 하지 않는다**" — 목적: (a) 철학이 harness에 종속되지 않게, (b) 코어를 live model 없이 단위 테스트 가능하게. [VERIFIED]
- 초안 §5.10 cond2 / 관련 라인: 완료 지점 "빼기" 판정과 종료 진단을 **"다른 provider의 Opponent를 세운 dialectic"** 으로 판정(`draft:340`, `:203`, `:350`). §4.2 상관 모델 실패 논거 — 맥락만 분리하면 안 사라지므로 모델까지 다르게.
- 초안 §7.4 인접 표: `| dual-host 낭비 | 미검증 2호스트 유지 | single-host seam(§7.4) |` — 2호스트 상시 유지는 명시적 반-패턴.
- 초안 이슈 매핑(`draft:491`): "#47 이종 모델 반박 패널 상시화 → **흡수** → §5.10에서 확정한 *교차모델 적대 심의* 그 자체. 별도 이슈가 아니라 이 설계의 일부." 단, **결선 방식(어느 seam으로)** 은 미정 — #54가 그 재료 조사.
- 이슈 #47(`gh issue view 47`): dialectic이 이미 Opponent에 Codex를 선호하는 seam을 **확장**하라. "가장 싸고 즉시 가능한 외부성 확보." 열린 항목: "상시" 트리거 지점(모든 ADR vs 되돌리기 어려운 결정만). [VERIFIED]
- 이슈 #54: 초안이 #47을 §5.10에 '흡수'라 표기했으나 결선 방식은 미정. [VERIFIED]

핵심: #47/§5.10의 의도는 "새 배관"이 아니라 **기존 dialectic-opponent(=이미 이종 모델 선호) seam을 확장**하는 것 — 교차검증은 이미 dialectic Opponent 역할·opponent-router 정책·reviewer-output 계약으로 존재하는 자산이다.

---

## 4. 세 선택지 평가

### (a) 2nd HostAdapter (§7.4 additive-adapter)
- **실현성**: rebuild `HostAdapter`(`host-adapter.ts:36`)를 Codex용으로 한 벌 더 구현. 하지만 이 seam은 host **인벤토리/드라이브** 계약(driveStep/fanout/stopGate/readSidecar)이지 checker 계약이 아니다 — Codex를 2nd host로 세우면 "Codex 위에서 drive 루프를 돈다"는 뜻이지 "Codex가 Claude를 refute한다"가 아니다.
- **비용**: 높음. §7.4가 지금은 구현 하나만 두라고 명시("구현은 하나뿐"), 표는 "미검증 2호스트 유지"를 반-패턴으로 못박음(draft §7.4). 인벤토리/spawn/설정 전체를 미검증 2호스트로 부양.
- **seam 무결성**: additive라 seam 자체는 보존되나, **교차검증 문제를 host-swap 문제로 오해**하게 만든다. maker≠checker는 host 교체가 아니라 반박 채널이 필요한 것. 목적-수단 불일치.

### (b) out-of-band 호출 (seam 밖에서 Codex 직접 호출)
- **실현성**: 오늘 경로 A가 정확히 이 모양 — dialectic이 `codex:rescue` subagent(플러그인 표면)로 코어 밖에서 Codex를 부른다. 즉 **이미 존재하는 실동작 패턴**.
- **비용**: 낮음(플러그인 표면 재사용). 그러나 코어가 이 호출을 소유하면 ADR-0001 경계(코어는 provider spawn 안 함, `prism/opponent.ts:32`) 위반 위험. out-of-band를 **skill/CLI 드라이브 층**에 두고 코어는 구조화 출력만 소비하면 경계 유지.
- **seam 무결성**: host-adapter seam을 우회하므로 seam을 오염시키지 않는다(코어에 Codex baked-in 안 됨). 대신 검증 채널이 seam 밖 free-form이면 "구조화 oracle"이 아님 — 반환을 반드시 reviewer-output/verdict 스키마로 sidecar 검증해야 게이트가 읽을 수 있다(`readSidecar`).

### (c) 별도 verifier seam (교차모델 검증 전용 인터페이스)
- **실현성**: 코어에 순수-정책+구조화-소비 seam을 하나 추가 — `opponent-router.ts`(정책 해소) + `prism/opponent.ts`의 `OpponentDelegate` 콜백(host-delegated 실행, 코어는 소비만) 조합이 **이미 이 seam의 원형**이다. rebuild에선 반환 스키마로 `reviewer-output`(cross-provider 필드 내장) 또는 dialectic objections를 쓰고, 실행은 (b)처럼 host/skill 위임.
- **비용**: 중간. rebuild에 reviewer-output 스키마 포팅 + delegate 콜백 표면 1개. 단, driveStep/fanout host seam은 안 건드림 — verifier seam은 **다른 관심사(oracle 반환)** 이라 host seam과 직교.
- **seam 무결성**: 가장 높음. host-adapter의 얇음을 그대로 두고(Codex가 host seam에 안 샘), 교차검증을 **자기 계약(verdict+evidence+different_provider 플래그)** 으로 표현. ADR-0001(코어=정책+소비, 실행=위임) 및 §4.2 상관-실패 논거와 정합. maker≠checker가 host 문제가 아니라 검증 문제라는 것을 구조가 반영.

---

## 근거 (Evidence)

| 주장 | 근거 |
|---|---|
| 오늘 Codex 호출 = CLI, subagent forwarder 경유 | `~/.claude/plugins/marketplaces/openai-codex/plugins/codex/skills/codex-cli-runtime/SKILL.md` ("`codex-companion.mjs task`", "inside `codex:codex-rescue` subagent") |
| dialectic이 Claude host에서 codex 플러그인 표면으로 이종 도달 | `agents/dialectic-opponent.md` 본문 §routing |
| ditto 자체 codex spawn = 직접 CLI, 인벤토리/run-with용 | `src/core/hosts/codex.ts:202-212`, 호출자 `src/core/run-with.ts:170`, `src/core/setup.ts:295` |
| 코어는 provider spawn 안 함, 정책만+소비만 (ADR-0001) | `src/core/opponent-router.ts:9-13`, `src/core/prism/opponent.ts:32-40` |
| rebuild seam에 cross-model 표면 없음 | `rebuild/seam/host-adapter.ts:36-45` |
| fanout 반환 opaque = 구조화 oracle 불가 | `rebuild/seam/host-adapter.ts:15-18,42` |
| 구조화 반환은 readSidecar/`--json-schema`로 이미 가능 | `rebuild/seam/host-adapter.ts:7-13,44` |
| rebuild verdict는 enum만, reviewer-output 미포함 | `rebuild/schemas/verdict.ts:3`, `rebuild/schemas/index.ts` |
| reviewer-output이 maker≠checker를 명시 표현 | `src/schemas/reviewer-output.ts:47-49,84-92` |
| §7.4 single-host, 2nd adapter는 가산, baked-in 금지 | `docs/redesign/ditto-rebuild-draft.md` §7.4 |
| 2호스트 상시 유지 = 반-패턴 | `docs/redesign/ditto-rebuild-draft.md` §7.4 표 |
| §5.10 교차모델 dialectic, #47 흡수(결선 미정) | `docs/redesign/ditto-rebuild-draft.md:340,491,203,350` |
| #47 = dialectic Codex seam 확장, 트리거 미정 | `gh issue view 47` |
| #54 = 흡수 표기·결선 방식 미정 | `gh issue view 54` |

---

## 권고 (recommendation, not decision)

가장 seam-보존적인 선택지는 **(c) 별도 verifier seam** — host-adapter의 얇음을 건드리지 않고, 이미 존재하는 자산(opponent-router 정책 + OpponentDelegate 소비 + reviewer-output의 `different_provider_than_generator` 계약)을 rebuild로 포팅하며, 실행은 (b)의 out-of-band(플러그인 표면) 위임을 재사용한다. (a)는 교차검증(반박 채널)을 host-swap 문제로 오분류하고 반-패턴인 2호스트 부양을 부른다. 이는 조사자 권고이지 결정이 아니다 — "상시" 트리거 지점(#47 열린 항목)과 결선 확정은 grilling 티켓 소관.
