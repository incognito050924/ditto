# wi_v03sandbox Context Packet Seed

## Entry Point

- Plan source: `reports/harnesses/ditto-application-plan.md`
- v0.3 priority bundle: line 743-758
- Missing items per project_v03_entry_point memory:
  - profile 권한 격리 — provider-native sandbox flag (codex `read-only`만 매핑됨)
  - profile 권한 격리 — 실제 network 차단 (proxy env scrub만)
  - isolated profile — worktree 격리 미구현
- Base commit at seed creation: `2f66231 docs(ditto): close wi_260524qi9 v0.3 handoff`

## Reuse, Do Not Rebuild

- `src/core/run-with.ts`: `runWithProvider` orchestration — RunStore.create → spawn → pipe → git_after/diff → manifest update → work item linkage.
- `src/core/hosts/types.ts`: `HostAdapter.spawnRun` 계약, `HostRunInput`(env shape 포함).
- `src/core/hosts/spawn.ts`: Bun.spawn 기반 codex/claude-code 구현.
- `src/core/git.ts`: `captureGitState`, `listChangedFiles`, `captureGitDiff`.
- Profile policy 2-layer 패턴: wrapper pre-spawn validation + post-run diff inspection + `manifest.unverified` surface.

## v0.3 Sandbox Scope

- workspace-write/reviewer/networked 각 profile의 provider-native sandbox flag 매핑을 codex/claude-code adapter에 추가.
- isolated profile은 spawn 전 git worktree 생성 → 그 path를 `cwd`로 사용 → run 종료 후 worktree 보존(default). worktree path를 manifest에 기록.
- 비-networked profile(read-only/workspace-write/reviewer/isolated)에 provider-native network-off flag 추가. 미지원은 `manifest.unverified` surface. proxy env 4종 scrub은 유지.
- cwd escape 회귀 fixture 3-case (pre-spawn 거부 / sandbox 차단 또는 post-run unverified / profile violation 기록).

## Out Of Scope

- `model_reported` stdout parsing (현재 null 유지).
- OpenCode/OpenAgent adapter (wi_260524qi9 AC-3에서 v0.3 범위 밖 명시).
- env scrub 키 확장 (proxy 4종 외).
- v0.3 wrapper 자체 dogfood 축적.
- `ditto verify` ↔ `runManifest.verifications` 자동 연결 (wi_v03verify로 분리).
- Phase 4 workflow loop / completion gate.
