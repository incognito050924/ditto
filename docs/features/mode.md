# mode — 이 세션이 어떤 ditto를 돌리는지, 설치본이 낡았는지, 무엇을 배포해야 하는지 on-demand로 답한다

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋: `c2d2e16` / 2026-07-19.

## 1. 이 기능이 실현하려는 설계 의도 (개념)

ditto는 자기 자신을 만들며 동시에 자기 자신으로 도그푸딩한다. 이때 반복해서 사람을 무는 실패가 있다: 한 세션이 **작업 트리(working tree)** 빌드가 아니라 **낡은 설치본(plugin cache)** 을 로드해, 편집이 반영되지 않는 줄 모르고 한참 작업하다 도중에야 발견하는 것 (ADR-0022 컨텍스트, `.ditto/knowledge/adr/ADR-0022-dogfood-deploy-lifecycle.md`).

`ditto mode`는 개발자가 매번 손으로 역추적하던 두 질문을 한 명령으로 답한다 (`src/core/mode-doctor.ts:4-20`):

1. **이 세션은 어느 플러그인을 로드했나** — 작업 트리(`--plugin-dir .`, `dev`)인가 설치본(마켓플레이스 캐시, `installed`)인가.
2. **설치본이 작업 트리보다 낡았나(STALE), 그렇다면 무엇을 실행해야 하나** — install / reinstall / commit-push-reinstall / none 중 무엇인가.

이 기능은 DITTO 4축(의도·오케스트레이션·E2E·지식)이 아니라 **거버넌스·배포 축**에 속한다. ADR-0022가 정립한 "도그푸딩·배포 생애주기"의 안전망(3번 결정)을 구현한 것으로, "견고함은 폴더 분리가 아니라 진입 결정성 + 격리 + 게이트 배포에서 온다"는 결정의 배포-신선도 감지 파트다 (`ADR-0022-dogfood-deploy-lifecycle.md` 결정 3).

`ditto mode`는 SessionStart 훅 배너(`formatModeBanner`)의 **능동(on-demand) 버전**이다 — 같은 판정 로직을 세션 시작 시 자동으로 띄우는 대신, 아무 터미널에서 물어볼 수 있게 한 것 (`src/cli/commands/mode.ts:16-20`).

## 2. 코드 위치와 진입점

| 경로 | 역할 |
|---|---|
| `src/cli/commands/mode.ts` | CLI 진입. IO만 배선(포맷 파싱 → 리포트 수집 → human/json 출력). |
| `src/core/mode-doctor.ts` | 순수 판정 + IO 수집 + human/banner 프레젠테이션. 훅과 공유. |
| `src/core/build-stamp.ts` | `src/` 아래 `.ts` 내용 stamp(`computeSourceStamp`)와 번들에 박힌 stamp 추출(`readEmbeddedStamp`). |
| `src/hooks/session-start.ts` | 같은 판정을 세션 시작 배너로 띄우는 수동적 소비자(`formatModeBanner`). |
| `scripts/build-bin.mjs` | 번들 말미에 `//# ditto-src-stamp=<sha256>`를 박는 쪽(`sourceStamp()`, line 39·68). |

CLI 인자 (`src/cli/commands/mode.ts:27-29`):

| 인자 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `--output` | string | `human` | 출력 형태: `human` \| `json` |

서브커맨드는 없다. 단일 커맨드.

종료 코드 (`mode.ts:13,40-45`): 잘못된 `--output` 값(`InvalidOutputFormatError`) → `USAGE_ERROR_EXIT`; 그 외 런타임 오류 → `70`(`MODE_RUNTIME_ERROR_EXIT`).

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

이 기능은 **상태 파일을 쓰지 않는다**(읽기 전용 진단). 런타임에서 세 소스를 읽어 판정만 낸다.

```
ditto mode --output human|json
  └─ resolveRepoRootForCreate()            → repoRoot                 (mode.ts:33)
  └─ collectModeReport(repoRoot)                                       (mode.ts:34)
        ├─ resolvePluginRoot(env, argv1)   → 이 세션의 pluginRoot     (mode-doctor.ts:232)
        │     env.CLAUDE_PLUGIN_ROOT 있으면 그것, 없으면 argv1의 <root>/bin/ditto에서 역산
        ├─ isDittoSourceRepo(repoRoot)     → ditto 소스 repo인가       (mode-doctor.ts:216)
        │     package.json name==="ditto" && src/cli/index.ts 존재
        │     아니면 → 신선도 무의미 → 세션 분류만 하고 조기 반환      (mode-doctor.ts:292-309)
        ├─ readInstalledIdentity(home)     → 설치본 present/version/srcStamp/surfaceStamp
        │     ~/.claude/plugins/cache/ditto-local/ditto/<version>/     (mode-doctor.ts:245)
        │     최고 버전 디렉터리의 bin/ditto에서 stamp 추출 + agents/skills/hooks surface stamp
        ├─ computeSourceStamp(repoRoot)    → 작업 트리 src stamp
        ├─ computeSurfaceStamp(repoRoot)   → 작업 트리 표면 stamp(agents/+skills/+hooks/)
        └─ gitState(repoRoot)              → dirty(git status), ahead(origin/main..HEAD)
  └─ resolveMode(inputs)                   → ModeReport               (mode-doctor.ts:91)
  └─ 출력: json이면 {...report, inDittoRepo}, human이면 formatModeHuman() 줄들
```

