# Handoff: wi_v02harden

## 최종 verdict
pass

## acceptance
- ac-1 [pass]
- ac-2 [pass]
- ac-3 [pass]
- ac-4 [pass]
- ac-5 [pass]

## 무엇이 끝났나
DITTO v0.2 doctor hardening — real-world accuracy and regression coverage — 모든 acceptance criterion이 pass로 기록되었다.

## 변경 파일
- .ditto/knowledge/adr/ADR-0003-toml-parser.md
- .ditto/work-items/wi_v02harden/completion.json
- .ditto/work-items/wi_v02harden/context-packet.md
- .ditto/work-items/wi_v02harden/dod.md
- .ditto/work-items/wi_v02harden/handoff.md
- .ditto/work-items/wi_v02harden/language-ledger.json
- .ditto/work-items/wi_v02harden/plan.md
- .ditto/work-items/wi_v02harden/progress.md
- .ditto/work-items/wi_v02harden/rollback.md
- .ditto/work-items/wi_v02harden/work-item.json
- bun.lockb
- package.json
- src/cli/commands/bridge.ts
- src/cli/commands/doctor.ts
- src/core/bridge-sync.ts
- src/core/hosts/claude-code.ts
- src/core/hosts/codex.ts
- src/core/hosts/shared.ts
- src/core/hosts/types.ts
- src/core/instruction-bridge.ts
- src/core/permission-inventory.ts
- src/core/surface-inventory.ts
- tests/bridge/sync.test.ts
- tests/core/hosts/registry.test.ts
- tests/core/instruction-bridge.test.ts
- tests/doctor/instructions.test.ts
- tests/doctor/mcp.test.ts
- tests/doctor/permissions.test.ts
- tests/doctor/surface.test.ts
- tests/fixtures/doctor/claude-code/permissions-allow-conservative/settings.json
- tests/fixtures/doctor/claude-code/permissions-allow-destructive/settings.json
- tests/fixtures/doctor/claude-code/permissions-allow-wildcard/settings.json
- tests/fixtures/doctor/codex/mcp-inline-table/config.toml
- tests/fixtures/doctor/codex/permissions-nested/config.toml

## remaining risks
- 외부 TOML 파서 의존 추가가 ADR-0001 runtime stack 결정에 영향을 줄 수 있다.
- Claude permissions allow 분류 룰이 사용자 settings 패턴에서 새 false positive를 만들 수 있다.
- Multiple managed block 시 bridge sync 거부 정책이 사용자 정상 흐름을 차단할 수 있다.
