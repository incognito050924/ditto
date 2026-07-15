# ADR-20260715-worktree-land-to-origin: worktree 작업의 랜딩은 작업 브랜치 커밋을 origin/<default>로 직접 push — 공유 로컬 main 머지 경로 폐기 (ADR-0011·ADR-20260626 clarify — supersede 아님)

- 상태: accepted
- 결정 일자: 2026-07-15
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: ADR-0011 (Distribution 횡단 배포계약·session-rooting invariant — land의 **목적지**가 scope-out 쓰기 경계와 직교임을 **clarify**), ADR-20260626-worktree-subrepo-scope-clarify (per-feature ephemeral worktree·rootingRoot 하위 sub-repo 쓰기 — 둘 다 ditto가 *어디에 쓰는가*를 규율하지 land target을 규율하지 않음, **clarify**), 헌장 §4-8 (push는 비가역·user-gated — 본 결정은 land의 목적지만 바꾸며 push 자체의 게이팅은 바꾸지 않는다). 코드(권위): `src/core/git.ts` (`landBranchToOrigin` — force-free push·non-FF fetch+rebase+re-push·per-attempt timeout `LAND_PUSH_TIMEOUT_MS`), `src/core/worktree.ts` (`resolveOriginDefault` via `git ls-remote --symref origin HEAD`·`branchLandedToOrigin`·`landWorktreesForWorkItem`·teardown C4 gate). 촉발 WI: wi_2607156f8.

## 컨텍스트

worktree 세션은 상태를 개별 repo가 아니라 소유 워크스페이스 `<ws>`에 루트한다(session-rooting, ADR-0011). 옛 랜딩 경로는 작업 브랜치의 커밋을 `<ws>`가 체크아웃한 공유 로컬 main에 `git merge`로 통합했다. 그런데 `<ws>`의 main은 동시에 다른 세션이 작업 중일 수 있는 살아있는 워킹트리다 — 그 브랜치에 머지하면 동시 세션의 HEAD가 이동하고 tracked 파일이 재작성된다(관측된 disruption). land 대상이 공유 워킹트리라는 것 자체가 문제였다.

## 결정

worktree 작업의 **랜딩은 작업 브랜치의 커밋을 `origin/<default>`로 직접 push**한다. 공유 로컬 main으로의 `git merge`·커밋 경로는 **폐기**한다 — land는 어떤 로컬 브랜치도 머지·이동시키지 않는다.

as-shipped 메커니즘(검증됨):

- **force-free push** of `<branch>:<default>`. 비-fast-forward 거부 시 → `origin/<default>` fetch + 그 위로 rebase(linear, **merge commit 없음**) + re-push, bounded retry. rebase **충돌 → abort + stop + surface**. **절대 `--force` 없음** — 원격 히스토리를 clobber하지 않는다.
- 각 git 서브프로세스에 **per-attempt timeout**. push는 pre-push 게이트를 돌리므로 그 예산을 넘는 긴 타임아웃(`LAND_PUSH_TIMEOUT_MS`), 순수 복구(fetch/rebase)는 짧은 타임아웃. hang은 던지지 않고 보고된다.
- `<default>`는 **원격에서** `git ls-remote --symref origin HEAD`로 해석한다(로컬 fallback 없음). origin 없음 / origin-HEAD unset·stale·degenerate → **skip + report**(잘못된 브랜치로 push하지 않는다).
- **multi-repo sub-repo는 각자 자기 `origin/<default>`로 land**한다. 일부만 성공하면 partial-land로 보고(all-or-nothing 아님).
- worktree teardown 게이트는 **"origin에 landed"**(= `refs/remotes/origin/<default>`에서 reachable)를 키로 삼는다 — 로컬-HEAD 조상 관계가 아니다.
- land 이후 **로컬 default 브랜치는 갱신하지 않는다**. 개발자가 `git fetch`로 당겨온다.

## 대안 (기각)

- **공유 로컬 main 머지 경로 유지(현행)** — 기각. `<ws>`의 main은 동시 세션이 쓰는 살아있는 워킹트리라, 머지가 그 세션의 HEAD·tracked 파일을 재작성한다(관측). land 대상을 공유 워킹트리에서 떼어내야 근본 해소된다.
- **`--force` push로 non-FF 회피** — 기각. 원격 히스토리를 clobber해 다른 landed 작업을 지운다. non-FF는 fetch+rebase+re-push로 회복하고, 회복 불가 시 멈춰 surface한다.

## 근거 (rationale)

- **session-rooting과 land 목적지의 분리.** 세션이 `<ws>`에 루트한다는 사실은 상태의 위치를 정하는 것이지, 완료된 커밋을 어디로 올릴지를 정하지 않는다. origin으로 랜딩하면 land 대상이 공유 워킹트리에서 분리되어, 한 세션의 완료가 다른 세션의 체크아웃을 흔들지 않는다.
- **origin이 진실이면 로컬 ref는 redundant.** `refs/remotes/origin/<default>`에서 reachable하면 그 커밋은 원격에 durable하게 존재한다. teardown을 이 신호에 키잉하면(로컬-HEAD 조상 관계 대신) push가 실패한 브랜치는 보존되고 성공한 브랜치만 정리된다 — 유실 없는 정리.
- **선형·force-free는 원격을 보호한다.** merge commit 없는 rebase는 히스토리를 선형으로 유지하고, `--force` 금지는 남의 landed 작업을 덮지 않게 한다. 회복 불가한 충돌은 조용히 넘기지 않고 멈춰 드러낸다(헌장 §4-5·§4-10).

## 변경 조건 (change_condition)

- **오프라인 랜딩(origin 없음)이 first-class 경로 요구가 되면** → 현재 no-origin은 benign skip이다. 오프라인에서도 완결적 land가 필요하면 land 경로를 재설계한다(로컬 통합 지점 재도입 여부 포함).
- **공유 로컬 통합 브랜치가 재도입되면**(예: 팀이 origin 대신 로컬 shared main으로 통합) → 본 "로컬 main 머지 폐기" 결정을 그 통합 모델 기준으로 재검토한다.
- **push 전송이 `git push origin`에서 벗어나면**(예: PR API·외부 머지 서비스로 land) → force-free·rebase·teardown-키잉 메커니즘을 새 전송 기준으로 다시 정의한다.

## ADR-0011·ADR-20260626과의 관계 (clarify, supersede 아님)

두 기존 ADR은 **ditto가 어디에 쓰는가**(scope-out 쓰기 경계 / worktree·sub-repo 쓰기 범위)를 규율한다. 본 ADR은 **완료된 커밋을 어디로 land하는가**를 정한다 — 직교한 축이다. session-rooting invariant(rootingRoot 밖 쓰기 차단)도, worktree sub-repo 쓰기 경계도 그대로 유효하며 본 결정이 뒤집지 않는다. land 목적지를 공유 워킹트리에서 origin으로 옮긴 것은 그 쓰기 경계 규율과 충돌하지 않는, 명시적 clarify·확장이다. **supersede 아님.**
