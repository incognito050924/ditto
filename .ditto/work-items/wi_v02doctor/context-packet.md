# Context Packet — wi_v02doctor (다음 세션 시작용)

본 문서는 새 세션이나 다른 PC에서 본 work item을 이어받을 때 가장 먼저 읽을 prompt이다. 본 문서만으로 현재 상태와 다음 동작을 결정할 수 있어야 한다.

## Current goal
ditto doctor instructions/permissions/mcp/surface 4개 명령이 host 설정과 .ditto 기대값의 drift를 정확히 감지하고, human/json 두 형식으로 진단을 보고하며, drift 종류에 따라 일관된 exit code를 낸다.

## **선결 사항: 사용자 결정 필요**

본 work item은 status=draft다. 다음 결정 D-1 ~ D-8을 채택하기 전에는 execute로 들어가지 않는다.

- D-1 AGENTS.md projection의 source of truth (추천: AGENTS.md 자체)
- D-2 managed block 마커 형식 (추천: HTML comment)
- D-3 doctor의 권한 범위 (추천: read-only)
- D-4 MCP inventory 수집 방법 (추천: 설정 파일 파싱)
- D-5 skill manifest 형식과 위치 (추천: v0.2는 mock fixture lint만)
- D-6 drift 정의 (추천: 정규화 + managed block 내부 sha256)
- D-7 exit code 규약 (추천: drift→1, 사용오류→65, 명령실패→70)
- D-8 v0.2가 다룰 host 범위 (추천: Claude Code 단독)

상세는 `.ditto/work-items/wi_v02doctor/plan.md#사용자-결정-필요-선결-항목` 참조.

## Acceptance criteria
- ac-1: doctor instructions가 AGENTS↔projection drift 감지 + json 출력
- ac-2: doctor permissions가 위험 표면 식별, 미존재는 missing
- ac-3: doctor mcp가 MCP inventory 출력, 수집 불가는 unverified+사유
- ac-4: doctor surface가 manifest↔파일 차이를 missing/extra/renamed로 분류
- ac-5: 모든 명령 human/json + 결정적 exit code, read-only 보장
- ac-6: 산출 .ditto 파일이 self-validation 통과

## Current git state
- main 브랜치, wi_v01implement 완료(done)
- working tree에 본 work item 문서들만 있어야 함.

## Relevant files
- 신규 (생성 대상): `src/core/{instruction-bridge,permission-inventory,mcp-inventory,surface-inventory}.ts`, `src/cli/commands/doctor.ts`, `tests/core/<store>.test.ts`, `tests/doctor/*.test.ts`, `tests/fixtures/doctor/<scenario>/`
- 기존 (수정 대상, 삭제 금지): `src/cli/index.ts` (doctor subCommand 등록), `tests/schemas/repo-self-validation.test.ts` (케이스 보강)
- 기존 (읽기만): `src/schemas/`, `src/core/{fs,id,work-item-store,run-store,evidence-store}.ts`, `AGENTS.md`, `CLAUDE.md`
- plan/dod/rollback: 본 work item 디렉터리

## Last failure
없음. 본 work item은 draft 상태로 시작.

## What not to touch
- `src/schemas/`의 필드 의미, enum 값, cross-field 룰
- `src/core/work-item-handoff.ts` (wi_v01implement 자산, finding fix까지 안정화됨)
- `tests/fixtures/scenarios/password-strength/` 골든 fixture
- `tests/schemas/repo-self-validation.test.ts` 본체 (케이스 추가만 허용)
- ADR-0001/0002의 결정 (스택, zod source of truth)
- `.ditto/knowledge/` 전부
- `.ditto/work-items/wi_v01bootstrap/`, `.ditto/work-items/wi_v01implement/` (재읽기 가능, 수정 금지)
- 사용자 환경의 `.claude/`, `.codex/` 같은 host 설정 파일 (검사만, 절대 수정 금지)

## Evidence and artifact pointers
- plan: `.ditto/work-items/wi_v02doctor/plan.md` (D-1~D-8 결정 항목 포함)
- DoD: `.ditto/work-items/wi_v02doctor/dod.md`
- rollback: `.ditto/work-items/wi_v02doctor/rollback.md`
- 이전 work item handoff: `.ditto/work-items/wi_v01implement/handoff.md`
- application plan의 Phase 2: `reports/harnesses/ditto-application-plan.md#phase-2-doctor와-instruction-bridge`

## Expected output contract
- 모든 새 `.ditto` 파일은 schema 검증 통과
- 모든 acceptance에 대해 검증 명령과 결과 evidence 첨부
- 검증하지 못한 항목은 unverified로 명시
- 완료 주장은 completion.json의 cross-field 룰을 만족
- handoff.md는 다음 세션을 위한 fresh evidence 요구를 포함

## 진입 명령

본 work item 진입 후 첫 명령:

```
git status                                                # 다른 변경 섞임 확인
bun x tsc --noEmit && bun run lint && bun test            # 기준선 확인
cat .ditto/work-items/wi_v02doctor/plan.md                # 결정 사항 D-1~D-8 확인
```

D-1~D-8이 모두 [DECIDED] 상태로 박혀 있지 않으면 plan/dod/rollback 합의가 미완. execute 금지.
