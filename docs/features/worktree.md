# worktree — work item별 격리된 git worktree(자기 브랜치·자기 파일)로 여러 feature를 병렬 개발

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋: `c2d2e16`, 작성일: 2026-07-19.

## 1. 이 기능이 실현하려는 설계 의도 (개념)

한 PC에서 여러 feature를 동시에 개발할 때, 두 작업(그리고 각자의 autopilot)이 같은 워킹트리를 공유하면 서로의 파일·브랜치·HEAD를 밟는다. `worktree` 커맨드는 **work item마다 자기 브랜치(`ditto/<wi>`)와 자기 체크아웃(`.ditto/local/worktrees/<wi>`)을 가진 격리된 git worktree**를 만들어 이 충돌을 없앤다. feature A의 autopilot이 A의 worktree에서 파일을 고쳐도 feature B의 worktree는 무관하다.

핵심 개념은 세 가지다.
- **per-feature ephemeral worktree**: feature 작업 동안만 존재하고 끝나면 제거하는 단기 worktree. 상주(resident) 환경이 아니다 (`src/core/worktree.ts:24`, ADR-20260626 D1).
- **session-rooting**: worktree 안에서 세션을 열면 상태(work item·autopilot·session)는 worktree 자기 `.ditto`가 아니라 **소유 워크스페이스 `<ws>`의 단일 `.ditto/local`**에 루트한다 (`src/core/fs.ts:62-63`, ADR-0011).
- **origin-land**: 완료된 커밋의 랜딩은 공유 로컬 main으로의 merge가 아니라 작업 브랜치를 `origin/<default>`로 직접 push한다 — 공유 워킹트리를 흔들지 않기 위함이다 (`src/core/worktree.ts:585-593`, ADR-20260715).

DITTO 4축 분류상 이 기능은 **오케스트레이션 축의 실행 격리 하부구조**다(autopilot이 안전하게 병렬로 돌 수 있게 하는 받침). 순수 지식·의도·E2E 축이 아니라, 병렬 개발이라는 배포·거버넌스 인접 문제를 푼다. (추론: 4축 명시 태깅을 코드에서 찾지는 못함 — 기능 성격 기반 분류.)

## 2. 코드 위치와 진입점

| 경로 | 역할 |
| --- | --- |
| `src/cli/commands/worktree.ts` | CLI 진입. 4개 서브커맨드 정의, 인자 파싱, 출력 포맷 |
| `src/core/worktree.ts` | worktree 생명주기 코어: create/remove/list/land + 락 + rooting 파서 |
| `src/core/worktree-drive.ts` | `driveWorktrees` 오케스트레이터(독립 집합 drive→land→teardown) |
| `src/schemas/work-item.ts:130-143` | `workItemWorktree` 스키마 — 각 worktree 메타(owning_repo/worktree_path/branch) |
| `src/core/fs.ts:52-79` | `findRepoRoot` — worktree cwd를 소유 워크스페이스로 rooting |
| `src/hooks/session-start.ts:20-36` | 세션 시작 시 worktree cwd → work item 자동 바인딩 |
| `src/hooks/pre-tool-use.ts:663` | scope-out 쓰기 가드가 rootingRoot 경계 판정에 같은 파서 사용 |
| `src/core/git.ts:308-370` | `landBranchToOrigin` — force-free push·non-FF rebase·per-attempt timeout |

서브커맨드 (`src/cli/commands/worktree.ts:290-301`):

| 서브커맨드 | 인자 | 하는 일 |
| --- | --- | --- |
| `create <workId>` | `--output human\|json` | work item 브랜치+worktree(들) 생성. multi-repo는 sub-repo마다 nest (`:33-81`) |
| `remove <workId>` | `--force`, `--output` | worktree 제거. dirty/미랜딩이면 `--force` 없이 차단 (`:83-136`) |
| `list` | `--output` | 워크스페이스 전 worktree와 git 상태(dirty, ahead/behind, orphan) 나열 (`:138-183`) |
| `drive <workIds...>` | `--push`, `--max-depth`, `--output` | 독립 집합의 각 멤버를 자기 worktree에서 autopilot drive → (`--push` 시) origin land → teardown (`:185-288`) |

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

