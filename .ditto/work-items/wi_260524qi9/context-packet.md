# DITTO v0.3 seed — provider wrapper and context packet

## Goal

DITTO v0.3의 구현 진입점을 provider wrapper + profile policy + context packet으로 고정하고, v0.1 RunStore/manifest와 v0.2 HostAdapter를 재사용하는 실행 가능한 acceptance criteria를 남긴다.

## Acceptance Criteria

- ac-1 [pass] Phase 3 본문과 v0.3 우선순위 묶음이 현재 구현 상태와 충돌하지 않는지 점검한다. 재구현 금지 대상은 RunStore, run-manifest schema, ditto run record, HostAdapter registry로 확정하고, v0.3에서 새로 얹을 표면은 run with, provider spawn/capture, profile policy, context build로 제한한다.
- ac-2 [pass] ditto run with --provider codex|claude-code --profile <name> -- <args...>가 provider command를 spawn하고, 성공/실패 모두 .ditto/runs/<id>/manifest.json에 git_before/git_after, changed_files, stdout_path, stderr_path, diff_path, exit_code, ended_at을 기록한다. provider non-zero exit은 manifest.exit_code에 실제 종료 코드를 기록한 정상 capture 완료 상태이며, DITTO runtime failure는 가능한 한 manifest를 남기되 exit_code: null과 unverified 또는 notes로 crash/kill 사유를 구분한다.
- ac-3 [pass] HostAdapter interface는 기존 doctor용 load* 메서드를 보존하면서 provider 실행을 위한 spawnRun/captureArtifacts 계열 계약으로 확장된다. Codex와 Claude Code built-in adapter가 같은 contract를 구현하고, OpenCode/OpenAgent는 v0.3 범위 밖으로 명시한다.
- ac-4 [pass] read-only/workspace-write/reviewer/networked/isolated profile의 실행 정책이 코드와 fixture로 표현된다. 최소 회귀 검증은 read-only/reviewer에서 workspace write 금지, workspace-write에서 cwd 밖 write 금지처럼 DITTO가 직접 강제 가능한 정책 fixture와, provider CLI 또는 OS sandbox 한계 때문에 강제하지 못해 manifest.unverified에 남기는 정책 fixture를 분리한다. networked가 아닌 profile에서 network 필요 작업이 감지되면 차단하거나 명시적으로 unverified에 기록한다.
- ac-5 [pass] ditto context build가 현재 work item, acceptance criteria, git state, 관련 run/evidence 상태로 repo-relative markdown context packet을 생성하고, run with가 그 path를 prompt_path로 manifest에 연결할 수 있다.
- ac-6 [pass] v0.1의 수동 ditto run record와 v0.3의 자동 ditto run with가 동일 run-manifest schema를 통과한다. 기존 run-store/run-record 테스트는 유지하고, 자동 run fixture를 추가해 schema round-trip과 artifact path를 검증한다.

## Git State

- head: d764187d90fdfeab4e71f235c35693e939402067
- branch: main
- dirty: true

## Runs

- none
