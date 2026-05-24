# Definition Of Done

- `ditto run with ... --verify "<command>"`가 provider run 종료 후 verify command를 spawn하고 stdout/stderr를 `.ditto/runs/<id>/verify.log`에 저장한다.
- `runManifest.verifications`에 `{command, exit_code, duration_ms, output_path}` entry 1건이 append된다.
- verify exit_code가 0/non-zero/spawn-fail 어느 쪽이든 wrapper의 run capture는 정상 완료되고, `ditto run with` CLI exit_code는 provider exit_code만 반영한다. spawn 실패는 verifications entry의 exit_code=-1 또는 notes로 surface된다.
- 회귀 fixture가 verify pass / fail / spawn-fail 3-case의 manifest 표현을 검증한다.
- `bun test`, `bun run lint`, `bun run build` 모두 통과한다.
- `tests/schemas/repo-self-validation.test.ts`가 .ditto/와 wi_v03verify 상태를 통과한다.
- wi_v03verify가 `completion.json` + `handoff.md`와 함께 status=done으로 마감되며, `changed_files`에 self-artifacts(completion/handoff/progress/work-item)를 포함한다.
- 마감 시점에 application plan line 754-758 v0.3 완료 기준 3개 모두 충족된 상태가 된다.
