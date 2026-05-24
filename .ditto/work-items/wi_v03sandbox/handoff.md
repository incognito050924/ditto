# wi_v03sandbox Handoff

## Outcome

DITTO v0.3 profile sandbox enforcement landed. All 6 AC pass, final_verdict=pass.

application plan line 754-758의 v0.3 완료 기준 중 wi_260524qi9가 미달했던 "profile별 권한 격리가 실제로 적용된다" 항목이 충족된다:

- codex/claude-code adapter가 5 profile 모두에 대해 provider-native sandbox/permission flag를 명시적으로 매핑.
- `isolated` profile은 `.ditto/worktrees/<run_id>/` 아래 detached HEAD worktree 안에서 실행되어 main repo와 격리됨. manifest에 `worktree_path` 기록.
- 비-networked profile은 codex sandbox 모드 부산물로 network outbound 차단, claude-code는 unverified surface로 한계 명시.
- cwd escape 3-case(pre-spawn USAGE 거부, defense-in-depth outside-repo surface, read-only/reviewer write detection) 모두 fixture로 회귀 보호.

## Verification

- `bun test`: 167 pass / 0 fail (이전 161 → +6 profile policy unit tests).
- `bun run lint`: pass.
- `bun run build`: pass.
- codex/claude-code spawn smoke test는 환경 내에서 정상 spawn 확인(`codex --help` / `claude --help` 통과).

## What Changed (high level)

- Schema: `runManifest`에 optional `worktree_path: relativePath` 추가.
- Adapters: codex와 claude-code가 5 profile 모두에 sandbox/permission flag prepend.
- Wrapper: `isolated`일 때 worktree 생성 + cwd substitution + git capture가 worktree 기준.
- Helpers: 신규 `src/core/worktree.ts` (`createWorktreeForRun`).
- Tests: codex/claude-code 매핑 unit tests 12건, isolated worktree fixture, profile policy defense-in-depth unit tests 6건.

## Next

- **wi_v03verify**: `ditto verify`를 `runManifest.verifications`에 자동 append하는 wrapper hook. project_v03_entry_point memory에 [DECIDED] plan 박혀 있음. 이게 끝나면 v0.3 마감.

## Deferred (post-v0.3)

- worktree 자동 prune 명령.
- claude-code `--permission-mode` 매핑의 v0.4+ stability validation (현재 best-effort + unverified surface).
- model_reported stdout parsing.
- OpenCode/OpenAgent adapter.
- 추가 env scrub 키.

## Pointers

- Design note: `.ditto/work-items/wi_v03sandbox/design/profile-sandbox-enforcement.md`
- Completion: `.ditto/work-items/wi_v03sandbox/completion.json`
- Base: `e806ed6` (seed), branch tip is the close commit.
