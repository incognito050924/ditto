# cleanup — classify가 stage한 run 폴더에 대한 종단 처분(archive/delete/restore) 기계

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준: HEAD `c2d2e16`, 2026-07-19. 핵심 파일(`src/core/cleanup-archive.ts`)의 마지막 변경 커밋은 `7f6b0a5`(2026-06-28).

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto classify`는 "권위를 잃은 문서"(orphan/stale/contradiction)를 발견해 각각을 action 버킷으로 **옮겨(move)** run 폴더 하나에 격리한다 — 아무것도 지우지 않는다(reversible staging). `ditto cleanup`은 그 다음 단계로, 이미 stage된 run 폴더에 **종단 처분(terminal action)**을 가한다. 즉 classify=판단·격리, cleanup=처분·되돌리기다.

세 가지 처분만 존재한다(`src/cli/commands/cleanup.ts:22-33`):

- `archive` (기본, 가역): run 폴더를 zip으로 압축해 zip을 남기고 폴더를 제거. **zip이 곧 되돌리기 수단**이다.
- `delete` (비가역, gated): stage된 파일 + 폴더를 영구 삭제. 명시적 `--confirm` 없이는 거부되고, auto/autopilot 경로는 절대 통과 못 한다(fail-closed).
- `restore`: stage된 문서 하나를 원래 경로로 되돌리는 store passthrough.

DITTO 4축 어디에도 속하지 않는 **거버넌스·정리(deslop) 층**이다. ADR-0017이 정리(cleanup/refactoring) 워크플로를 ACG 게이트 위에 세운 결정이고, 이 커맨드는 그 문서-정리(doc-cleanup) 갈래의 종단 기계다. 설계 원칙은 ADR-0001의 "ditto(TypeScript)는 LLM을 호출하지 않는다"를 따라 **순수 git/zip/fs 기계**로, 판단(per-doc judgment)은 전부 classify 스킬의 subagent가 이미 끝냈다는 전제 위에 있다(`src/core/cleanup-archive.ts:8-9`).

## 2. 코드 위치와 진입점

| 파일 | 역할 |
|---|---|
| `src/cli/commands/cleanup.ts` | CLI 진입. `archive`/`delete`/`restore` 서브커맨드, 인자 파싱, `--commit` 배선, 에러→exit code 매핑 |
| `src/core/cleanup-archive.ts` | 처분 기계 본체: `archiveRun`·`deleteRun`·`restoreDoc`·`commitCleanup`(per-sub-repo 커밋)·`deleteApprovalGate`·`unrelatedDirt` |
| `src/core/cleanup-store.ts` | run 폴더 store: `createRun`·`stageDoc`·`restore`·`readIndex`. protected-set·empty-basis 거부(store 층에서 강제) |
| `src/core/cleanup-scan.ts` | classify 쪽 후보 발견 + 결정적 신호(orphan/stale). cleanup 커맨드가 직접 쓰진 않으나 같은 파이프라인 |
| `src/schemas/cleanup-index.ts` | run 인덱스(index.json) zod 스키마 = SoT(ADR-0002) |
| `src/core/autopilot-cleanup.ts` | **별개 기능**(동명이인 주의): autopilot 라이프사이클의 worktree 종단 정리. 이 커맨드와 코드 경로가 다름 |

서브커맨드·주요 인자:

| 서브커맨드 | 인자 | 비고 |
|---|---|---|
| `archive` | `--run-id`(=`--작업ID`), `--workItem`(정보용), `--commit`, `--output` | run-id 필수(없으면 usage error) |
| `delete` | `--run-id`, `--confirm`, `--commit`, `--output` | `--confirm` 없으면 거부 |
| `restore` | `--run-id`, `--path`(원래 경로, 필수), `--output` | 문서 하나 되돌리기 |

`--commit`은 archive/delete 둘 다에 있고, 처분 결과를 **영향받은 sub-repo마다 하나씩** 커밋한다(git-revertable).

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

상태의 중심은 **run 폴더**와 그 안의 `index.json`이다.

```
classify create-run        → .ditto/local/cleanup/<run-id>/            (폴더 + 4개 action 하위폴더 + index.json)
classify stage-doc         → 문서를 원래 위치에서 action 하위폴더로 move + index.entries[] 1건 append
                             ─────────────── 여기까지 classify ───────────────
