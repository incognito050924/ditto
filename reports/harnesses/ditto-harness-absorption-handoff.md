---
schema_version: "0.1.0"
work_item_id: wi_harnessgap
# autopilot_id 없음 — .ditto/work-items로 추적되지 않은 문서/구현 스레드.
from_context: "Claude main 세션, 2026-06-01. 하네스 흡수 갭 분석 → G7/G9 확정 → skill↔core 중복 전수 대조 → '진짜 v0 갭'(G1·G3·G4·G5·G6·G7·G8) TDD 구현·커밋·푸시 완료 → 사용자가 다음으로 G9 선택 → G9(루프 step CLI 결선) plan 승인·TDD 구현·갭별 커밋 완료. 다음은 푸시."
to_owner: 다음 세션/에이전트
artifact_available: true   # 산출물 전부 작업 트리에 존재(코드+테스트+reports/harnesses/*)
created_at: "2026-06-01T12:00:00+09:00"
---

# Handoff — 하네스 흡수: v0 갭 구현 (wi_harnessgap)

## original_intent
원 요청: 현행화된 reports/harnesses 조사 보고서에서 DITTO 적용 항목을 통합한 정확한 채택 문서 작성. 이후 사용자 지시로 확장(축소 아님): get-shit-done 편입 → `[VERIFY]` 토큰 검증 → 흡수 계획 → 갭 분석 → 이동 하네스 재확인 → **G7 확정 → skill↔core 중복 대조 → "진짜 v0 갭만" 구현**.
보존할 의도: 산출물은 정확한 채택 문서 + 그 문서가 지목한 진짜 갭의 최소 구현. 사용자가 "진짜 v0 갭만(작고 안전)" 범위 선택 — DONE 재구현·post-v0·G2·G9는 제외.

## current_state
**v0 갭 7개(G1~G8) + G9(루프 step CLI 결선) 구현 완료, 전부 origin/main 푸시됨.** 권위 문서 `ditto-harness-absorption-gap.md`에 §7(중복 대조)·§8(G1~G8)·§9(G9) 기록.
G1~G8(508→532 pass): G4(`41cafc9`)·G1(`7e40c64`)·G7(`1bcd4c0`)·G5(`2671ba4`)·G3(`539b18a`)·G8(`94ed875`)·G6(`89f9c42`) — 푸시 완료(origin HEAD `88b2f4c` 시점).
**G9(532→550 pass / 0 fail, biome clean), 갭별 커밋 4개:** retry 이벤트(`c509295`, 구조적) · 코어 `nextNode`/`recordResult`+payload(`8e1609d`, 동작적) · CLI next-node/record-result(`44b9685`, 동작적) · SKILL 축소+contract §3.2(`dc02635`, 구조적). **이 4개는 로컬만 — 미푸시.**

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
- `bun test` → 550 pass / 0 fail (2026-06-01, fresh). 532(G1~G8) + 18 신규(G9: loop 13 + CLI 4 + transition 1).
- `bun run lint`(biome, src+tests+scripts 163파일) → 0 error.
- G9 E2E: 임시 repo에서 `ditto autopilot next-node`→spawn planner/N1+packet, `record-result`(ack-only `done` claimed pass)→G7 override(fail/retry/pending), decisions.jsonl에 `fixable retry attempts.fix=1` 기록 확인.
- 갭별 커밋 sha는 §current_state·gap §8/§9 표 참조.

## failed_or_unverified
- tsc --noEmit는 사전 존재 에러 다수(completion-store·opponent-router·m1/m2·run-with — **내 수정 파일 아님**). 프로젝트 게이트는 biome+bun test이며 둘 다 green. 내 신규 파일(autopilot-loop.ts 등)은 type-clean.
- **(정정)** 앞서 "루프 자동 지속 미배선"이라 적었으나 과장이었다. 루프는 이미 end-to-end 결선됨: ① Stop hook(`stop.ts` `autopilotForcesContinuation`)이 runnable 노드가 있고 승인 pending 아니면 stop 차단=지속력, ② SKILL.md가 next-node/record-result 호출 지시, ③ G9 step CLI. contract §3.4상 "완전 무인 CLI 루프"는 의도적 비도입(spawn은 main agent만). 통합 테스트(`tests/integration/autopilot-loop-drive.test.ts`, `5553514`)가 N1→N2→N3 done 구동 + Stop hook 정렬을 증명 → **v0 closure**.

## open_threads
- G1 closure_mode 저장이 (reason,gate)에서 파생 가능한 약한 redundancy — producer가 항상 derive로 세팅해 drift 억제하나 consistency 게이트는 없음(3-값이라 과설계 회피 판단).
- **(G9로 해소)** skill↔core 산문 중복(autopilot)·루프 step 미배선·G7 실효성 — 셋 다 닫힘. 남은 건 *자동 지속*뿐(위 failed_or_unverified).
- `ditto-harness-absorption-plan.md` 본문은 여전히 결함(배너만, superseded 미표기).
- `reports/harnesses/codeql-research-ko.md` — `88b2f4c`로 커밋됨(더는 untracked 아님).

## next_first_check
G9 + 루프 E2E 통합 검증까지 푸시 완료 → **wi_harnessgap 스레드 closed(v0 루프 결선·검증 끝)**. 다음 후보(전부 이 스레드 밖, 사용자 결정): ① **post-v0 마일스톤**(E2E user journey·PreToolUse safety·provider parity — 새 챕터, `e2e-journey-contract.md` 존재) ② G10(dialectic opponent-routing 부분 중복, 낮음·LLM 입력 의존이라 부분만 코드화) ③ G2(GradeGate 필요성 선행 분석). 새 작업은 정식 .ditto work item으로 열 것.

## forbidden_scope_creep
- G2·G10·post-v0를 다음 범위에 임의로 끌어와 착수 금지(어느 것을 열지는 사용자 결정). **G9는 마감됨.**
- 이미 DONE인 M0~M4 재구현 금지.
- tsc 사전 에러(내 파일 아님) 정리 금지 — 무관 리팩터.
- 구현된 8개 갭(G1~G9)에 범위 밖 기능 추가 금지. 특히 루프 *자동 지속* 배선은 별도 work item으로 열 것(이번 G9는 step CLI까지만).
