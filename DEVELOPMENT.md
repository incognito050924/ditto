# 개발 / Dogfooding

ditto를 개발하면서 **개발 중인 그 ditto를 그대로 사용**하는 방법이다. 코드를 고치면 바로 그 코드가 동작에 반영된다.

ditto는 두 얼굴을 가진다. dogfood도 두 갈래다.

1. **Claude Code 플러그인** — `/ditto:*` skills, agent(verifier·dialectic 등), hook(Stop·PostToolUse 등).
2. **CLI** — `ditto work`, `ditto run`, `ditto verify`, `ditto doctor` 등 터미널 명령.

---

## 1. 플러그인 dogfood — `bun run dogfood`

repo 루트에서:

```bash
bun run dogfood        # = claude --plugin-dir .
```

이 repo를 **플러그인 소스로 직접 지정**해 Claude Code 세션을 연다. 그 세션 안에서 개발 중인 ditto의 skills·agents·hooks가 켜진다.

- **변경 즉시 반영**: `--plugin-dir`은 repo를 *직접 참조*한다(복사·캐시 없음). `hooks/*.ts`, `skills/`, `agents/`를 고친 뒤
  - hook/agent/skill 변경 → 세션 안에서 `/reload-plugins`
  - 더 확실하게는 세션을 새로 시작
- **이 repo에서만**: 다른 프로젝트에는 영향을 주지 않는다(세션 단위, 설정 파일을 건드리지 않음).
- 동작 확인: 세션에서 `/` 입력 시 `/ditto:` 목록이 보이거나 `/plugin`으로 `ditto`가 로드됐는지 확인.

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
alias dittod='bun run --cwd /Users/incognito/dev/projects/ditto dev'
```

---

## marketplace 설치(`install-plugin.mjs`)를 dogfood에 쓰지 않는 이유

`scripts/install-plugin.mjs`는 `~/.claude/settings.json`에 marketplace를 등록해 **모든 세션에 영구 설치**한다. 이건 **배포/일반 사용**용이다.

dogfood에 부적합한 이유:
- marketplace로 로드된 플러그인은 `~/.claude/plugins/cache/`로 **복사**된다 → 소스를 고쳐도 재설치 전까지 반영되지 않는다.
- 글로벌이라 다른 모든 프로젝트에도 켜진다.

개발 중에는 `--plugin-dir`(즉시 반영·격리)이 맞고, install 스크립트는 "다 만든 ditto를 평소에 쓰고 싶을 때" 쓴다.

---

## 검사 자동화 (이미 걸려 있음)

- **커밋할 때**: pre-commit hook이 `bun run lint`를 돌려 lint 미통과 커밋을 막는다(`.githooks/pre-commit`, `bun install` 시 자동 활성화).
- **push/PR 할 때**: GitHub Actions(`.github/workflows/ci.yml`)가 서버에서 `bun run lint`를 다시 강제한다.
- 로컬 전체 검증: `bun test` (일부 테스트는 환경의존이라 CI 게이트에는 아직 미포함 — `ci.yml` 주석 참조).

---

## 한 줄 요약

개발 중 ditto를 쓰려면 — 플러그인은 `bun run dogfood`, CLI는 `bun run dev`. 둘 다 소스를 직접 읽으므로 고친 코드가 바로 동작한다.
