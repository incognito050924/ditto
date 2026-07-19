# setup — ditto 관리 리소스 설치·`.ditto/` 스캐폴딩·프로젝트 온보딩 마법사

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋: `c2d2e16` (2026-07-19).

---

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto setup`은 임의의 사용자 프로젝트를 **ditto가 구동될 수 있는 상태로 온보딩**한다. 구체적으로는 네 가지 설치를 조립한다:

1. **호스트 리소스** — 관리 지침 파일(AGENTS.md 차터, CLAUDE.md 프로젝션 등)을 대상 프로젝트에 배치하고, Claude Code가 `ditto` 바이너리를 프롬프트 없이 호출하도록 allowlist를 넣는다.
2. **`.ditto/` 스캐폴딩** — 런타임/지식 디렉터리 골격을 만든다(3계층 격리, ADR-0012).
3. **외부 도구 프로비저닝** — CodeQL·Playwright·언어별 LSP 서버를 감지하고 opt-in으로 설치한다.
4. **프로젝트 agent 연결 / memory 분리 / github 백로그 seed** 등 부수 구성.

이 커맨드는 DITTO 4축(의도·오케스트레이션·E2E·지식) 자체가 아니라, 그 축들을 떠받치는 **기층(배포·설치 표면)** 에 속한다. 핵심 설계 긴장은 두 가지다:

- **하나의 커맨드, 두 실행 모드.** 사람이 터미널에서 직접 돌릴 때는 @clack 기반 대화형 wizard, 에이전트/CI가 부를 때는 프롬프트 없는 비대화 경로. 판별은 `stdin.isTTY`와 `--yes`로 한다(`src/cli/commands/setup.ts:507`).
- **우아한 강등(ADR-0018).** 외부 도구는 전부 **선택적(OPTIONAL)** 이다. 부재·설치 실패가 setup을 깨뜨리지 않는다 — throw 대신 `status:'failed'` + 수동 명령을 돌려주고 계속 진행한다.

---

## 2. 코드 위치와 진입점

| 경로 | 역할 |
|---|---|
| `src/cli/commands/setup.ts` | CLI 진입점(citty). 모드 판별·recipe 해석·출력 포매팅. |
| `src/core/setup.ts` | 순수 코어 `setup()` — 리소스 라우팅·managed merge·스캐폴딩·allowlist·codex 표면·push-gate 훅. |
| `src/cli/wizard/setup-wizard.ts` | 대화형 오케스트레이터. 확정된 질문을 순서대로 묻고 위임한다. |
| `src/cli/wizard/prompt.ts` | 프롬프트 primitive(`select`/`multiSelect`/`confirm`). **TTY 없으면 안 묻고 기본값**. |
| `src/cli/wizard/provision-step.ts` | 도구 감지→다중선택→설치 단계. |
| `src/cli/wizard/agent-link-step.ts` | 발견된 프로젝트 agent를 ditto owner role에 연결. |
| `src/core/provision/provisioner.ts` | 외부 도구 프로비저너 통일 계약 + `defaultRegistry()`. |
| `src/core/provision/lsp-detect.ts` | 소스 트리 확장자→LSP 언어 감지. |
| `src/core/provision/lsp-servers.ts` | 언어별 LSP 서버 명세·설치. |
| `src/core/provision/playwright.ts` | Playwright/Chromium 프로비저너. |
| `src/core/provision/memory-separate.ts` | `.ditto/memory/`를 별도 git 저장소로 분리. |
| `src/core/recipe/load.ts` | recipe.yaml 발견·병합·malformed 정책. |
| `src/schemas/recipe.ts` | recipe.yaml zod 스키마(SoT, ADR-0002). |

### CLI 인자 (`src/cli/commands/setup.ts:369-403`)

| 인자 | 타입 | 기본 | 의미 |
|---|---|---|---|
| `--dir` / `target`(positional) | string | 없음 | 대상 프로젝트 디렉터리. 없으면 가장 가까운 `.ditto/.git` 루트 또는 cwd. |
| `--host` | string | `claude-code` | 설치 표면: `claude-code` \| `codex` \| `both`. |
| `--yes` | boolean | `false` | 비대화: wizard를 건너뛰고 기본값/플래그로 진행(CI/에이전트). |
| `--tools` | boolean | `false` | **비대화 전용**. 감지된 도구(codeql/playwright/LSP)도 설치. |
| `--recipe` | string | 없음 | recipe.yaml 경로 — 4단계를 전부 비대화로 구동(발견보다 우선). |

`ditto setup`은 별도 서브커맨드가 없다(단일 커맨드 + 위 플래그). host 문자열 검증은 `parseSetupHost`가 하며, 알 수 없는 값은 throw(`setup.ts:196-200`).

---

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

`run()`(`src/cli/commands/setup.ts:404`)는 위에서 아래로 분기한다:

```
인자 파싱 (host, targetDir, resourcesDir)
  │
  ├─ [self-host no-op] pluginRoot === projectRoot 이면 skip
  │     (ditto repo가 자기 자신을 관리하지 못하게, setup.ts:414-418)
  │
  ├─ recipe 해석 (loadResolvedRecipe: project/personal/cli 병합)
  │     └─ isRecipePresent 이면 → runRecipeSetup (4단계 헤드리스)  ← TTY/--yes 무관, 여기서 return
  │
  ├─ [대화형] stdin.isTTY && !--yes  → runWizard(@clack TUI)
  │
  └─ [비대화] 그 외              → setup() 직접 호출 + (--tools 시) provisionToolsNonInteractive
