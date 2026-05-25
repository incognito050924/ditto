# Plan: wi_v02harden

본 work item은 wi_v02doctor 리뷰(2026-05-24)에서 합의된 follow-up 5건을 묶는다. D-1 ~ D-5는 모두 [DECIDED] 상태로 들어왔으므로 곧바로 in_progress 전환 가능.

## 배경

wi_v02doctor는 fixture 기준 ac-1~ac-8 pass로 마감되었으나, 다음 5건의 실제 환경 정확도 이슈가 리뷰에서 사용자 ↔ agent 사이에 합의되었다.

1. `parseTomlSubset`이 nested section과 inline table을 처리하지 못함 → `~/.codex/config.toml`의 `[sandbox_workspace_write].network_access` 같은 위험 설정과 `env = { ... }` inline table을 doctor가 못 봄. **false safety**.
2. Claude `permissions.allow` 판정 regex가 너무 넓고 label도 부정확 → `Bash(ls)` 같은 보수적 entry까지 `write_outside_workspace`로 잡아 noisy.
3. surface catalog 비교가 `~/.claude/skills/` 전체를 대조 대상으로 잡아 사용자 환경에서 항상 `extra_file` 폭주.
4. CLAUDE.md에 marker block이 2개 이상일 때 첫 매치만 처리되고 두 번째 이후는 silent.
5. doctor `--advisory` 회귀가 instructions에만 있고, bridge sync의 free-area-only unchanged 회귀가 없음.

목표는 v0.3 provider wrapper preflight가 doctor 결과를 신뢰하기 전에 위 5건을 닫는 것.

## 결정 사항 (D-1 ~ D-5 모두 [DECIDED] 2026-05-24)

agent가 기술 결정을 사용자에게 떠넘기지 않는다는 합의에 따라, 추천값을 박고 product 의미 있는 항목만 사용자가 명시 확인. 본 5건은 모두 사용자가 직접 추천값을 제시했으므로 그대로 박음.

### D-1 [DECIDED: (a) 외부 TOML parser 채택]
- `smol-toml` 또는 동급 lib 도입. 후보는 P-1 commit 시 lockfile 영향과 함께 선택.
- 근거: 자체 `parseTomlSubset` 확장은 또 다른 반쪽 파서가 되고, codex가 새 TOML 문법을 쓰면 회귀 위험.
- 영향: ADR-0001 보강 patch 또는 ADR-0003 신설을 P-1 commit과 함께 진행.

### D-2 [DECIDED: (b) wildcard + 명시 destructive 분리]
- 분류표:
  - wildcard(`*`, `Bash(*)`, `Bash`, `WebFetch(*)`) → `dangerous_mode` + `approval_bypass`
  - 명시 destructive(`Write(*)`, `Bash(rm *)`, `Bash(sudo *)`) → `write_outside_workspace`
  - 그 외(`Bash(ls)`, `Bash(cat -n)`, `Read(*)` 등) → finding 0건
- `Read(*)` 같은 broad read는 secrets_read 후보지만 v0.2 label 체계에서 과도 차단을 피하기 위해 `write_outside_workspace`로 분류하지 않는다. secrets_read 룰은 후속 work item.
- 근거: false positive와 false safety의 균형.

### D-3 [DECIDED: (b) adapter API에서 home/local scope 분리]
- `HostAdapter.loadSurfaceInventory`가 `{ localSurfaces, homeSurfaces, unavailable }`를 반환하도록 확장.
- `collectSurfaceInventory`는 `localSurfaces`만 catalog와 mismatch 비교, `homeSurfaces`는 inventory에만 노출.
- 근거: catalog schema를 먼저 흔드는 것보다 런타임 inventory 출처를 명확히 하는 게 안정적. catalog는 Phase 9까지 mock 계약이므로 schema 변경 비용이 낮은 시점이 따로 있음.

### D-4 [DECIDED: (b) multiple_markers 시 bridge sync 거부]
- doctor instructions는 `multiple_markers` finding으로 보고하고 exit 1.
- bridge sync는 multiple_markers 상태에서 갱신 거부(exit 1)하고 stderr로 "marker를 한 개로 정리한 뒤 재실행"을 안내.
- 근거: 두 managed block 중 하나만 자동 갱신하는 동작은 더 위험. 거부 정책이 명시적이고 회복 경로가 분명.

### D-5 [DECIDED: (a) mcp는 exit 0 정보 보고, --advisory 옵션 제거]
- `doctor mcp`는 항상 inventory만 반환하고 exit 0. `--advisory` 옵션은 args에서 제거.
- 근거: MCP inventory 수집 불가는 "위험 drift"가 아니라 "검증 불가". CI gating에 포함시키지 않는 게 맞다.

## 작업 분해

### P-1. Codex TOML 파서 교체 (ac-1)
- 외부 TOML lib 도입(D-1=(a)).
- `src/core/hosts/shared.ts`의 `parseTomlSubset` 호출 지점 모두 새 파서로 교체. `parseTomlSubset` 자체는 다른 호출이 없으면 제거.
- `src/core/permission-inventory.ts` codex 분기에서 nested section(`sandbox_workspace_write.network_access` 등)도 검사.
- `src/core/hosts/codex.ts` `mcpServersFromToml`에서 inline table `env` 처리.
- ADR-0001 보강 patch 또는 ADR-0003 신설.
- 회귀 fixture: nested section + inline table 각 1개.

