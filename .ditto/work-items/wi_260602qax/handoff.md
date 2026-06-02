# Handoff: wi_260602qax

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
ditto 자기평가 보고서가 코드로 확정한 회귀·미배선 5건을 외과적으로 수정했다. (1) completionEvidenceGate를 Stop 완료 게이트에 배선 — 증거 없는 final_verdict=pass(빈 verifications + note-only evidence)를 exit 2로 차단해 '승인≠검증' 약속을 코드로 되살림. (2) handoff가 기존 completion.json의 verifications·remaining_risks·summary를 보존(무조건 clobber 차단). (3) classifyPromptAdvisory가 한국어 의문 프롬프트를 question으로 인식. (4) PreToolUse secret 차단을 default-deny로 재설계 — secret 파일 operand·stdin< 리다이렉션을 기본 차단하고 메타데이터 동사·검색패턴·템플릿 접미사만 좁게 예외(첫 expose-verb allowlist 시도는 적대검증에서 ~30개 유출 경로가 드러나 폐기). (5) gates VAGUE_TERMS를 단어경계 매칭으로. autopilot 루프(N1 design→승인→N2 implement→N3 verify[ac-4 FAIL]→N4 fix[default-deny]→N3 재검증)로 구동, 독립 적대검증으로 6/6 acceptance pass.

## 변경 파일
- .ditto/work-items/wi_260602qax/autopilot-decisions.jsonl
- .ditto/work-items/wi_260602qax/autopilot.json
- .ditto/work-items/wi_260602qax/completion.json
- .ditto/work-items/wi_260602qax/handoff.md
- .ditto/work-items/wi_260602qax/intent.json
- .ditto/work-items/wi_260602qax/language-ledger.json
- .ditto/work-items/wi_260602qax/work-item.json
- reports/ditto-vs-claude-code-evaluation-2026-06-02.md
- src/core/gates.ts
- src/core/work-item-handoff.ts
- src/hooks/pre-tool-use.ts
- src/hooks/stop.ts
- src/hooks/user-prompt-submit.ts
- tests/conformance/m1.conformance.test.ts
- tests/core/gates.test.ts
- tests/core/work-item-handoff.test.ts
- tests/hooks/pre-tool-use.test.ts
- tests/hooks/stop.test.ts
- tests/hooks/user-prompt-submit.test.ts

## remaining risks
- ac-4 default-deny는 단순형(single-segment) 유출을 모두 막지만, 복잡한 난독화(예: 변수 치환으로 secret 경로 조립, base64 인코딩된 경로, eval) 등은 isSecretPath 토큰 매칭을 우회할 수 있음 — 보수적 고확신 셋이라 의도된 false-negative 우선(엔트로피 스캐너는 follow-up).
- ac-2 summary 보존은 prior와 final_verdict가 같을 때만 — verdict가 바뀌는 re-handoff에서는 stale 방지 위해 fresh summary 사용(설계 선택). handoff CLI의 두 buildCompletion 통일(완전 리팩터)은 안 함(외과적 변경 우선, completion-store.ts는 dead path).
- ac-3 한국어 분류는 보수적 패턴 셋 — 드문 의문 종결어미나 혼합문은 놓칠 수 있음(execution-override 우선이라 directive 오발은 방지).
- 이번 세션의 PreToolUse 훅이 정상 read-only 명령(bun test/lint, .env 토큰 포함 테스트 명령)을 차단해 검증 시 DITTO_SKIP_HOOKS=1 prefix 필요(false-positive). ac-4 수정으로 일부 완화됐으나 훅 자체 활성 마찰은 잔존.

---

## 다른 PC에서 이어서 (cross-PC 재개 안내)

**현재 상태**: 이 work item(wi_260602qax)은 DONE·푸시 완료. `origin/main` HEAD = `46fd95c`(이 핸드오프 커밋 포함하면 그 다음). 다른 PC에서 `git pull origin main`만 하면 코드·테스트·평가 보고서·이 핸드오프가 전부 따라온다.

> **주의**: 세션 메모리(`~/.claude/.../memory/`)는 git으로 전달되지 않는다. 이어받을 컨텍스트는 이 핸드오프 + 커밋된 평가 보고서(`reports/ditto-vs-claude-code-evaluation-2026-06-02.md`)에 모두 담겨 있다.

**재개 절차(다른 PC)**:
1. `git pull origin main` → `bun install` → `bun test`로 green(702 pass) 확인.
2. 이어서 할 일은 평가 보고서 §5(우선순위 수정 제안)의 **미착수 follow-up**. 이번 work item은 확정 회귀 #1~#5만 닫았다.

**미착수 follow-up 백로그**(평가 보고서 §4~§5 기준, 우선순위순):
- **#6 continuation signal** — `buildContinuationSignal`/`nextReadyNodeId`/`ContinuationSignal`(src/core/autopilot-driver.ts:74-95)이 호출처 0인 죽은 코드. G3 헤드라인 'cap 초과→자동 handoff'를 **배선**할지 **삭제**할지 설계 판단 필요.
- **#7 빈 autopilot.json 종료 정책** — stop.ts:179의 pending-approval exit 0이 verify 없이 종료를 허용. pending=사용자 승인 대기는 의도된 동작일 여지가 커 정책 결정 후 수정.
- **#8 dialectic verbatim-echo** — `dialecticForcesContinuation`(stop.ts:38-42)이 opponent.claim을 verbatim 비교 → synthesizer가 paraphrase하면 false-continuation. objection에 안정 id 부여.
- **#9 얇은 죽은 skill 정리** — plan skill(bootstrapAutopilot이 실제 그래프 생성), dialectic-review skill(--mode review 10줄 alias). surface 제거 = product 결정이라 별도 work item.
- **#10 owner 본문 미완** — implementer/planner/researcher agent가 'v0 skeleton' 마커 상태. reviewer/verifier 수준으로 본문 작성(대규모).
- **#11 self-declared boolean 검증가능화** — RiskAxes.non_local, reviewerOutput.different_provider_than_generator, languageChange.agreed_with_user, decisionLedger.admissible가 schema 검증 불가.

**진입 방법**: 다른 PC 새 세션에서 "평가 보고서 §5 follow-up #6부터 진행" 또는 특정 번호 지정. 각 항목은 평가 보고서에 file:line 근거가 있다.
