# Rollback

- Seed 단계 교체 시: `.ditto/work-items/wi_v03sandbox/` 디렉터리를 제거한다.
- Implementation 단계에서 provider sandbox flag 매핑이 버전 호환성 문제로 깨질 경우: codex `read-only` 매핑만 남기고(wi_260524qi9 상태로 복귀), 나머지 profile은 `manifest.unverified`에 sandbox 미적용 사유를 명시하는 형태로 후퇴한다.
- Implementation 단계에서 git worktree 도입이 기존 run에 회귀를 일으키면: isolated profile만 worktree off하고, 나머지 profile은 변경 유지. worktree helper 자체는 후속 work item에서 재활용 가능하므로 보존한다.
- 신규 helper(`src/core/worktree.ts`)나 adapter sandbox 매핑 상수가 추가되었는데 v0.3 마감 전 후퇴가 필요하면 그 파일을 단독으로 revert한다 (runWithProvider 본체와 분리되어 있어야 한다).
