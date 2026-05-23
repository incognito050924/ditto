# Rollback: wi_v01implement

본 work item이 만들거나 수정하는 것을 단계별로 되돌리는 절차. 사용자가 작업 도중 abort하더라도 repo가 흩어지지 않도록 한다.

## 단계별 변경 분류

| 단계 | 변경 종류 | 영향 범위 |
|---|---|---|
| P-1 core fs | 신규 파일 | `src/core/fs.ts` |
| P-2 id | 신규 파일 | `src/core/id.ts` |
| P-3 WorkItemStore | 신규 파일 | `src/core/work-item-store.ts` |
| P-4 RunStore | 신규 파일 | `src/core/run-store.ts` |
| P-5 EvidenceStore | 신규 파일 | `src/core/evidence-store.ts` |
| P-6 CLI 실구현 | 수정 | `src/cli/commands/*.ts`, `src/cli/util.ts` |
| P-7 자체 검증 테스트 | 신규 | `tests/schemas/repo-self-validation.test.ts` 등 |
| P-8 manual smoke | 새 `.ditto` 파일 | repo 루트의 `.ditto/work-items/<id>/`, `.ditto/runs/<id>/` |

## 단계별 rollback

### P-1 ~ P-5 (core 신규)
```
git restore --staged --worktree src/core/
rm -rf src/core
```
의존성 없음. 단독 되돌릴 수 있다.

### P-6 (CLI 실구현)
```
git restore --staged --worktree src/cli/
```
CLI는 core가 없으면 컴파일이 깨질 수 있다. P-6 되돌리면 P-1~P-5도 함께 되돌리거나, CLI를 not_implemented 상태로 복귀.

### P-7 (테스트 신규)
```
git restore --staged --worktree tests/schemas/repo-self-validation.test.ts tests/core
rm -f tests/schemas/repo-self-validation.test.ts
rm -rf tests/core
```

### P-8 (smoke로 생긴 `.ditto/` 파일)
사용자 manual smoke가 만든 work item/run/evidence는 사용자의 실험 결과이므로 자동 삭제하지 않는다. 사용자가 의도적으로 제거하려면:
```
# id를 명시해 한정 삭제
rm -rf .ditto/work-items/<wi_id> .ditto/runs/<run_id>
```
`wi_v01bootstrap`, `wi_v01implement` 두 work item과 `.ditto/knowledge/`는 절대 자동 삭제 대상이 아니다.

## 전체 abort 시나리오

ac-1 ~ ac-5 어느 단계에서 abort가 필요한 경우:

1. 현재 작업 상태를 wi_v01implement의 `progress.md`에 기록(어디까지 했는지, 무엇이 깨졌는지).
2. 해당 단계의 변경만 위 절차로 되돌린다. **전체 reset --hard는 금지**(다른 commit/변경을 덮어쓸 수 있다).
3. wi_v01implement의 status를 `blocked`로 갱신하고 `re_entry.fresh_evidence_needed`를 채운다.
4. handoff.md를 작성해 다음 세션이 무엇부터 다시 봐야 할지 적는다.

## 금지 사항

- `git reset --hard`, `git clean -fd`, `git checkout .`은 본 work item rollback 절차에서 사용하지 않는다.
- `bun install` 의존성을 제거하지 않는다(스택 자체는 ADR-0001로 fix).
- `.ditto/knowledge/`는 어떤 단계 rollback에서도 손대지 않는다.

## 안전 점검

rollback 전에 다음을 확인한다.

- `git status`로 본 work item과 무관한 변경이 섞여 있는지
- 사용자가 manual smoke로 만든 work item이 보존되는지
- 본 work item의 plan/dod/rollback 문서 자체가 손상되지 않는지