### P-2. Claude permissions allow 분류 분리 (ac-2)
- D-2=(b) 분류표를 `src/core/permission-inventory.ts` 모듈 상수로 박음.
- `hasDangerousAllow`를 `classifyAllowEntry(entry): PermissionRiskLabel | null`로 교체.
- 회귀 fixture 3종(wildcard / destructive / conservative).

### P-3. Surface catalog scope 분리 (ac-3)
- D-3=(b)에 따라 `HostAdapter` interface(`src/core/hosts/types.ts`)의 `SurfaceInventory`에 `homeSurfaces` 추가, 기존 `surfaces` → `localSurfaces`로 rename.
- `src/core/hosts/claude-code.ts`와 `codex.ts`의 `loadSurfaceInventory` 구현 분기 갱신(`~/.claude/skills/`, `~/.codex/plugins/`는 home, repo-local은 local).
- `src/core/surface-inventory.ts`는 `localSurfaces`만 비교, JSON 출력에 home/local 구분 유지.
- 회귀 fixture: home에 mock skill 3개 + repo-local 1개 → mismatch_count=0.

### P-4. Multiple managed block (ac-4)
- `src/core/instruction-bridge.ts`의 `MANAGED_BLOCK_RE`를 `matchAll` 기반 수집으로 교체.
- 새 finding kind `multiple_markers` 추가. `InstructionFindingKind` enum 갱신.
- `src/core/bridge-sync.ts`에서 multiple_markers 감지 시 갱신 거부(throw 또는 명시 결과 action) + 안내 메시지.
- 회귀: `tests/doctor/instructions.test.ts`, `tests/bridge/sync.test.ts`, `tests/core/instruction-bridge.test.ts`에 각각 케이스.

### P-5. Advisory + bridge free-area 회귀 + mcp advisory 제거 (ac-5)
- `src/cli/commands/doctor.ts`의 `mcpCommand`에서 `advisory` arg 제거(D-5=(a)).
- `tests/doctor/permissions.test.ts`, `surface.test.ts`에 `--advisory` 회귀 1건씩.
- `tests/doctor/mcp.test.ts`에 `--advisory` 전달 시 usage error(exit 65) 회귀.
- `tests/bridge/sync.test.ts` 또는 `tests/core/bridge-sync.test.ts`에 자유 영역만 수정 후 `action=unchanged` + 자유 영역 sha256 보존 회귀.

### P-6. self-validation 보강
- 새 finding kind(`multiple_markers`)와 새 분류 label이 schema에 노출되면 case 추가.
- `tests/schemas/repo-self-validation.test.ts`는 기존 파일이므로 case 추가만 허용, 본체 수정 금지.

### P-7. manual smoke
- 본 ditto repo에서 4 doctor 명령 + bridge sync 실행해 회귀 없음 확인.
- 임시 `HOME` mock(별도 디렉터리)에 nested `network_access=true`를 박아 정확히 잡히는지 확인. **사용자 환경 `.codex/`, `.claude/`, `~/.claude.json`, `~/.codex/config.toml`은 어떤 경우에도 수정/삭제 금지.**

## 의존성과 실행 순서

P-1 ~ P-5는 독립이므로 병렬 가능. P-6은 그 다음. P-7은 마지막. P-1과 P-2는 모두 `permission-inventory.ts`를 만지므로 같은 commit 묶음으로 가는 게 hunk 충돌이 적다.

## 예상 변경 파일

수정 (삭제 금지, restore만):
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

신규:
- `tests/fixtures/doctor/codex/permissions-nested/`, `mcp-inline-table/`
- `tests/fixtures/doctor/claude-code/permissions-allow-{wildcard,destructive,conservative}/`
- `tests/fixtures/doctor/claude-code/surface-home-scope/`
- `tests/fixtures/doctor/claude-code/instructions-multiple-markers/`
- `package.json` + `bun.lockb`에 외부 TOML lib (D-1=(a))
- ADR-0001 보강 patch 또는 `.ditto/knowledge/adr/ADR-0003-toml-parser.md`

본 work item이 만드는 `.ditto/`:
- `.ditto/work-items/wi_v02harden/{work-item.json, plan.md, dod.md, rollback.md, context-packet.md, language-ledger.json, progress.md, completion.json, handoff.md, evidence/commands.jsonl}`

## 범위 밖

- provider CLI wrapper(`run_with`) → v0.3
- doctor `--fix` 옵션 → v0.3+
- 새 host adapter (OpenCode/OpenAgent) → v0.3+
- Phase 9 skill catalog 실제 schema 검증 → 별도 work item
- `samePath`의 realpath 보강, `secrets_read` 룰 추가 같은 minor → v0.3+로 미룸

## Review 합의 (사용자 ↔ agent)

| 단계 | review 시점 | 이유 |
|---|---|---|
| (생략) | D 결정은 plan.md에 이미 [DECIDED] | 사용자가 추천값을 직접 제시했으므로 추가 review 불필요 |
| P-1 + P-2 | core 정확도 묶음 commit 후 | TOML 파서와 allow 분류는 같은 inventory 영역 |
| P-3 + P-4 | surface scope + multiple marker commit 후 | 둘 다 새 분기/finding 도입 |
| P-5 + P-6 + P-7 | 회귀 + self-validation + smoke 묶음 후 handoff | 마감 |

## 진입 절차

1. D-1 ~ D-5 [DECIDED] 박혀 있음 (본 plan.md).
2. dod.md / rollback.md가 위 결정 기반으로 작성됨.
3. work-item.json status를 draft → in_progress로 갱신 후 P-1부터 진행.
