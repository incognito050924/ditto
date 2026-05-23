# Progress: wi_v02harden

## 현재 상태
`draft` — 2026-05-24 18:30 wi_v02doctor 리뷰 후속으로 초안 + D-1~D-5 [DECIDED] 박힘. P-1 시작 직전.

## 진행 로그
- 18:00 wi_v02doctor 리뷰(2026-05-24) 합의에 따라 work item 초안 작성.
  - AC 5개: Codex TOML 정확도 / Claude allow 분류 / Surface scope 분리 / Multiple managed block / Advisory + bridge free-area 회귀.
  - D 5건: 모두 [DECISION NEEDED]로 시작.
- 18:30 사용자 리뷰 1차: D 항목 전부 사용자 결정으로 둔 게 절차 떠넘김에 가깝다는 피드백. 사용자가 D-1~D-5 추천값 직접 제시. 다음과 같이 [DECIDED]로 박음.
  - D-1=(a) 외부 TOML parser — 자체 확장은 또 반쪽 파서 위험. ADR-0001 보강 또는 ADR-0003 신설.
  - D-2=(b) wildcard + 명시 destructive 분리 — Read(*) 같은 broad read는 v0.2 label에서 과도 차단 회피.
  - D-3=(b) adapter API에서 home/local scope 분리 — catalog schema 변경보다 inventory 출처 명확화.
  - D-4=(b) multiple_markers면 bridge sync 거부 — 두 block 중 하나만 갱신은 더 위험.
  - D-5=(a) mcp는 exit 0 + advisory 옵션 제거 — 수집 불가는 "위험 drift"가 아니라 "검증 불가".
- 18:30 dod.md/rollback.md/context-packet.md 결정 기반 단일 경로로 재작성. `bun x tsc` → `bun run tsc` 정정. context-packet의 "clean" 표현을 "본 work item 디렉터리 외 변경 없음"으로 보정.

## P-1 완료 (2026-05-24 19:00)
- 19:00 status draft → in_progress. `bun add smol-toml@1.6.1` (runtime dep 1개 추가).
- 19:10 (structural) `parseTomlSubset` → `parseToml(smol-toml.parse)` 위임. `src/core/hosts/{shared,codex}.ts` 갱신. 호출자 동작 그대로 — 107 pass 유지.
  - commit 8ec4ad2 `refactor(ditto): swap parseTomlSubset for smol-toml (structural)`
- 19:20 (behavioral) `permission-inventory.ts`에 `[sandbox_workspace_write].network_access` nested 검사 추가. inline table `env = { ... }`는 smol-toml로 자동 처리(추가 코드 없음). 회귀 fixture/테스트 2건 추가.
  - 신규: `tests/fixtures/doctor/codex/{permissions-nested,mcp-inline-table}/config.toml`
  - 테스트: `tests/doctor/permissions.test.ts` nested 케이스, `tests/doctor/mcp.test.ts` inline-table 케이스
  - ADR-0003 신설 (ADR-0001 본문은 보존). smol-toml 결정 근거 + 되돌리기 비용 기록.
  - commit 2c47a42 `feat(ditto): detect nested codex permissions and inline-table MCP env (behavioral)`

## P-2 완료 (2026-05-24 19:30)
- 19:25 `hasDangerousAllow`(광폭 regex)를 `classifyAllowEntry` 분류 함수로 교체. D-2=(b) 매핑을 모듈 상수로:
  - `WILDCARD_ALLOW`(`*`, `Bash`, `Bash(*)`, `WebFetch(*)`) → dangerous_mode + approval_bypass
  - `DESTRUCTIVE_ALLOW_PATTERNS`(`Write\(`, `Bash\(rm `, `Bash\(sudo `) → write_outside_workspace
  - 그 외(`Bash(ls)`, `Read(*)` 등) → finding 0
- 19:28 회귀 fixture 3종 + 테스트 3건 추가:
  - `permissions-allow-{wildcard,destructive,conservative}/settings.json`
  - 테스트 3건 모두 통과. 기존 `permissions-dangerous` 회귀와 공존(defaultMode 분기 별도 유지).
  - commit 88a23de `feat(ditto): split claude allow risk into wildcard / destructive / safe (behavioral)`

## 검증 (P-1 + P-2)
- `bun run tsc --noEmit` pass
- `bun run lint` pass (1차 format issue는 lint:fix로 자동 보정)
- `bun test` 112 pass / 0 fail (이전 107 + 신규 5)

## 1차 review 통과 (P-1 + P-2)
- 사용자 review 결과: 진행 OK, findings 0. ADR-0001 cross-reference 보류, WebFetch(*) wildcard 분류 유지. ADR-0003 pass count("전체 109 pass") 오차는 다음 docs commit과 함께 정정.

## P-3 완료 (2026-05-24 20:00)
- 20:00 (structural) `SurfaceInventory.surfaces`를 `localSurfaces`/`homeSurfaces`로 분리. claude-code/codex adapter 갱신. `collectSurfaceInventory`는 `actual = [...local, ...home]`으로 호환 유지 → 112 pass 회귀 동일. mock host adapter(registry.test, instruction-bridge.test)도 새 타입에 맞춤.
  - commit 83c752f `refactor(ditto): split SurfaceInventory into local and home (structural)`
- 20:10 (behavioral) `collectSurfaceInventory`가 catalog 비교 대상을 `localSurfaces`로만 좁힘. 출력 `surfaces`는 합쳐 노출(호환). 회귀 추가: HOME mock에 skill 3개(`extra-a/b/c`) + repo-local command 1개 → `mismatch_count=0`이지만 inventory에 home skill 포함.
  - commit 620b9db `feat(ditto): exclude home-scope surfaces from catalog mismatch comparison (behavioral)`