ditto cleanup archive      → readIndex(--commit 시) → zip run 폴더 → 폴더 rm → (opt) commitCleanup
ditto cleanup delete       → readIndex(--commit 시) → confirm 게이트 → 폴더 rm → (opt) commitCleanup
ditto cleanup restore      → readIndex → entry 찾기 → staged_path를 original_path로 move-back
```

- run 폴더 경로: `localDir(repoRoot, 'cleanup', runId)` = `<root>/.ditto/local/cleanup/<run-id>/` (`src/core/cleanup-archive.ts:49-51`, `src/core/ditto-paths.ts:24-26`). 즉 **개인 tier**(`.ditto/local/`)에 산다.
- archive zip 경로: `<root>/.ditto/local/cleanup/archive/<run-id>.zip` (`src/core/cleanup-archive.ts:54-56`).
- index.json 스키마: `cleanupIndex`(`src/schemas/cleanup-index.ts:81-96`) — `run_id`(정규식 `^cleanup-\d{8}-\d{6}(-[a-z0-9]+)?$`), `workspace_root`, `params`, `entries[]`. 각 `entries[]`는 `original_path`·`owning_repo`·`action`·`staged_path`·`basis`(≥1 신호)를 담는다(`:55-78`).
- 출력: `--output json`이면 `{action, run_id, zip_path/removed_run_dir, ...commit}` 형태, `human`이면 사람용 줄. archive의 JSON은 `archiveRun`의 `ArchiveResult`(`:68-72`)를 그대로 편다.

`--commit`이 index를 **archive/delete가 폴더를 지우기 전에 먼저 읽어야** 하는 이유: 커밋은 각 entry의 `original_path`(원래 있던 자리에서 문서가 사라진 상태 = git이 보는 삭제)를 sub-repo별로 커밋하는데, 그 경로 목록이 index에 있고 폴더가 사라지면 index도 사라진다(`src/cli/commands/cleanup.ts:83-86`).

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

**(1) archive = zip을 남김으로써 가역.** 삭제가 아니라 "zip으로 옮김"이다. zip이 되돌리기 자산이므로 auto 경로의 기본 처분으로 안전하다(`src/core/cleanup-archive.ts:12-15`).

**(2) delete 이중 방어(fail-closed).** 영구 삭제는 되돌릴 수 없으므로 `deleteApprovalGate(confirm)`가 `confirm===true`일 때만 통과한다. "작고 가역이면 자동 승인"류의 약한 waiver가 **의도적으로 없다** — 영구 삭제는 결코 그 범주에 들지 않는다(`:101-114`). 비대화/autopilot 경로는 `confirm`이 항상 false라 자연히 거부된다. classify의 auto-cleanup 체인은 `autoChainArchive`만 호출하고 이 함수는 물리적으로 `archiveRun`만 부를 수 있어 `deleteRun`에 도달 불가하다(`:272-279`, `src/cli/commands/classify.ts:57-82`). 이 fail-closed 규율은 charter §4-8(비가역 결정은 사용자 gate)의 구체화다.

**(3) sub-repo별 커밋 = 독립 git-revertable.** `commitCleanup`은 entry들을 `owning_repo`로 그룹핑해 sub-repo마다 커밋 하나씩 만든다(`:246-263`). 각 sub-repo가 독립적으로 `git revert` 가능해야 한다는 불변식(ac-10). 이 per-sub-repo 기계는 run land-commit 단계와 **공유**하는 `commitPerSubRepo`로 뽑아, 두 호출자가 drift하지 않게 한다(`:205-234`).

**(4) dirty-tree abort(무 auto-clean/stash).** 커밋 전에 영향받은 모든 sub-repo를 먼저 검사해, 이 cleanup의 예상 삭제(`allowed` 집합) 밖의 변경이 하나라도 있으면 **커밋을 아예 하지 않고** `CleanupDirtyRepoError`로 중단한다(`:210-215`, `unrelatedDirt` `:149-174`). 자동 clean/stash로 남의 변경을 건드리지 않는다는 안전 규율.

**(5) protected-set 불가침(store 층).** `.ditto/knowledge`·`reports/design`·`reports/contracts` 접두사, `CLAUDE.md`/`AGENTS.md`/`README*` basename은 절대 stage 불가(`src/core/cleanup-store.ts:24-45`). cleanup 커맨드는 이미 stage된 것만 다루므로 이 방어는 classify(stageDoc) 단계에서 걸리지만, 같은 파이프라인의 불변식이라 여기 함께 둔다.

관련 ADR: **ADR-0001**(런타임 스택 — ditto는 LLM 미호출, 순수 기계), **ADR-0002**(스키마 SoT), **ADR-0017**(정리 절차를 ACG 게이트 위에 정립; D2 "정리 중 버그 발견해도 고치지 않음"의 정신이 이 종단 기계의 무판단 성격과 정합).

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

**`archiveRun(repoRoot, runId)`** (`src/core/cleanup-archive.ts:84-99`)
- 입력: run-id. 하는 일: `assertRunExists`로 폴더 확인 → 이전 zip을 `rm(force)`로 지워 **멱등** 보장 → `zip -r -q -y`로 압축 → 폴더 `rm`.
- 숨은 결정: `execFileSync('zip', [..., runId], { cwd: localDir(repoRoot,'cleanup') })` — cwd를 cleanup 부모로 두고 인자를 run 폴더 이름 하나로만 줘서 **아카이브가 구조적으로 그 폴더 안에 갇힌다**(부모 탈출 불가). `-y`는 심볼릭 링크를 따라가지 않고 링크 자체로 저장 → run 폴더 안 심링크가 외부 파일을 끌어오지 못하게 막는다(`:74-83`, `:92-95`). 보안·격리 의도.

**`deleteApprovalGate(confirm)` + `deleteRun(...)`** (`:108-136`)
- `deleteRun`은 폴더 확인 → 게이트 → 불통과면 `CleanupDeleteRefusedError`로 **무엇도 건드리기 전에** throw → 통과 시 폴더 `rm`.
- 인과: confirm 없이 부르면 아무 파일도 지워지지 않고 예외만 난다(fail-closed).

**`commitCleanup(repoRoot, index, message)` → `commitPerSubRepo(...)`** (`:205-263`)
- Phase 1: 모든 sub-repo에 `unrelatedDirt` 검사, dirt 있으면 즉시 throw(커밋 0건).
- Phase 2: sub-repo마다 `git add --all -- <path>` → `git diff --cached --name-only`가 비면 **idempotent skip**(이미 커밋됨/clean) → 아니면 `git commit -- <paths>` → sha 수집.
- `unrelatedDirt`는 `git status --porcelain --untracked-files=all`를 파싱하는데, `--untracked-files=all`로 개별 파일 단위를 유지해 `allowed`(항상 개별 파일)와 granularity를 맞춘다(`:149-174`). rename `old -> new`는 new 쪽 경로를 취한다(`:169-170`).
- `relForRepo`(`:266-270`): `original_path`는 workspace-root 상대인데 sub-repo 상대로 재계산해야 그 sub-repo에서 `git add`가 먹는다. 경로 정합의 핵심.

**`restoreDoc` → `CleanupStore.restore`** (`:286-295`, `src/core/cleanup-store.ts:197-208`)
- index에서 `original_path`로 entry를 찾아 `staged_path`를 `original_path`로 `rename`(move-back). 삭제가 아니라 이동이라 가역.

**CLI 에러 매핑** (`src/cli/commands/cleanup.ts:199-214`)
- `CleanupRunMissingError`·`CleanupDeleteRefusedError` → `USAGE_ERROR_EXIT`(사용자 입력 문제), `CleanupDirtyRepoError` → `RUNTIME_ERROR_EXIT`, 그 외 → runtime 실패. 종류별 exit code로 스크립트/autopilot이 원인을 구분할 수 있게 한다.

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위(위 5개 파일 + classify.ts 연결부, 정적 읽기; 실행/테스트는 이 조사에서 돌리지 않음 — 미검증):

- archive-only auto 경로: classify가 `autoChainArchive`만 호출하고 그것이 `archiveRun`만 부르는 경로가 코드로 확인됨(`:277-279`). delete 도달 불가 = 의도대로.
- delete fail-closed: `deleteRun`이 게이트 통과 전 부작용 없이 throw하는 순서 확인됨(`:130-134`). 의도대로.
- `--commit`의 index 선-읽기: archive/delete 둘 다 폴더 제거 전에 `readIndex`를 잡음(`src/cli/commands/cleanup.ts:84`, `:142`). 의도대로.

미묘한 갭·미확인:

- **restore 후 index 정합성**: `restore`는 파일을 move-back만 하고 `index.entries`에서 그 entry를 제거하지 않는다(`src/core/cleanup-store.ts:197-208`). 이후 같은 run을 `--commit`으로 archive/delete하면 index에 여전히 그 `original_path`가 남아 있어 이미 복원된(=존재하는) 파일을 커밋 대상으로 삼으려 시도한다. `git add --all` 후 diff가 비면 idempotent skip되므로 실질 무해할 가능성이 높으나, **동작으로 검증하지 않음(미확인)**. 재설계 시 확인 지점.
- **archive는 `--commit` 안 줘도 되돌림이 zip에만 의존**: archive 자체는 원래 문서를 git에서 지운 상태(classify가 move)를 커밋하지 않으므로, `--commit` 없이 archive만 하면 워킹트리에는 삭제가 남는다(git 미커밋). 이는 의도된 분리(커밋은 opt-in)로 보이나, 사용자가 이를 모르면 워킹트리 dirt로 남는다.

확인 범위에서 위 두 지점 외 로직 불일치는 발견하지 못했다.

## 7. 잠재 위험·부작용·재설계 시 고려점

**보존해야 할 불변식(재설계 시 깨지면 안 됨):**
- delete는 명시 confirm 없이는 절대 실행 안 됨(fail-closed). auto/autopilot 경로가 delete에 물리적으로 도달 불가한 구조(`autoChainArchive`가 delete를 못 부름).
- archive의 zip 격리(cwd+단일 인자+`-y`)로 폴더 밖 파일이 아카이브에 들어가지 않음.
- `--commit`은 sub-repo별 독립 커밋 + dirty면 전량 abort(부분 커밋·auto clean 금지).
- protected-set은 store 층에서 강제(어떤 caller도 우회 불가).

**약점·drift 위험:**
- `zip` 바이너리 외부 의존: `execFileSync('zip', ...)`가 시스템 `zip` 부재/버전 차이에 취약. degrade 경로 없음(미확인 — 실패 시 그대로 예외). ADR-0018(선택적 외부도구 우아한 강등)의 관점에서 archive가 `zip` 부재 시 어떻게 되는지는 재설계 시 점검 대상.
- 동시성: `createRun`은 mkdir atomic claim + suffix로 sub-second 충돌을 막지만(`src/core/cleanup-store.ts:104-137`), archive/delete 자체는 폴더/zip에 대한 락이 없다. 같은 run-id에 동시 archive+delete가 붙으면 경합 가능(미확인). 개인 tier(`.ditto/local`)라 실사용상 단일 세션 전제로 보이나, worktree 다중 세션에서의 안전성은 검증 안 됨.
- restore↔index 정합성(§6): index 갱신 없는 move-back이 후속 `--commit`과 만나는 경계.
- `original_path`가 sub-repo 밖으로 나가는 경우 `relForRepo`가 workspace-relative를 그대로 반환(`:266-270`)해 엉뚱한 repo에 `git add`할 위험 — `owning_repo` 해석이 항상 정확하다는 가정에 의존.

**재고 가능한 결정:**
- archive의 되돌리기를 zip에만 의존하는 것: zip 손상/삭제 시 복구 불가. classify가 move-not-copy이므로 원본이 zip에만 남는다. 더 강한 보존(git stash/branch)도 대안이나 현재 순수 fs/zip 단순성을 택함(ADR-0001 정신과 정합).
