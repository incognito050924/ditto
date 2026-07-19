# release — 도그푸딩 전용: 버전 범프 + 번들 재빌드 + 커밋 + 태그 + 푸시로 릴리스를 컷하는 커맨드

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋 `c2d2e16` (2026-07-19).

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto release`는 **배포(distribution) 축**에 속한다. DITTO 4축(의도/오케스트레이션/E2E/지식)이 아니라, ditto가 자기 자신을 남의 프로젝트에 배포 가능한 산출물로 승격하는 거버넌스·배포 생애주기의 마지막 단계다(ADR-0022).

풀려는 문제: DITTO는 npm 레지스트리에 publish하지 않는다. Claude Code 플러그인 마켓플레이스는 repo 트리의 파일만 서빙하고 외부 릴리스-에셋을 가져오지 않는다. 따라서 **커밋된 ~1.4MB JS 번들(`bin/ditto`)이 곧 배포 산출물이고, `version` 필드가 `/plugin update`를 구동한다**(`scripts/release.mjs:3-7`). 릴리스 = "여러 매니페스트의 버전을 한 번에 올리고 + 번들을 그 버전으로 다시 굽고 + 커밋·태그·푸시"라는 다단계 절차를, 손으로 하면 반드시 어긋나는(4곳 버전 drift, 스테일 번들) 일을 하나의 결정적 명령으로 묶는 것이다.

핵심 개념 두 가지:
- **build-stamp(빌드 신원)**: 번들은 소스가 아니라 커밋된 blob이 실행된다. 스테일 번들이 조용히 옛 정책을 강제하지 않도록, 번들에 소스 내용의 sha256 스탬프를 심어 `doctor`가 drift를 검출한다(`src/core/build-stamp.ts:5-13`).
- **fail-closed 게이트**: 이 커맨드는 소비자 설치본의 `bin/ditto` 안에도 그대로 실려 나가므로(번들은 커맨드별 제외가 없는 단일 blob), 런타임 게이트가 소비자 환경에서 릴리스를 절대 못 하게 막는 유일한 방어선이다(`src/cli/commands/release.ts:28-34`).

## 2. 코드 위치와 진입점

| 경로 | 역할 |
|---|---|
| `src/cli/commands/release.ts` | CLI 진입. 게이트 → `scripts/release.mjs` 위임 → push → 리포트 |
| `scripts/release.mjs` | 정본 릴리스 컷터(4곳 버전 범프 + `build:bin` + 커밋 + 태그). push 안 함 |
| `scripts/build-bin.mjs` | 번들러. `bin/ditto` 생성 + 소스 스탬프 삽입 + `ditto.cmd` 방출 |
| `src/core/build-stamp.ts` | 소스 스탬프 계산/추출. `doctor`의 `binary_fresh` drift 검출용 |
| `src/core/mode-doctor.ts` | `isDittoSourceRepo()` — 게이트가 소비자/소스 repo를 판별 |
| `src/core/plugin-root.ts` | 플러그인 루트 탐색(release가 직접 쓰진 않음; doctor·설치 검증용) |

주의: 스코프 힌트가 지목한 `src/core/release.ts`는 **존재하지 않는다**(미확인이 아니라 확인함 — `ls`로 부재 확인). 핵심 로직은 CLI 파일과 `scripts/release.mjs`에 나뉘어 있다.

서브커맨드 없음. 인자(`src/cli/commands/release.ts:80-93`):

| 인자 | 타입 | 기본 | 의미 |
|---|---|---|---|
| `bump` | positional(필수) | — | `major` \| `minor` \| `patch` \| `X.Y.Z` |
| `--dry-run` | boolean | false | 계획만 출력, 아무것도 안 바꿈 |
| `--no-push` | boolean | false | 커밋+태그까지만, push 안 함(push가 기본) |
| `--output` | string | human | `human` \| `json` |

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

```
ditto release <bump> [--dry-run] [--no-push]
  │
  ├─ resolveRepoRootForCreate()           repoRoot 확정
  ├─ releaseGateError({isSourceRepo, dirty, dryRun})   ← FAIL-CLOSED, 최우선
  │     isSourceRepo=false → 거부(소비자 설치 보호)
  │     !dryRun && dirty   → 거부(버전-전용 커밋 보장)
  │
  ├─ node scripts/release.mjs <bump> [--dry-run]       ← 정본 컷터에 위임
  │     1. package.json에서 현재 버전 읽고 next 계산
  │     2. drift 가드: 4 touchpoint가 모두 같은 현재 버전인지 검사
  │     3. 4곳에 next 기록(surgical regex):
  │          package.json, .claude-plugin/plugin.json,
  │          .codex-plugin/plugin.json, src/cli/index.ts
  │     4. bun run build:bin → bin/ditto 재빌드(+스탬프) + bin/ditto.cmd
  │     5. git add {4파일 + bin/ditto + bin/ditto.cmd} → commit "release: vX.Y.Z" → tag vX.Y.Z
  │
  ├─ (dry-run이면 여기서 종료: 아무것도 안 바뀜)
  │
  ├─ git push  &&  git push origin vX.Y.Z              ← --no-push 아니면
  │     push는 .githooks/pre-push가 recipe.yaml push-gate(전체 bun test) 실행
  │
  └─ 리포트(human|json): version, tag, pushed + 소비자 업데이트 안내