**입력**: work item id(들). 형태 검증은 `workItemId` zod 스키마로 진입 시점에 한다 (`src/cli/commands/worktree.ts:24-31`). `drive`는 경로/서브프로세스에 id가 흘러가기 전에 전체 variadic 집합을 검증한다 (`:219-228`).

**읽는 상태**:
- work item 존재 여부·메타 → `WorkItemStore` (`.ditto/local/work-items/<wi>/`). worktree 메타는 work item의 `worktrees[]` 필드가 SoT (`src/core/worktree.ts:398-400`).
- git worktree porcelain → `git worktree list --porcelain` (`:88-106`).
- base 브랜치 → 각 owning repo의 `origin/HEAD` 또는 현재 브랜치 (`:143-158`).

**쓰는 상태**:
- git worktree 등록 + 브랜치 → `git worktree add -b ditto/<wi> -- <path> <base>` (`:290-297`).
- worktree 체크아웃 디렉터리 → `.ditto/local/worktrees/<wi>[/<sub-repo>]` (`:317-334`).
- work item 메타 `worktrees[]` → `store.update` (`:359-361`).
- 동시성 락 → `.ditto/local/worktrees/.lock` 디렉터리 + `pid` 파일 (`:244-288`).

흐름 (create → drive --push):

```
create <wi>
  └ withWorktreeLock
      ├ git worktree add -b ditto/<wi>  (workspace '.', base=origin/HEAD)
      ├ 각 sub-repo: git worktree add -b ditto/<wi>  (nested, 자기 base)
      │   └ 실패 시 전체 롤백(force-remove + branch -D) → rethrow  [atomic-or-nothing]
      └ store.update(worktrees[] = meta)

drive <wi> --push
  └ 멤버별: get → worktree 있나? intent-lock 됐나?
      ├ productionDriveMember(worktreeCwd, wi)   [autopilot 전체 구동]
      └ done이면 finishMember:
          ├ landWorktreesForWorkItem  (sub-repo 먼저, '.' 마지막)
          │   └ 각 repo: git push branch:origin/<default>  (force-free, non-FF→rebase)
          └ allLanded면 removeWorktreesForWorkItem (teardown)
```

**출력**: `human`(탭 구분 표) 또는 `json`. `create`는 생성된 worktree 목록 + 바인딩 힌트, `list`는 상태 표, `drive`는 멤버별 disposition ledger를 출력한다.

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### session-rooting invariant (ADR-0011, ADR-20260626 D2)
worktree 체크아웃은 tracked `.ditto/`(knowledge)를 함께 가져오므로, 순진한 walk-up은 worktree 자기 `.ditto`에서 멈춰 세션을 worktree 안에 rooting해 버린다 — 거기엔 메인의 gitignored `.ditto/local`(work-items·autopilot·sessions)이 체크아웃돼 있지 않아 보이지 않는다 (`src/core/worktree.ts:60-65`). 그래서 `findRepoRoot`는 walk-up **전에** 경로 세그먼트로 worktree를 감지해 소유 워크스페이스 `<ws>`로 되돌린다 (`src/core/fs.ts:57-63`). 결과: **코드 편집은 worktree에, 상태는 단일 메인 소스에** 남는다.

ADR-20260626 D2는 이 rooting이 ADR-0011의 scope-out 쓰기 차단을 뒤집지 않음을 못박는다. rootingRoot를 워크스페이스에 두면 그 하위 sub-repo 쓰기는 경계 **안**이라 in-scope다. rootingRoot **밖** 타 repo 쓰기는 여전히 차단(supersede 아님).

