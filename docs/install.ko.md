# DITTO 설치

> English: [install.md](install.md)

DITTO는 Claude Code(또는 Codex) 플러그인으로 설치된다. **한 줄이면** 플러그인,
전역 `ditto` CLI, 프로젝트의 `.ditto/` 작업공간이 한 번에 깔린다. 모든 단계는
멱등(여러 번 실행해도 결과가 같음)이라 안전하게 재실행할 수 있다.

> `ditto`는 네이티브 바이너리가 아니라 **`bun`이 실행하는 이식형 JS 번들**이라,
> `bun`이 `PATH`에 계속 있어야 한다. 같은 번들이 macOS·Linux·Windows에서 모두 돈다.

## 사전 준비

먼저 아래 셋을 설치한다 — 둘은 한 줄 명령으로 끝난다.

| 필요 | 이유 | 방법 |
|------|------|------|
| **bun ≥ 1.3** | `ditto` CLI와 훅을 실행(네이티브가 아닌 이식형 JS). | <https://bun.sh/docs/installation> (`curl -fsSL https://bun.sh/install \| bash`) |
| **git** | DITTO가 repo 상태를 읽고, 메모리가 git 위에 산다. | <https://git-scm.com/downloads> · macOS `brew install git` · Ubuntu `sudo apt-get install git` |
| **Claude Code** *(또는 Codex)* | DITTO는 호스트 플러그인이다. | <https://docs.claude.com/claude-code> |

무거운 분석 도구(CodeQL / Playwright / LSP)는 **선택**이고 나중에 추가한다 — DITTO를
띄우는 데 필수가 아니다. [선택 도구](#선택-도구) 참고.

## 설치

DITTO가 관리할 프로젝트(git repo) 안에서 **한 줄**을 실행한다 — `npx`가 GitHub 소스를
바로 받아온다(clone 불필요, npm publish 없음):

```bash
npx github:incognito050924/ditto install
```

Claude Code 플러그인 + 전역 `ditto` CLI를 설치하고 프로젝트의 `.ditto/`를 scaffold한다.
**git repo 밖에서** 실행하면 전역 플러그인만 깔리니, 그 뒤 프로젝트로 `cd`해서
`ditto setup`을 실행한다.

### 대안: Claude Code 마켓플레이스

플러그인 마켓플레이스를 선호하면 GitHub 소스에서 바로 설치한다:

```bash
claude plugin marketplace add incognito050924/ditto
claude plugin install ditto@ditto-local
```

이 경로에서 알아둘 둘:

- **업데이트 전에 마켓플레이스 갱신이 먼저다.** 설치본은 복사 캐시라, Claude Code는
  플러그인 `version`이 바뀔 때만 새 버전을 인식한다. `claude plugin marketplace update
  ditto-local` 후 `/plugin update`.
- 이 경로는 `ditto` CLI의 `PATH` 배치 **와** 도구 provisioning을 **건너뛴다** — 이후
  `ditto setup --tools`를 직접 실행한다.

### Codex 호스트

Codex도 지원하지만, 플러그인 표면을 repo 체크아웃에서 빌드한다:
`bun run build:codex-plugin` 후 `ditto setup --host codex`, 그다음 출력되는
`codex plugin add ditto@ditto-local` 명령(그리고 새 Codex 세션).

## setup 마법사

`ditto setup`은 한 프로젝트에 DITTO를 설치한다. 터미널에서는 **대화형 마법사**로 돌고,
`--yes`(또는 비TTY — 스크립트·에이전트)면 안전한 기본값으로 비대화 실행된다. npx 설치는
`ditto setup`을 대신 돌려주니, 전역 플러그인만 깔았거나 재적용할 때 직접 실행한다.

```bash
cd /path/to/your/project
ditto setup                 # 대화형
ditto setup --yes           # 비대화 기본값 (도구 설치 안 함)
ditto setup --yes --tools   # + 감지된 도구 provisioning
```

질문은 셋이다(기본값 먼저): **Host**(`claude-code` / `codex` / `both`) ·
**분석 도구**(*감지된* CodeQL / Playwright / LSP 다중선택) ·
**memory 저장**(`프로젝트 포함` / `별도 repo`).

설치되는 것:

| 파일 | 범위 | 내용 |
|------|------|------|
| `~/.claude/CLAUDE.md` · `~/.claude/AGENTS.md` | global | 전역 행동 규칙(모든 프로젝트에 적용). |
| `<project>/CLAUDE.md` · `<project>/AGENTS.md` | project | Agent Behavior Charter. |

프로젝트에 `Bash(ditto:*)` allowlist도 추가한다. 기존 내용은 **보존**된다 — DITTO는
`<!-- ditto:managed:start … -->` 블록 안에만 쓰고, 파일을 `<file>.ditto_bak`으로 한 번
백업한다. 재실행은 그 블록을 **제자리 갱신**한다(중복 생성 안 함). 규칙은 **다음** 호스트
세션부터 발효한다.

## 선택 도구

CodeQL, Playwright/Chromium, 언어 서버는 **opt-in**이다 — 마법사의 도구 질문이나
`--tools`로 설치한다. DITTO는 분석 도중 이들을 자동 설치하지 않고, 빠지면 가짜 통과
대신 **정직하게 degrade**한다:

| 도구 | 사용처 | 부재 시 |
|------|--------|---------|
| CodeQL CLI | `ditto codeql review` (ACG 게이트) | fail-close, 분석 차단 |
| Playwright / Chromium | `/ditto:e2e` 브라우저 여정 | `result=blocked` |
| 언어 서버(LSP) | 언어 인식 기능 | 해당 언어 미지원 보고(차단 없음) |

언제든 추가: `ditto setup --tools`, 또는 직접 `ditto doctor codeql --install` /
`bunx playwright install chromium`.

## 검증

대상 프로젝트에서 **새** Claude Code 세션을 시작한 뒤:

```text
/plugin            # ditto@ditto-local 목록에 있고 enabled
```

```bash
ditto doctor       # 바이너리 PATH·런타임 도달·drift 점검
```

정상 설치는 `distribution`·`capability`·`surface`가 `ok`다. (DITTO repo 자신 안에서
실행하면 `permissions`/`mcp`가 `missing`/`unverified`일 수 있다 — repo는 관리 대상이
아니라 정상.) `ditto doctor`는 advisory다. drift 교정은 `ditto setup` 재실행.

## 업데이트

```bash
npx github:incognito050924/ditto update      # 플러그인 + 전역 CLI + setup 재실행
```

마켓플레이스 경로면 대신: `claude plugin marketplace update ditto-local` 후 `/plugin update`.

## 제거

제거는 **두 층**이다 — 어디까지 지울지 고른다:

```bash
# 한 프로젝트에서만 (전역 플러그인 + CLI는 유지):
ditto uninstall            # 관리 블록 + allowlist 제거, .ditto/ 보존
ditto uninstall --purge    # .ditto/까지 삭제 — work-item 이력 + 메모리 (비가역)

# 전역 호스트 설치 (플러그인 + 전역 ditto CLI):
npx github:incognito050924/ditto uninstall   # 각 프로젝트의 .ditto/는 그대로 둠
```

`--purge`는 명시해야 한다; 터미널에서 `ditto uninstall`은 먼저 확인을 묻는다(기본: 보존).

## 기여자 · 유지보수자

DITTO 자체를 개발하거나, 로컬 clone에서 돌리거나, 새 버전을 배포하는 경우?
그 절차는 **[DEVELOPMENT.md](../DEVELOPMENT.md)**에 있다.
