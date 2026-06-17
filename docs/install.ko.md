# DITTO 설치

> English: [install.md](install.md)

DITTO는 로컬 Claude Code(또는 Codex) 플러그인으로 설치된다. 설치 스크립트는 **얇은
부트스트랩**이다 — `ditto` JS 런처를 번들로 만들어 `PATH`에 올리는, 그것이 존재하기 전에
반드시 일어나야 하는 두 단계만 하고, **나머지는 전부 런처 자신(`ditto setup`)에 위임**한다.
모든 단계는 멱등(여러 번 실행해도 결과가 같음)이라 안전하게 재실행할 수 있다.

> `ditto`는 네이티브 컴파일 바이너리가 아니라 **`bun`이 실행하는 이식형 JS 번들**이다.
> CLI와 훅이 동작하려면 `bun`이 `PATH`에 있어야 한다. 같은 번들이 macOS·Linux·Windows에서
> 모두 돌고, 런처만 다르다 — POSIX는 `#!/usr/bin/env bun` 셔뱅, Windows는 `bin/ditto.cmd`
> shim. 훅은 `bun "${CLAUDE_PLUGIN_ROOT}/bin/ditto"`로 호출하므로 OS별 `.exe`는 만들지 않는다.

## 사전 단계 (Prerequisites)

먼저 아래 둘을 설치한다. 둘 다 한 줄 명령으로 끝난다.

| 필요 | 이유 | 설치 방법 |
|------|------|-----------|
| **bun ≥ 1.3** | `ditto` JS 런처 번들 생성(`bun build --target=bun`) **및 런타임 실행** — `ditto`는 네이티브 바이너리가 아닌 이식형 JS라 `bun`이 `PATH`에 계속 있어야 한다. 설치 오케스트레이터도 실행. | 공식 가이드: <https://bun.sh/docs/installation> (`curl -fsSL https://bun.sh/install \| bash`). |
| **git** | DITTO가 repo 상태를 읽고, 메모리가 git 위에 산다. | 공식 다운로드: <https://git-scm.com/downloads>. macOS: `xcode-select --install` 또는 `brew install git`; Debian/Ubuntu: `sudo apt-get install git`; Windows: git-scm 설치 프로그램. |
| **Claude Code** *(또는 Codex)* | DITTO는 호스트 플러그인이다. | DITTO를 돌릴 호스트. <https://docs.claude.com/claude-code> 참고. |

설치에 필요한 건 이게 전부다. 아래의 무거운 분석 도구는 **선택**이며 wizard가 나중에
설치한다 — DITTO를 띄우는 데 필수가 아니다.

| 선택 도구 | 설치 주체 | 사용처 |
|-----------|-----------|--------|
| CodeQL CLI | `ditto setup`(도구 포함) 또는 `ditto doctor codeql --install` | `ditto codeql review`, `impact`, `boundary` (ACG 게이트) |
| Playwright / Chromium | `ditto setup`(도구 포함) 또는 `bunx playwright install chromium` | `/ditto:e2e` 실브라우저 여정 |
| 언어 서버(LSP) | `ditto setup`(도구 포함) | 감지된 언어별 LSP 서버 |

셋 다 **graceful**하다: 다운로드나 전제가 빠지면 wizard가 정확한 수동 명령을 출력하고
계속 진행한다 — 설치 자체를 실패시키지 않는다.

## 빠른 시작 (Quick start)

repo를 clone한 뒤, **DITTO가 관리할 프로젝트에** 설치한다:

```bash
git clone <ditto-repo-url> ditto
cd /path/to/your/project           # DITTO가 관리할 프로젝트
/path/to/ditto/scripts/install.sh  # 부트스트랩 후 setup wizard 실행
```

디렉터리를 옮기지 않고 대상 프로젝트를 명시할 수도 있다:

```bash
/path/to/ditto/scripts/install.sh install --target /path/to/your/project
```

**Windows (PowerShell 5+)** 에서는 `.ps1` 진입점을 쓴다:

```powershell
\path\to\ditto\scripts\install.ps1
\path\to\ditto\scripts\install.ps1 install -Target C:\path\to\your\project
```

