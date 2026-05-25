# Context Packet — wi_v01implement (다음 세션 시작용)

본 문서는 새 세션 또는 다른 PC에서 본 work item을 이어받을 때 가장 먼저 읽을 prompt이다. 본 문서만으로 현재 상태와 다음 동작을 결정할 수 있어야 한다.

## Current goal
ditto work start|status|handoff, run record, verify 명령이 `.ditto/` 파일을 실제로 읽고 쓰며, 모든 출력 파일이 zod schema 검증을 통과한다.

## Acceptance criteria
- ac-1: work start가 schema 부합 work-item.json 생성
- ac-2: work status가 work-item.json을 읽어 human/json 출력
- ac-3: work handoff가 completion 검사 후 handoff.md와 completion.json 생성
- ac-4: run record가 manifest.json 생성하고 work item runs 갱신
- ac-5: verify가 명령 실행 후 evidence/commands.jsonl 갱신과 verdict 변경
- ac-6: 본 work item이 만든 모든 `.ditto` 파일이 self-validation 테스트 통과

## Current git state
- 본 work item 시작 시점에 main 브랜치에서 wi_v01bootstrap 완료 상태.
- `git status`로 다른 변경이 섞여 있는지 먼저 확인.

## Relevant files
- 골격 (기존, 수정 대상): `src/cli/commands/work.ts`, `src/cli/commands/run.ts`, `src/cli/commands/verify.ts`, `src/cli/util.ts`
- core 신규 (생성 대상): `src/core/{fs,id,work-item-store,run-store,evidence-store}.ts`
- schema (기존, 읽기만): `src/schemas/`
- 자체 검증 테스트 (기존, 케이스 보강 한정 — 삭제 금지): `tests/schemas/repo-self-validation.test.ts`
- store 단위 테스트 신규 (생성 대상): `tests/core/*.test.ts`
- plan/dod/rollback: 본 work item 디렉터리

## Last failure
없음. 본 work item은 draft 상태로 시작.

## What not to touch
- `src/schemas/`의 필드 의미, enum 값, cross-field 룰
- `tests/fixtures/scenarios/password-strength/` 골든 fixture
- `tests/schemas/repo-self-validation.test.ts` 본체 (기존 케이스 삭제 금지, 신규 케이스 추가만 허용)
- ADR-0001/0002의 결정(스택, zod source of truth)
- `.ditto/knowledge/` 전부
- `.ditto/work-items/wi_v01bootstrap/` 회고 기록 (재읽기 가능, 수정 금지)

## Evidence and artifact pointers
- plan: `.ditto/work-items/wi_v01implement/plan.md`
- DoD: `.ditto/work-items/wi_v01implement/dod.md`
- rollback: `.ditto/work-items/wi_v01implement/rollback.md`
- 이전 work item handoff: `.ditto/work-items/wi_v01bootstrap/handoff.md`
- 골든 fixture(참고용): `tests/fixtures/scenarios/password-strength/.ditto/`

## Expected output contract
- 모든 새 `.ditto` 파일은 schema 검증 통과
- 모든 acceptance에 대해 검증 명령과 결과 evidence 첨부
- 검증하지 못한 항목은 unverified로 명시
- 완료 주장은 completion.json의 cross-field 룰을 만족
- handoff.md는 다음 세션을 위한 fresh evidence 요구를 포함

## 진입 명령

본 work item 진입 후 첫 명령:

```
git status                       # 다른 변경 섞임 확인
bun x tsc --noEmit && bun run lint && bun test    # 기준선 확인
cat .ditto/work-items/wi_v01implement/plan.md
```

기준선이 깨져 있으면 plan/dod 합의 전에 기준선을 먼저 복구한다.
