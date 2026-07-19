# uninstall — `ditto setup`이 프로젝트에 심은 것만 골라 안전하게 되돌린다 (alias: teardown)

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋: `c2d2e16` (2026-07-19), 확인 범위: `src/cli/commands/teardown.ts`, `src/core/teardown.ts`, `src/core/managed-resource.ts`, `src/core/settings-allowlist.ts`, `src/core/charter-region.ts`, `src/core/resource-routing.ts`, `src/core/setup.ts`(관련 부분), `tests/core/teardown.test.ts`.

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto setup`은 사용자 프로젝트의 여러 파일에 **ditto가 관리하는 조각**을 심는다: `CLAUDE.md`/`AGENTS.md` 등에 지침 블록, `.claude/settings.json`의 permission allow 규칙, `.git/hooks/pre-push`의 push-gate 훅. `uninstall`은 이 설치의 **역과정**이다 (`src/core/teardown.ts:20-24`).

핵심 문제는 "되돌리기"가 **파괴적 작업**이라는 점이다. 사용자의 `CLAUDE.md`에는 ditto가 심은 블록과 사용자가 직접 쓴 내용이 **한 파일에 섞여** 있다. 순진하게 파일을 삭제하면 사용자 내용까지 날아간다. 그래서 uninstall의 개념은 **"내가 심은 것만 추적해서 그것만 제거한다"**로 좁혀진다:

- 관리 블록은 marker(`<!-- ditto:managed:start ... -->` … `<!-- ditto:managed:end -->`)로 경계를 표시해 두었으므로, marker 사이만 잘라내고 나머지 사용자 내용은 byte 단위로 보존한다 (`src/core/managed-resource.ts:104-126`).
- marker가 없는 canonical charter(`AGENTS.md`)는 알려진 charter 버전의 sha와 대조해 "인식된 leading 영역"만 제거한다 (`src/core/charter-region.ts`).
- allow 규칙은 배열에서 그 규칙 하나만 filter로 뺀다 (`src/core/settings-allowlist.ts:39-46`).
- pre-push 훅은 marker로 "우리 훅"임을 확인한 뒤에만 제거하고, 이전 훅이 있었으면 복원한다 (`src/core/teardown.ts:115-145`).

DITTO 4축(의도/오케스트레이션/E2E/지식) 중 어디에도 속하지 않는 **배포·설치 생애주기(distribution/lifecycle)** 표면이다. setup의 짝으로, 도구가 사용자 프로젝트에 남긴 흔적을 정직하게 되돌리는 것이 목적이다. 파괴적 작업 안전장치(charter §7 "파괴적 명령은 명시 지시 없이 실행하지 않는다")를 여러 층위에서 구현한 사례다.

## 2. 코드 위치와 진입점

| 파일 | 역할 |
|---|---|
| `src/cli/commands/teardown.ts` | CLI 진입점. 인자 파싱, self-host 가드, `.ditto/` purge 결정, 사람 대상 출력. |
| `src/core/teardown.ts` | 순수(부수효과 최소) teardown 코어. setup이 계산한 목적지를 다시 계산해 각각 되돌린다. |
| `src/core/managed-resource.ts` | 관리 블록의 marker 탐지·strip. `stripManagedBlock`(제거)/`upsertManagedBlock`(설치)의 대칭 쌍. |
| `src/core/charter-region.ts` | marker 없는 `AGENTS.md`의 charter 영역을 sha 인식으로 찾고 교체/제거. |
| `src/core/settings-allowlist.ts` | `.claude/settings.json`의 `Bash(ditto:*)` allow 규칙 추가/제거. |
| `src/core/resource-routing.ts` | 번들된 resource 파일 목록화(`discoverResources`) + 설치 위치 계산(`routeResource`). setup·teardown 공용. |
| `src/core/setup.ts` | 역과정의 원본. push-gate 훅 상수·`gitHooksDir`·`loadCharterShas`를 여기서 import. |

CLI 등록 (`src/cli/index.ts:52-53`):

```ts
uninstall: teardownCommand,
teardown: teardownCommand, // alias of uninstall (기존 참조·setup/teardown 대칭 호환)
```

`uninstall`이 정식 이름이고 `teardown`은 별칭이다 — 둘 다 같은 command 객체를 가리킨다.

### CLI 인자 (`src/cli/commands/teardown.ts:33-46`)

| 인자 | 타입 | 기본 | 의미 |
|---|---|---|---|
| `dir` | string | (없음) | 대상 프로젝트 디렉터리. 없으면 가장 가까운 `.ditto`/`.git` 루트 또는 cwd로 자동 해석. |
| `purge` | boolean | `false` | `.ditto/`(work-item 이력 + 메모리)까지 영구 삭제. **비가역**. 기본은 보존. |

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

```
CLI args (dir, purge)
  │
  ├─ projectRoot 해석: args.dir ? resolve : resolveRepoRootForCreate()   (teardown.ts:49)
  ├─ resourcesDir 해석: resolveResourcesDir()                             (teardown.ts:50)
  │
  ├─ self-host 가드: pluginRoot === projectRoot 이면 no-op 후 return      (teardown.ts:54-58)
  │
  └─ core teardown({ resourcesDir, projectRoot, homeDir })               (teardown.ts:60)
        │
        ├─ discoverResources(resourcesDir)  → 번들 파일 목록
        │    (charter-manifest.json 제외 — 인식용 데이터일 뿐)            (core/teardown.ts:72)
        │
        ├─ 각 파일마다 routeResource → destPath 계산 후 undo:
        │    ├─ AGENTS.md         → teardownCharterSource (sha 인식 제거)  (core/teardown.ts:78-79)
        │    └─ 그 외             → teardownFile (marker strip)            (core/teardown.ts:80)
        │
        ├─ unallowlistSettingsFile(.claude/settings.json)                 (core/teardown.ts:84-85)
        │
        └─ uninstallPushGateHook({ projectRoot })                        (core/teardown.ts:89)
        ↓
     TeardownResult { files[], allowlistPath, pushGateHook }
        │
  ├─ result.files.length === 0 → "no managed resources found" 실패 종료   (teardown.ts:64-67)
  ├─ 파일별 outcome 출력 + push-gate 훅 상태 출력                          (teardown.ts:69-77)
  └─ purge 결정(shouldPurge) → rm(.ditto/) or 보존                        (teardown.ts:79-88)