읽는 것:

- `${CLAUDE_PLUGIN_ROOT}` 환경변수 또는 `process.argv[1]`(실행 중 bin 경로).
- `~/.claude/plugins/cache/ditto-local/ditto/<version>/bin/ditto` (설치본 번들, stamp 추출) + 그 아래 `agents/`·`skills/`·`hooks/` (표면 stamp).
- 작업 트리의 `src/**/*.ts` (src stamp), `agents/`·`skills/`·`hooks/` (표면 stamp).
- `git status --porcelain`, `git rev-list --count origin/main..HEAD`.

`ModeReport` 모양 (zod 스키마 아님 — 이 모듈의 TS interface, `mode-doctor.ts:60-66`):

```ts
{ sessionMode: 'dev'|'installed'|'unknown';
  installed: { present, version, fresh };
  drift: { src, surface };
  action: 'none'|'install'|'reinstall'|'commit-push-reinstall';
  reason: string }
```

(미확인 참고: DITTO는 스키마가 SoT지만(ADR-0002) `ModeReport`는 zod 스키마로 정의돼 있지 않고 순수 TS interface다 — `src/schemas/`에 `ditto-config.ts` 외 mode 관련 스키마 없음. 진단 출력이라 영속 계약이 아닌 것으로 보이나, 이는 추론이다.)

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### 4-1. 분리축은 "플러그인 로드 경로"이지 git 브랜치가 아니다

`classifySession` (`mode-doctor.ts:69-76`)이 `pluginRoot`만으로 세션을 분류한다. ADR-0022가 명시하듯 "브랜치를 나눠도 plain 세션은 여전히 stale 설치본을 잡는다" — 그래서 판정 기준이 브랜치가 아니라 로드 경로다.

### 4-2. 신선도는 두 정체성 축을 모두 비교한다 (src + surface)

`doctor distribution`의 `binary_fresh`는 dev 체크아웃 안에서 `src/`→`bin`만 비교하는데, 설치본에는 `src/`가 없어 **agents/·skills/가 drift해도 진공으로 fresh처럼 읽힌다** — 이 WI가 태어난 바로 그 실패다 (`mode-doctor.ts:13-19`). 그래서 `resolveMode`는 두 stamp를 모두 비교하고 **둘 다 일치할 때만** fresh로 본다 (`mode-doctor.ts:93-95`):

```ts
const driftSrc = inp.installedPresent && inp.installedSrcStamp !== inp.repoSrcStamp;
const driftSurface = inp.installedPresent && inp.installedSurfaceStamp !== inp.repoSurfaceStamp;
const fresh = inp.installedPresent && !driftSrc && !driftSurface;
```

ADR-0022 결정 3이 "설치본 vs 워킹트리는 src-stamp + 표면-stamp(agents/skills/hooks) 2축으로 비교한다(후자는 `doctor distribution`의 `binary_fresh` 사각을 메운다)"로 이 결정을 못박았다.

### 4-3. action은 배포 규칙을 코드화한 것

`resolveMode`의 action 분기(`mode-doctor.ts:97-101`)가 "언제 배포/재설치하나"의 규칙 자체다: 설치본 없음 → `install`; fresh → `none`; drift인데 로컬 전용 작업(미커밋·미푸시) 있음 → `commit-push-reinstall`; drift인데 이미 푸시됨 → `reinstall`. 이유 문자열은 `ACTION_REASON` 맵(`mode-doctor.ts:78-84`)에 상수로 두어 출력과 규칙이 한 소스를 공유한다.

### 4-4. 배너 vs 능동 명령 = 같은 판정, 두 소비 지점

ADR-0022는 SessionStart 배너를 안전망으로 정한다(결정 3). `formatModeBanner`(수동, 훅)와 `formatModeHuman`(능동, CLI)이 같은 `ModeReport`를 다르게 렌더한다. 순수 판정(`resolveMode`)과 프레젠테이션을 분리해, 훅과 CLI가 판정을 이중 구현하지 않는다 (`mode.ts:16-20` 주석: "pure verdict ... shared with the SessionStart hook; this only wires IO").

