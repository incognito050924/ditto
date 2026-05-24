# Definition Of Done

- `dist/ditto run with --provider codex --profile workspace-write --workItem <wi> --output json -- --help`가 provider help를 forward하고 manifest를 생성한다(DITTO help가 아니라).
- 동일 패턴이 `-- --version`, wrapper flag 이름 충돌 case(`-- --output ...` 등)에서도 동작한다.
- CLI 통합 회귀 fixture가 위 3+ case에 대해 manifest 생성 + provider args 정확 전달을 검증한다.
- 다른 wrapper command(`run with --help` 단독, `run record`, `verify`, `doctor` 등)의 기존 help 동작이 깨지지 않는다(최소 sanity).
- wi_v03cliforward 자체 work-item.json `runs.length >= 1`이고, 해당 run의 manifest가 `.ditto/runs/<id>/manifest.json`에 존재하며 `verifications` 배열에 entry 1건 이상 기록된다.
- `bun test`, `bun run lint`, `bun run build` 통과.
- `tests/schemas/repo-self-validation.test.ts`가 .ditto/와 wi_v03cliforward 상태를 통과한다.
- wi_v03cliforward가 `completion.json` + `handoff.md`와 함께 status=done으로 마감되며, `changed_files`에 self-artifacts(completion/handoff/progress/work-item + 실제 manifest 위치)를 포함한다.
- 마감 후 project_v03_entry_point memory가 'v0.3 fully closed'로 다시 정정된다.
