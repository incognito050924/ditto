# Context Packet — wi_v02doctor (다음 세션 시작용)

본 문서는 새 세션이나 다른 PC에서 본 work item을 이어받을 때 가장 먼저 읽을 prompt이다. 본 문서만으로 현재 상태와 다음 동작을 결정할 수 있어야 한다.

## Current goal
ditto doctor instructions/permissions/mcp/surface 4개 명령이 host 설정과 .ditto 기대값의 drift를 정확히 감지하고, human/json 두 형식으로 진단을 보고하며, drift 종류에 따라 일관된 exit code를 낸다.

## 결정 사항 (D-1 ~ D-11 모두 [DECIDED])

본 work item은 status=in_progress. 모든 결정 항목이 합의되어 execute 가능.

| ID | 결정 |
|---|---|
| D-1 | AGENTS.md → CLAUDE.md managed block 본문 복사 (4a) + `ditto bridge sync` |
| D-2 | HTML comment marker + sha256 메타 |
| D-3 | doctor는 read-only (sync 분리) |
| D-4 | 두 host 설정 파일 파싱. Claude는 .mcp.json → ~/.claude.json(project entry → user entry) → 그 외 unverified |
| D-5 | 두 host 디렉터리 인벤토리만, schema 검증은 Phase 9 |
| D-6 | 정규화 + sha256 (D-2와 일관) |
| D-7 | drift→1, usage→65, runtime→70, `--advisory` 옵트인 |
| D-8 | Codex + Claude Code 두 host 1급 지원 |
| D-9 | HostAdapter interface 추상화 |
| D-10 | 기본 모든 host, `--host`로 좁힘 |
| D-11 | Codex AGENTS.md는 sync source만, `bridge sync --host codex`는 usage error |

상세는 `.ditto/work-items/wi_v02doctor/plan.md#d-1--d-11-결정-요약-모두-decided` 참조.

## Acceptance criteria
- ac-1: doctor instructions가 두 host에 대해 drift 감지. claude-code는 sha256 3단 비교(content_mismatch/sha256_mismatch/marker_missing/projection_missing), codex는 marker 부재 확인. JSON은 top-level findings와 host별 results[](path/status/sha/findings)를 함께 반환.
- ac-2: doctor permissions가 두 host의 위험 표면을 공통 enum으로 정규화, 미존재는 missing.
- ac-3: doctor mcp가 두 host 설정 파일 파싱해 inventory 출력, 수집 불가는 unverified+사유.
- ac-4: doctor surface가 두 host의 surface 디렉터리 인벤토리 + missing/extra/renamed 분류 (schema 검증은 Phase 9).
- ac-5: 모든 명령 human/json + 결정적 exit code + --host 인자 + --advisory + read-only 보장.
- ac-6: 산출 .ditto 파일이 self-validation 통과.
- ac-7: bridge sync --host claude-code가 AGENTS.md → CLAUDE.md managed block만 갱신, 자유 영역 보존, --check 는 dry-run, --host codex는 usage error.
- ac-8: HostAdapter interface가 codex(primary)/claude-code(compatibility) 두 built-in host 구현으로 등록됨. doctor는 두 built-in host를 registry로 순회하고, host별 구조 차이는 missing/unverified로 드러냄. Codex AGENTS.md는 source of truth, Claude Code CLAUDE.md는 bridge sync projection. 새 host 자동 지원은 v0.2 범위 밖.

## Current git state
- main 브랜치, wi_v01implement 완료(done)
- working tree에 본 work item 문서들만 있어야 함.

## Relevant files
- 신규 (생성 대상):
  - `src/core/hosts/{types,codex,claude-code}.ts` — HostAdapter interface + 두 host 구현
  - `src/core/{instruction-bridge,bridge-sync,permission-inventory,mcp-inventory,surface-inventory}.ts`
  - `src/cli/commands/{doctor,bridge}.ts`
  - `tests/core/hosts/{codex,claude-code}.test.ts`
  - `tests/core/<module>.test.ts`
  - `tests/doctor/*.test.ts`, `tests/bridge/sync.test.ts`
  - `tests/fixtures/doctor/<host>/<scenario>/`, `tests/fixtures/bridge/<scenario>/`
- 기존 (수정 대상, 삭제 금지): `src/cli/index.ts` (doctor/bridge subCommand 등록), `tests/schemas/repo-self-validation.test.ts` (케이스 보강)
- 기존 (읽기만): `src/schemas/`, `src/core/{fs,id,work-item-store,run-store,evidence-store,work-item-handoff}.ts`, `AGENTS.md`, `CLAUDE.md`
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
bun x tsc --noEmit && bun run lint && bun test            # 기준선 확인 (현재 79 pass 예상)
cat .ditto/work-items/wi_v02doctor/plan.md                # P-0부터 시작
cat .ditto/work-items/wi_v02doctor/dod.md                 # ac별 검증 명령 숙지
cat .ditto/work-items/wi_v02doctor/rollback.md            # 신규/수정 파일 분리 + 금지 사항
```

D-1~D-11 모두 [DECIDED]. P-0 host adapter부터 순차 진행. dod.md의 각 ac 검증 명령을 그대로 실행해 evidence 수집.

## Review 합의 (사용자 ↔ agent)

진행 중 review를 받을 timing이 합의되어 있다. 임의로 묶지 말 것.

| 단계 | review 시점 | 이유 |
|---|---|---|
| **P-0 host adapter** | 단독 commit 후 review | HostAdapter interface가 P-1~P-5의 토대. 잘못된 추상화면 cascading. 사용자 환경 가정(.codex/config.toml 필드, .mcp.json, ~/.claude.json 구조)이 실제와 일치하는지도 이 시점에 확인. |
| P-1 ~ P-5 + P-5b | 묶어서 commit 후 review | core 구현은 P-0 위에서 비교적 독립. 한 번에 review로 충분. |
| P-6 (fixture/regression) | 묶어서 commit 후 review | doctor/bridge 시나리오 회귀. fixture가 의도된 drift를 모두 잡는지 한 번 확인. |
| P-7 + P-8 (self-validation + smoke) | 묶어서 마무리 후 work handoff | 자기 검증 + manual smoke로 마감. ditto work handoff wi_v02doctor로 final_verdict 도출. |

총 review 4회. 각 review 사이에 사용자가 finding을 줄 수 있고, 그 finding은 같은 work item progress.md에 회고로 기록.

## 새 세션에서 이어받기

이 work item을 새 세션 또는 다른 PC에서 이어받을 때:

1. `git pull` (origin 최신)
2. `bun install` (의존성 동기화)
3. `git status` 확인 (clean이어야 함; 무관 변경 있으면 stash)
4. 본 context-packet.md 읽기
5. `cat .ditto/work-items/wi_v02doctor/progress.md`로 진행 로그 확인
6. plan.md의 다음 P-단계 진행

`.ditto/work-items/wi_v02doctor/` 디렉터리만 committed 되어 있으면 어떤 세션에서든 동일하게 이어받을 수 있다 (PURPOSE의 "세션 이동 보장" 핵심).
