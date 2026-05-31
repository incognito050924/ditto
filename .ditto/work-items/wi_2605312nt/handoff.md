# Handoff: wi_2605312nt

## 최종 verdict
pass

## acceptance
- ac-1 [pass]
- ac-2 [pass]
- ac-3 [pass]
- ac-4 [pass]
- ac-5 [pass]

## 무엇이 끝났나
v0.4 KnowledgeContract design-lock — schema + 설계문서 (M6 runtime 보존) — 모든 acceptance criterion이 pass로 기록되었다.

## 변경 파일
- .ditto/work-items/wi_2605312nt/completion.json
- .ditto/work-items/wi_2605312nt/handoff.md
- .ditto/work-items/wi_2605312nt/language-ledger.json
- .ditto/work-items/wi_2605312nt/plan.md
- .ditto/work-items/wi_2605312nt/work-item.json
- reports/design/contracts/knowledge-contract.md
- reports/design/ditto-v0-conformance-matrix.md
- schemas/knowledge-record.schema.json
- scripts/export-schemas.ts
- src/schemas/index.ts
- src/schemas/knowledge-record.ts
- tests/schemas/knowledge-record.test.ts
- tests/schemas/sidecar-registration.test.ts

## remaining risks
- 메모리 ⑤ 노트는 'agents/knowledge-curator.md 본문 + /ditto:knowledge-update skill driver'를 제안했으나, 설계서 §0/line 830은 knowledge를 post-v0(M6)로 배치하고 M1.5b conformance가 knowledge-curator agent의 v0 부재를 단언. 헌장 §2 우선순위(도메인/저장소 규칙 > 메모리) + 사용자 '상세 설계까지' 범위 → agent runtime 미생성, schema+설계문서로 design-lock. v0 invariant 보존.
- knowledgeRecord는 기존 glossary schema를 재정의하지 않고 glossary_path로 참조(얕은 추상화·중복 금지, 헌장 §4-3). CLAUDE.md projection은 설계문서에 박되 runtime은 M6(bridge-sync 확장)으로 보존.