```

세 진입 경로가 모두 코어 `setup()`(`src/core/setup.ts:645`)로 수렴하되, 무엇을 추가로 실행하는지가 다르다.

**코어 `setup()`이 읽고 쓰는 것:**

- **읽기:** 번들 리소스 디렉터리(`resolveResourcesDir()`)의 관리 파일들 + `charter-manifest.json`(차터 sha 인식 데이터, 설치 대상에서 제외 — `setup.ts:147`).
- **쓰기(대상 프로젝트):**
  - 호스트 지침 파일 — claude-code는 `routeResource`가 라우팅, codex는 프로젝트/글로벌 AGENTS.md(`setup.ts:137-183`).
  - `.ditto/` 골격 — `initScaffold`가 `local/{work-items,runs,handoff,sessions,logs,cache}`, `knowledge/`, `knowledge/adr/`, `agents/` 생성 + `.ditto/.gitignore`(local/ 무시, knowledge/·agents/ 추적; `src/core/init-scaffold.ts` SCAFFOLD_DIRS·DITTO_GITIGNORE).
  - `.claude/settings.json` — `permissions.allow`에 `Bash(ditto:*)` 규칙 멱등 추가(claude-code 호스트일 때만; `settings-allowlist.ts` ALLOW_RULE, `setup.ts:666-668`).
  - codex 호스트면 `.agents/plugins/ditto`(플러그인 복사), `.agents/plugins/marketplace.json`, `.ditto/local/surfaces.codex.json`, `.ditto/local/codex-plugin-status.json`, `.codex/agents/*.toml`(`setup.ts:331-371`).
  - recipe가 `push_gate`를 선언하면 `.git/hooks/pre-push`(`setup.ts:544-611`).

**recipe 경로가 읽는 상태 파일:** repo-root `recipe.yaml`(tier ② git-shared)와 `.ditto/local/recipe.yaml`(tier ③ 개인, gitignored), 그리고 `--recipe` 경로. 우선순위 `cli > personal > project > builtinDefault`, per-field 병합(`recipe/load.ts:55-59, 108-122`).

---

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### 4-1. TTY 유무가 대화 여부를 결정한다 (묻지 않으면 기본값)

`prompt.ts`의 모든 primitive는 `io.isTTY`가 false면 **어떤 것도 묻지 않고 기본값을 돌려준다**(`select` `setup.ts` 계열 `prompt.ts:77`, `multiSelect:106`, `confirm:43`). 이유: `ditto`는 사람이 터미널에서 직접 돌릴 때만 대화하고, 에이전트/CI가 부를 땐 입력을 받을 수 없다(CRA `--yes` 패턴, `prompt.ts:1-8`). 이 덕분에 wizard 코드 하나가 대화형과 비대화형을 겸한다 — `runProvisionStep`은 비TTY에서 multiSelect가 추천 항목을 그대로 쓰므로 사람 개입 없이 감지된 도구를 설치한다(`provision-step.ts:75-77`).

### 4-2. 우아한 강등 (ADR-0018)

프로비저너 계약(`provisioner.ts:45-58`)의 철학: **opt-in only**(흐름 도중 몰래 설치 안 함), **fail-soft**(`install()`은 throw 대신 `{status:'failed', manual:[복붙 명령]}`), **shared probe**(`resolveExisting()`이 소비자가 의존하는 유일 접점). ADR-0018 D1은 "선택적 도구의 부재·실패는 집행을 절대 깨뜨리지 않는다"를 불변식으로 못박고, D2는 "그 도구가 유일한 충족 수단일 때만 정직하게 unverified/fail로 표면화"하도록 한다. 기각된 대안: (a) hard-fail throw, (b) 가짜 pass, (d) 도구마다 동등 대체 분석기 영구 유지(ADR-0018:64-70). setup에서의 구현은 heavy LSP 서버(jdtls/kotlin)를 자동 설치하지 않고 manual만 안내(`lsp-servers.ts:180-198`), Playwright 설치 실패 시 `bunx playwright install chromium` 명령 반환(`playwright.ts:78-82`) 등으로 나타난다.

### 4-3. recipe = 헤드리스 4단계 선언 (ADR-0002 스키마 SoT)

`recipe.yaml`은 wizard 4단계를 비대화로 선언하는 파일이다. 모든 필드가 OPTIONAL이라 부분 recipe도 유효하고, 지정한 단계만 override 한다(`recipe.ts:5-14`). `host`/`agent-role`/`memory`는 `z.string()`이 아니라 CANONICAL 집합에 대한 `z.enum(...)`이다 — `host: gitlab` 같은 의미상 잘못된 값이 죽은 config로 흘러가지 않고 검증에서 실패하게(`recipe.ts:10-14`). agent role enum은 `nodeOwner.options`에서 pseudo-owner(driver/main-session)를 뺀 것으로 파생돼 정본 enum과 drift 하지 않는다(`recipe.ts:26-36`).

### 4-4. AGENTS.md는 정본 원본, CLAUDE.md는 프로젝션

`installResource`(`setup.ts:387`)는 목적지 역할로 설치 방식을 가른다: AGENTS.md는 raw·create-if-missing(저작된 차터를 번들 스냅샷이 덮어쓰지 않게), CLAUDE.md는 형제 AGENTS.md를 verbatim 미러링하는 단일 managed 블록(`source=AGENTS.md`) — `ditto doctor instructions`가 요구하는 형태(`setup.ts:373-386`). 그래서 `setup()`은 CLAUDE.md 프로젝션을 AGENTS.md 설치 뒤에 오도록 순서를 강제한다(`setup.ts:653-656`).

### 4-5. 3계층 격리 (ADR-0012)

스캐폴딩이 `.ditto/.gitignore`에 `local/`(개인 런타임 tier ③)을 무시하고 `knowledge/`·`agents/`(프로젝트-전역 tier ②)는 추적으로 두는 것이 3계층 격리의 구현이다(`init-scaffold.ts` DITTO_GITIGNORE). memory 분리도 이 선을 따른다 — 분리 대상은 SoT 절반(`.ditto/memory/`)뿐이고 파생 절반(`.ditto/local/memory/`)은 이미 gitignore라 중복 관리 대상이 아니다(`memory-separate.ts:1-14`).

---

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### 5-1. `run()` — 모드 라우팅 (`setup.ts:404-564`)

- **self-host no-op** (`:414-418`): `pluginRoot === projectRoot`면 "ditto repo가 자기를 관리"하는 상황이므로 skip. `install-plugin.mjs`의 `target === repo` 가드와 대칭.
- **recipe 우선** (`:426-503`): recipe 해석을 TTY/`--yes` 분기 **이전에** 둔다. 존재하는 recipe(명시 `--recipe` 또는 발견된 비어있지 않은 recipe.yaml)는 isTTY/`--yes`와 무관하게 전체 4단계 헤드리스 경로를 구동하고 여기서 return — 레거시 host+scaffold-only 경로로 떨어지지 않는다(`:420-425` 주석). `recipe.host`가 `--host`를 이긴다(`:432-433`).
- **명시 recipe malformed/missing은 throw**(catch되어 exit), **발견된 malformed는 경고 후 무시**(어느 파일인지 이름 표시) — `recipe/load.ts:71-92`의 source-keyed 정책.
- **대화형 분기** (`:507-510`): `process.stdin.isTTY && !args.yes`일 때만 `runWizard`.
- **비대화 fallback** (`:512-559`): `setup()` 직접 호출 후 리소스별 상태 태그 출력. `--tools` 명시일 때만 `provisionToolsNonInteractive`(무거운 다운로드를 묻지 않고 자동 실행하지 않는 안전 기본, `:557-559`).

### 5-2. `runRecipeSetup` — 헤드리스 4단계 (`setup.ts:135-179`)

recipe 값으로 host(setup)+tools(provision)+agents(writeVariants)+memory(separate)를 순서대로 실행한다. **핵심 fail-closed 가드**: `recipe.memory === 'submodule'`이면 side effect 이전에 throw(`:140-144`) — submodule은 원격 선행이 필요해 헤드리스로 자동화할 수 없고, 가짜 성공을 보고하느니 거부한다. github 백로그 seed는 `deps.setup` **이후**에 실행돼(`.ditto/.gitignore`가 이미 존재해 개인 좌표 config가 git-addable로 새지 않도록) try/catch로 감싸 실패해도 setup을 깨지 않는다(`:165-176`, ADR-0018).

### 5-3. `provisionRecipeTools` vs wizard `runProvisionStep`

- **recipe 경로**(`setup.ts:59-89`): recipe의 **명시 tool id 목록**을 registry에 resolve(단일 인스턴스 도구 먼저, 없으면 LSP)해 없는 것만 설치 — wizard의 detect+multiSelect를 우회. 미등록 id는 `skipped`.
- **wizard 경로**(`provision-step.ts:78-134`): `detect`로 언어 감지 → `planProvisioning`이 registry 도구 + 감지된 언어의 LSP를 후보로 모음 → 이미 있으면 표시만, 없으면 추천 체크된 채 multiSelect → 선택된 것만 설치. 감지됐지만 registry.lsp에 provisioner 없는 언어는 `unservicedLanguages`로 보고만 한다(graceful no-op, `:84-86`).

### 5-4. `installPushGateHook` — 비파괴·멱등·fail-safe (`setup.ts:544-611`)

recipe가 `push_gate`를 선언할 때만 `.git/hooks/pre-push`를 설치한다. 세 가지 안전 계약이 코드로 강제된다:

- **core.hooksPath 지시(`:549-561`)**: husky/lefthook처럼 커스텀 hooksPath가 설정돼 있으면 `.git/hooks/pre-push`를 써도 git이 무시하거나, hooksPath를 재지정하면 사용자 훅을 조용히 죽인다 — 둘 다 SAFETY 게이트의 silent failure이므로 **refuse**(안내 메시지와 함께).
- **비파괴(`:598-610`)**: 기존 non-ditto 훅은 절대 덮어쓰지 않고 `.ditto-backup`으로 한 번만 옮긴다. 백업이 이미 있으면 refuse.
- **멱등(`:592-596`)**: 우리 훅(마커 인식)이면 in-place 재작성, 재백업 안 함.

`bakeWorkspaceRoot`(`:620-632`)는 cloned sub-repo 설치 시 템플릿의 `WS_ROOT=""` 치환 라인을 신뢰 workspace 루트로 굽는다 — 치환 라인이 없으면 throw(빈 WS_ROOT면 clone 자신의 recipe를 조용히 resolve하는 위험).

### 5-5. `installResource` — 차터 refresh 상태 기계 (`setup.ts:387-455`)

marker-less AGENTS.md 차터는 `refreshCharterRegion`으로 갱신하되, 결과가 세 갈래다: `replaced`(백업 후 새로 씀→`refreshed`), `up-to-date`(조용한 no-op), `unrecognized`(사용자가 편집한 영역→그대로 두고 "couldn't refresh" 고지). `charterRefreshNotices`(`setup.ts:187-194`)가 `unrecognized`만 골라 모든 출력 경로(recipe/비대화/wizard)에서 고지한다 — `up-to-date`는 고지 안 함.

### 5-6. `discoverProjectAgents` — codex 번들 제외 (`setup.ts:284-293`)

codex는 ditto 자체 agent를 `.codex/agents`에 직접 복사하므로, provenance 헤더(`ditto agent-projection`)가 있는 번들 agent를 제외해 사용자가 직접 쓴 agent만 surface한다(`discoverCodexAgents:258-278`, `:271`). both 호스트는 claude+codex를 합치되 이름 충돌은 claude 우선 dedupe(`:291-292`).

---

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위(위에 인용한 파일들의 정적 읽기; 실행·테스트는 이 조사에서 돌리지 않음 — **미검증**):

- **의도대로 동작하는 것으로 읽히는 지점:** TTY 판별→기본값, recipe-우선 라우팅, submodule fail-closed, push-gate 3중 안전, AGENTS.md/CLAUDE.md 순서 강제, 우아한 강등(모든 프로비저너 fail-soft).
- **주의할 비대칭:** `--tools`는 **비대화 경로에서만** 도구를 설치한다(`setup.ts:557-559`). recipe 경로는 `recipe.tools`로, wizard 경로는 multiSelect로 도구를 다룬다 — 세 경로가 도구 설치 트리거를 각각 다르게 가진다. 재설계 시 이 세 트리거의 통일 여부가 고려점.
- **wizard vs recipe 단계 커버리지 차이:** wizard는 memory 분리를 `confirm`으로 묻지만(`setup-wizard.ts:69`), recipe 경로는 `github 백로그 seed`를 추가로 처리한다(`runRecipeSetup:165-176`). 즉 두 경로가 **완전히 동형은 아니다** — github seed는 recipe 경로 전용. 이는 의도된 것으로 보이나(seed는 recipe.backlog 선언이 있어야 하므로), "wizard=recipe의 대화형 등가물"이라는 순진한 가정은 성립하지 않는다.
- **죽은 경로/불일치 발견 못 함**(확인 범위 내). LSP 감지 taxonomy(`lsp-detect.ts`)와 registry.lsp 키(`lsp-servers.ts`)의 lock-step은 주석으로만 보장되고 자동 검증은 이 조사에서 확인 못 함 — **미확인**.

---

## 7. 잠재 위험·부작용·재설계 시 고려점

**재설계 시 반드시 보존해야 할 불변식:**

1. **선택적 도구 부재가 setup을 깨뜨리지 않는다**(ADR-0018 D1). 모든 프로비저너의 fail-soft(throw 금지) 계약. 이걸 깨면 도구 미설치 환경에서 온보딩 자체가 불가능해진다.
2. **TTY 없으면 안 묻는다**(`prompt.ts`). 에이전트/CI 경로의 전제.
3. **submodule 헤드리스 거부**(`setup.ts:140-144`). 가짜 성공 방지 — 자동화 못 하는 것을 정직하게 거부.
4. **push-gate hook 비파괴/멱등/fail-safe**(`setup.ts:544-611`). 사용자의 기존 husky/lefthook 훅을 조용히 죽이지 않는다.
5. **AGENTS.md 정본, CLAUDE.md 프로젝션 순서**(`setup.ts:653-656`). 뒤집으면 doctor 계약(body sha == AGENTS.md sha)이 깨진다.
6. **3계층 격리 gitignore**(ADR-0012). 개인 좌표 config·런타임 상태가 git에 새지 않게.

**약점·확장 시 깨질 지점:**

- **동시성:** setup은 대상 프로젝트에 다수 파일을 쓴다. 같은 프로젝트에 setup을 동시에 두 번 돌리면 allowlist/scaffold는 멱등이지만 codex 플러그인 복사(`rm -rf` 후 `cp`, `setup.ts:349-351`)는 경쟁에 취약할 수 있음 — **미검증**, 재설계 시 확인 권장.
- **drift:** LSP 감지 taxonomy ↔ registry.lsp 키 ↔ resolveServer의 3자 lock-step이 주석 규율에만 의존(`lsp-detect.ts:10-13`). 키 추가 시 세 곳을 함께 바꾸지 않으면 감지됐으나 서버 미등록(`unservicedLanguages`)으로 조용히 빠진다.
- **모드 3분기 유지비:** recipe / 대화형 wizard / 비대화 fallback 세 경로가 코어 `setup()`으로 수렴하되 부수 단계(도구·agent·memory·github seed)를 각기 다르게 조립한다. 새 온보딩 단계를 추가하면 세 경로 전부를 갱신해야 하는 구조. 재설계 시 "단계 목록을 데이터로 선언하고 모드는 실행기만 다르게" 하는 방향을 재고할 수 있다(현재는 각 경로가 단계를 명령형으로 나열).
- **`--tools` 트리거 비대칭**(§6 참조). 세 경로의 도구 설치 진입점이 다른 점.
