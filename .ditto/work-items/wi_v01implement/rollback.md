# Rollback: wi_v01implement

본 work item이 만들거나 수정하는 *각 파일*을 단계별로 되돌리는 절차다. 디렉터리 단위 명령은 사용하지 않는다. 본 work item 시작 이전부터 존재하던 파일은 어떤 단계 rollback에서도 *삭제 대상이 아니며*, `git restore <file>`로만 되돌린다.

## 사전 점검 (모든 rollback 전 필수)

```
git status --short
```

본 work item과 무관한 변경이 섞여 있으면 그것부터 분리한다(`git stash push -m "unrelated"` 등). 무관 변경이 분리되기 전에는 어떤 rollback도 시작하지 않는다.

## 파일 분류

본 work item이 생성하는 신규 파일(이 파일들만 삭제 가능):

- `src/core/fs.ts`
- `src/core/id.ts`
- `src/core/work-item-store.ts`
- `src/core/run-store.ts`
- `src/core/evidence-store.ts`
- `tests/core/fs.test.ts`
- `tests/core/id.test.ts`
- `tests/core/work-item-store.test.ts`
- `tests/core/run-store.test.ts`
- `tests/core/evidence-store.test.ts`

본 work item이 수정만 하는 기존 파일(삭제 금지, restore만):

- `src/cli/commands/work.ts`
- `src/cli/commands/run.ts`
- `src/cli/commands/verify.ts`
- `src/cli/util.ts`
- `tests/schemas/repo-self-validation.test.ts` (케이스 보강만)

본 work item이 만들거나 갱신하는 `.ditto/` repo-local 파일(보존 또는 별도 처리):

- `.ditto/work-items/wi_v01implement/{work-item.json, progress.md, completion.json, handoff.md, language-ledger.json}` — 본 work item의 자기 기록. 의도된 abort 시 progress.md에 사유를 적고 status를 `blocked`로 둔다.
- 사용자 manual smoke로 생긴 `.ditto/work-items/<smoke-wi>/...`, `.ditto/runs/<smoke-run>/...` — 사용자 실험 자산이므로 자동 삭제 대상 아님.

## 단계별 rollback (각 단계 독립)

각 명령은 *해당 단계가 만든 파일만* 다룬다. 다른 단계나 무관한 사용자 변경에는 영향이 없다.

### P-1 ~ P-5 (core 신규)
```
# 신규 파일 단위로 정리. 디렉터리 단위 명령 금지.
git restore --staged --worktree src/core/fs.ts
git restore --staged --worktree src/core/id.ts
git restore --staged --worktree src/core/work-item-store.ts
git restore --staged --worktree src/core/run-store.ts
git restore --staged --worktree src/core/evidence-store.ts
# 신규 untracked인 경우는 위 명령으로 처리되지 않으므로 파일 단위로 삭제
test -f src/core/fs.ts && rm src/core/fs.ts
test -f src/core/id.ts && rm src/core/id.ts
test -f src/core/work-item-store.ts && rm src/core/work-item-store.ts
test -f src/core/run-store.ts && rm src/core/run-store.ts
test -f src/core/evidence-store.ts && rm src/core/evidence-store.ts
# src/core/ 디렉터리가 비면 자연스레 제거할 수 있으나 rmdir만 사용(빈 경우에만 성공)
rmdir src/core 2>/dev/null || true
```

각 단계는 단독으로도 위 명령 중 자기 파일만 다루면 된다. 예: P-1만 되돌리려면 `src/core/fs.ts` 한 줄만.

### P-6 (CLI 실구현 - 기존 파일 수정만)
```
# 기존 파일이므로 restore만, 삭제 금지
git restore --staged --worktree src/cli/commands/work.ts
git restore --staged --worktree src/cli/commands/run.ts
git restore --staged --worktree src/cli/commands/verify.ts
git restore --staged --worktree src/cli/util.ts
```

