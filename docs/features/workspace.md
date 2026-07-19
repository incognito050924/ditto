# workspace — recipe.yaml에 선언된 다중 저장소 워크스페이스를 조립하고 루트 레시피로 게이트한다

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋: `c2d2e16` (2026-07-19).

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto workspace`는 하나의 `recipe.yaml`이 선언한 **다중 저장소(multi-repo) 워크스페이스를 물리적으로 조립**한다. 루트 레시피의 `repos[]` 항목 중 `url`을 선언한 것들을 각자의 `dir`로 `git clone`하고, 각 클론에 **루트 레시피의 push_gate 훅**을 심는다(`src/core/workspace/clone.ts:9-21`).

핵심 문제는 "여러 저장소로 이루어진 작업공간을 어떻게 안전하게, 멱등하게(여러 번 실행해도 결과가 같게) 세팅하는가"다. 이 커맨드가 푸는 개념은 세 가지다.

- **선언적 조립**: 저장소 목록·URL·게이트 설정을 `recipe.yaml`에 선언해 두면 `sync` 한 번으로 클론+게이트가 재현된다(`src/cli/commands/workspace.ts:20`).
- **ROOT-ONLY trust(루트만 신뢰)**: 클론된 하위 저장소가 자기 자신의 악성 `recipe.yaml`/`bin/ditto`를 실을 수 있으므로, 게이트는 하위 저장소가 아니라 **루트 레시피**를 신뢰한다(`resources/hooks/pre-push:20-30`).
- **session-rooting 경계 안에서의 쓰기 봉쇄**: 모든 클론 쓰기가 워크스페이스 루트 아래로 **엄격히 제한**된다(ADR-0011 session-rooting, `clone.ts:57-119`).

DITTO 기능 4축(의도/오케스트레이션/E2E/지식) 중 어디에도 속하지 않는다. 이것은 그 4축을 떠받치는 **횡단 배포계약 축(Distribution)** 에 속한다 — "DITTO 하네스가 타겟 저장소에 어떻게 올라가 살아있게 되는가"를 다루는 층이며(ADR-0011 D1), 여기서는 특히 다중 저장소 작업공간을 조립하고 push_gate(State/배포 계약의 일부)를 각 클론에 배포하는 역할이다.

## 2. 코드 위치와 진입점

| 경로 | 역할 |
|---|---|
| `src/cli/commands/workspace.ts` | CLI 진입점. `workspace sync` 서브커맨드 정의, 환경 해석(루트/레시피/훅 템플릿), 결과 요약·exit code |
| `src/core/workspace/clone.ts` | 코어. 모든 git/fs 부수효과 — URL 허용목록, 디렉터리 봉쇄, non-clobber 분류, clone, 훅 설치, `.gitignore` 추가 |
| `src/schemas/recipe.ts` | 계약(SoT). `recipe.repos[]` 항목 스키마(`dir`, 선택적 `url`, 하위 `push_gate`/barrier) |
| `src/core/setup.ts` | `installPushGateHook` — pre-push 훅 설치 + `WS_ROOT` 베이킹. `defaultHookTemplatePath` |
| `resources/hooks/pre-push` | 설치되는 훅 템플릿. `WS_ROOT` 치환 라인으로 ROOT-ONLY trust 구현 |

관련(스코프 힌트에 있었으나 workspace 커맨드가 직접 import하지는 않는) 개념 파일:
- `src/core/ditto-paths.ts` — 3계층 격리 경로 헬퍼(`dittoDir`/`localDir`/`committedWorkItemDir`). ADR-0012 tier 개념의 코드 표현. **미확인**: `workspace sync` 경로가 이 헬퍼를 직접 호출하지는 않는다(clone.ts는 `.gitignore`·클론 디렉터리만 다룸).
- `src/core/plugin-root.ts` — 플러그인 루트 해석(`resolvePluginRoot`). ADR-0011 D2 session-rooting의 "플러그인 루트 ≠ 세션 타겟 루트" 구분을 구현. 이것도 workspace 커맨드가 직접 쓰지 않고 `doctor` 쪽 표면이다(`plugin-root.ts:12-19`).

서브커맨드·인자:

| 커맨드 | 인자 | 기본값 | 효과 |
|---|---|---|---|
| `workspace sync` | `--output human\|json` | `human` | `repos[]` 중 `url` 선언분을 클론 + 루트 push_gate 훅 설치. 실패 클론이 있으면 non-zero exit |

`workspace` 자체는 서브커맨드 컨테이너일 뿐이고 현재 `sync` 하나만 갖는다(`workspace.ts:66-75`).

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

입력:
- **워크스페이스 루트**: `resolveRepoRootForCreate()`가 결정(cwd에서 위로 올라가며 `.ditto` → `.git` 순으로 탐색, 못 찾으면 cwd)(`workspace.ts:34`, `fs.ts:86-95`).
- **레시피**: `loadResolvedRecipe(workspaceRoot, ...)`가 `recipe.yaml`을 로드·검증(malformed면 무시하고 경고)(`workspace.ts:35-37`).
- **훅 템플릿 경로**: `defaultHookTemplatePath(resolveResourcesDir())` → `resources/hooks/pre-push`(`workspace.ts:38`, `setup.ts:507-509`).

변환·저장(각 `repos[]` 항목마다, `clone.ts:238-290`):

```
recipe.repos[] (url 선언분만 필터)     clone.ts:316-318
  └─ for each repo:
     1) URL 허용목록      isAllowedCloneUrl   → 거부 시 status=refused
     2) 디렉터리 봉쇄      resolveContainedDir → 루트 밖이면 refused (WorkspaceContainmentError)
     3) 대상 분류          classifyDir → empty | same-url | foreign
          foreign  → refused (덮어쓰기 거부)
          same-url → skipped, 훅만 재수렴(installRootGateHook)
          empty    → git clone --  →  실패 시 rm -rf target, status=failed
     4) 클론 성공 시: 부모 .gitignore에 dir/ 추가 + 루트 push_gate 훅 설치
