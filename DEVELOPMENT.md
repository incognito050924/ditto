# 개발 / Dogfooding

ditto를 개발하면서 **개발 중인 그 ditto를 그대로 사용**하는 방법이다. 코드를 고치면 바로 그 코드가 동작에 반영된다.

ditto는 두 얼굴을 가진다. dogfood도 두 갈래다.

1. **Claude Code 플러그인** — `/ditto:*` skills, agent(verifier·dialectic 등), hook(Stop·PostToolUse 등).
2. **CLI** — `ditto work`, `ditto run`, `ditto verify`, `ditto doctor` 등 터미널 명령.

---

## 1. 플러그인 dogfood — `claude --plugin-dir .`

> 권장 진입은 `bun run dogfood [--host claude|codex]`(ADR-0022) — 워킹트리를 host별로 로드하고 SessionStart 모드 배너(`mode-doctor`)로 dev vs stale-설치본을 알린다. 아래 `--plugin-dir` 설명은 그 내부 동작이다. SoT는 `scripts/dogfood.mjs`.

ditto repo 루트에서 Claude Code를 **이 플래그로 직접** 연다:

```bash
cd /path/to/ditto
claude --plugin-dir .
```

이 repo를 플러그인 소스로 직접 지정해 세션을 연다. 그 세션 안에서 개발 중인 ditto의 skills·agents·hooks가 켜진다. 배포 설치본·다른 프로젝트에는 영향이 없다(세션 단위).

bun 스크립트나 셸 함수로 감싸지 않는다 — claude는 claude로 직접 실행한다(빌드/테스트/lint 같은 bun 스크립트와 분리). 자주 쓰면 본인 셸 alias로 줄이는 건 개인 취향.

- **변경 즉시 반영**: `--plugin-dir`은 repo를 *직접 참조*한다(복사·캐시 없음). `hooks/*.ts`, `skills/`, `agents/`를 고친 뒤
  - hook/agent/skill 변경 → 세션 안에서 `/reload-plugins`
  - 더 확실하게는 세션을 새로 시작
- **이 repo에서만**: 다른 프로젝트에는 영향을 주지 않는다(세션 단위, 설정 파일을 건드리지 않음).
- 동작 확인: 세션에서 `/` 입력 시 `/ditto:` 목록이 보이거나 `/plugin`으로 `ditto`가 로드됐는지 확인.
- 세션을 열지 않고 비대화형으로 로드 검증:

  ```bash
  claude --plugin-dir . plugin details ditto
  ```

  `Source: ditto@inline` 과 함께 Skills(6: autopilot·deep-interview·dialectic·dialectic-review·handoff·verify),
  Agents(8), Hooks(4) 인벤토리가 나오면 정상이다. 각 skill이 `/ditto:<skill>` 명령으로 뜬다.
- 비대화형으로 skill까지 끝까지 돌리려면 `claude --plugin-dir . --dangerously-skip-permissions -p "/ditto:verify <id>"` (print 모드는 권한 프롬프트에 답할 수 없어 권한 스킵이 없으면 도구 사용 skill에서 멈춘다). **주의**: 권한 스킵은 일회성 데모/자동화용이고, 실제 work item에 돌리면 `completion.json`이 갱신되니 데모 후 `git restore`로 되돌릴 것.

> hook은 `bun run "${CLAUDE_PLUGIN_ROOT}/hooks/*.ts"`로 **소스를 직접 실행**한다. 그래서 hook 동작을 바꿔도 `bun build`가 필요 없다.

## 2. CLI dogfood — `bun run dev <args>`

CLI는 빌드 산출물(`dist/ditto`) 대신 소스를 직접 실행하면 항상 최신이다.

```bash
bun run dev --help
bun run dev work status
bun run dev doctor
```

`dist/ditto`(빌드본)는 stale될 수 있으니 개발 중에는 `bun run dev`를 쓴다. 배포용 바이너리가 필요할 때만 `bun run build`.

자주 쓰면 셸 alias가 편하다:

```bash
# ~/.zshrc
alias dittod='bun run --cwd <repo-root> dev'   # <repo-root> = 이 저장소를 clone한 절대경로
```

### skills/agents의 CLI 호출 — `${CLAUDE_PLUGIN_ROOT}/bin/ditto`

skills·agents 본문의 **실행되는** CLI 호출은 `"${CLAUDE_PLUGIN_ROOT}/bin/ditto" autopilot next-node`처럼 **플러그인 루트 절대경로**를 쓴다(`hooks/hooks.json`과 동일 패턴). `${CLAUDE_PLUGIN_ROOT}`는 셸 환경변수가 **아니라** Claude Code가 skill/agent 본문을 모델에 넘기기 **전에 inline 치환**하는 토큰이다(로드 시점에 로드된 플러그인 루트의 절대경로로 교체됨 — `--plugin-dir` 이든 github 설치든 동일). 그래서 모델은 절대경로를 그대로 Bash에 실행한다.