CLI가 core를 import하면, P-1~P-5가 없는 상태에서 P-6만 살아 있으면 컴파일이 깨진다. P-6을 되돌리려면 위 명령으로 CLI를 not_implemented 상태로 복귀시킨다.

### P-7 (자체 검증 테스트 확장 - 기존 파일 수정만)
```
# 기존 파일이므로 restore만. 삭제 금지(wi_v01bootstrap의 자산).
git restore --staged --worktree tests/schemas/repo-self-validation.test.ts

# 신규 단위 테스트 파일들은 단독 삭제 가능
git restore --staged --worktree tests/core/fs.test.ts
git restore --staged --worktree tests/core/id.test.ts
git restore --staged --worktree tests/core/work-item-store.test.ts
git restore --staged --worktree tests/core/run-store.test.ts
git restore --staged --worktree tests/core/evidence-store.test.ts
test -f tests/core/fs.test.ts && rm tests/core/fs.test.ts
test -f tests/core/id.test.ts && rm tests/core/id.test.ts
test -f tests/core/work-item-store.test.ts && rm tests/core/work-item-store.test.ts
test -f tests/core/run-store.test.ts && rm tests/core/run-store.test.ts
test -f tests/core/evidence-store.test.ts && rm tests/core/evidence-store.test.ts
rmdir tests/core 2>/dev/null || true
```

### P-8 (manual smoke가 만든 `.ditto/` 파일)
사용자가 manual smoke로 만든 work item/run/evidence는 사용자의 실험 결과이므로 자동 삭제 대상이 아니다. 제거가 필요하면 별도 작업으로 id와 파일 목록을 확정한 뒤 파일 단위로 처리한다. 본 rollback 절차 안에서는 smoke 디렉터리를 삭제하지 않는다.

`wi_v01bootstrap`, `wi_v01implement`, `.ditto/knowledge/`는 어떤 단계 rollback에서도 손대지 않는다.

## 전체 abort 시나리오

어느 ac에서든 abort가 필요할 때:

1. `.ditto/work-items/wi_v01implement/progress.md`에 어디까지 했는지, 무엇이 깨졌는지 기록한다.
2. 위 단계별 절차 중 해당 단계에 *명시된 파일에 한정해서만* 되돌린다.
3. `wi_v01implement/work-item.json`의 status를 `blocked`로 갱신한다. 이 경우 `re_entry`는 schema가 강제하므로 `command` 또는 `fresh_evidence_needed`가 채워져야 한다.
4. `wi_v01implement/handoff.md`를 작성해 다음 세션이 무엇부터 다시 봐야 할지 적는다.

## 금지 사항

- `git reset --hard`, `git checkout .`, `git checkout --`, `git restore .` 같은 디렉터리/전체 단위 명령은 본 work item rollback에서 절대 사용하지 않는다. 다른 사용자 변경을 함께 삭제할 위험이 있다.
- `git clean -fd`, `git clean -fx` 사용 금지. untracked 파일이 다른 작업의 in-progress일 수 있다.
- 디렉터리 단위 `rm -rf src/core`, `rm -rf tests/core` 금지. 다른 세션/사용자가 같은 디렉터리에 새 파일을 넣었을 수 있다. 파일 단위 `rm <file>`만 허용한다.
- `bun install` 의존성 제거 금지 (스택은 ADR-0001로 fix).
- `--no-verify`, `--no-gpg-sign` 같은 hook/sign 우회 금지.
- `.ditto/knowledge/` 어떤 파일도 본 rollback이 손대지 않는다.
- `tests/schemas/repo-self-validation.test.ts`와 `tests/schemas/fixture-validation.test.ts`는 삭제 금지(wi_v01bootstrap 자산).

## 안전 점검 (rollback 직후)

```
git status --short
bun x tsc --noEmit
bun run lint
bun test
```

위 명령이 통과하지 않으면 rollback이 불완전한 것이므로 다음 단계로 진행하지 않는다.
