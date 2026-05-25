# Rollback: wi_v02handoff

본 work item이 만들거나 *수정하는* 각 파일을 단계별로 되돌리는 절차. 디렉터리 단위 명령 금지.

## 사전 점검

```
git status --short
```

본 work item 외 변경이 섞여 있으면 분리(`git stash push -m "unrelated"`). 무관 변경 분리 전 어떤 rollback도 시작하지 않는다.

## 파일 분류

본 work item이 *수정만 하는* 기존 파일 (삭제 금지, restore만):
- `src/schemas/work-item.ts`
- `src/core/work-item-store.ts`
- `src/core/work-item-handoff.ts`
- `schemas/work-item.schema.json` (schemas:export 산출물)
- `tests/core/work-item-store.test.ts`
- `tests/core/work-item-handoff.test.ts`
- `.ditto/work-items/wi_v02doctor/work-item.json`
- `.ditto/work-items/wi_v02doctor/completion.json`
- `.ditto/work-items/wi_v02doctor/handoff.md`

본 work item이 만들거나 갱신하는 `.ditto/`:
- `.ditto/work-items/wi_v02handoff/{work-item.json, plan.md, dod.md, rollback.md, context-packet.md, language-ledger.json, progress.md, completion.json, handoff.md, evidence/commands.jsonl}`

신규 파일 없음 (모든 변경이 기존 파일 수정).

## 단계별 rollback

### P-1 (schema + work-item-store + handoff base 선택)
```
git restore --staged --worktree src/schemas/work-item.ts schemas/work-item.schema.json
git restore --staged --worktree src/core/work-item-store.ts src/core/work-item-handoff.ts
git restore --staged --worktree tests/core/work-item-store.test.ts tests/core/work-item-handoff.test.ts
```

### P-2 (union → replace)
```
git restore --staged --worktree src/core/work-item-handoff.ts tests/core/work-item-handoff.test.ts
```
(P-1과 같은 파일을 만지므로 patch hunk 단위로 분리하거나 둘을 함께 되돌림)

### P-3 (wi_v02doctor 정정)
```
git restore --staged --worktree .ditto/work-items/wi_v02doctor/work-item.json
git restore --staged --worktree .ditto/work-items/wi_v02doctor/completion.json
git restore --staged --worktree .ditto/work-items/wi_v02doctor/handoff.md
```
wi_v02doctor의 부풀려진 changed_files가 복원됨. 본 work item이 close되지 않은 상태에서만 의미.

### P-4 (self-validation + manual smoke + handoff)
사용자 manual smoke가 만든 임시 work item은 mktemp 디렉터리에서 수행되므로 자동 정리. 본 repo의 `.ditto/work-items/<smoke-wi>/`는 만들지 않음.

## 전체 abort 시나리오

1. `.ditto/work-items/wi_v02handoff/progress.md`에 어디까지 했는지, 무엇이 깨졌는지 기록.
2. 위 단계별 절차 중 해당 단계 파일에 한정해서만 되돌림.
3. `wi_v02handoff/work-item.json` status를 `blocked`로 갱신, `re_entry.command` 또는 `re_entry.fresh_evidence_needed` 채움.
4. `wi_v02handoff/handoff.md` 작성해 다음 세션 진입점 명시.

## 금지 사항

- `git reset --hard`, `git checkout .`, `git checkout --`, `git restore .` 같은 디렉터리/전체 단위 명령 금지.
- `git clean -fd`, `git clean -fx` 금지.
- 디렉터리 단위 `rm -rf` 금지.
- `--no-verify`, `--no-gpg-sign` 같은 hook/sign 우회 금지.
- `.ditto/knowledge/` 어떤 파일도 본 rollback이 손대지 않는다.
- `wi_v01bootstrap`, `wi_v01implement`, `wi_v02harden` 디렉터리는 손대지 않는다.
- `tests/schemas/repo-self-validation.test.ts`, `tests/schemas/fixture-validation.test.ts`는 삭제 금지.
- 사용자 환경 `.claude/`, `.codex/`, `~/.claude.json`, `~/.codex/config.toml`은 본 rollback이 어떤 경우에도 수정/삭제하지 않는다.
- `src/schemas/common.ts`의 필드 의미와 cross-field 룰은 변경 금지(work-item.ts에 신규 필드 추가만 허용).

## 안전 점검 (rollback 직후)

```
git status --short
bun run tsc --noEmit
bun run lint
bun test
```

통과하지 않으면 rollback 불완전.