```

출력:
- 저장 상태: 각 클론은 `<workspaceRoot>/<dir>/`에 생기고, 부모 `<workspaceRoot>/.gitignore`에 `dir/`가 추가되며(`clone.ts:214-230`), 각 클론의 `.git/hooks/pre-push`에 `WS_ROOT`가 루트로 고정된 훅이 설치된다(`setup.ts:577-581`).
- 반환/표시: `SyncWorkspaceResult { outcomes: CloneRepoOutcome[], anyFailed }`(`clone.ts:302-306`). human 모드는 항목별 `STATUS dir url [hook] [reason]` 한 줄씩(`workspace.ts:46-51`), json 모드는 result 그대로.
- exit code: **거부(refused)는 의도된 비파괴 안전 결과라 exit 0**, 진짜 클론 실패(failed)만 non-zero(`workspace.ts:56-58`, `clone.ts:332`).

읽고 쓰는 스키마: `recipeRepoEntry`(`schemas/recipe.ts:108-119`) — `dir`(필수), `url`(선택), 하위 `push_gate`/`barrier_test_command`/`authored_test_command`. `PushGateHookStatus`(`setup.ts:473-479`)가 훅 설치 결과.

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### 4-1. session-rooting invariant — 디렉터리 봉쇄 (ADR-0011 D2)
모든 클론 쓰기는 워크스페이스 루트 아래로 **엄격히** 제한된다. `resolveContainedDir`이 (1) 어휘적 봉쇄(`../escape`·절대경로·`.` 거부), (2) 대상이 심볼릭 링크면 거부, (3) 심링크를 realpath로 풀어 재봉쇄 — 3중 방어를 편다(`clone.ts:103-119`). ADR-0011 D2는 "DITTO의 cross-repo subagent 쓰기는 세션 repoRoot 밖이면 PreToolUse scope-out에 차단된다"를 **경계(버그 아님)** 로 못박았고(ADR-0011 §D2), 이 봉쇄는 그 경계를 clone 경로에서도 재확인한다. 기각된 대안: cross-repo 원격 오케스트레이션 지원(호스트-추상 기계 필요, 현재 요구 아님 → 기각).

### 4-2. ROOT-ONLY trust — 하위 저장소를 신뢰하지 않는다
클론된 하위 저장소는 자기 `recipe.yaml`에 악성 `push_gate.test_command`를 싣거나 자기 `bin/ditto`를 실을 수 있다. 그래서 하위 저장소에 설치되는 훅은 `WS_ROOT`를 **루트 절대경로로 고정**해, push 시 루트 레시피/루트 바이너리를 신뢰한다(`setup.ts:614-628`, `resources/hooks/pre-push:20-49`). `WS_ROOT`가 비어 있으면 하위 저장소의 자기 레시피를 조용히 해석하게 되므로, sub-repo 설치 시 `bakeWorkspaceRoot`가 템플릿의 `WS_ROOT=""` 라인이 없으면 **에러를 던진다**(fail-closed, `setup.ts:626-629`).

### 4-3. clone-time RCE / option-injection 차단
`git clone`은 `ext::<cmd>`/`fd::` 전송으로 임의 셸 명령을 실행할 수 있고(clone 시점 RCE), `-`로 시작하는 URL은 git 옵션으로 파싱된다. `isAllowedCloneUrl`이 우선순위대로 `-`·`ext::`/`fd::`를 거부하고 https/ssh/git:// 허용목록만 통과시킨다(`clone.ts:41-55`). 로컬/`file://`는 테스트 seam(`DITTO_ALLOW_LOCAL_CLONE=1`)에서만 허용되며 그때도 RCE 전송은 여전히 거부된다(`clone.ts:23-34,52-54`). clone 자체도 `--`로 옵션 종료를 명시하고 non-interactive git 환경(`GIT_TERMINAL_PROMPT=0`)으로 인증/호스트키 프롬프트에 매달리지 않고 즉시 실패한다(`clone.ts:121-125,277`).