> 산문 언급(예: "intent-drift 게이트(`ditto autopilot intent-drift`)")은 실행되지 않으므로 브랜드명 bare `ditto`로 남긴다 — 실행 라인만 절대경로다.

**왜 bare `ditto`가 아닌가 (중요):** Claude Code는 설치된 플러그인의 `bin/`을 PATH **끝에 append**한다(바이너리 `ZF7`: `[기존PATH, ...플러그인bin]`, prepend 없음·설정 불가). macOS에는 `/usr/bin/ditto`(OS 아카이브 유틸)가 있어 `/usr/bin`(PATH 앞쪽)이 append된 플러그인 bin을 **이긴다** → 깨끗한 macOS 사용자에게 bare `ditto`는 OS 유틸로 가서 조용히 깨진다. `${CLAUDE_PLUGIN_ROOT}/bin/ditto` 절대경로는 PATH 순서와 무관하므로 이 충돌을 원천 회피한다. (codex 플러그인도 skills/agents에서 동일하게 `${CLAUDE_PLUGIN_ROOT}/scripts/...`를 쓴다.)

**로컬 dev:** `claude --plugin-dir .`(repo 루트 = 플러그인 루트, alias `ccd`)로 띄우면 `${CLAUDE_PLUGIN_ROOT}`가 repo 루트로 치환된다. `src/`(CLI/훅 로직)를 고쳤으면 `bun run build:bin`으로 repo 루트 `bin/ditto` 번들을 갱신한다(skills/agents/hooks 편집은 소스 그 자체라 빌드 불필요).

---

## marketplace 설치(`install-plugin.mjs`)를 dogfood에 쓰지 않는 이유

`scripts/install-plugin.mjs`는 `~/.claude/settings.json`에 marketplace를 등록해 **모든 세션에 영구 설치**한다. 이건 **배포/일반 사용**용이다.

dogfood에 부적합한 이유:
- marketplace로 로드된 플러그인은 `~/.claude/plugins/cache/`로 **복사**된다 → 소스를 고쳐도 재설치 전까지 반영되지 않는다.
- 글로벌이라 다른 모든 프로젝트에도 켜진다.

개발 중에는 `--plugin-dir`(즉시 반영·격리)이 맞고, install 스크립트는 "다 만든 ditto를 평소에 쓰고 싶을 때" 쓴다.

---

## 배포 / 설치 — npx 한 줄 (다른 프로젝트·일반 사용)

남이(또는 본인이 ditto repo 밖에서 평소 쓰려고) 설치할 때는 **npm publish 없이 GitHub 소스**로 한 줄이다 — Claude Code 플러그인과 전역 `ditto` CLI를 둘 다 멱등(여러 번 돌려도 결과 같음) 설치/갱신/삭제한다. 진입점은 단 하나(`scripts/npx-bootstrap.mjs`, package.json `bin`)이고 **verb는 아래 3개뿐**이다 — 다른 인자는 usage 출력 후 exit 64.

```bash
npx github:incognito050924/ditto install     # 플러그인 + 전역 CLI + (cwd가 git repo면) 프로젝트 setup
npx github:incognito050924/ditto update      # 최신으로 갱신
npx github:incognito050924/ditto uninstall   # 플러그인 + 전역 CLI 제거 (프로젝트 .ditto 보존)
```

### verb별 — 구체적으로 뭘 하나 / 언제 쓰나

진입점이 매번 하는 일은 세 갈래다: **plugin**(=`claude plugin …`로 위임, Claude Code가 github에서 클론·관리) + **cli**(=커밋된 `bin/ditto` 번들을 `~/.local/share/ditto/bin`에 복사 후 `~/.local/bin/ditto`로 심링크) + **setup**(=cwd가 git repo면 방금 심은 ditto로 `ditto setup --dir <cwd> --yes` 실행 → 그 프로젝트 `.ditto/` scaffold). setup 덕에 `npx … install` 한 줄이 전역+프로젝트까지 끝낸다. 각 verb는 이 갈래들을 다르게 다룬다.

