# Progress

- 2026-05-24: Seed created after wi_260524qi9 마감 검토에서 v0.3 완료 기준 미달 항목(provider-native sandbox flag, isolated worktree, network-off flag)이 확인되어 후속 work item으로 분리. wi_v03sandbox는 wi_260524qi9가 도입한 wrapper-level profile policy 위에 provider-native enforcement layer를 얹는 데 집중한다.
- 2026-05-24: Phase 3 진입 — single design note `profile-sandbox-enforcement.md`로 profile→flag matrix(codex/claude-code), worktree lifecycle(isolated), network-off layering, schema에 worktree_path optional 추가, regression fixture 배치를 한 번에 박음. wi_v03sandbox status는 in_progress로 전환하고 started_at_sha는 seed commit `e806ed6`을 사용한다.
- 2026-05-24: runManifest schema에 optional `worktree_path` 필드를 추가하고 exported JSON schema를 재생성. 기존 manifest는 optional이라 회귀 없음.
- 2026-05-24: codex adapter에 profile→sandbox flag matrix(5 profile) 적용. read-only/workspace-write/reviewer/isolated는 `--sandbox` 매핑, networked는 workspace-write + 'network is not forced open' unverified. `buildCodexSpawnArgs` pure function 분리 + 6 unit test.