### 4-4. 멱등성 + non-clobber
`classifyDir`이 대상을 `empty`/`same-url`/`foreign`으로 분류한다(`clone.ts:146-168`). 우리 클론(same-url)이면 손대지 않고 훅만 재수렴, foreign(다른 url이거나 loose 파일)이면 **덮어쓰기 거부**. 덕분에 재실행이 안전하고, 사용자가 클론 후 편집한 내용도 보존된다. clone 실패 시 `rm -rf target`은 방금 만든 빈 디렉터리에만 도달하므로(clone은 empty/absent 대상에서만 실행) 기존 사용자 콘텐츠를 파괴할 수 없다(`clone.ts:232-236,281-284`).

### 4-5. multi-repo 회복력 — 한 저장소 실패가 나머지를 막지 않는다
`syncWorkspace`는 실패/거부한 저장소를 만나도 루프를 중단하지 않고 각 outcome을 모아 요약한다. `anyFailed`(failed가 하나라도 있을 때만 true, refused는 실패 아님)로 exit code를 결정한다(`clone.ts:308-333`).

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

- **`cloneRepoEntry`**(`clone.ts:238-290`): 한 저장소를 처리하는 핵심. 게이트를 **fs/git op 이전에** 순서대로(허용목록 → 봉쇄 → non-clobber) 실행한다. 이 순서 덕분에 clone은 항상 empty/absent 대상에만 도달 → 실패 정리(`rm -rf`)가 절대 사용자 콘텐츠를 지우지 않는다는 불변식이 성립한다(주석 232-236).

- **`resolveContainedDir` + `realpathNearestExisting`**(`clone.ts:77-119`): 대상이 아직 없을 수 있으므로(클론이 만듦) 가장 가까운 **존재하는 조상**을 realpath로 풀고 안 만들어진 꼬리를 재부착한다. 숨은 의도: 어휘적 검사만으로는 미리 심어둔 심링크 조상을 `git clone`이 따라가 루트 밖에 쓸 수 있어서, (a) 대상 자체가 심링크면 거부하고 (b) 조상 심링크를 realpath로 무력화한다(주석 96-102).

- **`classifyDir` + `gitOriginUrl` + `normalizeUrl`**(`clone.ts:127-168`): `remote.origin.url`을 읽어 정규화(trailing `/`·`.git` 제거) 후 비교해 same-url 판정. 읽을 수 없는 디렉터리는 `foreign`으로 떨어져 손대지 않는다(fail-safe, `clone.ts:161-162`).

- **`bakeWorkspaceRoot`**(`setup.ts:614-628`): sub-repo 설치 시 템플릿의 `WS_ROOT=""`를 루트 절대경로로 치환. 매번 깨끗한 온-디스크 템플릿에 대해 실행하므로 install/refresh 둘 다 멱등(재실행이 clean 템플릿에서 WS_ROOT 재도출). 치환 라인이 없으면 throw → 조용한 "빈 WS_ROOT" 취약점을 fail-closed로 차단.

- **`installPushGateHook`**(`setup.ts:544-611`): `core.hooksPath`가 커스텀이면(husky/lefthook) 훅을 쓰지 않고 거부(`refused-hookspath`) — `.git/hooks/pre-push`가 무시되거나 사용자 훅을 조용히 죽이는 것이 SAFETY 게이트의 침묵 실패라서. 우리 훅 마커가 있으면 in-place refresh, 남의 훅이면 `.ditto-backup`으로 한 번만 백업하고, 백업이 이미 있으면 거부(non-clobber).

