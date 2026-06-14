# Codex dual-host 수정 계획 (audit wi_260614a56 → 실행 wi_260614706)

> **목적**: Codex dual-host audit(`final_verdict=fail`, codex-cli 0.139.0)이 fresh 증거로 찾은 F1~F8을 고치기 위한 실행 계획. **Codex 세션이 이 문서를 기준으로 수정한다.**
> **소스**: `.ditto/local/work-items/wi_260614a56/codex-dual-host-audit.md` (F1~F8), 공식 Codex 문서(hooks/plugins/subagents), 본 세션의 hook-trust 게이트 발견.
> **검증 기준**: 각 수정은 fixture-green이 아니라 **fresh CODEX_HOME에서 실 codex 동작**으로 닫는다(audit이 fixture-green ≠ feature-works를 입증했으므로).
> **표기**: `[DECISION]` = 착수 전 결정 필요 · `[fix]` = 구현 · `[verify]` = Codex 실증.

---

## -1. 계획 검증 판정

**판정**: 방향은 맞다. audit F1~F8의 실패 원인을 대부분 직접 겨냥하고 있고, 특히 F2/F3를 같은 CLI 참조 문제로 묶은 것, F4를 맹목 수정하지 않고 조사 선행으로 둔 것, hook trust를 별도 검증 전제로 둔 것은 타당하다.

**보정한 원칙**:
- `setup --host codex`는 "plugin 파일 준비"와 "Codex가 실제 enabled plugin으로 로드"를 구분해야 한다. 둘 중 하나만 된 상태를 `doctor`가 성공으로 둥글리면 다시 false-green이다.
- FIX-3의 절대경로 치환은 target `.agents/plugins/ditto` 복사본, project `.codex/agents`, 그리고 `codex plugin add`가 가져갈 plugin cache 입력까지 함께 고려해야 한다. 설치 후 plugin cache가 이미 낡은 본문을 들고 있으면 skill은 계속 깨진다.
- custom-agent 검증은 "TOML 파일 존재", "project trust 조건에서 Codex가 로드", "`spawn_agent(agent_type=<name>)`로 호출 가능"을 분리해야 한다.
- 이 계획은 하나의 사용자 요청에서 나온 작업이다. 별도 work item 분리는 사용자 승인 없이는 하지 않고, 필요하면 같은 work item 안에서 FIX 단위 커밋/검증 슬라이스로 나눈다.

## 0. 먼저 결정할 것 (DECISION) — 여기서 안 정하면 F2/F3/F4가 헛돈다

### D-A. Codex에서 `ditto` CLI를 어떻게 참조하나 (F2 + F3의 공통 뿌리)

**문제**: 두 참조가 다 깨진다.
- skill 본문의 `"${CLAUDE_PLUGIN_ROOT}/bin/ditto"` — 일반 Codex 셸 env엔 그 변수가 없다(hook 명령에만 주입). → `/bin/ditto`로 풀려 exit 127 (audit F2).
- agent projection이 bare `ditto`로 치환(`agent-projection.ts:104`) — macOS는 `/usr/bin/ditto`(Apple archive 툴)가 PATH에서 앞서 **엉뚱한 바이너리** 실행 (audit F3).

**선택지**:
- **(A) 권장 — setup-time 절대경로 치환**: build가 아니라 **setup(설치) 시점**에 Codex skill 본문과 agent TOML의 ditto 참조를 **설치된 절대경로**(`<installedPluginDir>/bin/ditto`)로 치환. 설치 시점엔 경로를 알 수 있다. 충돌·미정의 변수 둘 다 회피. 단점: 산출물이 설치 위치에 바인딩(로컬 설치엔 문제 없음).
- (B) PATH 보장: setup이 DITTO bin 디렉터리를 `/usr/bin`보다 앞에 오도록 Codex 세션 env/PATH에 주입. Codex가 그 env를 skill/agent 셸에 전달한다는 보장이 없어 취약.
- (C) CLI 이름 변경(`ditto`→`ditto-cli`/`dt`): 충돌 영구 제거. 가장 깨끗하나 bin·hooks.json·skills·agents·docs·install 전부 손대는 큰 변경.

**권장 = (A)**. (C)는 별도 ADR감으로 분리. **이 결정을 먼저 확정**해야 F2/F3 fix가 구체화된다.

**검증 보정**: (A)를 택하면 치환 시점이 중요하다. Codex는 `codex plugin add` 때 marketplace source를 `$CODEX_HOME/plugins/cache/...`로 복사하고, prompt에는 그 cache의 skill 경로가 올라온다. 따라서 setup이 target `.agents/plugins/ditto`만 나중에 고치거나 project `.codex/agents`만 고치면 부족하다. `codex plugin add`가 읽는 plugin source와 project custom-agent TOML이 모두 같은 실행 가능한 DITTO CLI 경로를 갖는지 확인해야 한다.

