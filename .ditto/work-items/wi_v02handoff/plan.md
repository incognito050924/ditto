# Plan: wi_v02handoff

본 work item은 wi_v02harden post-review에서 발견된 `work-item-handoff.ts`의 두 root cause를 정리한다. D-1 ~ D-3 모두 [DECIDED]로 들어왔으므로 곧바로 in_progress 전환 가능.

## 배경

wi_v02harden post-review(2026-05-24)에서 두 finding:

1. **F-2 immediate fix**: completion.json/handoff.md changed_files가 132개로 부풀려짐. work-item.json reset + `--base 4b18c40`로 34개로 정정. wi_v02harden 산출물만 정정.
2. **Root cause**: `work-item-handoff.ts`의 두 동작이 합쳐져 누적 noise를 만듦.

이 두 root cause를 본 work item에서 정리. wi_v02doctor도 같은 패턴으로 99개 entries → 정정 필요(ac-3).

## 결정 사항 (D-1 ~ D-3 모두 [DECIDED] 2026-05-24)

기술 결정은 추천값으로 박고, product 결정만 사용자 확인. 본 3건 모두 기술 결정.

### D-1 [DECIDED: (a) started_at_sha를 work-item schema에 optional 필드로 추가]
- `work-item.ts`에 `started_at_sha: sha (optional)` 추가. 40hex(git short)와 64hex 모두 받게 또는 git의 full 40hex만.
- `WorkItemStore.create`가 `git rev-parse HEAD`로 자동 채움. git 안 통하면 (예: 새 repo) 필드 비움.
- `writeWorkItemHandoff`가 `--base` 미지정 시 base 후보 순서: `started_at_sha` → `origin/main` → `origin/master` → `main` → `master`.
- 근거: 외부 ref 없이 work item 시작 시점이 자기 자신에 박혀 있으면 handoff가 결정적. 별도 store 추가 없이 schema 최소 확장.
- schema_version=0.1.0 유지(optional 필드 추가는 backward compatible). 기존 work-item.json은 그대로 통과.

### D-2 [DECIDED: (a) collected를 replace]
- `writeWorkItemHandoff`가 기존 `item.changed_files`와 union하지 않고 collected로 replace.
- 근거: handoff 재실행이 idempotent해야 함(같은 작업 트리에서 두 번 실행하면 같은 결과). union은 한 번 잘못된 base로 부풀린 list를 영원히 누적시킴.
- 수동 추가 보존은 현재 사용 사례 없음(work item 4개 모두 자동 collect만). 필요해지면 v0.3+에서 `--merge` 옵션 별도 ADR.

### D-3 [DECIDED: 본 work item에서 wi_v02doctor만 정정]
- wi_v02harden은 이미 post-review correction에서 정정 완료(34 entries).
- wi_v02doctor는 부풀려진 99 entries → 시작 commit 기준 실제 diff로 정정.
- 정정 방법: `work-item.json.changed_files`를 `[]`로 reset → `ditto work handoff wi_v02doctor --base <시작 직전 sha>`로 재실행.
- wi_v02doctor 시작 commit은 git log로 식별 필요(작업 시작 시점 명확). 추정: `ef9ffab docs(ditto): record review cadence ...` 같은 wi_v02doctor seed 직전 commit. P-3에서 정확히 식별.
- wi_v01bootstrap/wi_v01implement는 본 work item 범위 밖(이미 done이고 v0.1 마감 자산). 같은 패턴이 있어도 v0.3+에서 별도 정리.

## 작업 분해

### P-1. schema + work-item-store + handoff base 선택 (ac-1)
- (structural) `src/schemas/work-item.ts`의 `workItem` zod schema에 `started_at_sha: z.string().regex(/^[a-f0-9]{40}$/).optional()` 추가.
- (structural) `src/core/work-item-handoff.ts`의 `pickBaseRef`/`writeWorkItemHandoff`가 `started_at_sha`도 후보 list에 포함.
- (behavioral) `src/core/work-item-store.ts`의 `create`가 `git rev-parse HEAD`로 자동 채움. git 실패 시 필드 omit.
- (behavioral) `WorkItem.create` 호출자 영향 검토(현재 `ditto work start`만).
- 회귀: `tests/core/work-item-store.test.ts`에 create 시 started_at_sha 자동 채움 + 없을 때 omit. `tests/core/work-item-handoff.test.ts`에 base 선택 우선순위 회귀.
- `bun run schemas:export`로 `schemas/work-item.schema.json` 갱신(같은 commit).

