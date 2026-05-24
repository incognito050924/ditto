# Handoff: wi_260524qi9

## 최종 verdict
pass

## acceptance
- ac-1 [pass]
- ac-2 [pass]
- ac-3 [pass]
- ac-4 [pass]
- ac-5 [pass]
- ac-6 [pass]

## 무엇이 끝났나
DITTO v0.3 seed — provider wrapper and context packet — 모든 acceptance criterion이 pass로 기록되었다.

## 변경 파일
- .ditto/work-items/wi_260524qi9/completion.json
- .ditto/work-items/wi_260524qi9/context-packet.md
- .ditto/work-items/wi_260524qi9/design/host-adapter-contract.md
- .ditto/work-items/wi_260524qi9/design/run-with-cli.md
- .ditto/work-items/wi_260524qi9/handoff.md
- .ditto/work-items/wi_260524qi9/progress.md
- .ditto/work-items/wi_260524qi9/work-item.json
- src/cli/commands/context.ts
- src/cli/commands/run.ts
- src/cli/index.ts
- src/core/context-packet.ts
- src/core/git.ts
- src/core/hosts/claude-code.ts
- src/core/hosts/codex.ts
- src/core/hosts/spawn.ts
- src/core/hosts/types.ts
- src/core/run-with.ts
- tests/core/context-packet.test.ts
- tests/core/hosts/claude-code-spawn.smoke.test.ts
- tests/core/hosts/codex-spawn.smoke.test.ts
- tests/core/run-with.test.ts

## remaining risks
- profile별 권한 격리는 provider CLI 자체 기능과 OS sandbox 지원에 따라 완전 차단이 어려울 수 있다.
- context packet은 Phase 5에도 별도 주제로 남아 있어 v0.3에서 과도하게 확장될 위험이 있다.
- 실제 Codex/Claude CLI 호출은 로컬 설치 여부와 버전에 의존한다.