### D-B. Codex custom-agent role 호출이 비대화형에서 되는가 (F4)

audit: `codex exec`가 `.codex/agents/verifier.toml`을 읽고도 `agent_type: verifier`를 **unknown으로 거부**. 공식 문서는 `.codex/agents/*.toml`과 `name` 기반 custom agent를 말하지만, 실제 비대화형 tool registry가 그 이름을 노출하는지는 별도 문제다. **이것이 Codex 제약(exec 비지원), project trust 문제, TOML 위치/스키마 문제, 또는 호출 프롬프트/도구 노출 문제인지 먼저 조사**해야 한다(공식 subagents 문서 + `codex exec --help` + fresh trusted target). 조사 결과에 따라 F4는 "fix"일 수도, "Codex 한계로 문서화"일 수도 있다. **맹목 수정 금지.**

**조사 결과(2026-06-14, Codex CLI 0.139.0)**: 공식 문서 기준 TOML 스키마(`name`, `description`, `developer_instructions`)는 맞다. fresh target에서 `.codex/agents/probe.toml`을 추가하고 실제 사용자 Codex auth로 `codex exec --ephemeral`을 실행했을 때, Codex는 `agent_type: probe` 시도를 했지만 harness가 `unknown agent_type 'probe'`로 거부했다. fallback generic subagent는 뜰 수 있으나 custom role developer instructions가 적용된 증거는 아니다. 따라서 현 단계의 DITTO 주장은 "Codex custom-agent TOML 파일 설치는 pass, custom role callable은 fail/미지원"으로 낮춘다. 증거는 `.ditto/local/codex-f4-*/probe-real.jsonl` 및 `probe-real.err`.

### D-C. hook 발화 검증은 trust 게이트를 통과해야 한다 (검증 전제)

공식 hooks 문서: "Codex skips plugin-bundled hooks until you review and trust the current hook definition." → plugin 설치만으론 hook이 안 뜬다. **모든 hook 검증은 (1) 대화형 TUI `/hooks`에서 trust 후, 또는 (2) `--dangerously-bypass-hook-trust`로** 해야 유효하다. audit의 "apply_patch 차단 pass"는 plugin hook env를 수동 주입한 시뮬이지 실 codex 발화가 아니다.

---

## 1. 수정 단위 (의존순)

### 즉시·안전 (Codex 지원 여부와 무관하게 고친다)

#### FIX-1 = F6 [fix] setup 재실행이 자기 소스를 삭제하는 파괴적 버그
- **근거**: `src/core/setup.ts:200` `rm(installedPluginDir)` → `:202` `cp(pluginRoot, installedPluginDir)`. `pluginRoot === installedPluginDir`(설치된 plugin에서 setup 실행)이면 소스를 지우고 ENOENT. `cli/commands/setup.ts:70-76`은 `pluginRoot===projectRoot`만 가드.
- **fix**: `resolve(pluginRoot) === resolve(installedPluginDir)`이면 rm 전에 throw(또는 copy skip). cli 가드에도 같은 조건 추가.
- **verify**: 설치된 `.agents/plugins/ditto/bin/ditto setup --host codex <same-target>` → 명확한 에러로 거부 + `.agents/plugins/ditto` **보존**(테스트로).
- **risk**: 낮음. 가드 추가뿐.

#### FIX-2 = F7 [fix] `--host` 오타가 조용히 claude-code로 fallback (false-green 부류)
- **근거**: `src/cli/commands/hook.ts:56` `args.host === 'codex' ? 'codex' : 'claude-code'` — 알 수 없는 값도 claude-code로. OBJ-1과 같은 seam 은폐.
- **fix**: host를 fail-closed로 파싱 — `'claude-code'|'codex'`만 허용, 그 외(빈 값 제외 또는 포함 정책 결정)면 stderr + exit 2. 기존 host 파서 의미 재사용.
- **verify**: `ditto hook pre-tool-use --host codx < payload` → exit≠0 에러. `--host codex`는 그대로 차단(exit 2). 단위 테스트 추가.
- **risk**: 낮음. 단, `--host` 미지정 default(claude-code)는 유지해야 Claude 무회귀 — "오타 거부"와 "미지정 default"를 구분.

### Codex 설치/표면 정합 (D-A 확정 후)

