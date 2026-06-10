# DITTO 설치

> English guide: [install.md](install.md)

DITTO는 로컬 Claude Code 플러그인으로 설치됩니다. 오케스트레이터 스크립트
하나가 플러그인 등록, 자체 포함형 CLI/훅 바이너리 빌드, `PATH` 등록, 그리고
지정한 프로젝트의 스캐폴딩까지 처리합니다. 모든 단계는 멱등(idempotent)이라
다시 실행해도 안전합니다.

## 사전 요구사항

| 요구사항 | 이유 | 비고 |
|----------|------|------|
| **bun ≥ 1.3** | 자체 포함형 `ditto` 바이너리 빌드(`bun --compile`)에 필요. | `node`만으로도 설치 스크립트는 돌지만, 바이너리 빌드에는 bun이 필요합니다. <https://bun.sh> |
| **Claude Code** | DITTO는 Claude Code 플러그인입니다. | 플러그인은 `~/.claude/settings.json`에 등록됩니다. |
| **git** | DITTO가 저장소 상태를 읽습니다. | 개발 환경이면 이미 있습니다. |
| curl + unzip *(선택)* | CodeQL CLI 자동 설치에 사용. | `ditto impact` / `boundary` / `acg-review`에서 사용. 이 단계는 graceful이라 설치를 실패시키지 않습니다. |

