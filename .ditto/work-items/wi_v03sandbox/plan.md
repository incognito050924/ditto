# Plan

1. v0.3 완료 기준(plan line 754-758)과 wi_260524qi9 마감 상태를 재확인하여 sandbox/worktree/network-off 표면이 충돌 없이 얹히는지 점검한다.
2. Design note: profile→provider-native flag matrix(codex/claude-code 각각), isolated worktree 라이프사이클, network-off flag 메커니즘.
3. codex adapter 우선 — profile별 sandbox flag prepend 구현 + fixture.
4. claude-code adapter — 같은 매핑 contract 구현 + fixture.
5. git worktree helper(`src/core/worktree.ts` 신규) + isolated profile spawn에서 cwd substitution + manifest에 worktree path 기록.
6. 비-networked profile의 network-off flag 주입(adapter layer) + 미지원은 unverified surface.
7. cwd escape 회귀 fixture 3-case 추가.
8. DITTO self-validation/lint/build 통과 확인.
9. handoff + completion + work item close (changed_files에 self-artifacts 포함).
