---
schema_version: "0.1.0"
work_item_id: wi_harnessgap
# autopilot_id 없음 — 이 작업은 autopilot 그래프로 구동되지 않았다(문서 분석 스레드).
from_context: "Claude main 세션, 2026-06-01. reports/harnesses/* 메타 분석 스레드(현행화 통합 → [VERIFY] 검증 → 흡수 계획 → 갭 분석). .ditto/work-items 로 추적되지 않았음."
to_owner: read-only 분석 프로파일(다음 세션/에이전트)
artifact_available: true   # 모든 산출물은 작업 트리에 존재(reports/harnesses/*)
created_at: "2026-06-01T08:30:00+09:00"
---

# Handoff — 하네스 흡수 분석 (wi_harnessgap)

## original_intent
원 요청: **현행화된 reports/harnesses 조사 보고서들에서 DITTO 적용 항목을 추출·통합한 보고서 작성.** 이후 사용자 지시로 확장됨(축소 아님): get-shit-done(신규 활성 저장소) 편입 → 보고서들의 `[VERIFY]` 토큰을 실제 upstream으로 검증 → 흡수(이식) 계획 문서 작성 → 그 계획을 실제 코드와 갭 분석 → 갭 분석이 각 참고 하네스의 최신 상태 기준인지 검증.
보존할 의도: 이건 "하네스 패턴을 DITTO에 어떻게 흡수할지"의 메타 분석이고, **산출물은 정확한 채택 문서이지 구현이 아니다**(사용자가 "구현 보류" 선택).

## current_state
4개 문서 산출 완료:
- `ditto-harness-synthesis.md` — 15개 하네스 적용 항목 통합(WHAT).
- `ditto-harness-absorption-plan.md` — 흡수 방법/순서(HOW). **상단에 ⚠️ 전제 정정 배너** 있음(본문은 미정정 — open thread).
- `ditto-harness-absorption-gap.md` — **권위 문서.** 흡수 계획 WI vs 실제 구현(M0~M4) 갭 분석.
- 보고서 14종의 `[VERIFY]` 토큰 전부 해소(검증 완료 표기로 전환).

갭 분석 핵심 결론: **흡수 계획의 다수가 이미 구현·테스트됨**(M0~M4, 508 테스트 green). 진짜 갭만 추림 — §2.1 v0 정제 6건(G1 closure_mode·G2 GradeGate A/B/C[필요성 판단 후]·G3 transition table+rollback·G4 reviewer 본문·G5 file-overlap gate·G6 생성형 inventory), §2.2 post-v0(E2E·PreToolUse safety·parity, 이미 의도 연기), §5 신규 후보 2건(G7·G8). **구현은 사용자 지시로 보류 중.**

## decisions_made
- 흡수 단위는 "하네스"가 아니라 "DITTO 계약"(통합 보고서 §2 개념축).
- native-first 필터: Claude Code가 주는 primitive(agent 호출·hook·permission·sandbox·skill/MCP)는 재구현 않고 바인딩만. "자동차는 안 만든다"는 이 의미이며, 하네스 채택 규율(통째 복제 금지)과는 별개(메모리 ditto-mental-model에 가드 반영).
- get-shit-done은 아카이브 → `open-gsd/gsd-core @ 9b5ee373`(branch next)로 전환, 제외 해제.
- `[VERIFY]` 토큰은 upstream 지정 커밋/공식 문서로 직접 대조 후 해소(grep으로 활성 토큰 0건 확인).
- "구현 전부"는 M0~M4 재구현이 되므로 거부 → 갭 분석으로 전환(사용자 승인).
- 갭 분석은 DITTO 코드 기준이며 로컬=origin/main 최신(HEAD aff0abb, 2026-06-01) 확인.

## changed_files
- M: reports/harnesses/{03,04,andrej-karpathy-skills,deepagents,get-shit-done,hannes,mattpocock-skills,oh-my-claudecode,oh-my-codex,oh-my-openagent,oh-my-opencode-slim,ouroboros,superpowers}.md, blogs/{01,02}.md  — [VERIFY] 해소 + 검증 반영
- A: reports/harnesses/{ditto-harness-synthesis,ditto-harness-absorption-plan,ditto-harness-absorption-gap,ditto-harness-absorption-handoff}.md
- 메모리: ~/.claude/.../memory/ditto-mental-model.md(native-first 가드), harness-verify-marker-convention.md(기존)
- 코드 변경 없음. `bun.lockb`만 M(이 작업과 무관).

## evidence_refs
- command `bun test` → 508 pass / 0 fail (2026-06-01, 갭 분석 시점 fresh).
- command `git rev-list --count origin/main..main` 및 역방향 → ahead 0 / behind 0 (로컬=origin 최신).
- 하네스 커밋 대조: ouroboros 32fcaf10·oh-my-codex ff17267b·oh-my-claudecode ed7800dd·deepagents 1906af98·superpowers 6fd4507 = 현재 HEAD와 동일. oh-my-openagent 7afa4d08f→c14f327, gsd-core(next) 9b5ee373→e3bc53f8 = 이동 → diff 완료(신규 패턴 G7·G8만).
- gates.ts:72-104(acceptanceTestable)·:144-174(convergenceGate) 등 DONE 판정의 file:line은 gap 문서 §1 표에 기록.

## failed_or_unverified
- **G7(subagent 완료신호≠완료증명)이 실제 DITTO 갭인지 미확정** — `src/core/autopilot-dispatch.ts`의 `decideOnFailure`에 "침묵/ack-only/빈 child 결과 → 비-PASS inconclusive" 분기가 있는지 직접 확인 안 함.
- **hannes 현재 HEAD 미재확인** — 보고서에 github URL 없음(비공개 boxwood). 보고서 기록상 신규 커밋 없음(46ad7c5).
- 갭 분석 에이전트가 인용한 file:line·테스트는 전수 재확인하지 않음(상태 최신성만 직접 검증).

## open_threads
- G7 확정 여부(위 next_first_check).
- 어느 갭을 실제 work item으로 열지 = 사용자 결정 대기.
- `ditto-harness-absorption-plan.md` 본문이 여전히 결함(배너만 추가) — 정정 또는 superseded 명시 필요.
- `reports/harnesses/codeql-research-ko.md`(?? untracked)는 이 세션이 만든 게 아님 — 무관, 확인 요망.
- 이 handoff의 work item이 .ditto에 정식 추적되지 않음 — dogfooding 관점에선 흠. 후속 작업을 연다면 정식 work item으로 열 것.

## next_first_check
`src/core/autopilot-dispatch.ts`의 `decideOnFailure`(및 호출부)를 읽어 **빈/ack-only/timeout child 결과를 PASS가 아닌 inconclusive로 처리하는 분기가 있는지** 확인 → G7이 진짜 갭인지 확정. 없으면 gap 문서 §5 G7을 "확정 갭"으로 승격.

## forbidden_scope_creep
- `ditto-harness-absorption-plan.md`를 그대로 실행 금지 — 다수 WI가 이미 DONE(M0~M4), 재구현이 됨.
- 이미 DONE인 항목(W1-1·W1-4·W2-1·W2-2·W3-2·W3-4·W4-1packet·W4-2drift·W4-3fail-open) 재구현 금지.
- post-v0(E2E·PreToolUse safety·runtime parity)를 v0 갭처럼 끌어와 착수 금지 — 별개 마일스톤.
- 갭 범위를 넘어 새 기능 추가 금지(사용자 승인 없이). 구현 자체가 현재 "보류" 상태.
