# Context Packet — wi_v02harden (다음 세션 시작용)

본 문서는 새 세션이나 다른 PC에서 본 work item을 이어받을 때 가장 먼저 읽을 prompt이다. 본 문서만으로 현재 상태와 다음 동작을 결정할 수 있어야 한다.

## Current goal

v0.2 doctor가 실제 사용자 환경(Codex `~/.codex/config.toml`, repo `.codex/config.toml`, Claude `.claude/settings.json`, home-scope `~/.claude/skills/`)에서 false safety / false drift 없이 동작하고, 합의된 회귀(advisory, bridge free-area-only, multiple managed block)에 자동 테스트가 박혀 있다.

## 배경 (wi_v02doctor 리뷰 합의)

wi_v02doctor가 fixture 기준 ac-1~ac-8 pass로 마감되었으나, 2026-05-24 리뷰에서 다음 5건이 실제 환경 신뢰도를 깎는다고 합의되었다.

1. `parseTomlSubset`이 nested section/inline table 미처리 → `[sandbox_workspace_write].network_access=true`나 `env = { ... }`를 doctor가 못 봄.
2. Claude `permissions.allow` 판정 regex가 너무 넓고 label도 부정확 → `Bash(ls)` 같은 보수적 entry까지 위험으로 잡힘.
3. surface catalog 비교가 `~/.claude/skills/` 전체를 포함 → 사용자 환경에서 항상 mismatch_count 폭주.
4. CLAUDE.md에 marker block이 2개 이상이면 첫 매치만 처리, 두 번째 이후 silent.
5. doctor `--advisory` 회귀가 instructions에만 있고, bridge sync의 free-area-only unchanged 회귀가 부재.

이 5건이 v0.3 provider wrapper preflight 전에 닫혀야 doctor 결과를 신뢰할 수 있다.

## 결정 사항 (D-1 ~ D-5 모두 [DECIDED] 2026-05-24)

| ID | 결정 | 근거 (요약) |
|---|---|---|
| D-1 | (a) 외부 TOML parser 채택 | 자체 확장은 또 반쪽 파서. ADR-0001 보강 또는 ADR-0003 신설 |
| D-2 | (b) wildcard + 명시 destructive 분리 | Read(*) 같은 broad read는 v0.2 label에서 과도 차단 회피 |
| D-3 | (b) adapter API에서 home/local scope 분리 | catalog schema 변경보다 inventory 출처 명확화 |
| D-4 | (b) multiple_markers면 bridge sync 거부 | 두 block 중 하나만 갱신은 더 위험 |
| D-5 | (a) mcp는 exit 0, --advisory 옵션 제거 | 수집 불가는 "위험 drift"가 아니라 "검증 불가" |

상세는 `plan.md#결정-사항-d-1--d-5-모두-decided-2026-05-24` 참조.

## Acceptance criteria

- ac-1: Codex TOML nested + inline 정확도
- ac-2: Claude allow 분류 분리 — wildcard/destructive/conservative 3종 회귀
- ac-3: Surface catalog scope 분리 — home은 inventory-only
- ac-4: Multiple managed block finding + bridge sync 거부 정책
- ac-5: advisory 회귀 2건(permissions/surface) + mcp advisory 제거 회귀 + bridge free-area-only 회귀

## Current git state

- main 브랜치, wi_v02doctor done (closed_at 2026-05-23).
- 본 work item 디렉터리(`.ditto/work-items/wi_v02harden/`) 외 변경이 없어야 정상. (디렉터리 자체는 신규 untracked가 정상 — clean이라는 표현은 본 디렉터리 외 의미.)

## Relevant files

- 수정 대상 (삭제 금지): `src/core/hosts/{shared,types,codex,claude-code}.ts`, `src/core/permission-inventory.ts`, `src/core/surface-inventory.ts`, `src/core/instruction-bridge.ts`, `src/core/bridge-sync.ts`, `src/cli/commands/doctor.ts`
- 테스트 (수정만): `tests/doctor/*.test.ts`, `tests/bridge/sync.test.ts`, `tests/core/{bridge-sync,instruction-bridge}.test.ts`
- 기존 (case 추가 한정, 삭제 금지): `tests/schemas/repo-self-validation.test.ts`
- 신규 fixture: `tests/fixtures/doctor/<scenario>/` (rollback.md 파일 분류 참조)
- ADR: `.ditto/knowledge/adr/ADR-0001-runtime-stack.md` 보강 또는 `.ditto/knowledge/adr/ADR-0003-toml-parser.md` 신설 (D-1=(a))
- 참조 (읽기 전용, 수정 금지): `.ditto/work-items/wi_v02doctor/{plan,dod,progress}.md`, ADR-0001/0002

## Last failure

없음. 본 work item은 draft 상태로 시작.

## What not to touch

- `src/schemas/work-item.ts`, `completion-contract.ts`, `common.ts`의 필드 의미와 cross-field 룰
- `src/core/work-item-store.ts`, `work-item-handoff.ts` (wi_v01 자산)
- ADR-0001/0002 본문 삭제 (보강 patch만 허용)
- `.ditto/knowledge/` 전체 (본 work item이 만드는 ADR 변경 한정)
- `.ditto/work-items/wi_v01bootstrap/`, `wi_v01implement/`, `wi_v02doctor/` (재읽기 가능, 수정 금지)
- 사용자 환경 `.claude/`, `.codex/`, `~/.claude.json`, `~/.codex/config.toml` (검사만, 절대 수정 금지)
- `tests/fixtures/scenarios/password-strength/` 골든 fixture

## Expected output contract

- 모든 새 `.ditto` 파일은 schema 검증 통과 (`tests/schemas/repo-self-validation.test.ts`)
- 모든 ac에 회귀 명령 evidence 첨부 (`evidence/commands.jsonl`)
- 검증하지 못한 항목은 unverified로 명시
- ADR 보강 patch 또는 ADR-0003 신설이 P-1 commit과 함께

## 진입 명령

```
git status                                          # 본 work item 디렉터리 외 변경이 없는지 확인
bun run tsc --noEmit && bun run lint && bun test    # 기준선 확인 (현재 107 pass)
cat .ditto/work-items/wi_v02harden/plan.md          # D-1~D-5 [DECIDED] + P-1~P-7
cat .ditto/work-items/wi_v02harden/dod.md           # ac별 검증 명령
cat .ditto/work-items/wi_v02harden/rollback.md      # 신규/수정 파일 + 금지 사항
```

본 plan.md에 D-1~D-5가 모두 [DECIDED]로 박혀 있으므로, work-item.json의 status를 draft → in_progress로 갱신한 뒤 곧바로 P-1 시작 가능.

## Review 합의 (사용자 ↔ agent)

| 단계 | review 시점 | 이유 |
|---|---|---|
| (D 결정) | 이미 [DECIDED] | 사용자가 추천값을 직접 제시 |
| P-1 + P-2 | core 정확도 묶음 commit 후 | TOML 파서와 allow 분류는 같은 inventory 영역 |
| P-3 + P-4 | surface scope + multiple marker commit 후 | 둘 다 새 분기/finding 도입 |
| P-5 + P-6 + P-7 | 회귀 + self-validation + smoke 묶음 후 handoff | 마감 |

## 새 세션에서 이어받기

1. `git pull` (origin 최신)
2. `bun install` (의존성 동기화)
3. `git status` (본 work item 디렉터리 외 변경이 없는지 확인; 있으면 stash)
4. 본 context-packet.md 읽기
5. `cat .ditto/work-items/wi_v02harden/progress.md`로 진행 로그 확인
6. plan.md의 다음 P 단계 진행
