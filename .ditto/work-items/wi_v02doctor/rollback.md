# Rollback: wi_v02doctor

본 work item이 만들거나 수정하는 *각 파일*을 단계별로 되돌리는 절차. 디렉터리 단위 명령은 사용하지 않는다. 본 work item 시작 이전부터 존재하던 파일은 *삭제 대상이 아니며* `git restore <file>`로만 되돌린다.

## 사전 점검 (모든 rollback 전 필수)

```
git status --short
```

본 work item과 무관한 변경이 섞여 있으면 그것부터 분리한다(`git stash push -m "unrelated"` 등). 무관 변경이 분리되기 전에는 어떤 rollback도 시작하지 않는다.

## 파일 분류

본 work item이 생성하는 신규 파일(이 파일들만 삭제 가능):

- `src/core/instruction-bridge.ts`
- `src/core/permission-inventory.ts`
- `src/core/mcp-inventory.ts`
- `src/core/surface-inventory.ts`
- `src/cli/commands/doctor.ts`
- `tests/core/instruction-bridge.test.ts`
- `tests/core/permission-inventory.test.ts`
- `tests/core/mcp-inventory.test.ts`
- `tests/core/surface-inventory.test.ts`
- `tests/doctor/instructions.test.ts`
- `tests/doctor/permissions.test.ts`
- `tests/doctor/mcp.test.ts`
- `tests/doctor/surface.test.ts`
- `tests/fixtures/doctor/<scenario>/` 신규 fixture (정확한 디렉터리는 D-결정 후 확정)

본 work item이 수정만 하는 기존 파일(삭제 금지, restore만):

- `src/cli/index.ts` (doctor subCommand 등록만 추가)
- `tests/schemas/repo-self-validation.test.ts` (케이스 보강 한정)

본 work item이 만들거나 갱신하는 `.ditto/` repo-local 파일(보존 또는 별도 처리):

- `.ditto/work-items/wi_v02doctor/{work-item.json, progress.md, completion.json, handoff.md, language-ledger.json}`
- 사용자 manual smoke로 생긴 임시 `.ditto/work-items/<smoke-wi>/...`는 사용자 실험 자산이므로 자동 삭제 대상 아님.

## 단계별 rollback (각 단계 독립)

각 명령은 *해당 단계가 만든 파일만* 다룬다.

### P-1 ~ P-4 (core 신규)
```
git restore --staged --worktree src/core/instruction-bridge.ts
git restore --staged --worktree src/core/permission-inventory.ts
git restore --staged --worktree src/core/mcp-inventory.ts
git restore --staged --worktree src/core/surface-inventory.ts
# 신규 untracked인 경우 파일 단위로 삭제
test -f src/core/instruction-bridge.ts && rm src/core/instruction-bridge.ts
test -f src/core/permission-inventory.ts && rm src/core/permission-inventory.ts
test -f src/core/mcp-inventory.ts && rm src/core/mcp-inventory.ts
test -f src/core/surface-inventory.ts && rm src/core/surface-inventory.ts
```

각 P-1/P-2/P-3/P-4는 독립이므로 자기 파일 한 줄만 처리.

### P-5 (doctor CLI 신규 + 기존 index.ts 수정)
```
# doctor.ts는 신규
git restore --staged --worktree src/cli/commands/doctor.ts
test -f src/cli/commands/doctor.ts && rm src/cli/commands/doctor.ts

# index.ts는 기존 — restore만, 삭제 금지
git restore --staged --worktree src/cli/index.ts
```

### P-6 (doctor 회귀 테스트 + fixture 신규)
```
git restore --staged --worktree tests/doctor/instructions.test.ts
git restore --staged --worktree tests/doctor/permissions.test.ts
git restore --staged --worktree tests/doctor/mcp.test.ts
git restore --staged --worktree tests/doctor/surface.test.ts
test -f tests/doctor/instructions.test.ts && rm tests/doctor/instructions.test.ts
test -f tests/doctor/permissions.test.ts && rm tests/doctor/permissions.test.ts
test -f tests/doctor/mcp.test.ts && rm tests/doctor/mcp.test.ts
test -f tests/doctor/surface.test.ts && rm tests/doctor/surface.test.ts
rmdir tests/doctor 2>/dev/null || true

# fixture 디렉터리는 파일 단위 삭제 (디렉터리 단위 rm -rf 금지)
# [DECISION NEEDED: 정확한 fixture 디렉터리 목록 후 확정]
```

### P-7 (self-validation 보강 — 기존 파일 수정만)
```
# 기존 파일이므로 restore만. 삭제 금지(wi_v01bootstrap 자산).
git restore --staged --worktree tests/schemas/repo-self-validation.test.ts
```

### P-8 (manual smoke가 만든 `.ditto/` 파일)
사용자가 manual smoke로 만든 work item/run/evidence는 사용자의 실험 결과이므로 자동 삭제 대상이 아니다. 본 rollback 범위에서는 삭제하지 않는다.

`wi_v01bootstrap`, `wi_v01implement`, `wi_v02doctor` 자체와 `.ditto/knowledge/`는 어떤 단계 rollback에서도 손대지 않는다.

## 전체 abort 시나리오

어느 ac에서든 abort가 필요할 때:

1. `.ditto/work-items/wi_v02doctor/progress.md`에 어디까지 했는지, 무엇이 깨졌는지 기록한다.
2. 위 단계별 절차 중 해당 단계에 *명시된 파일에 한정해서만* 되돌린다.
3. `wi_v02doctor/work-item.json`의 status를 `blocked`로 갱신한다. schema가 강제하는 `re_entry.command` 또는 `re_entry.fresh_evidence_needed`를 채운다.
4. `wi_v02doctor/handoff.md`를 작성해 다음 세션이 무엇부터 다시 봐야 할지 적는다.

## 금지 사항

- `git reset --hard`, `git checkout .`, `git checkout --`, `git restore .` 같은 디렉터리/전체 단위 명령 사용 금지.
- `git clean -fd`, `git clean -fx` 사용 금지.
- 디렉터리 단위 `rm -rf src/core`, `rm -rf tests/doctor` 금지. 파일 단위 `rm <file>`만 허용.
- `bun install` 의존성 제거 금지 (스택은 ADR-0001로 fix).
- `--no-verify`, `--no-gpg-sign` 같은 hook/sign 우회 금지.
- `.ditto/knowledge/` 어떤 파일도 본 rollback이 손대지 않는다.
- `tests/schemas/repo-self-validation.test.ts`와 `tests/schemas/fixture-validation.test.ts`는 삭제 금지 (wi_v01bootstrap 자산).
- 사용자 환경의 `.claude/`, `.codex/` 등 host 설정 파일은 본 work item rollback이 어떤 경우에도 수정/삭제하지 않는다.

## 안전 점검 (rollback 직후)

```
git status --short
bun x tsc --noEmit
bun run lint
bun test
```

위 명령이 통과하지 않으면 rollback이 불완전한 것이므로 다음 단계로 진행하지 않는다.
