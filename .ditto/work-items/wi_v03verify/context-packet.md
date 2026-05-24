# wi_v03verify Context Packet Seed

## Entry Point

- Plan source: `reports/harnesses/ditto-application-plan.md`
- v0.3 priority bundle: line 743-758, 특히 "verification capture를 manifest에 연결" 항목
- project_v03_entry_point memory의 [DECIDED] plan: `--verify <command>` 옵션을 wrapper에 추가
- Base commit at seed creation: `05b05e6 docs(ditto): close wi_v03sandbox v0.3 sandbox handoff`

## Reuse, Do Not Rebuild

- `src/core/run-with.ts`의 `runWithProvider` orchestration — RunStore.create → spawn → pipe → git_after/diff → manifest update → work item linkage 순서 그대로.
- `src/schemas/run-manifest.ts`의 `verification` schema(이미 `{command, exit_code, duration_ms?, output_path?, notes?}` 보유)와 `runManifest.verifications` array.
- `src/core/run-store.ts`의 `pathFor()`(필요 시 verify.log 추가 — 'verify.log' 키만 추가 가능).
- 기존 `ditto verify` CLI(`src/cli/commands/verify.ts`)는 evidence ledger + AC verdict update 경로로 그대로 유지. `--verify`는 manifest-level의 별도 lightweight 경로.

## v0.3 Verify Scope

- `ditto run with --verify <command>` — provider run 종료 후 wrapper가 verify command를 spawn하고 stdout/stderr를 `.ditto/runs/<id>/verify.log`에 저장.
- Verification entry를 `runManifest.verifications`에 append: `{command, exit_code, duration_ms, output_path}`.
- verify exit_code가 어떻든 wrapper run capture는 정상 완료. CLI exit_code는 provider exit_code만 반영.
- spawn 실패(ENOENT 등)는 exit_code=-1 또는 notes로 surface.
- Command word splitting은 단순 whitespace; 복잡한 경우는 shell script 호출 권장.
- 회귀 fixture: verify pass / fail / spawn-fail 각각 manifest 표현 검증.

## Out Of Scope

- verify timeout 옵션.
- 복수 `--verify` (single verification per run in v0.3).
- shell interpretation(`bash -c` 등).
- `ditto verify` 명령의 evidence ledger 통합 — 별도 경로 유지.
- AC verdict 자동 update — `--verify`는 manifest evidence만 produce.
- chunked / streamed verify output.
- model_reported parsing, OpenCode/OpenAgent adapter (v0.3 후 별도).

## Done = v0.3 마감

wi_v03verify done이면 application plan line 754-758 완료 기준 3개 모두 충족:
- "provider 실행 실패와 성공이 모두 evidence로 남는다" (wi_260524qi9 + wi_v03sandbox 통과)
- "profile별 권한 격리가 실제로 적용된다" (wi_v03sandbox 통과)
- "DITTO 자체 v0.3 work item이 DITTO 도구로 검증·마감되어 있다" (3개 work item 모두 done)
