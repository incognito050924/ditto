---
schema_version: "0.1.0"
work_item_id: wi_harnessgap
# autopilot_id 없음 — .ditto/work-items로 추적되지 않은 문서/구현 스레드.
from_context: "Claude main 세션, 2026-06-01. 하네스 흡수 갭 분석 → G7/G9 확정 → skill↔core 중복 전수 대조 → 사용자 지시로 '진짜 v0 갭'(G1·G3·G4·G5·G6·G7·G8) TDD 구현 → 커밋. 다음은 푸시."
to_owner: 다음 세션/에이전트
artifact_available: true   # 산출물 전부 작업 트리에 존재(코드+테스트+reports/harnesses/*)
created_at: "2026-06-01T12:00:00+09:00"
---

# Handoff — 하네스 흡수: v0 갭 구현 (wi_harnessgap)

## original_intent
원 요청: 현행화된 reports/harnesses 조사 보고서에서 DITTO 적용 항목을 통합한 정확한 채택 문서 작성. 이후 사용자 지시로 확장(축소 아님): get-shit-done 편입 → `[VERIFY]` 토큰 검증 → 흡수 계획 → 갭 분석 → 이동 하네스 재확인 → **G7 확정 → skill↔core 중복 대조 → "진짜 v0 갭만" 구현**.
보존할 의도: 산출물은 정확한 채택 문서 + 그 문서가 지목한 진짜 갭의 최소 구현. 사용자가 "진짜 v0 갭만(작고 안전)" 범위 선택 — DONE 재구현·post-v0·G2·G9는 제외.

## current_state
**문서 4종 + v0 갭 7개 구현 완료.** 권위 문서 `ditto-harness-absorption-gap.md`에 §7(중복 대조)·§8(구현 완료 기록) 추가.
구현(전부 TDD red→green, 갭별 커밋, 508→532 pass / 0 fail, biome clean):
- G4 reviewer 본문(`41cafc9`) · G1 closure_mode(`7e40c64`) · G7 content-free 가드(`1bcd4c0`) · G5 file-overlap gate(`2671ba4`) · G3 transition table+rollback(`539b18a`) · G8 ack≠verification(`94ed875`) · G6 생성형 inventory(`89f9c42`).
문서 커밋 `93b5f86`은 이미 origin/main 푸시됨. **G1~G8 구현 커밋(7개)은 로컬만 — 아직 미푸시.**

## decisions_made
- 범위 = "진짜 v0 갭만". G2(필요성 선행)·G9(큰 구조변경)·G10(낮음)·post-v0는 의도적 제외.
- G1 closure_mode는 reason 단독이 아니라 (reason, gatePassed) 함수 — cap이라도 게이트 통과면 mutual_agreement, 미통과면 ledger_only. 단일 출처 `deriveClosureMode`.
- G7은 native Task 동기 dispatch라 wait_agent/mailbox는 N/A로 좁힘 — content-free(빈/ack-only) 결과만 결정론 차단(G9 CLI 결선 없이).
- G6 catalog = 생성 산출물. 손기입 제거. 재생성==커밋본 테스트가 drift-guard. 런타임 doctor 드리프트 검사는 유지(생성기는 손기입만 제거).
- G8은 스키마 갭(note-only pass 허용)을 게이트로 보강 — 스키마는 안 건드림(기존 fixture 호환).
- 갭별 분리 커밋(Tidy First). 전부 "동작적".

## changed_files
- 코드: `src/core/gates.ts`(deriveClosureMode·completionEvidenceGate), `src/core/autopilot-dispatch.ts`(guardChildResult), `src/core/autopilot-graph.ts`(fileOverlapGate·selectReadyNodes·nodeTransition), `src/core/autopilot-driver.ts`(rollbackOnRejection), `src/core/interview-driver.ts`·`src/core/convergence-store.ts`(closure_mode 배선), `src/core/surface-inventory.ts`(generateSurfaceCatalog), `src/schemas/{convergence,interview-state}.ts`(closure_mode), `scripts/gen-surfaces.ts`(신규), `package.json`(surfaces:gen).
- 에이전트/스킬: `agents/reviewer.md`(본문), `skills/autopilot/SKILL.md`(step3 rollback·step6 guard).
- 테스트/픽스처: `tests/core/{gates,autopilot-dispatch,autopilot-graph,autopilot-driver}.test.ts`, `tests/doctor/surface.test.ts`, `tests/fixtures/gates/{interview-state,convergence}/*.json`(closure_mode 7), `tests/fixtures/gates/completion/ack-only-pass.json`(신규), `.ditto/surfaces.json`(재생성).
- 문서: `reports/harnesses/ditto-harness-absorption-gap.md`(§7·§8), 본 handoff.

## evidence_refs
- `bun test` → 532 pass / 0 fail (2026-06-01, fresh). 508 baseline + 24 신규.
- `bun run lint`(biome, src+tests+scripts 160파일) → 0 error.
- `bun run scripts/gen-surfaces.ts` → 20 surfaces, 커밋본과 set 동일(python key diff로 확인).
- 갭별 커밋 sha는 §current_state·gap §8 표 참조.

## failed_or_unverified
- tsc --noEmit는 사전 존재 에러 다수(completion-store·opponent-router·m1/m2·run-with — **내 수정 파일 아님**). 프로젝트 게이트는 biome+bun test이며 둘 다 green. 내 파일은 type-clean.
- G7/G8 게이트의 *실효성*(런타임에서 실제 오케스트레이터가 호출하는지)은 미검증 — autopilot 루프가 런타임 미배선(G9)이라 이 헬퍼들은 단위 테스트로만 살아 있다. SKILL.md 산문엔 반영했으나 deterministic 호출 경로 없음.

## open_threads
- G1 closure_mode 저장이 (reason,gate)에서 파생 가능한 약한 redundancy — producer가 항상 derive로 세팅해 drift 억제하나 consistency 게이트는 없음(3-값이라 과설계 회피 판단).
- G9(루프 CLI 결선)가 미배선·중복·G7 실효성을 한 번에 닫는 핵심이나 큰 구조 변경 — 미착수.
- `ditto-harness-absorption-plan.md` 본문은 여전히 결함(배너만, superseded 미표기).
- `reports/harnesses/codeql-research-ko.md`(untracked) — 이 스레드 무관, 미커밋.

## next_first_check
`git push origin main`으로 G1~G8 7개 커밋 푸시(사용자가 "끝나면 푸시" 지시). 푸시 후 origin/main HEAD가 `89f9c42`인지 확인. 그다음 작업을 연다면 G9(autopilot 루프 `ditto autopilot {next-node,record-result}` CLI 결선)가 우선 후보 — 정식 .ditto work item으로 열 것.

## forbidden_scope_creep
- G2·G9·G10·post-v0를 이번 범위에 끌어와 착수 금지(사용자가 "진짜 v0 갭만" 명시).
- 이미 DONE인 M0~M4 재구현 금지.
- tsc 사전 에러(내 파일 아님) 정리 금지 — 무관 리팩터.
- 구현된 7개 갭에 범위 밖 기능 추가 금지.