### per-feature ephemeral worktree (ADR-20260626 D1)
ADR-0022 D1은 worktree를 "기각"했지만, 그건 stable/dev를 격리하는 **상주** 도그푸딩 용법에 한정된다. 여기 worktree는 목적(병렬 feature 개발)·수명(작업 동안만)이 다른 직교 축이라 그 기각의 재도입이 아니다. 변경 조건: ephemeral이 사실상 상주로 변질되면 재평가.

### origin-land, 공유 로컬 main 머지 폐기 (ADR-20260715)
옛 랜딩은 작업 브랜치를 `<ws>`의 공유 로컬 main에 merge했다. 그런데 그 main은 다른 세션이 동시에 쓰는 살아있는 워킹트리라, 머지가 그 세션의 HEAD·tracked 파일을 재작성했다(관측된 disruption). 그래서 land를 **`origin/<default>`로 직접 push**로 바꿔 land 대상을 공유 워킹트리에서 떼어냈다. teardown 게이트도 "origin에 landed"(= `refs/remotes/origin/<default>`에서 reachable)를 키로 삼는다 — 로컬-HEAD 조상 관계가 아니다 (`src/core/worktree.ts:507-521`). 기각된 대안: `--force` push로 non-FF 회피(원격 히스토리 clobber → 남의 landed 작업 삭제) — non-FF는 fetch+rebase+re-push, 회복 불가 시 멈춰 surface.

### git option injection 가드 (cov-d-git-validation)
브랜치·sub-repo 이름이 git argv로 흐른다. `execFileSync`는 배열 전달이라 shell injection은 없지만 `-`-접두 토큰은 git 옵션으로 파싱된다. `assertSafeArg`가 `-` 시작을 거부하고, 경로/base는 호출부에서 `--`로 옵션 파싱을 끝낸다 (`src/core/worktree.ts:132-136`, `:293`).

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### `withWorktreeLock` — repo 레벨 뮤텍스 (`src/core/worktree.ts:244-288`)
`git worktree add/remove`는 공유 `.git/worktrees` 레지스트리를 변형하고 work-item.json은 read-modify-write이므로, 둘을 하나의 락(atomic `mkdir`의 `.lock` 디렉터리) 아래 직렬화한다. 홀더는 획득 직후 `pid`를 쓴다.
- **PID-liveness reclaim**: EEXIST를 만난 대기자가 홀더를 분류한다. pid가 죽은 프로세스면 `dead-pid`(unlink+rmdir로 즉시 회수), pid 파일 없이 grace(2s)보다 오래된 빈 디렉터리면 `empty-stale`(rmdir만) (`:202-224`). `empty-stale`이 unlink를 생략하는 게 안전의 핵심 — 관측 없이 지운 pid가 없으므로, 그 사이 peer가 재획득하면 non-empty가 돼 rmdir이 실패하고 live 락은 보존된다 (`:266-270`). 30s deadline은 **살아있는** 홀더에만 적용.

### `createWorktreeForWorkItem` — atomic-or-nothing 생성 (`:310-363`)
workspace('.') worktree를 먼저 만들고, `detectSubRepos`(hidden dir 제외, `.git` 있는 직속 자식)로 발견한 sub-repo마다 nested worktree를 자기 base에서 만든다. **어느 sub-repo라도 실패하면** 이 호출에서 만든 worktree+branch 전부를 역순으로 force-remove·`branch -D`로 롤백하고 rethrow한다 (`:336-357`). 효과: work-item 메타가 phantom worktree를 가리키는 일이 없다 — 메타는 모든 worktree가 존재한 뒤 같은 락 안에서만 쓴다 (`:359-361`).