#### FIX-3 = F2 + F3 [fix] skill·agent의 ditto 참조를 Codex에서 실행 가능하게 (D-A 의존)
- **근거**: `agent-projection.ts:104`(bare ditto), skill 본문 다수(`skills/autopilot/SKILL.md:24,31,33,35`, `deep-interview:32`, `e2e:16`, `e2e-author:22-40`, `knowledge-update:22`, `memory-graph:10`, `tech-spec:11,27,47,70`, `verify:19`).
- **fix (D-A=(A) 가정)**: setup의 Codex 경로에서 (a) plugin source로 쓰이는 `.agents/plugins/ditto/skills/**/SKILL.md`, (b) project `.codex/agents/*.toml`, (c) 필요하면 plugin source 내부 `.codex/agents/*.toml`의 ditto 참조를 `<installedPluginDir>/bin/ditto` 절대경로로 치환. build-time `rewritePluginRoot`(bare ditto)는 제거하거나 setup-time 치환으로 대체. Claude build는 `${CLAUDE_PLUGIN_ROOT}` 유지(무회귀). 이미 `$CODEX_HOME/plugins/cache/...`에 설치된 낡은 plugin은 재설치/upgrade/cache bust 없이는 고쳐지지 않으므로 setup 출력과 검증이 그 상태를 드러내야 한다.
- **verify**: fresh target + fresh CODEX_HOME에서 설치 후, plugin add가 가져간 cache의 skill 본문과 project agent TOML의 명령을 그대로 실행 → DITTO CLI가 뜬다(exit 0, `ditto --help`가 Apple ditto 아님). `which -a ditto` 충돌 환경에서도.
- **risk**: 중. setup-time 치환은 멱등·재설치 안전해야(FIX-1과 함께). Claude 경로 무회귀 테스트 필수.

#### FIX-4 = F1 [fix/doc] setup이 plugin을 실제 로드하거나, 안 한다고 정직히 안내
- **근거**: `setup --host codex`는 marketplace 파일만 쓰고, fresh CODEX_HOME은 `codex plugin marketplace add <target>` + `codex plugin add ditto@ditto-local` 없이는 plugin 미로드(audit F1). `setup.ts:150-205`, `cli/commands/setup.ts:156-176`.
- **fix 선택**: (a) setup이 `codex plugin marketplace add`/`plugin add`를 직접 실행(codex CLI 가용 시), 또는 (b) setup이 "끝났다"고 주장하지 말고 다음 수동 명령을 명확히 출력. **권장 (b)+가능하면 (a) best-effort** — codex 바이너리 부재/실패에 fail-open. 어느 쪽이든 결과 상태를 `prepared`(파일만 준비), `enabled`(Codex prompt에 skill 로드 확인), `needs_user_action`(수동 명령 필요)처럼 구분한다.
- **verify**: fresh CODEX_HOME에서 setup → (a면) plugin add 없이 skill 보임 / (b면) 출력된 명령 그대로 실행 시 보임. `codex debug prompt-input`에 DITTO skill 표시. prepared-only 상태를 enabled처럼 표현하면 실패.
- **risk**: 중. (a)는 외부 codex 상태 변경 — 멱등·실패 격리.

#### FIX-5 = F5 [fix] 설치 target에서 doctor가 codex 설치와 일치
- **근거**: 설치 후 `doctor surface/capability/instructions --host codex` 전부 fail.
  - `surface-inventory.ts:24-42`가 `.ditto/local/surfaces.codex.json` 요구(설치 target엔 없음).
  - `hosts/codex.ts:172-180`이 repo root plugin surface만 스캔, 설치된 `.agents/plugins/ditto` 미추적.
  - `instruction-bridge.ts:147-169`이 Codex AGENTS.md의 managed marker를 drift로 오판하나, `setup.ts:94-109,227-239`은 managed block으로 AGENTS.md 설치.
- **fix**: (a) codex surface 스캐너가 설치된 `.agents/plugins/ditto`(+ `.codex/agents`)를 스캔. (b) surfaces.codex.json 부재를 설치 target에서 fail이 아닌 적절 처리(또는 setup이 생성). (c) Codex AGENTS.md managed-block 기대를 instruction-bridge와 일치(둘 중 하나로 통일). (d) FIX-4의 상태 구분과 맞춰, prepared-only 상태에서 "hook registered"를 성공으로 주장하지 않는다.
- **verify**: FIX-4가 `enabled`까지 수행한 상태에서는 세 doctor 명령 exit 0 + drift 0. prepared-only 정책을 택한 경우에는 `doctor capability`가 수동 enable 필요를 명확히 보고하고, advisory가 아닌 pass로 둥글리지 않는다.
- **risk**: 중상. 3개 하위(스캐너·카탈로그·AGENTS.md 정책)라 쪼개서. 각각 단위+설치 fixture.

### 조사 선행 후 결정

