# Rollback: wi_v02harden

본 work item이 만들거나 *수정하는* 각 파일을 단계별로 되돌리는 절차. 디렉터리 단위 명령은 사용하지 않는다. 본 work item 시작 이전부터 존재하던 파일은 *삭제 대상이 아니며* `git restore <file>`로만 되돌린다.

## 사전 점검 (모든 rollback 전 필수)

```
git status --short
```

본 work item 외 변경이 섞여 있으면 그것부터 분리한다(`git stash push -m "unrelated"` 등). 무관 변경이 분리되기 전에는 어떤 rollback도 시작하지 않는다.

## 파일 분류

본 work item이 *생성하는 신규* 파일 (이 파일들만 삭제 가능):
- `tests/fixtures/doctor/codex/permissions-nested/config.toml` (P-1)
- `tests/fixtures/doctor/codex/mcp-inline-table/config.toml` (P-1)
- `tests/fixtures/doctor/claude-code/permissions-allow-wildcard/settings.json` (P-2)
- `tests/fixtures/doctor/claude-code/permissions-allow-destructive/settings.json` (P-2)
- `tests/fixtures/doctor/claude-code/permissions-allow-conservative/settings.json` (P-2)
- `tests/fixtures/doctor/claude-code/surface-home-scope/` (P-3 — 디렉터리 내부 파일 단위 삭제)
- `tests/fixtures/doctor/claude-code/instructions-multiple-markers/CLAUDE.md` (P-4)
- `.ditto/knowledge/adr/ADR-0003-toml-parser.md` (P-1, ADR 신설 경로 선택 시)

본 work item이 *수정만 하는* 기존 파일 (삭제 금지, restore만):
- `src/core/hosts/shared.ts`, `types.ts`, `codex.ts`, `claude-code.ts`
- `src/core/permission-inventory.ts`
- `src/core/surface-inventory.ts`
- `src/core/instruction-bridge.ts`
- `src/core/bridge-sync.ts`
- `src/cli/commands/doctor.ts`
- `tests/doctor/instructions.test.ts`, `permissions.test.ts`, `mcp.test.ts`, `surface.test.ts`
- `tests/bridge/sync.test.ts`
- `tests/core/bridge-sync.test.ts`, `instruction-bridge.test.ts`
- `tests/schemas/repo-self-validation.test.ts` (case 추가 한정)
- `package.json` + `bun.lockb` (D-1=(a) 외부 TOML lib 추가)
- `.ditto/knowledge/adr/ADR-0001-runtime-stack.md` (ADR 보강 경로 선택 시)

본 work item이 만들거나 갱신하는 `.ditto/`:
- `.ditto/work-items/wi_v02harden/{work-item.json, plan.md, dod.md, rollback.md, context-packet.md, language-ledger.json, progress.md, completion.json, handoff.md, evidence/commands.jsonl}`

## 단계별 rollback (각 단계 독립)

### P-1 (Codex TOML 교체 + ADR)
```
git restore --staged --worktree src/core/hosts/shared.ts src/core/hosts/codex.ts src/core/permission-inventory.ts
# 사용자 확인 후, 외부 TOML lib 제거
bun remove <lib>
# ADR 보강 경로 선택 시
git restore --staged --worktree .ditto/knowledge/adr/ADR-0001-runtime-stack.md
# ADR 신설 경로 선택 시
test -f .ditto/knowledge/adr/ADR-0003-toml-parser.md && rm .ditto/knowledge/adr/ADR-0003-toml-parser.md
```

### P-2 (Claude allow 분류)
```
git restore --staged --worktree src/core/permission-inventory.ts tests/doctor/permissions.test.ts
```
P-1과 같은 파일(`permission-inventory.ts`)을 만지므로 둘을 함께 되돌리거나 patch hunk 단위로 분리.

### P-3 (Surface scope 분리)
```
git restore --staged --worktree src/core/hosts/types.ts src/core/hosts/claude-code.ts src/core/hosts/codex.ts src/core/surface-inventory.ts tests/doctor/surface.test.ts
```
HostAdapter interface가 P-0(wi_v02doctor)의 자산이므로 *interface 변경 부분만 restore*, 파일 자체는 삭제 금지.

### P-4 (Multiple managed block)
```
git restore --staged --worktree src/core/instruction-bridge.ts src/core/bridge-sync.ts
git restore --staged --worktree tests/doctor/instructions.test.ts tests/bridge/sync.test.ts tests/core/instruction-bridge.test.ts tests/core/bridge-sync.test.ts
```

### P-5 (advisory + free-area 회귀 + mcp advisory 제거)
```
git restore --staged --worktree src/cli/commands/doctor.ts
git restore --staged --worktree tests/doctor/permissions.test.ts tests/doctor/mcp.test.ts tests/doctor/surface.test.ts tests/bridge/sync.test.ts tests/core/bridge-sync.test.ts
```

### P-6 (self-validation 보강 — 기존 파일)
```
git restore --staged --worktree tests/schemas/repo-self-validation.test.ts
```

### P-7 (manual smoke 환경)
사용자 manual smoke가 만든 mock HOME 디렉터리는 `mktemp` 기반이므로 자동 정리. 본 rollback이 사용자 환경 `.codex/`, `.claude/`, `~/.claude.json`, `~/.codex/config.toml`을 어떤 경우에도 수정하지 않는다.

## 전체 abort 시나리오

어느 ac에서든 abort가 필요할 때:

1. `.ditto/work-items/wi_v02harden/progress.md`에 어디까지 했는지, 무엇이 깨졌는지 기록.
2. 위 단계별 절차 중 해당 단계에 *명시된 파일에 한정해서만* 되돌림.
3. `wi_v02harden/work-item.json`의 status를 `blocked`로 갱신, schema가 강제하는 `re_entry.command` 또는 `re_entry.fresh_evidence_needed` 채움.
4. `wi_v02harden/handoff.md` 작성해 다음 세션 진입점 명시.

## 금지 사항

- `git reset --hard`, `git checkout .`, `git checkout --`, `git restore .` 같은 디렉터리/전체 단위 명령 금지.
- `git clean -fd`, `git clean -fx` 금지.
- 디렉터리 단위 `rm -rf src/core`, `rm -rf tests/doctor` 금지. 파일 단위 `rm <file>`만 허용.
- `--no-verify`, `--no-gpg-sign` 같은 hook/sign 우회 금지.
- `.ditto/knowledge/` 어떤 파일도 본 rollback이 손대지 않는다 (ADR 신설/보강 patch는 본 work item이 만든 변경 한정).
- `tests/schemas/repo-self-validation.test.ts`, `tests/schemas/fixture-validation.test.ts`는 삭제 금지 (wi_v01bootstrap 자산).
- `wi_v01bootstrap`, `wi_v01implement`, `wi_v02doctor` 디렉터리는 어떤 경우에도 손대지 않는다.
- 사용자 환경 `.claude/`, `.codex/`, `~/.claude.json`, `~/.codex/config.toml`은 본 rollback이 어떤 경우에도 수정/삭제하지 않는다.
- ADR-0001 본문 삭제 금지 (보강 patch만 허용; 보강이 받아들여지지 않으면 ADR-0003 신설 경로로 fallback).

## 안전 점검 (rollback 직후)

```
git status --short
bun run tsc --noEmit
bun run lint
bun test
```

위 명령이 통과하지 않으면 rollback이 불완전한 것이므로 다음 단계로 진행하지 않는다.