```

**읽고 쓰는 상태 파일·스키마:**

- **관리된 지침 파일** (`CLAUDE.md`, `AGENTS.md`, global `~/.claude/*` 등): 스키마 없는 텍스트. 계약은 marker 규약 — `<!-- ditto:managed:start source=<name> sha256=<hex> -->` … `<!-- ditto:managed:end -->` (`src/core/managed-resource.ts:12-13`). teardown은 이 marker 쌍 사이를 제거.
- **`.claude/settings.json`**: `ClaudeSettings` 인터페이스 (`src/core/settings-allowlist.ts:19-22`) — `permissions.allow: string[]`에서 `Bash(ditto:*)`만 제거, 나머지 키는 verbatim 보존.
- **`.git/hooks/pre-push`**: 텍스트 훅. `ditto:managed:pre-push` marker (`src/core/setup.ts:468`)로 "우리 것" 판정. 이전 훅 백업은 `.ditto-backup` suffix (`src/core/setup.ts:471`).
- **`.ditto/`**: work-item 이력·메모리 SoT. **기본적으로 건드리지 않음**. `--purge`일 때만 `rm(recursive, force)`.

> 미확인: 이 CLI 자체를 실행한 fresh 출력은 확보하지 못했다. 흐름은 코드 정적 분석 + `tests/core/teardown.test.ts`의 round-trip 테스트로 확인.

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### 4-1. Managed-resource 추적: "심은 것만 되돌린다"

핵심 불변식은 **teardown semantics A: strip-ONLY** (`src/core/teardown.ts:22-24`) — 관리 블록만 제거하고, setup 이후 사용자가 블록 밖에 추가한 증분(increment)을 포함한 모든 사용자 내용을 보존한다. 대안(파일 통째 삭제 또는 파일을 원본 백업으로 복원)은 setup 이후 사용자가 추가한 내용을 잃는다. marker 경계 추적이 이 손실을 구조적으로 막는다.

### 4-2. Corruption fallback: 절대 내용을 파괴하지 않는다

marker가 불균형(start만 있고 end 없음, 여러 start, end가 start보다 앞 등)이면 `locateBlock`이 `'corrupted'`를 반환하고 (`src/core/managed-resource.ts:30-40`), strip을 **거부**한다. 대신 `.ditto_bak` 스냅샷이 있으면 그것으로 복원, 없으면 파일을 **그대로 둔다** (`src/core/teardown.ts:152-170`). 즉 "확신 없으면 파괴하지 않는다"가 최우선. 이건 charter §7의 파괴적 작업 안전장치를 파일 단위로 구현한 것.

### 4-3. `.ditto/` 보존이 기본값 (비가역성 격리)

`.ditto/`는 work-item 이력·메모리 SoT라 삭제가 비가역이다. 코드 주석이 명시하듯 `install-plugin.mjs`가 uninstall 시 `.ditto/`를 보존하는 것과 대칭 (`src/core/teardown.ts:26-29`). 삭제는 명시적 의사표시로만 열린다 (`src/cli/commands/teardown.ts:12-25`):

```ts
async function shouldPurge(flagPurge: boolean): Promise<boolean> {
  if (flagPurge) return true;
  if (!process.stdin.isTTY) return false;   // 비TTY는 --purge 플래그로만
  ...confirm(io, '...영구 삭제할까?', false);  // TTY는 confirm, 기본 '아니오'
}
```

두 단계 방어: 비대화형(스크립트·CI)에서는 오직 `--purge`로만, 대화형에서는 confirm의 기본값이 '아니오'. 실수로 이력이 날아가는 경로를 양쪽에서 막는다.

### 4-4. Self-host no-op

대상이 ditto repo 자기 자신이면(`pluginRoot === projectRoot`) 아무것도 하지 않고 반환한다 (`src/cli/commands/teardown.ts:54-58`). ditto가 자기 자신을 관리하면 안 된다는 규칙 — setup의 같은 가드와 대칭 (`src/cli/commands/setup.ts:415-416`).

### 4-5. Empty-result를 실패로 취급 (false-green 방지)

관리 resource를 하나도 발견하지 못하면 "reverted"라고 말하는 대신 **실패로 종료**한다 (`src/cli/commands/teardown.ts:63-67`). 주석에 "the pre-fix symptom"이라 적혀 있다 — 실제로 되돌린 게 없는데 성공처럼 보고하던 결함을 고친 것. charter §4-5(증거 없는 완료 선언 금지)의 구현.

> 관련 ADR: `.ditto/knowledge/adr/`에서 setup/teardown/install을 직접 다루는 ADR은 **확인되지 않았다**. 설계 근거는 코드 주석에 인용된 work item(예: push-gate 훅은 wi_260629i9c, sub-repo 훅 baking은 wi_2606299kn — `src/core/teardown.ts:95`, `src/core/setup.ts:499`)과 charter §7에 있다.

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### `teardown()` — 코어 오케스트레이터 (`src/core/teardown.ts:66-92`)

- **입력**: `{ resourcesDir, projectRoot, homeDir }`.
- **하는 일**: `discoverResources(resourcesDir)`로 번들 파일 목록을 얻되 `charter-manifest.json`은 제외한다 (`:72`) — 그것은 인식용 데이터라 프로젝트에 설치된 적이 없으므로 되돌릴 대상이 아니다. 각 파일을 `routeResource`로 다시 destPath 계산 후 undo. 그 다음 allow 규칙 제거, push-gate 훅 제거.
- **산출**: `TeardownResult { files, allowlistPath, pushGateHook }`.
- **숨은 결정**: 목적지를 setup 때 저장해 두는 게 아니라 **동일한 discover+route를 재실행**해 재계산한다. 즉 setup과 teardown이 같은 순수 함수를 공유하므로 위치가 자동으로 대칭이 된다. 트레이드오프: setup 이후 번들 resource 목록이 바뀌면 teardown이 되돌리는 대상도 바뀐다(추론).

### `teardownFile()` — 일반 관리 파일 되돌리기 (`src/core/teardown.ts:152-170`)

- 목적지 없음 → `left-untouched`.
- `stripManagedBlock(current)`이 `ok` → atomic write로 되돌린 내용 저장 → `stripped`.
- `corrupted` → `.ditto_bak` 있으면 복원(`restored-from-backup`), 없으면 `left-untouched`. **strip으로 파괴하지 않는다**가 이 분기의 전부.

### `stripManagedBlock()` — marker 사이 제거 + seam 정리 (`src/core/managed-resource.ts:109-126`)

- `locateBlock`이 단 하나의 well-formed 블록만 인정한다. `null`(블록 없음)이면 내용 그대로 반환 → 멱등.
- 블록 앞(`before`)과 뒤(`after`)를 이어붙이되, **제거로 생긴 seam의 빈 줄만** 접는다:

```ts
let seam = beforeTail + afterHead;
if (seam.length >= 3) seam = '\n\n';   // 3+ 연속 개행 → 한 빈 줄로
```

블록을 들어낸 자리에 개행이 과하게 남는 것만 정규화하고, **파일의 다른 곳 공백은 건드리지 않는다** (`:116-124`). 미묘한 정규화 결정 — 사용자 포맷 보존과 seam 깔끔함의 균형.

### `teardownCharterSource()` — marker 없는 `AGENTS.md` 되돌리기 (`src/core/teardown.ts:180-202`)

- `AGENTS.md`는 raw charter라 persistent marker가 없다. 그래서 marker strip은 no-op이고, 대신 sha 인식으로 charter 영역을 찾는다.
- 알려진 sha 집합 = manifest의 prior 버전들 + 현재 번들 charter의 sha (`:191`).
- `refreshCharterRegion({ current, bundledCharter: '', knownShas })` 호출 — **bundledCharter를 빈 문자열로** 주는 게 핵심 트릭 (`:196`). refresh의 "영역 교체"가 빈 값으로 교체 → 사실상 "영역 제거"가 된다. 인식된 leading 영역은 사라지고 뒤따르는 사용자 규칙은 byte-identical 보존.
- 인식 안 됨(사용자가 편집함)/제거할 게 없음 → `left-untouched`. refresh의 "의심되면 건너뛰기"와 대칭.

### `refreshCharterRegion()` — sha 인식 영역 탐지 (`src/core/charter-region.ts:56-76`)

- leading line-prefix들의 offset을 뒤에서부터 훑어(가장 긴 매칭 우선) 정규화 sha가 known 집합에 있는 첫 boundary를 찾는다.
- 정규화(`normalizedSha256`)는 CRLF·행말 공백을 접으므로 그 정도 변형은 여전히 인식하되, 그 외 어떤 비공백 차이도 unrecognized로 남긴다 — exact-match이지 fuzzy가 아니다 (`src/core/charter-region.ts:11-16`). 사용자가 charter를 한 글자라도 고쳤으면 인식 실패 → 안전하게 보존.

### `unallowlistSettingsFile()` / `removeAllowRule()` (`src/core/settings-allowlist.ts:39-46, 71-75`)

- 파일 없으면 no-op. 있으면 읽어서 `permissions.allow`에서 `Bash(ditto:*)`만 filter로 빼고 나머지 키·규칙은 그대로 두고 다시 쓴다. 순수 함수 `removeAllowRule`는 입력을 mutate하지 않는다.

### `uninstallPushGateHook()` — push-gate 훅 제거 (`src/core/teardown.ts:115-145`)

- `gitHooksDir`가 throw(=git repo 아님) → `left-untouched`.
- `pre-push` 없음 → `left-untouched`.
- 있는데 `PUSH_GATE_HOOK_MARKER`가 **없으면**(사용자 자기 훅) → `left-untouched`. **우리가 심지 않은 훅은 절대 제거하지 않는다** (`:129-135`).
- 우리 훅이면: `.ditto-backup` 백업이 있으면 그 이전 훅을 복원(`restored-prior`), 없으면 우리 훅만 삭제(`removed`) (`:137-144`). 멱등하고 안전.

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위(위 파일 + `tests/core/teardown.test.ts`) 내에서 **의도와 동작의 명확한 불일치는 발견되지 않았다**. 근거:

- round-trip 테스트가 "관리 블록 strip + 앞뒤 사용자 텍스트 보존"과 "setup 이후 추가한 증분 보존"을 검증한다 (`tests/core/teardown.test.ts:36-58`, `:60-...`).
- CLI 진입점의 self-host 가드·empty-result 실패·purge 두 단계 방어는 코드에서 직접 확인.
- push-gate 훅 teardown은 별도 테스트 파일(`tests/core/push-gate-hook-teardown.test.ts`)이 존재한다(내용은 이번에 정독하지 않음 — **미확인**).

주의할 관찰 (불일치는 아니나 문서화 가치 있음):

- **`.ditto_bak` 스냅샷은 정상 strip 후에도 남는다** (`src/core/teardown.ts:29-32` 주석). uninstall 후에도 프로젝트에 `<file>.ditto_bak`가 남을 수 있고, 이는 의도된 동작(값싼 안전장치, 사용자가 지우면 됨). 사용자 관점에선 "완전히 깨끗하게 지워지지 않는다"로 보일 수 있다.
- **`--purge` 시 allowlist 메시지가 항상 "removed"라고 출력된다** (`src/cli/commands/teardown.ts:83-85`). 실제 제거는 `unallowlistSettingsFile`이 하며 settings.json이 없으면 no-op인데(`src/core/settings-allowlist.ts:71-72`), 출력은 무조건 "removed Bash(ditto:*)"라고 말한다. 파일이 없던 경우엔 문구가 실제보다 강하게 들릴 수 있다(경미, 추론).

## 7. 잠재 위험·부작용·재설계 시 고려점

**재설계 시 반드시 보존해야 할 불변식:**

1. **strip-only, 사용자 내용 무손실.** marker 사이만 제거하고 밖은 byte 보존. 이걸 "파일 삭제/복원"으로 단순화하면 setup 이후 증분이 사라진다.
2. **corruption fallback은 절대 파괴하지 않는다.** 불균형 marker에서 strip 거부 → 백업 복원 or 그대로 둠. 이 fail-safe를 없애면 손상된 파일에서 사용자 내용을 지울 위험.
3. **우리가 심지 않은 것은 건드리지 않는다.** 사용자 자기 pre-push 훅(marker 없음), 인식 안 되는(편집된) charter, 다른 allow 규칙 — 전부 보존. teardown이 "우리 흔적만" 되돌린다는 계약의 핵심.
4. **`.ditto/` 삭제는 명시적 의사표시로만.** 비대화형 `--purge` + 대화형 confirm(기본 아니오). 이 이중 방어를 완화하면 비가역 데이터 손실 경로가 열린다.
5. **empty-result는 실패.** 되돌린 게 없으면 성공이라 말하지 않는다(false-green 방지).

**약점·확장 시 깨질 지점:**

- **동시성/정합성**: 관리 파일 write는 `atomicWriteText`(temp write + rename, `src/core/fs.ts:105-111`)로 원자적이지만, teardown **전체**는 트랜잭션이 아니다. 여러 파일 strip + allowlist 제거 + 훅 제거가 순차 진행되므로, 중간에 실패하면 부분적으로 되돌려진 상태가 남을 수 있다(추론 — 명시 rollback 로직은 확인 안 됨).
- **setup과의 대칭 의존**: teardown은 목적지를 저장하지 않고 `discoverResources`+`routeResource`를 재실행해 재계산한다. setup/teardown 사이에 번들 resource 집합이나 라우팅 규칙이 바뀌면(예: 새 `GLOBAL_*` 파일 추가, prefix 규칙 변경), teardown이 되돌리는 대상 집합도 달라진다. "설치 당시"가 아니라 "현재 번들"을 기준으로 되돌린다는 뜻 — resource 목록 drift에 취약(추론).
- **charter sha 인식의 취약성**: `AGENTS.md`를 사용자가 한 글자라도(비공백) 고치면 unrecognized로 남아 charter 영역이 **제거되지 않고 남는다**. 안전 측(파괴 안 함)으로 기운 설계지만, 사용자 입장에선 "uninstall했는데 charter가 남아있다"가 될 수 있다. manifest에 없는 아주 오래된 charter 버전도 인식 실패로 남는다.
- **`.ditto_bak` 잔재**: §6 참조 — uninstall 후에도 백업 파일이 남아 "완전 제거" 기대와 어긋난다.
- **push-gate 훅의 `core.hooksPath` 케이스**: setup은 custom hooksPath(husky/lefthook)면 설치를 거부한다(`src/core/setup.ts:553-561`). teardown의 `uninstallPushGateHook`은 `gitHooksDir`(hooksPath를 honor)로 경로를 얻으므로, custom hooksPath 환경에서의 되돌리기 동작은 이번 확인 범위에서 명확히 검증하지 못했다(**미확인** — 별도 테스트 파일 확인 필요).