```

읽고 쓰는 상태:
- 입력: `package.json`의 `version`(SoT), 나머지 3 touchpoint(범프 대상이자 drift 가드 검사 대상).
- 출력(커밋 대상): 4개 버전 매니페스트 + `bin/ditto` + `bin/ditto.cmd`. 이것이 유일한 배포 채널(마켓플레이스가 repo 트리를 서빙).
- 로컬 상태 파일(`.ditto/...`)은 읽거나 쓰지 않는다. zod 스키마도 관여 안 함 — 이 커맨드의 "계약"은 스키마가 아니라 매니페스트 정규식·게이트 술어다.

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

**(a) 순수 precondition 게이트 + fail-closed (`src/cli/commands/release.ts:35-46`).**
`releaseGateError`는 부수효과 없는 순수 함수로 `{isSourceRepo, dirty, dryRun}`만 받아 거부 사유 문자열 또는 null을 반환한다. 순수하게 뽑은 이유는 테스트 가능성(`tests/cli/release.test.ts:10-27`이 4조합을 단위 검증)과, 어떤 mutation·child process보다 **먼저** 판정하기 위함(`:101` 주석 "before any mutation or child process"). `isSourceRepo`에서 fail-closed인 이유는 §1에 인용: 번들이 소비자에게 통째로 나가므로 이 런타임 게이트만이 소비자 릴리스를 막는다.

**(b) dry-run은 dirty tree를 허용, 실제 릴리스는 clean만 (`:40-44`).**
dry-run은 아무것도 안 바꾸니 미리보기용으로 dirty여도 OK. 실제 릴리스는 clean tree여야 `release: vX.Y.Z` 커밋이 **버전 범프 + 재빌드 번들만** 담고 개발자의 미커밋 변경을 섞지 않는다.

**(c) 정본 컷터 재사용 (`:112-115`).** CLI는 메커니즘(4곳 범프·빌드·커밋·태그)을 직접 구현하지 않고 `scripts/release.mjs`에 위임한다. CLI가 추가하는 것은 게이트·push·리포트뿐. `scripts/release.mjs`는 `ditto` 없이도(순수 node) 돌아가는 정본이라, 부트스트랩·수동 상황에서도 릴리스가 가능하다.

**(d) push는 별도, 그리고 기본값 (`:87-91`, `:130-143`).** commit·tag는 로컬(가역), push는 비가역. push 실패(push-gate 탈락·네트워크)해도 커밋·태그는 로컬에 남아 복구 가능(`git push` 재시도). `--no-push`로 끌 수 있으나 기본은 push. push는 `.githooks/pre-push`의 전체 `bun test` 게이트를 통과해야 한다 — 깨진 빌드가 stable로 새 나가지 못하게 하는 ADR-0022 5번 "게이트된 배포".

**ADR-0022(도그푸딩·배포 생애주기)** 근거: "단일 repo = dev+dogfood"이고 stable은 npx 설치본(repo 밖)이다. 결정 5 "게이트된 배포(승격)": 변경은 main 머지 → 릴리스 빌드 → 배포 → 스모크 검증을 통과해야 stable. `ditto release`가 그 "릴리스 빌드" 단계의 결정적 진입이다. **철회 조건**(ADR-0022): 배포 채널을 npx에서 **npm 레지스트리**로 바꾸면 배포 표면(5번)만 부분 재검토 — 그때 "커밋된 bin/ditto가 곧 산출물"이라는 이 커맨드의 전제가 깨진다.

**ADR-0016(dual-host)** 근거: 버전 touchpoint에 `.claude-plugin/plugin.json`과 `.codex-plugin/plugin.json` **둘 다** 포함(`scripts/release.mjs:34-38`) — 두 호스트가 동일 버전으로 발맞춰 승격되도록.

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

**`releaseGateError` (`src/cli/commands/release.ts:35-46`)** — 입력 3-술어 → 순서대로 검사 → 거부 사유 or null. 순서 의존: `isSourceRepo`를 먼저 봐서, 소비자 환경에서는 dirty 여부와 무관하게 즉시 거부. 효과: 소비자 설치본에서 `ditto release patch`는 항상 exit≠0("release refused")로 무력화된다(`tests/cli/release.test.ts:55-63`가 실제 소비자-유사 tmp repo로 검증).

**게이트 배선 (`:101-110`)** — `isDittoSourceRepo(repoRoot)`(pkg.name==='ditto' ∧ `src/cli/index.ts` 존재; `src/core/mode-doctor.ts`)와 `isDirty()`(`git status --porcelain` 비어있지 않음, `:58-65`)를 게이트에 주입. 거부 시 `USAGE_ERROR_EXIT`. 이 판정이 **어떤 spawn보다 먼저** 일어나는 게 fail-closed의 핵심.

**정본 위임 (`:112-119`)** — `run('node', ['scripts/release.mjs', bump, ...dryRun?['--dry-run']:[]])`. 비-0 exit면 `RUNTIME_ERROR_EXIT`로 전파. `run`은 `Bun.spawnSync`에 stdio inherit(`:48-56`)이라 컷터 로그가 그대로 사용자에게 흐른다.

**dry-run 조기 종료 (`:120-124`)** — 컷터가 dry-run으로 아무것도 안 바꿨으니 push 단계 건너뛰고 즉시 리턴. json이면 `{status:'dry-run', pushed:false}`.

**push 2단계 (`:130-143`)** — `git push`(브랜치) 성공해야 `git push origin <tag>` 시도. `pushed = 둘 다 성공`. 실패 시 "committed + tagged locally, but push failed … Re-run: git push && git push origin <tag>" 후 `RUNTIME_ERROR_EXIT`. 미묘한 결정: 커밋·태그는 이미 로컬에 랜딩됐으므로 실패를 **복구 가능 상태**로 남긴다(재실행 명령을 문자열로 안내).

**리포트 (`:145-158`)** — pushed면 소비자 업데이트 원-라인(`npx github:incognito050924/ditto update` 또는 `claude plugin marketplace update ditto-local` → `/plugin update`) 안내. 이 `GH_SOURCE` 리터럴(`:18`)은 `scripts/npx-bootstrap.mjs:46`의 값과 손으로 맞춰야 하는 결합점(주석이 명시).

**`scripts/release.mjs`의 drift 가드 (`:80-87`)** — 범프 전에 4 touchpoint가 **모두** 현재 `package.json` 버전과 일치하는지 검사. 하나라도 어긋나면 "fix drift first"로 fail. 효과: 지난 릴리스가 일부만 갱신됐거나 손으로 건드려 버전이 갈라진 상태를 무음으로 덮지 않고, 새 릴리스 전에 강제로 드러낸다.

**빌드 스탬프 (`scripts/build-bin.mjs:66-68`, `src/core/build-stamp.ts:34-43`)** — 번들 끝에 `//# ditto-src-stamp=<sha256>`를 붙인다. sha는 `src/` 아래 모든 `.ts`를 (repo-relative posix 경로 + NUL + 내용 + NUL, 경로정렬)로 해시. `computeSourceStamp`(런타임)와 `sourceStamp`(빌드)가 **동일 알고리즘**이어야 하며(양쪽 주석이 상호 참조), `doctor distribution`의 `binary_fresh`가 재계산해 스테일 번들을 검출. 효과: 릴리스로 구운 `bin/ditto`가 소스와 일치함을 배포 후에도 기계적으로 확인 가능.

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위(코드 읽기 + 기존 단위/통합 테스트 존재 확인, 실제 릴리스 실행은 안 함)에서:

- 게이트 4조합·소비자 거부·소스-repo dry-run 무변경은 `tests/cli/release.test.ts`가 검증하는 계약과 코드가 일치.
- **미검증**: 실제 `--no-push` / 실제 push 경로(§5의 push 2단계, 리포트)는 자동 테스트가 없다. dry-run과 게이트만 테스트가 덮고, 실제 커밋·태그·push는 부작용이 커 테스트가 회피한다(합리적이나, 리그레션 사각지대).
- **잠재 불일치(경미)**: `readVersion`(`:67-72`)은 `pkg.version ?? ''`로 빈 문자열 fallback을 허용해, 이론상 `tag='v'`가 될 수 있다. 그러나 이 지점 도달 전에 `scripts/release.mjs`가 이미 semver를 검증·기록했으므로 현재 계약상 도달 불가(방어 코드지 실결함 아님).
- **직접 배포 파이프라인과의 경계**: 이 커맨드는 `build:bin`(→`bin/ditto`)만 부른다. **플러그인 조립(`scripts/build-plugin.mjs`→`dist/plugin`, `scripts/build-codex-plugin.mjs`)은 `ditto release`가 호출하지 않는다** — 그건 `bun run dogfood` 등 별도 경로 소관. 즉 릴리스가 굽는 것은 커밋되는 `bin/ditto` 하나뿐이고, `dist/plugin`은 도그푸딩 로컬 로드용 gitignored 산출물이다. 확인 범위에서 이 분리는 의도대로다(마켓플레이스가 repo 트리를 서빙 → 커밋된 `bin/ditto`가 배포 단위).