CodeQL과 Playwright/Chromium은 가능하면 자동 설치됩니다. 둘 다 graceful로
동작하므로, 다운로드가 실패하면 설치 스크립트가 정확한 수동 단계를 출력하고
계속 진행합니다. 자세한 동작은 아래 [의존성 모델](#의존성-모델-codeql--playwright) 참고.

## 의존성 모델: CodeQL / Playwright

DITTO **런타임은 분석 도중 무거운 외부 도구를 자동 설치하지 않습니다.** 없으면
정직하게 degrade합니다 — 의도된 설계입니다(가짜 통과 방지).

| 도구 | 쓰임 | 없을 때 런타임 동작 |
|------|------|--------------------|
| CodeQL CLI | `ditto codeql review`(ACG 게이트) | `doctor codeql`이 fail-closed로 분석 차단 |
| CodeQL 쿼리팩 | 분석 쿼리 | 분석 시 자동 다운로드(별도 설치 불필요) |
| Playwright/Chromium | `/ditto:e2e` 실제 브라우저 저니 | `result=blocked`로 degrade(가짜 pass 없음) |

도구를 **미리 까는 경로는 둘**입니다:

1. **설치 스크립트 경로** — `scripts/install.sh`가 단계 3b/3c에서 CodeQL과
   Playwright/Chromium을 graceful하게 사전 준비합니다. `--no-codeql` /
   `--no-playwright`로 건너뜁니다.
2. **마켓플레이스 경로** — `claude plugin install <plugin>@<marketplace>`로
   설치하면 install.sh를 거치지 않아 위 사전 준비가 **실행되지 않습니다.** 이때
   CodeQL은 아래 opt-in 명령으로 부트스트랩하세요.

### CodeQL CLI 설치 (opt-in)

```bash
ditto doctor codeql --install
```

- **이미 있으면** 아무것도 하지 않고 `already-present`로 끝납니다(탐지 순서:
  `CODEQL_BIN` → PATH → gh 확장 → ditto-managed).
- **없으면** 공식 CLI 번들(github/codeql-cli-binaries)을 받아
  `~/.local/share/ditto/codeql`에 풀고 `~/.local/bin/codeql`로 심링크합니다.
  쿼리팩은 첫 분석 때 자동으로 받습니다.
- **실패해도 hard-fail하지 않고** `failed` + 복붙용 수동 명령(gh 확장 / 번들
  직접)을 출력합니다. `~/.local/bin`이 PATH에 없으면 그 사실도 함께 알립니다.
  Windows는 심링크 대신 PATH 추가 안내를 줍니다.

> CodeQL이 없을 때 `doctor codeql`의 안내 메시지도 이 명령을 가리킵니다. 이
> 설치기는 설치 스크립트(단계 3b)와 **동일한 번들 소스·위치·탐지**를 씁니다 —
> 어느 경로로 깔든 ditto-managed CodeQL은 한 곳뿐입니다.

### Playwright / Chromium 설치

런타임은 브라우저를 **절대 자동 설치하지 않습니다**(`/ditto:e2e`는 없으면
`blocked`). 미리 깔려면 install.sh(단계 3c)를 쓰거나 직접 실행하세요:

```bash
bunx playwright install chromium
```

이렇게 하면 런타임 탐지가 요구하는 두 가지(bun 캐시의 `playwright-core` + ms-playwright
캐시의 full Chromium)가 모두 준비됩니다.

## 빠른 시작

저장소를 클론한 뒤, **DITTO로 관리할 프로젝트에** 설치합니다:

```bash
git clone <ditto-repo-url> ditto
cd /path/to/your/project           # DITTO가 관리할 프로젝트
/path/to/ditto/scripts/install.sh  # 현재 디렉터리에 설치
```

디렉터리를 옮기지 않고 대상을 직접 지정할 수도 있습니다:

```bash
/path/to/ditto/scripts/install.sh install --target /path/to/your/project
```

**Windows (PowerShell 5+)** 에서는 `.ps1` 진입점을 사용합니다:

```powershell
\path\to\ditto\scripts\install.ps1
\path\to\ditto\scripts\install.ps1 install -Target C:\path\to\your\project
```

## 설치 스크립트가 하는 일

| 단계 | 범위 | 동작 |
|------|------|------|
| 1. register | 전역 | `~/.claude/settings.json`을 패치해 로컬 플러그인을 로드. |
| 2. build | 저장소 | `bun run build:plugin` → `dist/plugin/` (배포 단위, `bin/ditto` 포함). |
| 3. place | 전역 | 바이너리를 `PATH`에 심링크(`~/.local/bin/ditto`)해 맨손 `ditto …` 사용 가능. **Windows에서는 심링크하지 않습니다** — 아래 노트 참고. |
| 3b. codeql | 호스트 | 기존 CodeQL CLI 재사용 또는 다운로드(graceful). |
| 3c. playwright | 호스트 | `/ditto:e2e`용 Playwright + Chromium 사전 준비(graceful). |
| 4. init | 프로젝트 | `ditto init`이 대상의 `.ditto/`를 스캐폴딩. |
| 5. allowlist | 프로젝트 | 대상 `.claude/settings.json`에 `Bash(ditto:*)`를 추가해 `ditto …`가 매번 묻지 않도록 함. |

> 대상이 DITTO 저장소 **자기 자신**일 때(self-host)는 프로젝트 단계(init /
> allowlist)를 건너뜁니다 — 저장소는 자기 자신을 관리 대상으로 삼지 않습니다.

### Windows 참고

심링크 배치(3단계)는 POSIX 전용입니다. Windows에서는 설치 스크립트가
바이너리를 빌드하지만 `PATH`에 **자동으로 올리지 않습니다.** 설치 후 아래
디렉터리를 `PATH`에 추가해야 `ditto`(및 CodeQL)가 인식됩니다:

- `<ditto-repo>\dist\plugin\bin` — `ditto.exe` 바이너리
- 설치 스크립트가 알려주는 CodeQL 디렉터리 (CodeQL을 다운로드한 경우)

추가할 정확한 디렉터리는 설치 스크립트가 출력합니다. 이 경로들이 `PATH`에
오르기 전까지는 훅과 맨손 `ditto …` 명령이 동작하지 않습니다.

### 옵션

| 플래그 | 효과 |
|--------|------|
| `--target <dir>` (Windows: `-Target`) | 설치할 프로젝트. 기본값은 현재 디렉터리. |
| `--no-build` (`-NoBuild`) | 바이너리 빌드 건너뛰기(기존 것 재사용). |
| `--no-codeql` (`-NoCodeql`) | CodeQL 설치 건너뛰기. |
| `--no-playwright` (`-NoPlaywright`) | Playwright/Chromium 설치 건너뛰기. |

DITTO 저장소를 자동 감지하지 못하면 `DITTO_HOME`을 저장소 루트
(`.claude-plugin/plugin.json`이 있는 디렉터리)로 지정하세요.

## 행동 규칙 적재 — `ditto setup` (설치 스크립트가 하지 않는 단계)

설치 스크립트의 4단계는 `ditto init`(`.ditto/` 스캐폴딩)이지 `ditto setup`이
아닙니다. **행동 규칙은 `ditto setup`을 실행해야 적재됩니다** — 설치만 마치면
플러그인 표면(스킬·에이전트·훅)은 동작하지만, 아래 관리블록은 비어 있습니다:

| 파일 | 범위 | 내용 |
|------|------|------|
| `~/.claude/CLAUDE.md` · `~/.claude/AGENTS.md` | 전역 | 전역 행동 규칙(완료 게이트·사실 게이트·출력 규칙 등). 모든 프로젝트에 적용. |
| `<대상>/CLAUDE.md` · `<대상>/AGENTS.md` | 프로젝트 | Agent Behavior Charter(행동 헌장). |

대상 프로젝트에서 실행합니다:

```bash
cd /path/to/your/project
ditto setup
```

동작 특성(직접 실행으로 검증됨):

- **기존 내용 보존**: 파일에 이미 있던 사용자 내용은 관리블록
  (`<!-- ditto:managed:start … -->`) 밖에 그대로 남고, 첫 적용 시
  `<파일>.ditto_bak` 백업이 생깁니다.
- **멱등**: 재실행해도 블록이 중복 적재되지 않고 갱신만 됩니다.
- **제거**: `ditto teardown`이 관리블록만 벗겨내고 사용자 내용은 남깁니다.
- 적재된 규칙은 **새 Claude Code 세션부터** 로드됩니다.

> self-host(대상 = DITTO 저장소 자신)에서는 setup이 통째로 건너뛰어집니다.
> DITTO 저장소에서 dogfooding하면서 **전역** 블록만 필요하면, 아무 다른
> 프로젝트(임시 디렉터리도 가능)에서 `ditto setup`을 한 번 실행하세요 — 전역
> 파일은 대상과 무관하게 같은 위치에 적재됩니다.

## 마켓플레이스 설치/갱신 경로

install.sh 대신 Claude Code 플러그인 마켓플레이스로 설치할 수도 있습니다
(GitHub 소스 또는 로컬 `dist/plugin` 디렉터리 소스):

```bash
claude plugin marketplace add <owner>/<repo>     # 또는 로컬 dist/plugin 경로
claude plugin install ditto@ditto-local
```

이 경로에는 함정이 둘 있습니다(직접 재현됨):

1. **갱신은 `marketplace update`가 필수.** 설치본은 marketplace의 **복사본
   캐시**(`~/.claude/plugins/cache/…`)입니다. 소스가 바뀌어도(push/재빌드)
   `claude plugin marketplace update ditto-local`을 돌리기 전까지 stale입니다.
   버전이 고정(0.0.0)이라 `claude plugin update`는 no-op입니다.
2. **기설치 상태의 `install`은 no-op.** "already installed"로 끝나며 캐시를
   갱신하지 않습니다. 갱신하려면 `claude plugin uninstall ditto@ditto-local`
   후 다시 `claude plugin install` 하세요.

또한 이 경로는 install.sh의 3b/3c(CodeQL·Playwright 사전 준비)와 `PATH` 배치를
건너뜁니다 — 위 [의존성 모델](#의존성-모델-codeql--playwright)의 opt-in 명령을
사용하세요.

## 확인

대상 프로젝트에서 **새** Claude Code 세션을 시작한 뒤:

```text
/plugin            # ditto@ditto-local 가 목록에 있고 enabled 인지
```

```bash
ditto doctor       # 바이너리가 PATH에 있고 런타임이 닿는지
```

정상 설치라면 `distribution`, `capability`, `surface`가 `ok`로 나옵니다.
DITTO 저장소 안에서 실행하면 `permissions` / `mcp`가 `missing` /
`unverified`로 나올 수 있는데, 저장소는 관리 대상이 아니므로 정상입니다.

## 세션 단위 래퍼 (설정 영구 변경 없이)

`settings.json`을 영구적으로 바꾸지 않으려면, 조립된 제품 표면을 통해 한
세션만 DITTO를 로드할 수 있습니다:

```bash
# bash/zsh — ~/.bashrc 또는 ~/.zshrc 에 추가
export DITTO_HOME="/path/to/ditto"
alias ditto-claude='claude --plugin-dir "$DITTO_HOME/dist/plugin"'
```

```powershell
# PowerShell 프로필 ($PROFILE)
$env:DITTO_HOME = 'C:\path\to\ditto'
function ditto-claude { claude --plugin-dir $env:DITTO_HOME\dist\plugin $args }
```

이후 `ditto-claude`를 실행하면 그 세션에서만 DITTO가 로드된 Claude Code가
뜹니다. `dist/plugin`이 없으면 먼저 `bun run build:plugin`을 실행하세요.
`--plugin-dir`는 저장소 루트가 아니라 `dist/plugin`(조립된 제품 표면)을
가리키므로, 소스나 dogfooding 상태가 새어 들어가지 않습니다.

## 업데이트 & dogfooding

설치된 플러그인은 `dist/plugin/`을 읽습니다 — 이것은 `build:plugin`이 조립한
소스의 **복사본**이지 소스 트리 자체가 아닙니다. 그리고 Claude Code는 플러그인을
**세션 시작 시점에만** 로드합니다(핫리로드 없음). 그래서 항상 두 가지가 참입니다:

1. 소스를 바꾸면 `dist/plugin`을 **다시 빌드**해야 한다.
2. 재빌드를 반영하려면 **새 Claude Code 세션**이 필요하다.

DITTO는 1번을 자동화해 손으로 빌드할 일을 거의 없앱니다:

- **Git 훅 (멀티 PC 동기화).** `post-merge`와 `post-checkout`이 `git pull` /
  merge / 브랜치 전환 후 `dist/plugin`을 자동 재빌드합니다. graceful이라 빌드
  실패가 git 작업을 막지 않으며, `bun install`로 활성화됩니다(`prepare`
  스크립트가 `core.hooksPath`를 `.githooks/`로 지정). 즉 어느 PC에서든:
  `git pull` → 자동 재빌드 → 새 세션 시작.
- **Dev 런처 (로컬 루프).** `bun run dev:plugin`이 재빌드 후 갓 만든
  `dist/plugin`으로 Claude Code를 띄우는 것까지 한 번에 합니다. 아래의 선택적
  `ditto-claude` 래퍼도 셸 함수로 동일하게 동작합니다.

어느 경우든 재빌드는 세션 시작 시점에 반영됩니다 — 세션 도중 리로드는 없습니다.
수동이 필요하면: `bun run build:plugin`.

> **검증됨.** 자동 재빌드가 실제 `git merge`·`git checkout`에서 발동하는 것(과
> 파일 체크아웃·동일 커밋 전환의 skip 가드)을 직접 실행해 확인했습니다. Windows
> (`install.ps1`)는 아직 미검증이며, 재빌드를 실제로 로드하려면 새 세션이
> 필요합니다.

## 상태 확인 및 제거

```bash
/path/to/ditto/scripts/install.sh status                        # JSON 상태 보고
/path/to/ditto/scripts/install.sh uninstall                     # 현재 디렉터리
/path/to/ditto/scripts/install.sh uninstall --target /the/project
```

uninstall은 등록, 바이너리 배치, allowlist를 되돌립니다. 대상의 `.ditto/`
런타임 데이터는 그대로 둡니다 — 이것이 work-item 이력이며, 완전히 지우려면
수동으로 제거하세요.
