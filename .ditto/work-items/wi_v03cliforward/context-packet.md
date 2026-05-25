# wi_v03cliforward Context Packet Seed

## Entry Point

- Review source: `reports/harnesses/ditto-phase3-review.md` (P1 release-blocker, P2 운영 규칙 gap, P3 후속 분리)
- Plan reference: `reports/harnesses/ditto-application-plan.md` Phase 3 line 269-318 (CLI contract)
- project_v03_entry_point memory의 "v0.3 substantially implemented; P1 fix pending" 상태
- Base commit at seed creation: `b4c10b0 docs(ditto): close wi_v03verify and DITTO v0.3 version`

## What P1 Looks Like (재현)

```sh
dist/ditto run with --provider codex --profile workspace-write --workItem <wi> --output json -- --help
# 결과:
# - DITTO run-with help 출력
# - exit 0
# - .ditto/runs/<id>/manifest.json 생성 안 됨
```

원인:
- `src/cli/commands/run.ts`가 citty `defineCommand`로 정의되고, citty가 `--help` token을 argv 어디에 있든 자기 help flag로 처리한다.
- `src/cli/util.ts`의 `extractDashDashTail`은 `--` 뒤를 slice하지만, citty의 help 처리가 command `run` 함수 호출보다 먼저 일어나서 tail extraction 기회가 없다.

## Reuse, Do Not Rebuild

- `runWithProvider` orchestration (`src/core/run-with.ts`) — provider args를 받아 정확히 spawn하는 부분은 이미 동작한다. 회귀 fixture(`tests/core/run-with.test.ts`)도 core 레벨에서 args forwarding을 검증한다. 문제는 CLI layer.
- `HostAdapter.spawnRun` 계약 — 그대로.
- profile policy, worktree, `--verify` wiring — 그대로.
- `extractDashDashTail` — argv split 로직 자체는 활용 가능. 다만 citty 호출 전 단계에서 적용해야 한다.

## v0.3 CLI Forward Scope

- `src/cli/index.ts` 또는 `src/cli/util.ts`에 raw argv pre-processing 추가: 최상위 entry에서 process.argv를 보고 `--` 위치 기준으로 wrapper-side argv와 provider-side argv로 분리한다. citty에는 wrapper-side argv만 전달, provider-side는 module-level state 또는 env로 보관해서 `run with` command가 `extractDashDashTail`을 통해 그대로 읽도록 한다.
- 회귀 fixture: 빌드된 `dist/ditto` 또는 동등한 entry 호출 형태로 process.argv 경로를 끝까지 시뮬레이션. 최소 3-case (`-- --help`, `-- --version`, wrapper flag 이름 충돌 `-- --output`).
- P2 운영 규칙 즉시 적용: wi_v03cliforward 자체를 `ditto run with --verify "<sanity command>"`로 한 번 capture해서 work item runs에 적어도 1개 run manifest 남김.

## Out Of Scope

- P3 networked profile network-explicit enablement — 별도 work item.
- `--help` 외 다른 wrapper-level 명령(`run record`, `verify`, `doctor` 등)의 CLI 회귀 — 본 work item 범위는 `run with`. 단 그들의 기존 help 동작이 깨지지 않음은 최소 sanity check.
- `--verify` timeout, 복수 `--verify`, shell interpretation — 후속.
- 기존 v0.3 세 work item(wi_260524qi9 / wi_v03sandbox / wi_v03verify)의 retrospective run manifest 보정 — 의도적으로 하지 않음.

## Done = v0.3 fully closed

본 work item이 done이면 P1 닫힘 + 자기 적용 evidence 1건 확보. project_v03_entry_point memory를 다시 "v0.3 fully closed"로 정정한다. P3은 별도 work item으로 남는다.
