# Context Packet — wi_v02handoff (다음 세션 시작용)

## Current goal

`WorkItemStore.update`가 work item이 in_progress이면서 `started_at_sha`가 비어 있을 때 `git rev-parse HEAD`로 자동 backfill해 work item 시작 sha를 `work-item.json`에 저장한다(첫 draft→in_progress 전환과 legacy 직접 편집 케이스 둘 다 catch, done 전환에선 backfill 안 함). `ditto work handoff`가 `--base` 미지정 시 이 sha를 1순위 base로 사용한다. `writeWorkItemHandoff`가 collected를 누적 없이 replace해 handoff 재실행이 idempotent하고 마감 산출물이 실제 변경 범위와 정확히 일치한다.

## 배경 (wi_v02harden post-review에서 식별)

wi_v02harden 마감 후 사용자 follow-up review에서 두 finding(F-1, F-2)이 잡혔다. F-1(AC-1 user-scope permission)은 wi_v02harden post-correction에서 즉시 fix. F-2(changed_files 132 → 34)는 산출물만 정정하고 root cause를 본 work item으로 분리:

1. `ditto work handoff`의 기본 base가 `origin/main`(사용자 환경에서 23+ commit 뒤처짐) → 첫 handoff가 repo-wide 132개 파일을 수집.
2. `writeWorkItemHandoff`가 `merged = new Set([...item.changed_files, ...collected])` → 한 번 부풀린 list가 영원히 누적. handoff 재실행으로 갱신 안 됨.

wi_v02doctor도 같은 패턴으로 99 entries → 본 work item에서 정정.

## 결정 사항 (D-1 ~ D-3 모두 [DECIDED] 2026-05-24)

| ID | 결정 | 근거 |
|---|---|---|
| D-1 | (a) work-item schema에 started_at_sha optional(40 hex) 추가. WorkItemStore.update가 in_progress + 비어 있을 때 git rev-parse HEAD로 자동 backfill(첫 전환 + legacy 둘 다 catch). done 전환에선 backfill 안 함. handoff base 후보 우선순위: --base > started_at_sha > origin/main fallback. | 외부 ref 없이 work item 시작 시점이 자기 자신에 박혀 결정적. legacy 직접 편집도 catch. schema_version 유지(backward compatible). |
| D-2 | (a) collected를 union 없이 replace. | handoff 재실행이 idempotent. 수동 추가 보존은 v0.3+ 별도. |
| D-3 | 본 work item에서 wi_v02doctor만 정정. wi_v02harden은 이미 fix. wi_v01* 자산은 범위 밖. | 범위 명확화. |

상세는 `plan.md#결정-사항-d-1--d-3-모두-decided-2026-05-24`.

## Acceptance criteria

- ac-1: started_at_sha schema(40 hex optional) + WorkItemStore.update backfill hook(in_progress + 비어 있을 때, legacy 포함) + handoff base 우선순위 (work-item-store.test 6 케이스 + work-item-handoff.test 우선순위 2 케이스)
- ac-2: collected replace + 재실행 idempotent (work-item-handoff.test 가짜 entry 회귀)
- ac-3: wi_v02doctor changed_files 정정 (99 → 합리적 수), wi_v02harden 34 유지

## Current git state

- main 브랜치, wi_v02harden done + post-corrections 박힘.
- 본 work item 디렉터리(`.ditto/work-items/wi_v02handoff/`) 외 변경이 없는지가 정상 진입 조건.

## Relevant files

- 수정 대상 (삭제 금지): `src/schemas/work-item.ts`, `src/core/work-item-store.ts`, `src/core/work-item-handoff.ts`, `schemas/work-item.schema.json`(export 산출물), `tests/core/work-item-store.test.ts`, `tests/core/work-item-handoff.test.ts`, `.ditto/work-items/wi_v02doctor/{work-item.json, completion.json, handoff.md}`
- 참조 (읽기 전용): `.ditto/work-items/wi_v02harden/progress.md`(post-review correction 섹션), `.ditto/work-items/wi_v02doctor/*`(정정 대상)
- 신규: 없음

## What not to touch

- `src/schemas/common.ts`의 필드 의미와 cross-field 룰 (work-item.ts에 신규 optional 필드 추가만 허용)
- `src/core/work-item-store.ts`의 `create` 외 메서드 (필요 최소 변경)
- `.ditto/knowledge/` 전체
- `.ditto/work-items/wi_v01bootstrap/`, `wi_v01implement/`, `wi_v02harden/` (재읽기 가능, 수정 금지)
- 사용자 환경 `.claude/`, `.codex/`, `~/.claude.json`, `~/.codex/config.toml`
- `tests/fixtures/scenarios/password-strength/` 골든 fixture

## Expected output contract

- 모든 `.ditto` 파일 schema 검증 통과
- 모든 ac에 회귀 명령 evidence 첨부 (`evidence/commands.jsonl`)
- `schemas:export` 산출물(`schemas/work-item.schema.json`)이 같은 commit에 포함

## 진입 명령

```
git status                                          # 본 work item 디렉터리 외 변경 없는지 확인
bun run tsc --noEmit && bun run lint && bun test    # 기준선 (wi_v02harden 마감 + post-correction 후 121 pass)
cat .ditto/work-items/wi_v02handoff/plan.md         # D-1~D-3 [DECIDED] + P-1~P-4
cat .ditto/work-items/wi_v02handoff/dod.md          # ac별 검증 명령
cat .ditto/work-items/wi_v02handoff/rollback.md
```

D-1~D-3 모두 [DECIDED]이므로 status를 draft → in_progress로 갱신한 뒤 곧바로 P-1 시작 가능.

## Review 합의

| 단계 | review 시점 | 이유 |
|---|---|---|
| (D 결정) | 이미 [DECIDED] | 기술 결정 추천값 박힘 |
| P-1 + P-2 | core 변경 묶음 commit 후 | schema/store/handoff 한 단위 |
| P-3 + P-4 | 정정 + 마감 묶음 후 handoff | 마감 |

## 새 세션에서 이어받기

1. `git pull`
2. `bun install`
3. `git status` (본 work item 디렉터리 외 변경 없는지 확인)
4. 본 context-packet.md 읽기
5. `cat .ditto/work-items/wi_v02handoff/progress.md`로 진행 로그 확인
6. plan.md의 다음 P 단계 진행