### P-2. union → replace (ac-2)
- (behavioral) `writeWorkItemHandoff`의 `merged = Array.from(new Set([...item.changed_files, ...collected]))` → `merged = collected`.
- 회귀: `tests/core/work-item-handoff.test.ts`에 첫 handoff 후 work-item.json.changed_files에 가짜 entry 박고 두 번째 handoff에서 사라짐 확인.

### P-3. wi_v02doctor changed_files 정정 (ac-3)
- git log로 wi_v02doctor 시작 commit + 시작 직전 commit sha 식별.
- `.ditto/work-items/wi_v02doctor/work-item.json.changed_files`를 `[]`로 reset.
- `ditto work handoff wi_v02doctor --base <시작 직전 sha>` 재실행.
- completion.json/handoff.md/work-item.json 모두 정확한 list로 갱신.
- wi_v02harden 재확인: `ditto work handoff --base 4b18c40` 재실행 결과가 여전히 34 entries로 동일한지 확인(이미 처리됨, 본 단계는 검증만).

### P-4. self-validation + manual smoke + handoff (마감)
- `tests/schemas/repo-self-validation.test.ts`는 schema 확장에 자동 통과(optional 필드).
- `bun run schemas:export`로 export된 schemas/*.schema.json도 commit.
- manual smoke: 임시 work item 생성(`ditto work start`) → started_at_sha 박힘 확인 → handoff → 두 번 handoff해서 idempotent 확인 → 정리.
- `ditto verify` ac-1~ac-3 + `ditto work handoff wi_v02handoff --base <자기 시작 직전>`로 마감.

## 의존성과 실행 순서

P-1 → P-2 (P-1의 handoff 변경 위에 P-2 union→replace가 얹힘).
P-3는 P-1+P-2 완료 후 (정정이 이미 새 동작 위에서 일어남).
P-4는 마지막.

P-1 안에서도 Tidy First 분리:
- P-1a (structural): schema + handoff base 선택 list 확장 (started_at_sha 없으면 기존 동작)
- P-1b (behavioral): WorkItemStore.create가 자동 채움 + 회귀

## 예상 변경 파일

수정 (삭제 금지):
- `src/schemas/work-item.ts` (started_at_sha optional 추가)
- `src/core/work-item-store.ts` (create 시 git rev-parse HEAD)
- `src/core/work-item-handoff.ts` (base 선택 + union → replace)
- `tests/core/work-item-store.test.ts`
- `tests/core/work-item-handoff.test.ts`
- `schemas/work-item.schema.json` (schemas:export 산출물)
- `.ditto/work-items/wi_v02doctor/{work-item.json, completion.json, handoff.md}` (P-3 정정)

신규: 없음(테스트는 기존 파일에 case 추가)

본 work item이 만드는 `.ditto/`:
- `.ditto/work-items/wi_v02handoff/{work-item.json, plan.md, dod.md, rollback.md, context-packet.md, language-ledger.json, progress.md, completion.json, handoff.md, evidence/commands.jsonl}`

## 범위 밖

- wi_v01bootstrap, wi_v01implement의 changed_files 정정 → v0.3+ 별도 정리
- 수동 추가 changed_files 보존 옵션(`--merge`) → v0.3+ ADR
- provider CLI wrapper(`run_with`) → v0.3
- ditto work resume 같은 신규 명령 → v0.3+

## Review 합의 (사용자 ↔ agent)

| 단계 | review 시점 | 이유 |
|---|---|---|
| (D 결정) | 이미 [DECIDED] | 기술 결정 추천값 박힘 |
| P-1 + P-2 | core 변경 묶음 commit 후 | schema/store/handoff 한 단위 |
| P-3 + P-4 | 정정 + 마감 묶음 후 handoff | 마감 |

## 진입 절차

1. D-1 ~ D-3 [DECIDED] 박혀 있음 (본 plan.md).
2. dod.md / rollback.md가 위 결정 기반.
3. work-item.json status를 draft → in_progress로 갱신 후 P-1 시작.
