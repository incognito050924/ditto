# Handoff: wi_2605313sr

## 최종 verdict
pass

## acceptance
- ac-1 [pass]
- ac-2 [pass]
- ac-3 [pass]
- ac-4 [pass]
- ac-5 [pass]

## 무엇이 끝났나
v0.4 EvidenceRecord sidecar + evidence-index.json ledger (freshness·portability) — 모든 acceptance criterion이 pass로 기록되었다.

## 변경 파일
- .ditto/work-items/wi_2605313sr/completion.json
- .ditto/work-items/wi_2605313sr/handoff.md
- .ditto/work-items/wi_2605313sr/language-ledger.json
- .ditto/work-items/wi_2605313sr/plan.md
- .ditto/work-items/wi_2605313sr/work-item.json
- reports/design/ditto-v0-conformance-matrix.md
- reports/design/ditto-v0-implementation-plan.md
- schemas/completion-contract.schema.json
- schemas/evidence-index.schema.json
- schemas/evidence-record.schema.json
- scripts/export-schemas.ts
- src/core/evidence-store.ts
- src/schemas/completion-contract.ts
- src/schemas/evidence-record.ts
- src/schemas/index.ts
- tests/conformance/m3.conformance.test.ts
- tests/core/evidence-store.test.ts
- tests/schemas/sidecar-registration.test.ts

## remaining risks
- acceptanceVerdict에 evidence_records 추가 시 default [] 이므로 기존 completion fixture/artifact는 마이그레이션 불필요(absent→[]). buildCompletion(completion-store/work-item-handoff)도 미설정→default []. backward compat 유지.
- evidence(bare evidenceRef[])와 evidence_records(freshness 래핑) 두 배열 공존 → 표면상 중복. 그러나 설계서 §6.7 line 698 + [DECIDED]가 backward compat 위해 명시적으로 요구. evidence=legacy bare ref, evidence_records=freshness/portability 래핑으로 역할 분리, evidenceRef 폐기 안 함.
- evidence-index.json은 커밋 대상(.gitignore는 evidence/ 하위만 무시). raw artifact는 계속 gitignore. ledger가 raw 없이 판정 가능한 메타(summary/sha256/exit_code/key_lines)를 담음.