### `listWorktreesForWorkspace` — 메타 ∪ porcelain (`:398-471`)
work-item 메타의 `worktrees[]`가 무엇이 존재해야 하는지의 SoT다. 각 항목의 dir이 없으면 crash 대신 `exists:false`로 보고 (`:411-424`). 그다음 **porcelain ∖ meta**: 디스크에 있으나 어떤 메타에도 없는 run worktree를 `orphan:true`로 추가한다 (`:444-469`) — work item 폐기/메타 out-of-band 삭제/외부 `git worktree add`로 생긴 누수를 list 표면이 숨기지 않게 한다.

### `removeWorktreesForWorkItem` — 안전 teardown (`:523-583`)
sub-repo worktree 먼저(nest되어 있으므로), workspace 마지막 순서로 처리 (`:534-536`). 각 worktree가 **dirty**(미커밋)이거나 **unlanded**(`branchLandedToOrigin`이 false)이고 `force`가 아니면 `blocked`로 남기고 삭제하지 않는다 (`:544-552`). 삭제 시 브랜치는 `-d`가 아니라 `-D`로 지운다 — landed 브랜치는 로컬 main에 머지된 적이 없어 `-d`의 로컬-머지 검사가 항상 실패하기 때문 (`:558-564`). 실제 제거된 worktree만 메타에서 뺀다 → partial teardown도 정확한 메타 (`:573-580`). CLI는 blocked를 crash가 아닌 의도적 안전 거부로 보고 exit 0을 유지한다 (`src/cli/commands/worktree.ts:130`).

### `landWorktreesForWorkItem` / `landBranchOwning` — 직접 origin land (`:686-748`)
`resolveOriginDefaultBranch`는 로컬이 아니라 **원격**에서 `git ls-remote --symref origin HEAD`로 default를 해석한다 — land 목적지이므로 로컬 fallback이 push를 잘못 겨냥하지 않게 (`:603-620`). 자기 가드: origin 없음/미해석/stale → `skipped-no-origin`; default==branch(degenerate) → skip; 이미 reachable → `landed`(멱등 재개) (`:686-708`). land는 **비원자·비가역**이라 첫 hard failure에서 STOP하고 어느 repo가 이미 landed됐는지 보고한다(all-or-nothing 아님). benign no-origin skip은 sweep을 멈추지 않는다 (`:731-742`). `LandStatus`는 실패 클래스를 구분 유지한다(`skipped-no-origin` / `push-gate-rejected` / `auth-or-network-failed` / `non-ff-retry-exhausted` / `rebase-conflict`, `:648-655`) — 절대 collapse하지 않음. git 원출력은 reason에 들어가기 전 `scrubCredentials`로 자격증명 제거 (`:707`).

### `driveWorktrees` — 독립 집합 오케스트레이터 (`src/core/worktree-drive.ts:99-221`)
`chain-drive.ts`의 injectable-seam 모양을 미러링해(`driveMember`/`land`/`removeWorktrees` 주입) 결정적 오케스트레이션을 단위 테스트 가능하게 한다. `work chain drive`와 달리 집합이 follows-spine이 **아니다** — 한 멤버의 halt가 나머지를 멈추지 않고 CONTINUE하며, **오직 depth cap만** 루프를 끊는다 (`:158-202`). 멤버별 게이트: worktree 없음→halt; terminal-not-done(abandoned)→halt; 이미 done→drive 스킵하고 finish로(멱등 재개, cap 소비 안 함); intent-lock 없음→halt(`needs-intent-lock`, 절대 intent 자동 생성 안 함) (`:163-190`). `finishMember`는 `--push` 없으면 `driven-not-landed`로 두고(push는 비가역·user-gated), `--push`면 land→allLanded 시 teardown (`:110-156`). hard land failure는 `land-failed`로 worktree를 보존한다(force-delete 안 함, `:150-155`).

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위(코드 정적 읽기 + import 추적 + ADR 대조; 실행/테스트는 돌리지 않음):