## 7. 잠재 위험·부작용·재설계 시 고려점

**dist/ditto vs bin/ditto 구분(스코프 힌트 핵심).** 세 산출물이 있다(모두 `scripts/build-bin.mjs`의 `buildBinInto` 재사용):
- `bin/ditto` (`build:bin`) — **git 커밋됨**(`git ls-files bin/`로 확인). 이것이 배포 산출물이고 `npx-bootstrap`이 소비자에게 **복사**한다(`scripts/npx-bootstrap.mjs:81,103`). 릴리스가 재빌드·커밋하는 대상.
- `dist/ditto` (`build`) — **gitignored**(`.gitignore:468`). 스크래치 빌드 출력. 릴리스·배포와 무관.
- `dist/plugin/bin/ditto` (`build:plugin`) — gitignored. 도그푸딩용 조립 번들. repo `bin/`을 절대 건드리지 않도록 별도 트리에 굽는다(`scripts/build-plugin.mjs:70-73`).
재설계 시 이 셋을 혼동하면 "스테일 번들 로드"(ADR-0022가 처음 겪은 사건)가 재발한다.

**동시성·drift 위험.**
- 4 touchpoint 버전을 정규식으로 개별 편집한다(`scripts/release.mjs:95-98`). 파일 포맷·키 문자열이 바뀌면 정규식이 조용히 안 맞고 "no version match" fail(drift 가드가 잡음). 새 touchpoint(예: 세 번째 호스트)를 추가하면 `TOUCHPOINTS` 배열·이 문서를 함께 갱신해야 한다.
- 빌드 스탬프 알고리즘이 `build-bin.mjs`와 `build-stamp.ts`에 **중복 구현**돼 있다(의도적, 서로 참조). 한쪽만 바꾸면 모든 정상 번들이 drift로 오검출된다 — 반드시 짝으로 수정.
- `GH_SOURCE` 리터럴이 `release.ts:18`과 `npx-bootstrap.mjs:46`에 이중화. repo 소유자·이름이 바뀌면 둘 다.

**재설계 시 보존해야 할 불변식.**
1. **fail-closed on isSourceRepo** — 소비자 환경에서 릴리스 불가. 이걸 약화하면 소비자 설치가 릴리스를 컷할 수 있다(ADR-0022 격리 위반).
2. **clean tree 요구(실제 릴리스)** — 버전-전용 커밋 보장. 약화하면 릴리스 커밋이 개발자 미커밋 변경을 오염.
3. **커밋된 bin/ditto = 배포 산출물** — 마켓플레이스가 repo 트리를 서빙한다는 전제. npm 레지스트리로 전환하면(ADR-0022 철회 조건) 이 전제와 push→소비자 업데이트 안내가 재설계 대상.
4. **push는 user-gated 비가역, commit은 로컬 가역** — push 실패를 복구 가능 상태로 남기는 2단계. 재고 가능한 결정: push가 **기본값**인 점(`--no-push`로만 끔). 릴리스를 로컬 검토 후 수동 push하는 워크플로를 원하면 기본을 뒤집을 여지.