#### FIX-6 = F4 [verify→fix?] Codex custom-agent role 호출 (D-B 의존)
- **근거**: `codex exec`가 custom role `verifier` 거부(audit F4). 파일은 깔림.
- **선행 조사 결과**: 공식 subagents 문서 + `codex exec --help` + fresh target 실증상, TOML 파일은 설치되지만 비대화형 `codex exec`의 tool registry는 project custom `agent_type`을 받지 않는다(`probe`가 unknown). generic subagent fallback은 가능하지만 custom role 호출 증거가 아니다.
- **그 다음**: DITTO 쪽 fix로 `agent_type=<custom>` callable을 만들 수 있는 근거가 없다. 따라서 ADR-0016 검증상태 + test-methods에 "Codex custom-agent file projection pass, custom role invocation fail/unsupported under codex exec 0.139.0"로 문서화하고 비대화형 custom-role 주장을 철회한다. Codex 향후 버전에서 role registry가 열리면 probe test를 다시 실행한다.
- **verify**: `.ditto/local/codex-f4-*/probe-real.jsonl`에서 `unknown agent_type 'probe'`와 generic fallback 결과를 확인. custom role callable pass는 미검증이 아니라 현재 fresh evidence 기준 fail.
- **risk**: 불명(조사 의존).

### 문서/지침

#### FIX-7 = F8 [fix] dialectic의 Codex 라우팅을 호스트-인지로
- **근거**: `skills/dialectic/SKILL.md:23`, `agents/dialectic-opponent.md:9`, 생성된 `dist/codex-plugin/.codex/agents/dialectic-opponent.toml:13` — 기존 지침은 Codex opponent를 Claude Code의 `codex:rescue`/codex-plugin-cc 경로로만 안내했다. Codex 호스트 세션엔 틀림.
- **fix**: 지침과 `OpponentModelRouter`를 호스트-인지로 — Claude Code host면 codex-plugin-cc를 통해 Codex 모델을 호출하고, Codex host면 Claude Code 역호출 없이 별도 Codex context를 만든다. Codex custom agent가 callable이면 `dialectic-opponent` custom role을 쓰고, 아니면 generic Codex subagent에 Opponent packet/지침을 넣는다. generic subagent는 provider fallback이 아니라 role-surface downgrade로 `opponent.run.command`에 기록한다.
- **verify**: Codex host에서 router 후보가 Codex provider만 남고, build artifact의 dialectic 지침이 `do not call Claude Code`와 `generic Codex subagent` 경로를 포함한다.
- **risk**: 낮음(지침 텍스트). 단 dialectic 동작에 직접 영향이므로 dogfood로 확인.

---

## 2. 권장 실행 순서

1. **FIX-1(F6)·FIX-2(F7)** — 작고 안전·위험제거. 먼저.
2. **D-A 확정** → **FIX-3(F2/F3)** — Codex에서 ditto 실행 가능해야 나머지가 의미.
3. **FIX-4(F1)·FIX-5(F5)** — 설치/표면 정합.
4. **D-B 조사** → **FIX-6(F4)**.
5. **FIX-7(F8)**.

작업 추적은 기본적으로 `wi_260614706` 하나를 유지한다. 사용자 승인 없이 F1~F8을 별도 work item으로 쪼개지 않는다. 구현은 FIX 단위로 작게 나누고, 커밋은 Tidy First: 구조/동작 분리, FIX 단위로.

## 3. 검증 프로토콜 (공통)

- **fresh CODEX_HOME + fresh target repo**로 매번(설치 잔재 오염 금지). audit이 쓴 `env CODEX_HOME=<tmp>` 패턴.
- hook 검증은 **D-C(trust 게이트)** 통과 후: TUI `/hooks` trust 또는 `--dangerously-bypass-hook-trust`.
- 각 AC는 **실 codex 명령 + exit code + 출력**으로 닫는다(fixture-green 단독 불가).
- 회귀: 매 FIX 후 `env -u DITTO_SKIP_HOOKS bun test` 전체 green + Claude host 라이브 smoke(secret write 차단) 유지.

## 4. 완료 기준 (이 계획 전체)

audit의 "all DITTO features work under Codex"가 fresh 증거로 참이 되려면:
- skill·agent가 Codex에서 ditto CLI를 실제 실행(FIX-3).
- setup이 plugin을 로드(또는 정직 안내) + 설치 target doctor 일치(FIX-4,5).
- hook이 trust 후 실 발화(D-C) + apply_patch 안전게이트 실차단.
- custom-agent role 호출 가능 여부 확정(FIX-6).
- 파괴적/false-green 버그 제거(FIX-1,2).
- 지침 호스트-정합(FIX-7).

미해결로 남는 항목(예: F4가 Codex 한계)은 ADR-0016 검증상태에 정직히 기록하고 주장 강도를 그에 맞춘다.
