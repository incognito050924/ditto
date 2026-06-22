# ADR-0022: ditto 자기호스팅 도그푸딩·배포 생애주기 — 단일 repo dev+dogfood + 결정적 진입 + 게이트 배포

- 상태: accepted
- 결정 일자: 2026-06-22
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: ADR-0011 (Distribution 횡단 배포계약·session-rooting), ADR-0012 (3계층 격리·배포 표면=dist/plugin), ADR-0016 (dual-host — hooks는 양 호스트 공유), `scripts/dogfood.mjs`, `src/core/mode-doctor.ts`, `src/hooks/session-start.ts`, `src/core/setup.ts`(codexHome). 메모리: dogfood-vs-ditto-adr-scope(이 결정은 제품 동작이 아니라 repo 거버넌스), ditto-global-plugin-refresh(세션-freeze 실측).

## 컨텍스트

ditto는 자기 자신을 만들며 동시에 자기 자신으로 도그푸딩한다. 이 둘이 엉켜 반복 마찰을 낳았다 — 대표 사건: 한 세션이 워킹트리가 아니라 **stale 설치본(plugin cache 0.0.0)**을 로드해, 편집이 반영되지 않는 줄 모르고 작업하다 도중에야 발견. 게다가 #1 배포 갱신(uninstall→install)이 0.0.0을 고아로 만들어 그 경로에 고정된 라이브 세션의 모든 훅이 깨졌다.

핵심 사실:

- **분리축은 "플러그인 로드 경로(워킹트리 vs 설치본)"이지 git 브랜치가 아니다.** 브랜치를 나눠도 plain 세션은 여전히 stale 설치본을 잡는다.
- **세션-freeze는 불변 제약이다.** Claude Code는 subagent/skill 정의를 세션 시작 시 고정한다. config·branch로 못 바꾼다 — 정의 변경 검증은 항상 *새 세션*이 필요하다.
- 사용자는 도그푸딩을 ditto **자신**으로 한다(ditto로 ditto를 개발). 즉 도그푸딩 = 실제 자기개발이라 별도 "테스트 상태" 격리가 불필요하다.
- stable ditto는 폴더가 아니라 **npx 설치본**으로 다른 프로젝트(또는 사용자가 일반 사용 시)에 깔린다 — ditto repo 폴더로 상주할 이유가 없다.

## 결정

1. **단일 repo = dev+dogfood 환경.** ditto 소스 repo 한 곳이 개발·도그푸딩 장소다. 별도 clone·worktree를 상주시키지 않는다. stable은 npx 설치본(repo 밖)이다.
2. **결정적 진입 — `bun run dogfood [--host claude|codex]`.** 워킹트리 빌드를 host별로 로드한다. claude=무상태(`--plugin-dir <repoRoot>`), codex=유상태(격리 `CODEX_HOME`에 local marketplace 등록+install; codex엔 `--plugin-dir` 등가물 없음). 외울 플래그가 없어 "관습"이 아니라 명령이 보장한다.
3. **안전망 — SessionStart 배너(mode-doctor).** repo에서 세션이 열릴 때 어느 플러그인을 로드했는지 알린다. dev→확인, stale 설치본→경고+`bun run dogfood`, 비-ditto 프로젝트→침묵. 설치본 vs 워킹트리는 src-stamp + **표면-stamp(agents/skills/hooks)** 2축으로 비교한다(후자는 `doctor distribution`의 `binary_fresh` 사각을 메운다).
4. **격리.** 도그푸딩은 사용자의 실제 환경을 양방향으로 오염시키지 않는다. codex는 `CODEX_HOME`을 격리 디렉터리로 돌리고, `ditto setup`도 그 `CODEX_HOME`을 존중해 글로벌 AGENTS.md까지 격리 home에 쓴다(실제 `~/.codex` 불가침).
5. **게이트된 배포(승격).** 변경은 dogfood→main 머지 → 릴리스 빌드 → 배포 → **throwaway에 방금 배포한 산출물을 스모크 검증**(에이전트 spawn / mode 신선도) → 통과해야 stable. 깨진 빌드가 조용히 stable이 되지 못한다. (스모크 게이트·npx 배포 구현은 후속 work item.)

견고함은 폴더 분리가 아니라 **진입 결정성 + 격리 + 게이트 배포**에서 온다.

## 기각된 대안

- **별도 clone(상주):** 두 작업트리를 항상 push/pull로 동기화해야 한다. 도그푸딩=자기개발이라 격리할 별도 상태가 없으므로 동기화 부담만 남는다.
- **git worktree:** `.git`을 공유해 격리가 clone보다 약하다. (가벼움이 기준이면 채택했겠으나 사용자는 견고함을 우선했다.)
- **설치 채널 canary/stable:** 마켓플레이스 항목·버전을 두 벌 관리하고, 세션-freeze·재설치 사이클이 그대로라 문제를 다 풀지 못하며 설정이 복잡하다.
- **브랜치 분리:** 축이 틀렸다(위 컨텍스트).

## 철회 조건

- 도그푸딩 대상이 ditto **자신**이 아니라 외부 프로젝트로 확장되면(ditto를 남의 코드베이스에 돌려보는 폭) → 별도 소비자 환경(분리 상태)을 재검토한다.
- 배포 채널을 GitHub-소스 npx에서 **npm 레지스트리**로 전환하면 → 배포 표면(5번)만 부분 재검토한다. 단일-repo(1)·진입(2)·안전망(3)·격리(4) 결정은 불변이다.
- Claude Code/codex가 세션-freeze를 푸는 라이브-reload를 제공하면 → 결정적 진입(2)의 "새 세션 필요" 전제를 재검토한다.