## P-4 완료 (2026-05-24 20:30)
- 20:20 (structural) `MANAGED_BLOCK_RE` → global flag + `matchAll` 기반 collection. `projectionFromSurface`는 첫 매치만 사용해 회귀 동일 → 113 pass.
  - commit 0dd507a `refactor(ditto): scan managed blocks with matchAll (structural)`
- 20:25 (behavioral) D-4=(b) 적용:
  - `InstructionFindingKind` / `ProjectionLoadResult`에 `multiple_markers` 추가
  - `compareClaudeProjection`이 multiple_markers 분기에서 finding 1건만 보고
  - `bridge-sync.ts` `refused-multiple-markers` action 신설 + 파일 0 수정
  - `bridge.ts` CLI: refused 시 exit 1(drift) + stderr 안내(`clean up to exactly one block`)
  - 회귀 3건: `tests/doctor/instructions.test.ts`, `tests/bridge/sync.test.ts`, `tests/core/instruction-bridge.test.ts`
  - commit 08eb237 `feat(ditto): report multiple_markers finding and refuse bridge sync (behavioral)`

## 검증 (P-3 + P-4)
- `bun run tsc --noEmit` pass
- `bun run lint` pass (format 자동 보정 2회)
- `bun test` 116 pass / 0 fail (이전 113 + 신규 3)
- schema self-validation 10/10

## 2차 review 통과 (P-3 + P-4)
- 사용자 review 결과: 진행 OK, findings 0. context-packet.md "현재 107 pass" 오차 지적 → P-5+P-6+P-7 docs commit에서 정정.

## P-5 완료 (2026-05-24 21:00)
- 21:00 D-5=(a) 적용. `doctor mcp` `--advisory` 사용 시 명시적 usage error(exit 65)로 reject + stderr 안내. args 정의는 유지하되 description으로 의미 명시.
- 회귀 4건:
  - `tests/doctor/permissions.test.ts`: --advisory + wildcard fixture → exit 0 (drift 발생에도)
  - `tests/doctor/surface.test.ts`: --advisory + surface-mismatch → exit 0
  - `tests/doctor/mcp.test.ts`: --advisory → exit 65 + stderr "does not support --advisory"
  - `tests/bridge/sync.test.ts`: 자유 영역만 수정 → 두 번째 sync action=unchanged, `사용자 추가 줄` 보존
- commit 93eae90 `feat(ditto): finalize doctor advisory and bridge free-area regressions (behavioral)`

## P-6 완료 (2026-05-24 21:05)
- `tests/schemas/repo-self-validation.test.ts`가 wi_v02harden 산출물(work-item.json, language-ledger.json, evidence/commands.jsonl)을 work-items 디렉터리 자동 순회로 검증.
- 새 finding kind(multiple_markers)와 새 분류 label은 internal type only → schema 노출 없음 → case 추가 불필요.
- 결과: 29 pass / 0 fail.

## P-7 manual smoke (2026-05-24 21:15)
- 본 ditto repo:
  - `doctor instructions`: CLAUDE.md 없음 → `projection_missing`(repo가 Codex primary라 정상 상태, 회귀 아님)
  - `doctor permissions`: codex/claude 설정 모두 missing → dangerous_count=0 (정상)
  - `doctor mcp`: `.mcp.json` 없음 → unverified + 사유 명시 (정상)
  - `doctor surface`: home의 `graphify` skill이 inventory에 보이고 mismatch_count=0 (**P-3 효과 입증**)
- 임시 HOME mock + 임시 .codex/config.toml로 fixture 직접 검증:
  - nested `[sandbox_workspace_write].network_access = true` → `network_on` finding + dangerous_count=1 (**P-1 nested 효과 입증**)
  - inline table `env = { TOKEN = "x", REGION = "kr" }` → `env_keys: ["REGION", "TOKEN"]` (**P-1 inline 효과 입증**)
- 사용자 환경의 `.codex/`, `.claude/`, `~/.claude.json`, `~/.codex/config.toml`은 어떤 경우에도 수정/삭제하지 않음.

## ditto verify 결과 (ac별 evidence)
- ac-1 ↔ `bun test tests/doctor/permissions.test.ts tests/doctor/mcp.test.ts` → exit 0
- ac-2 ↔ `bun test tests/doctor/permissions.test.ts` → exit 0
- ac-3 ↔ `bun test tests/doctor/surface.test.ts` → exit 0
- ac-4 ↔ `bun test tests/doctor/instructions.test.ts tests/bridge/sync.test.ts tests/core/instruction-bridge.test.ts` → exit 0
- ac-5 ↔ `bun test tests/doctor tests/bridge tests/core/bridge-sync.test.ts` → exit 0

모든 ac verdict=pass 박힘. evidence/commands.jsonl에 5개 entry 자동 기록.

## 최종 검증
- `bun run tsc --noEmit` pass
- `bun run lint` pass
- `bun test` 120 pass / 0 fail (wi_v02doctor 마감 시점 107 → wi_v02harden 마감 120, 신규 13건)
- schema self-validation 29/29 pass

## 다음 동작
- `ditto work handoff wi_v02harden`로 final_verdict=pass, status=done, closed_at 박고 completion.json/handoff.md 생성.
- 마감 commit 후 work item 종료. v0.3 provider wrapper 준비로 이행 가능.