- **session-rooting**: `findRepoRoot`(`fs.ts:62`)·`session-start.ts:25`·`pre-tool-use.ts:663`이 모두 동일 `parseWorktreePath`를 쓴다 — rooting 판정이 3곳에서 일관. 의도와 일치.
- **land 목적지 = origin, teardown 키 = origin-reachable**: `removeWorktreesForWorkItem`의 `unlanded` 판정(`worktree.ts:545`)과 land 성공 판정(`branchLandedToOrigin`, `:630-646`)이 **같은 신호**(origin/<default> reachable)를 읽는다. gate↔score 일치. ADR-20260715와 일치.
- **멱등 재개**: `landBranchOwning`(이미 reachable→landed)과 `driveWorktrees`(status==='done'→finish만)가 모두 멱등. 일치.
- **atomic-or-nothing create**의 롤백은 best-effort(각 remove/branch-D를 catch로 삼킴, `:344-354`). worktree remove가 실패하면 메타는 안 쓰이지만(rethrow 전) 고아 worktree가 디스크에 남을 수 있다 — 단, `list`의 orphan 검출이 이를 나중에 드러내므로 은폐되진 않는다. 의도와 일치하되 완전 원자성은 아님(아래 §7).

확인 범위에서 죽은 경로·의도 배반은 발견하지 못함.

미확인: 실제 multi-repo 환경에서 sub-repo nested worktree land의 partial-land 동작은 코드로만 확인했고 실행 검증은 하지 않았다.

## 7. 잠재 위험·부작용·재설계 시 고려점

- **create 롤백의 비원자성**: sub-repo 생성 실패 시 롤백이 best-effort catch라(`:344-354`), git worktree remove 자체가 실패하면 디스크에 고아 worktree가 남는다. `list`의 orphan 검출이 사후에 드러내므로 침묵 누수는 아니지만, 클린업은 수동(`worktree remove --force` 또는 git 직접)이다. 재설계 시 이 "detect-but-not-auto-heal" 경계를 보존할지 결정 필요.
- **동시성 락은 workspace 단위 전역**: `.ditto/local/worktrees/.lock` 하나가 create/remove/land 임계구역을 직렬화한다. 서로 다른 work item의 worktree 조작도 이 락을 두고 경합하며, 30s deadline 초과 시 throw한다. 대량 병렬 `drive`에서 락 대기가 병목이 될 수 있다. 락 세분화는 재설계 후보지만 `.git/worktrees` 레지스트리 공유 때문에 세분화가 자명하지 않다.
- **공유트리 동시 세션 gotcha**(메모리 기록 다수와 일치): worktree를 안 쓰고 여러 세션이 같은 메인 체크아웃을 공유하면 land abort·pre-commit 외래 lint·changed_files 오염이 반복 관측됐다. origin-land(ADR-20260715)는 land 대상을 공유 워킹트리에서 떼어내 이 disruption의 근원 중 하나를 없앤 것이다 — 재설계 시 **land가 로컬 공유 브랜치를 절대 이동시키지 않는다**는 불변식은 반드시 보존해야 한다.
- **land 후 로컬 default 미갱신**: 의도된 동작이지만(개발자가 `git fetch`), CLI가 매번 NOTE로 안내한다(`worktree.ts:277-281`). 로컬 sync를 자동화하면 다시 공유 워킹트리를 건드리게 되므로 이 불변식도 보존 대상.
- **보존해야 할 불변식**: ① session-rooting(worktree 코드/메인 상태 분리), ② teardown 게이트 = origin-reachable(로컬-HEAD 아님), ③ force-free push(원격 히스토리 clobber 금지), ④ push는 user-gated(`--push` 없으면 land 안 함), ⑤ no-auto-pick(intent 자동 생성·자동 발견 금지 — `drive`는 명시 id만 구동).
- **재고 가능한 결정**: offline land(origin 없음은 현재 benign skip), 락 세분화, create 롤백의 자동 힐링 — 모두 ADR-20260715/ADR-20260626의 change_condition에 재개방 조건이 명시돼 있다.