### 4-5. dual-host와의 관계

`bun run dogfood [--host codex]`가 배너·출력에 박혀 있다(`DOGFOOD_HINT`, `mode-doctor.ts:119`). ADR-0016(dual-host)에 따라 dev 진입은 claude=`--plugin-dir <repoRoot>`(무상태), codex=격리 `CODEX_HOME` local marketplace(유상태)로 갈리지만, `mode-doctor`는 host를 분기하지 않고 단일 힌트 문자열로 안내한다 (`scripts/dogfood.mjs:76-114`가 실제 host 분기를 담당).

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### `resolvePluginRoot(env, argv1)` — `mode-doctor.ts:232-242`

입력: 환경변수 맵 + `argv[1]`. 하는 일: `CLAUDE_PLUGIN_ROOT`가 있으면 그대로, 없으면 `argv1`이 `.../bin/ditto`로 끝날 때 그 상위(`<pluginRoot>`)를 역산. 효과: 하네스가 `${CLAUDE_PLUGIN_ROOT}`를 훅/스킬 본문에는 치환하지만 **맨 셸에는 치환하지 않기** 때문에, bare `ditto mode`는 env를 못 보고 argv 경로로 대체 추론한다. 그래도 못 구하면 `null` → `unknown`.

숨은 결정: bare 셸에서 세션 mode는 대개 `unknown`이지만, 신선도·action 판정은 항상 답할 수 있어 명령이 여전히 쓸모 있다 (`mode-doctor.ts:155-161` 주석).

### `classifySession(pluginRoot, repoRoot)` — `mode-doctor.ts:69-76`

순서 의존 가드: **설치본 판정이 repo-containment보다 먼저** (`pluginRoot.includes('/plugins/cache/')` → `installed`를 먼저 return). 캐시가 `~/.claude` 아래 있어 `repoRoot`가 그 조상(예: `$HOME`)일 때 설치본을 `dev`로 오분류하는 것을 막는다. 이 순서가 뒤집히면 오분류. 테스트가 이 케이스를 잠금(`tests/core/mode-doctor.test.ts:95` "cache path that also sits under repoRoot → installed, not dev").

### `computeSurfaceStamp(root)` — `mode-doctor.ts:201-213`

입력: 루트 디렉터리. 하는 일: `agents/`·`skills/`·`hooks/` 아래 모든 파일을 재귀 수집→경로 정렬→`sha256(경로 + ' ' + 내용 + ' ')` 누적. 효과: src-stamp가 `.ts`만 해시하므로 놓치는 `agents/*.md` 등 표면 drift를 잡는 두 번째 정체성 축. 정렬(`files.sort()`, line 204)로 파일 나열 순서에 무관한 결정론 확보.

주의: src-stamp(`build-stamp.ts:34`)는 구분자로 NUL(` `)을 쓰고, surface-stamp(`mode-doctor.ts:207-210`)는 공백 `' '`을 쓴다. 둘은 독립 알고리즘이라 서로 비교되지 않으므로(각 축이 installed vs repo끼리만 비교) 문제 없으나, 두 stamp가 같은 규칙이라고 오해하면 안 된다.

### `readInstalledIdentity(home)` — `mode-doctor.ts:244-263`

입력: 홈 디렉터리. 하는 일: `~/.claude/plugins/cache/ditto-local/ditto/` 아래 버전 디렉터리들을 정렬해 **최고 버전**을 "fresh 세션이 로드할 것"으로 택하고(line 252), 그 `bin/ditto`에서 stamp 추출 + 표면 stamp 계산. 효과: 없으면 `absent`(모든 필드 null). stamp 추출 실패(예: pre-stamp 빌드)는 `try/catch`로 `null` → src drift로 취급 (`resolveMode`에서 `null !== repoSrcStamp` → drift).

미묘함: 버전 선택이 문자열 정렬(`.sort()`)이라 semver가 아니다 — `0.10.0` < `0.9.0`로 정렬될 수 있음. 현재 버전 폭에서 문제가 관측되는지는 **미확인**.

### `gitState(repoRoot)` — `mode-doctor.ts:265-274`

`git status --porcelain`으로 dirty, `git rev-list --count origin/main..HEAD`로 ahead 판정. 효과: drift가 있을 때 action이 `commit-push-reinstall`(로컬 작업 존재)인지 `reinstall`(이미 푸시됨)인지 가른다. `origin/main`이 없거나 명령이 실패하면 `rev.status !== 0` → `ahead=false`로 안전 강등.

### `formatModeBanner` — `mode-doctor.ts:127-153`

