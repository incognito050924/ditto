# Handoff: wi_v02handoff

## 최종 verdict
pass

## acceptance
- ac-1 [pass]
- ac-2 [pass]
- ac-3 [pass]

## 무엇이 끝났나
DITTO v0.2 work-item-handoff cleanup — accurate changed_files and base ref — 모든 acceptance criterion이 pass로 기록되었다.

## 변경 파일
- .ditto/work-items/wi_v02doctor/completion.json
- .ditto/work-items/wi_v02doctor/handoff.md
- .ditto/work-items/wi_v02doctor/work-item.json
- .ditto/work-items/wi_v02handoff/completion.json
- .ditto/work-items/wi_v02handoff/context-packet.md
- .ditto/work-items/wi_v02handoff/dod.md
- .ditto/work-items/wi_v02handoff/handoff.md
- .ditto/work-items/wi_v02handoff/language-ledger.json
- .ditto/work-items/wi_v02handoff/plan.md
- .ditto/work-items/wi_v02handoff/progress.md
- .ditto/work-items/wi_v02handoff/rollback.md
- .ditto/work-items/wi_v02handoff/work-item.json
- schemas/work-item.schema.json
- src/cli/commands/work.ts
- src/core/work-item-handoff.ts
- src/core/work-item-store.ts
- src/schemas/work-item.ts
- tests/core/work-item-handoff.test.ts
- tests/core/work-item-store.test.ts

## remaining risks
- schema에 신규 optional 필드 추가가 외부 도구의 strict parser(예: zod-to-json-schema export 후 다른 lang 사용)에서 unknown field로 reject될 수 있다.
- union → replace 전환이 사용자가 수동으로 changed_files에 추가한 entry를 잃게 만들 수 있다.
- 기존 work item changed_files 정정이 git 기록 차원의 단순 mutation이라 어느 base를 선택할지가 정정 정확도를 결정한다.
