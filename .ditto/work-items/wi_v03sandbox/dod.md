# Definition Of Done

- codex/claude-code adapter의 `spawnRun`이 input.profile에 따라 provider-native sandbox flag를 args 앞에 prepend하며, 미지원 매핑은 `manifest.unverified`에 명시된다.
- isolated profile spawn 시 git worktree가 생성되고 그 path가 cwd로 사용되며, worktree path가 manifest에 기록된다(default: 보존).
- 비-networked profile(read-only/workspace-write/reviewer/isolated) spawn 시 provider-native network-off flag가 args에 추가되거나 미지원이면 `manifest.unverified`에 surface된다. proxy env 4종 scrub은 유지된다.
- cwd escape 회귀 fixture 3-case (pre-spawn USAGE 거부 / mock provider의 cwd 밖 write 시도가 sandbox 차단 또는 post-run unverified surface / read-only/reviewer 위반이 `manifest.unverified`에 기록)가 모두 검증된다.
- `bun test`, `bun run lint`, `bun run build` 모두 통과한다.
- `tests/schemas/repo-self-validation.test.ts`가 .ditto/와 wi_v03sandbox 상태를 통과한다.
- wi_v03sandbox가 `completion.json` + `handoff.md`와 함께 status=done으로 마감되며, `changed_files`에 self-artifacts(completion/handoff/progress/work-item)를 포함한다.