| verb | plugin 갈래 | cli 갈래 | setup 갈래 | 언제 쓰나 |
|---|---|---|---|---|
| `install` | marketplace 있으면 `update`·없으면 `add`, plugin 있으면 `update`·없으면 `install` | `bin/ditto` 복사 + 심링크 | cwd가 git repo면 `ditto setup`(best-effort, 실패는 경고) | **처음 설치**. 멱등이라 깨진 설치 **복구·재설치**에도 그대로 다시 돌리면 됨 |
| `update` | marketplace 무조건 `update`, plugin 있으면 `update`·없으면 `install`(fallback) | 번들 다시 복사 + 심링크 | install과 동일 | **이미 깔려 있고** 최신 main 산출물로 올릴 때 |
| `uninstall` | plugin·marketplace 제거(tolerant — 없으면 skip) | **우리가 심은** 심링크·`~/.local/share/ditto`만 제거 | — (프로젝트 `.ditto/`는 안 건드림; 데이터까지 지우려면 프로젝트에서 `ditto uninstall --purge`) | 플러그인+전역 CLI 모두 제거할 때 |

- 안전장치: `uninstall`/`install`은 우리가 심지 않은 `ditto`(예: 개발자의 dogfood 심링크 `→ dist/plugin/bin/ditto`, 또는 사용자가 직접 둔 바이너리)는 **건드리지 않는다** — 그 경우 CLI 갈래만 건너뛰고 경고하며, 플러그인은 그대로 설치됨(`npx-bootstrap.mjs:107-117`, `:126-132`).
- 전제: `claude`(Claude Code CLI)가 PATH에 없으면 **exit 2로 중단**(`requireClaude`). 런타임은 `bun`(≥1.3)이 필요 — 없으면 경고만 하고 진행(설치 자체는 됨), CLI 실행 시점에 막힌다.
- 검증: install/update 성공 후 안내대로 새 Claude Code 세션에서 `/plugins`(ditto enabled·0 errors) + `ditto doctor`로 확인.
- Windows: 심링크가 POSIX 전용이라 복사만 되고, `~/.local/share/ditto/bin`을 PATH에 직접 추가하라고 안내한다(`:103-104`).
- `install-plugin.mjs`는 **로컬 repo 경로**(install.sh가 위임) — 작업 트리에서 빌드해 설치한다. npx와 같은 프로젝트 setup을 하지만 GitHub 소스가 아니라 로컬 clone을 쓴다.

> 동작 권위는 코드다. 위 표는 `scripts/npx-bootstrap.mjs`(install→`doInstall`, update→`doUpdate`, uninstall→`doUninstall`)의 사실을 담은 것이고, 분기·메시지가 바뀌면 그 파일이 SoT다(charter §4-11).

## 배포 기준 — 언제 rebuild / push / reinstall / update 하나 (단일출처: ADR-0022)

| 상황 | 한다 | SoT |
|---|---|---|
| `src/`·skills·agents·hooks 고치고 dogfood 검증 | 아무것도 안 함 — `bun run dogfood`(플러그인) / `bun run dev`(CLI)가 소스 직접 로드 | `dogfood.mjs` |
| 배포 번들·버전 올리기 | `node scripts/release.mjs <major\|minor\|patch>` — 4 touchpoint 버전 + `bin/ditto` 재빌드 + commit + tag (**push 안 함**) | `release.mjs` |
| 게시(배포) | `git push && git push origin v<X.Y.Z>` — 깨끗한 트리 + 전체 green일 때만 (ADR-0022 게이트 ⑤) | git |
| 배포 후 스모크 | throwaway `CLAUDE_CONFIG_DIR`/`HOME`에 `npx github:… install` → enabled + `ditto --version` 확인 | `npx-bootstrap.mjs` |
| 소비자 갱신 | `npx github:… update` (= `marketplace update ditto-local` + `/plugin update`) | `npx-bootstrap.mjs` |
| 지금 내 모드·신선도·배포 액션 확인 | `ditto mode` (`--output json`) | `mode-doctor` |
| 세션이 stale 설치본을 잡음 | `bun run dogfood`로 재시작(워킹트리 로드) | SessionStart `mode-doctor` 배너 |

판정의 권위는 코드다: 신선도는 `ditto doctor distribution`(src-stamp + 표면-stamp)과 SessionStart `mode-doctor`가, 배포 lifecycle 결정은 ADR-0022가 박는다. 이 표는 사실을 복제하지 않고 그 SoT를 가리킨다(charter §4-11, drift 방지).

## 검사 자동화 (이미 걸려 있음)

- **커밋할 때**: pre-commit hook이 `bun run lint`를 돌려 lint 미통과 커밋을 막는다(`.githooks/pre-commit`, `bun install` 시 자동 활성화).
- **push/PR 할 때**: GitHub Actions(`.github/workflows/ci.yml`)가 서버에서 `bun run lint`를 다시 강제한다.
- 로컬 전체 검증: `bun test` (일부 테스트는 환경의존이라 CI 게이트에는 아직 미포함 — `ci.yml` 주석 참조).

---

## 한 줄 요약

개발 중 ditto를 쓰려면 — 플러그인은 `bun run dogfood`, CLI는 `bun run dev`. 둘 다 소스를 직접 읽으므로 고친 코드가 바로 동작한다.