`install.sh`는 비대화로 실행된다(`ditto setup --yes --tools`). wizard 질문에 직접
답하려면 부트스트랩 후 터미널에서 `ditto setup`을 직접 실행한다([setup wizard](#setup-wizard) 참고).

## install.sh가 하는 일

스크립트는 바이너리를 부트스트랩한 뒤 나머지를 `ditto setup`에 넘긴다:

| 단계 | 범위 | 동작 |
|------|------|------|
| 1. build | repo | `bun run build:plugin` → `dist/plugin/` (배포 단위, `bin/ditto` JS 번들 + `bin/ditto.cmd` Windows 런처 포함). |
| 2. place | global | 바이너리를 `PATH`(`~/.local/bin/ditto`)에 심링크 → 맨 `ditto …`가 동작. **Windows에서는 심링크 안 함** — 아래 주석 참고. |
| 3. delegate | project | `ditto setup --dir <target> --yes --tools` 실행 → 호스트 지침 블록 설치, `.ditto/` scaffold, `Bash(ditto:*)` allowlist, 감지된 도구 provisioning. |

**marketplace 등록 단계는 없다** — GitHub/소스 플러그인과 로컬 `dist/plugin` 개발 경로는
영속 marketplace 항목이 필요 없다.

> 대상이 **DITTO repo 자신**(self-host)이면 `ditto setup`은 프로젝트 단계를 no-op한다 —
> repo는 자기 자신의 관리 대상이 되면 안 된다.

### Windows 주석

심링크 배치(2단계)는 POSIX 전용이다. Windows에서는 런처를 번들로 만들되 `PATH`에 자동으로
올리지 않는다. 설치 후 `<ditto-repo>\dist\plugin\bin`을 `PATH`에 추가하면, 맨 `ditto` 명령이
그 안의 `ditto.cmd` shim(내부적으로 `bun "…\bin\ditto"` 실행)으로 해석된다. 설치 프로그램이
정확한 디렉터리를 출력한다. 훅도 같은 방식(`bun "${CLAUDE_PLUGIN_ROOT}/bin/ditto"`)으로
호출하므로 **`bun`이 `PATH`에 있어야** 한다. 네이티브 `.exe`는 없다 — 예전 `ditto.exe`는
실행 불가능한 셔뱅 텍스트 파일이라 Windows에서 한 번도 동작하지 않았다.

### 옵션

| 플래그 | 효과 |
|--------|------|
| `--target <dir>` (Windows는 `-Target`) | 설치 대상 프로젝트. 기본은 현재 디렉터리. |
| `--no-build` (`-NoBuild`) | 바이너리 빌드 생략(기존 것 재사용). |
| `--no-tools` (`-NoTools`) | 도구 provisioning(CodeQL/Playwright/LSP) 생략. |

DITTO repo를 자동 감지하지 못하면 `DITTO_HOME`을 repo 루트(`.claude-plugin/plugin.json`이
있는 디렉터리)로 설정한다.

## setup wizard

`ditto setup`은 프로젝트에 DITTO를 설치하는 유일 표면이다. **터미널(TTY)에서** 실행하면
대화형이고, 스크립트·CI·에이전트(비TTY)거나 `--yes`면 안전한 기본값으로 비대화 실행된다.

```bash
cd /path/to/your/project
ditto setup                 # 대화형 wizard
ditto setup --yes           # 비대화, 기본값, 도구 설치 안 함
ditto setup --yes --tools   # 비대화 + 감지된 도구 provisioning (install.sh가 쓰는 경로)
```

### wizard 질문

| # | 질문 | 선택지(기본 먼저) | 하는 일 |
|---|------|-------------------|---------|
| 1 | **Host** | `claude-code` / `codex` / `both` | 어느 호스트의 지침 블록·표면·에이전트를 설치할지. |
| 2 | **분석/언어 도구** | **감지된** 도구에 대한 다중선택 | DITTO가 소스 트리를 순회해 언어를 추론하고, 빠진 도구(CodeQL·Playwright·감지된 언어별 LSP 서버)를 미리 체크해 제시한다. 확인·토글하면 선택된 빠진 것만 설치한다. 건너뛰어도 안전 — 기능이 degrade될 뿐 깨지지 않는다. |
| 3 | **memory 저장** | `프로젝트 포함` / `별도 repo 분리` | memory SoT(`.ditto/memory/`)의 위치. 기본은 프로젝트 git에 포함. **별도 repo**를 고르면 `gitignore-독립`(기본: `.ditto/memory/`에서 `git init` + 부모 `.gitignore`에 추가) 또는 `submodule`(opt-in; 원격 선행 필요라 수동 절차 출력) 중 택. |

비대화 실행은 Host를 `--host`(기본 `claude-code`)에서 받고, `--tools`가 있을 때만 도구를
설치하며, memory는 프로젝트 포함으로 둔다.

질문 뒤 wizard는 한 줄을 고지한다: **PreToolUse 안전 훅**은 플러그인 전역으로 활성이다
(파괴적·secret 접근 류의 보수적 집합을 차단; 기본은 허용). per-project 토글이 아니라서,
정상 명령을 오탐 차단하면 `DITTO_SKIP_HOOKS=1`을 앞에 붙인다.

### ditto setup이 설치하는 것

| 파일 | 범위 | 내용 |
|------|------|------|
| `~/.claude/CLAUDE.md` · `~/.claude/AGENTS.md` | global | 전역 행동 규칙(완료 게이트, 사실 게이트, 출력 규칙). 모든 프로젝트에 적용. |
| `<target>/CLAUDE.md` · `<target>/AGENTS.md` | project | Agent Behavior Charter. |

동작(직접 실행으로 검증됨):

- **기존 내용 보존**: 파일에 이미 있던 것은 관리 블록(`<!-- ditto:managed:start … -->`)
  밖에 그대로 남고, 첫 적용 시 `<file>.ditto_bak` 백업 생성.
- **멱등**: 재실행은 블록을 제자리 갱신, 중복 생성 안 함.
- **제거**: `ditto uninstall`은 관리 블록만 떼고 사용자 내용은 유지.
- 적용된 규칙은 **다음** 호스트 세션부터 발효.

### Codex 호스트

Codex는 플러그인 표면을 먼저 빌드한다:

```bash
bun run build:codex-plugin
ditto setup --host codex
```

Codex 분기는 빌드된 플러그인을 `<target>/.agents/plugins/ditto/`에 복사하고,
`<target>/.agents/plugins/marketplace.json`을 쓰고, 생성된 에이전트를
`<target>/.codex/agents/`에 설치한다. 이건 **준비된** 상태이지 활성화된 플러그인이 아니다.
`ditto setup --host codex`가 후속 명령을 출력한다:

```bash
codex plugin marketplace add /path/to/your/project
codex plugin add ditto@ditto-local
```

이를 쓰려는 Codex home에서 실행한 뒤 새 Codex 세션을 시작한다. 그 전까지
`ditto doctor capability --host codex`는 `codex_plugin_needs_user_action`을 보고한다.

## 도구: CodeQL / Playwright / LSP

DITTO **런타임은 분석 도중 무거운 외부 도구를 자동 설치하지 않는다.** 빠지면 정직하게
degrade한다 — 거짓 통과를 막기 위해서다.

| 도구 | 사용처 | 부재 시 런타임 동작 |
|------|--------|---------------------|
| CodeQL CLI | `ditto codeql review` (ACG 게이트) | `doctor codeql`이 fail-close하고 분석 차단 |
| CodeQL 쿼리팩 | 분석 쿼리 | 분석 시점 자동 다운로드(별도 설치 없음) |
| Playwright/Chromium | `/ditto:e2e` 실브라우저 여정 | `result=blocked`로 degrade(가짜 통과 없음) |
| 언어 서버(LSP) | 언어 인식 기능 | 해당 언어를 미지원으로 보고, 차단 없음 |

이들은 `ditto setup`이 **opt-in**으로 설치한다(wizard 도구 질문, 또는 비대화 `--tools`).
전부 하나의 provisioner 뒤에 공유 탐지 probe(`<TOOL>_BIN` env → `PATH` →
`~/.local/share/ditto/…` ditto-managed)로 통일돼 있다.

CodeQL은 독립 opt-in 설치기도 있다(wizard를 건너뛰는 marketplace 경로용):

```bash
ditto doctor codeql --install
```

- **있으면** `already-present` 반환(탐지: `CODEQL_BIN` → PATH → gh 확장 → ditto-managed).
- **없으면** 공식 CLI 번들(github/codeql-cli-binaries)을 `~/.local/share/ditto/codeql`에
  받아 `~/.local/bin/codeql`로 심링크.
- **hard-fail 없음**: 오류 시 `failed` + 복붙 수동 명령 반환.

LSP 서버는 현재 `ditto setup --tools`로만 설치된다(ts/js·python·go·rust는 자동, Java/Kotlin
같은 무거운 서버는 수동 안내). Playwright는 `bunx playwright install chromium`으로 직접
미리 받을 수도 있다.

## Marketplace 설치/업데이트 경로

`install.sh` 대신 Claude Code 플러그인 marketplace로 설치할 수도 있다(GitHub 소스 또는
로컬 `dist/plugin` 디렉터리 소스):

```bash
claude plugin marketplace add <owner>/<repo>     # 또는 로컬 dist/plugin 경로
claude plugin install ditto@ditto-local
```

이 경로의 함정 둘(둘 다 직접 재현됨):

1. **업데이트는 `marketplace update` 필요.** 설치된 플러그인은 **복사 캐시**
   (`~/.claude/plugins/cache/…`)다. 소스가 바뀌어도 `claude plugin marketplace update
   ditto-local`을 돌리기 전까진 stale. 버전이 고정(0.0.0)이라 `claude plugin update`는 무동작.
2. **이미 설치된 플러그인에 `install`은 무동작.** 갱신하려면
   `claude plugin uninstall ditto@ditto-local` 후 다시 `install`.

이 경로는 부트스트랩의 `PATH` 배치 **와** 도구 provisioning을 건너뛴다 — 이후
`ditto setup --tools`(또는 위 opt-in 명령)를 직접 실행한다.

## 검증

대상 프로젝트에서 **새** Claude Code 세션을 시작한 뒤:

```text
/plugin            # ditto@ditto-local 목록에 있고 enabled
```

```bash
ditto doctor       # 바이너리 PATH·런타임 도달·drift 점검
```

정상 설치는 `distribution`·`capability`·`surface`가 `ok`다. DITTO repo 자신 안에서
실행하면 `permissions`/`mcp`가 `missing`/`unverified`일 수 있다 — repo는 관리 대상이 아니라
정상이다.

`ditto doctor`가 **진단** 표면이다(instructions·permissions·MCP·surface·capability·
distribution drift). advisory다 — drift를 보고하되 자동 교정하지 않는다. 교정하려면
`ditto setup`을 재실행한다(멱등 재투영).

## 세션 단위 wrapper (영속 설정 없이)

조립된 산출물 표면으로 한 세션만 DITTO를 로드하려면:

```bash
# bash/zsh — ~/.bashrc 또는 ~/.zshrc에 추가
export DITTO_HOME="/path/to/ditto"
alias ditto-claude='claude --plugin-dir "$DITTO_HOME/dist/plugin"'
```

```powershell
# PowerShell 프로필 ($PROFILE)
$env:DITTO_HOME = 'C:\path\to\ditto'
function ditto-claude { claude --plugin-dir $env:DITTO_HOME\dist\plugin $args }
```

그러면 `ditto-claude`가 그 세션에만 DITTO를 로드해 Claude Code를 띄운다. `dist/plugin`이
없으면 먼저 `bun run build:plugin`. `--plugin-dir`은 repo 루트가 아니라 `dist/plugin`(조립된
표면)을 가리켜, 소스·도그푸딩 상태가 새지 않는다.

## 업데이트 & 도그푸딩

전용 `ditto update` 명령은 없다 — **업데이트 = 부트스트랩 재실행**이다(`install.sh`는 멱등:
재빌드 + 멱등 `ditto setup`). 더해 아래 `dist/plugin` 자동 재빌드가 있다. 설치된 플러그인은
소스 트리가 아니라 `build:plugin`이 조립한 **복사본** `dist/plugin/`을 읽고, Claude Code는
플러그인을 **세션 시작 시에만** 로드한다(핫 리로드 없음). 그래서:

1. 소스 변경 후 `dist/plugin`을 **재빌드**해야 한다.
2. 재빌드를 반영하려면 **새 Claude Code 세션**이 필요하다.

DITTO는 1단계를 자동화한다:

- **Git 훅(다중 PC 동기화).** `post-merge`/`post-checkout`이 `git pull`/merge/브랜치
  전환 후 `dist/plugin`을 재빌드한다(graceful; 빌드 실패가 git을 막지 않음).
  `bun install`(`prepare`가 `core.hooksPath`를 `.githooks/`로 지정)로 활성화.
- **개발 런처.** `bun run dev:plugin`이 재빌드 + 새 `dist/plugin`으로 Claude Code 실행을
  한 단계로.

수동이 필요하면: `bun run build:plugin`.

## 상태 & 제거

```bash
/path/to/ditto/scripts/install.sh status                       # JSON 상태 보고
/path/to/ditto/scripts/install.sh uninstall                    # 현재 디렉터리
/path/to/ditto/scripts/install.sh uninstall --target /the/project
```

uninstall은 바이너리 심링크를 제거하고 `ditto uninstall`(별칭: `teardown`)에 위임한다 — 관리 지침 블록과
allowlist 규칙을 떼되 대상의 `.ditto/` 런타임 데이터는 **보존**한다(work-item 이력·메모리).

`.ditto/`까지 삭제하려면(비가역 — work-item 이력·메모리 영구 삭제):

```bash
ditto uninstall --purge                 # 대상 프로젝트에서
```

`--purge`는 명시해야 한다; 터미널에서 `ditto uninstall`은 먼저 확인을 묻는다(기본: 보존).
