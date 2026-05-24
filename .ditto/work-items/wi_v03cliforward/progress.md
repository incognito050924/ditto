# Progress

- 2026-05-24: Seed created — `reports/harnesses/ditto-phase3-review.md`가 진단한 release-blocker P1(citty가 `-- --help`를 가로채 provider forward 실패)을 닫기 위해 분리. 같은 work item에서 P2 운영 규칙(`ditto run with --verify` 자기 적용)을 즉시 적용한다. P3(networked profile network-explicit)은 별도 work item으로 분리한다. 본 work item 마감 후에만 v0.3을 fully closed로 다시 선언한다.
- 2026-05-24: Phase 3 진입 — root cause를 citty/dist/index.mjs:435의 `rawArgs.includes("--help")` flat scan으로 확정. design note `cli-argv-forward.md`에 수정 위치(src/cli/index.ts entry에서 process.argv의 `--` pre-slice 후 wrapper-side만 citty rawArgs로 전달), 다른 command isolation 분석(verify는 incidental fix), test approach(Bun.spawnSync + PATH-override mock binary), self-application 규칙을 한 번에 박음. status를 in_progress로 전환하고 started_at_sha는 seed commit `a32d3c2`을 사용한다.