- **`addToParentGitignore`**(`clone.ts:214-230`): 클론 dir을 부모 `.gitignore`에 멱등 추가해 클론이 루트 저장소 git status를 오염시키지 않게 한다(3계층 격리에서 하위 클론은 루트가 추적하지 않는다는 것과 정합).

- **CLI exit 정책**(`workspace.ts:56-58`): refused는 exit 0으로 요약에만 노출, failed만 `RUNTIME_ERROR_EXIT`. "거부 = 의도된 안전 결과"라는 개념을 exit code에 반영.

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위(clone.ts / workspace.ts / recipe.ts / setup.ts의 push-gate 부분 / pre-push 템플릿 정독)에서:

- URL 안전, 디렉터리 봉쇄, non-clobber, ROOT-ONLY trust, multi-repo 회복력, refused≠failed exit 정책 — 모두 코드와 주석의 의도대로 배선되어 있다(위 §5 인용). **확인 범위에서 불일치 없음.**
- 스코프 힌트가 지목한 `src/core/workspace/ditto-paths.ts`·`plugin-root.ts` 경로는 **존재하지 않는다**. 실제 파일은 `src/core/ditto-paths.ts`·`src/core/plugin-root.ts`이고, 이 둘은 `workspace sync` 경로에서 직접 호출되지 않는다(clone.ts는 이들을 import하지 않음). 3계층 격리 경로·플러그인 루트 해석은 workspace가 아니라 setup/doctor 계열이 소비하는 인접 개념이다 — **문서화 대상 커맨드와는 개념적으로만 연결**된다.
- 스키마 주석(`recipe.ts:110-114`)은 `url`에 대해 "clone BEHAVIOR는 별도 follow-up, 지금은 필드만 land"라고 적혀 있으나, 현재 코드에는 clone 동작이 **이미 구현되어 있다**(`clone.ts`). 즉 이 주석은 필드가 먼저 들어왔던 시점의 것으로 이제 stale하다(동작 자체의 결함은 아니고 주석 drift, `recipe.ts:112-114`).

## 7. 잠재 위험·부작용·재설계 시 고려점

**보존해야 할 불변식(재설계 시 반드시 유지):**
- **게이트 순서**: 허용목록 → 봉쇄 → non-clobber가 fs/git op보다 먼저. 이 순서가 무너지면 "clone은 empty 대상에만 도달 → `rm -rf`가 안전"이라는 불변식이 깨져 사용자 데이터 파괴 위험(`clone.ts:238-284`).
- **ROOT-ONLY trust의 fail-closed**: `WS_ROOT` 치환 라인 부재 시 throw. 이걸 완화해 빈 WS_ROOT를 허용하면 하위 저장소의 악성 recipe/bin을 신뢰하게 된다(`setup.ts:626-629`).
- **RCE 전송 거부는 로컬 seam에서도 유지**(`clone.ts:52`).

**약점·재고 가능 지점:**
- **인증 모델이 좁다**: ambient git(공개/사전 인증 URL)만 지원, non-interactive라 자격증명 프롬프트는 즉시 실패(`clone.ts:20,121-125`). private repo 지원을 넓히려면 여기서 확장 필요.
- **동시성**: 여러 세션이 같은 워크스페이스에서 `sync`를 동시에 돌리면 `.gitignore` append·클론 디렉터리 생성이 경합할 수 있다(파일 락 없음). 현재 코드에 동시 실행 가드는 **없음**(미확인: 상위 호출자에 직렬화 장치가 있는지는 확인 안 함).
- **얕은 url 정규화**: `normalizeUrl`은 trailing `/`·`.git`만 제거한다(`clone.ts:141-143`). scp-style vs ssh:// 같은 동일 저장소의 다른 표기는 서로 다르게 보여 same-url 판정을 빗나갈 수 있다 → 이미 우리 클론을 foreign으로 오판해 거부할 여지(비파괴적이지만 재실행이 막힘).
- **clone 깊이**: full depth 클론(`clone.ts:275-277`). 대형 저장소 다수를 조립하면 비용이 크다. 재설계 시 shallow/파셜 옵션을 recipe에 둘지 검토 가능.
- **주석 drift**: `recipe.ts:112-114`의 "clone은 follow-up" 주석이 실제 구현과 어긋난다 — 재설계 시 정정 대상.