`inDittoRepo`가 아니면 빈 배너(침묵) — npx로 ditto를 깐 일반 프로젝트는 경고할 게 없다. dev → 확인(비경고), stale installed → 경고(`warn:true`) + `bun run dogfood`로 나갔다 다시 들어오라는 지시. 한국어 리라이트(wi_260713nlg) 때 operative cue(도그푸딩 확인·STALE 경고·exit/re-enter 명령)를 모두 보존 (ADR-20260713-directive-fidelity-banner-gate 정합; `mode-doctor.ts:130-133` 주석).

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위: `src/core/mode-doctor.ts`·`src/cli/commands/mode.ts`·`src/core/build-stamp.ts` 정독 + `tests/core/mode-doctor.test.ts`(22개 테스트) 케이스 확인 + ADR-0016/0022 대조. 테스트 자체를 실행하지는 않음(**미검증**: 이 문서 작성 중 `bun test`를 돌리지 않았다).

- **ADR-0022 결정 3(2축 신선도)** — `resolveMode`가 src+surface 둘 다 비교, 일치. 테스트 `mode-doctor.test.ts:48`("surface drift only ... → reinstall")·`:67`("no embedded src stamp → src drift")가 잠금.
- **의도(bare 셸에서도 유용)** — `sessionMode=unknown`이어도 신선도·action은 답함, 일치 (`mode-doctor.test.ts:89`).
- **scope 힌트와의 불일치(주의)**: 힌트는 `ditto-config.ts`를 mode의 core로 지목했으나, **`mode.ts`도 `mode-doctor.ts`도 `ditto-config.ts`를 import하지 않는다** (grep로 확인: `mode-doctor.ts` import는 `build-stamp`뿐). `src/core/ditto-config.ts`는 per-developer `deep_interview`/`github` 블록(`.ditto/local/config.json`)을 읽는 별개 표면으로, 런타임 "실행 모드"와 무관하다. 즉 mode의 "모드"는 config 파일이 아니라 **플러그인 로드 경로**로 결정된다. 죽은 경로가 아니라 힌트의 개념 혼동으로 판단.
- 확인 범위에서 mode-doctor 자체의 죽은 코드·의도-동작 불일치는 없음.

## 7. 잠재 위험·부작용·재설계 시 고려점

- **버전 선택이 문자열 정렬**(`readInstalledIdentity`, `mode-doctor.ts:248-252`): `.sort()`가 semver가 아니라 사전식이다. 버전이 두 자리(`0.10.0`)로 넘어가면 최고 버전 오선택 가능. 재설계 시 semver 비교로 교체 검토. (현재 실제 오작동 여부 미확인.)
- **`~/.claude/plugins/cache/ditto-local/ditto` 경로 하드코딩**(`mode-doctor.ts:245`): 마켓플레이스/캐시 경로 규약이 바뀌면 설치본 탐지가 조용히 `absent`로 강등돼 항상 `install`을 권한다. 하네스 캐시 레이아웃에 강결합.
- **dual-host 비대칭 미반영**: `readInstalledIdentity`는 Claude 캐시(`~/.claude/plugins/cache`)만 본다. Codex 설치본(격리 `CODEX_HOME`의 local marketplace, ADR-0016 D3·ADR-0022 결정 2)은 신선도 검사 대상이 아니다 — codex 도그푸딩 세션에서 `ditto mode`의 설치본 판정이 무의미하거나 오도할 수 있음. 재설계 시 host별 설치본 소스를 고려.
- **표면 stamp 범위 고정**(`SURFACE_DIRS=['agents','skills','hooks']`, `mode-doctor.ts:184`): 배포 표면에 새 디렉터리가 추가되면(예: `.mcp.json`, `commands/`) 그 drift는 신선도에서 새어나가 `binary_fresh` 사각과 동형 재발. 배포 표면 정의의 SoT를 이 배열과 묶어야 drift 재발을 막음.
- **`isDittoSourceRepo` 게이트**(`mode-doctor.ts:216-225`): `package.json` name과 `src/cli/index.ts` 존재로 판정. repo가 리네임되거나 소스가 이동하면 전체가 침묵(비-ditto로 오판)해 안전망 자체가 조용히 꺼진다.
- **재설계 시 보존해야 할 불변식**: ① 신선도는 두 축(src·surface) 모두 일치할 때만 fresh(단일 축 회귀 금지 — 이 WI가 태어난 실패). ② `classifySession`의 설치본-우선 순서(`/plugins/cache/` 체크가 repo-containment보다 먼저). ③ 순수 판정(`resolveMode`)과 프레젠테이션(banner/human) 분리 — 훅·CLI가 판정을 이중 구현하지 않는다.
