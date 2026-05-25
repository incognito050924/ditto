# wi_v03verify Handoff

## Outcome

DITTO v0.3 verification capture wiring 완료. 4 AC 모두 pass, final_verdict=pass.

이로써 application plan line 754-758의 v0.3 완료 기준 3개가 모두 충족된다:

- "provider 실행 실패와 성공이 모두 evidence로 남는다" — wi_260524qi9 + wi_v03sandbox가 충족.
- "profile별 권한 격리가 실제로 적용된다" — wi_v03sandbox가 충족.
- "DITTO 자체 v0.3 work item이 DITTO 도구로 검증·마감되어 있다" — wi_260524qi9, wi_v03sandbox, wi_v03verify 3개 work item이 모두 done. **v0.3 version 마감.**

## Verification

- `bun test`: 171 pass / 0 fail (이전 167 → +4 verify fixtures).
- `bun run lint`: pass.
- `bun run build`: pass.

## What Changed (high level)

- `RunStore.pathFor`의 kind union에 `'verify.log'` 추가 (structural).
- `RunWithInput.verify_command?` 추가, `runWithProvider`가 provider run 종료 직후 `runVerifyStep` 호출.
- `runVerifyStep`이 whitespace-split된 command를 Bun.spawnSync로 실행, `.ditto/runs/<id>/verify.log`에 출력 저장, `runManifest.verifications`에 `{command, exit_code, duration_ms, output_path, notes?}` entry 1건 append.
- `ditto run with` CLI에 `--verify "<command>"` flag 추가.
- 4 fixture: verify pass with output, verify fail (non-zero), verify spawn fail (ENOENT), no `--verify` (baseline).

## Design Constraints (재확인)

- single `--verify` per run (복수는 후속).
- whitespace word split — quoted args/shell expansion 미지원; 복잡한 경우 shell script로 위임.
- verify 결과는 manifest evidence로만 surface — CLI exit이나 RunWithRuntimeError에 영향 없음.
- 기존 `ditto verify` CLI(evidence ledger + AC verdict update)는 별도 경로로 그대로 유지.

## Next

v0.3 version closed. project_v03_entry_point memory를 "v0.3 fully done"으로 갱신하고, default 다음 진입점은 application plan **Phase 4 workflow loop와 completion gate** (line 320 부근).

## Deferred (post-v0.3)

- verify timeout 옵션.
- 복수 `--verify`.
- shell interpretation 지원.
- model_reported stdout parsing.
- OpenCode/OpenAgent adapter.
- 추가 env scrub 키.
- claude-code `--permission-mode` 매핑의 v0.4+ stability validation.
- worktree 자동 prune 명령.

## Pointers

- Design note: `.ditto/work-items/wi_v03verify/design/verify-option.md`
- Completion: `.ditto/work-items/wi_v03verify/completion.json`
- Base: `ede2c39` (seed), branch tip은 이 close commit.
- v0.3 마감 직전 마지막 work item: `wi_v03sandbox` (`05b05e6`).
