# Dialectic-10 — ADR-0018 / ADR-0019 착수 전 압박검증 (review, round 1/1)

- review_id: rv_12561930e8 · 2026-06-15 · mode=review
- 대상: ADR-0018(L2 effect-interception), ADR-0019(CodeQL standing-code fitness gate)
- 질문: 두 ADR로 본격 구현 착수 가능한가? ① 목표(`ditto refactor --scope`가 standing 코드 §4.4 full-bar 자동커밋 도달)에 건전한가?
- Opponent: Codex (codex:codex-rescue, adversarial-review)
- **verdict: revise** — required_edits 1·2·3 반영 시 handoff §5 순서로 착수 가능.

## 판정 요약

설계 골격(5입력 AND 게이트 + fail-open)은 건전하고 L2 코어 9/9·L1 coverage 배선은 실재. 그러나 두 admissible critical objection이 ADR 텍스트대로면 게이트를 공허하게 통과시키거나 빌드를 불가능하게 만든다(synthesizer가 소스로 직접 확인). 싸게 고쳐지므로 reject가 아닌 revise.

## accepted objections

- **OBJ-A (critical)** CodeQL metrics 쿼리는 SARIF result를 안 냄(@kind treemap / where none()) → ADR-0019 D1 기성팩으로 구현 불가. **검증 확정**(로컬 codeql 2.25.6 js qlpack 2.3.11).
- **OBJ-B (critical)** 빈 effect trace가 unrefuted=full-bar 자격으로 false-pass(l2-differential.ts:215-220). '기대 effect 있는데 0 관측' 분류기 부재.
- **OBJ-C (high)** CodeQL fail-open이 ADR 텍스트(D4)에만, runner는 throw — refactor.ts catch/timebox 없음.
- **OBJ-D (high)** 하드코딩 baselineGreen/behaviorGreen=true가 debt 배선 순간 공허한 full-bar 오발화.
- **OBJ-F (critical)** runL2Differential 프로덕션 호출자 0건 — ac-2/ac-3 미구현(입력=coverage seeds).

## rejected (grounded)

- **OBJ-E** interception 0건 관측 — admissible severity이나 NOT NOVEL(handoff §4 lines 89-90 자인). OBJ-B 수정으로 안전화, 비gating.
- **OBJ-G** 더 단순한 L2-없는 슬라이스 — coverage-only는 behavior PASSING만 증인, PRESERVATION(old↔new)은 못 함. 사용자가 pure-only/coverage-only 명시 기각. 비용 이유 범위 축소는 헌장 금지.

## required edits (착수 전/중 반영)

1. **[OBJ-B] ADR-0018 D5 신설** — effect-bearing unit의 OLD zero-trace → unverified(diff-only), full 자격 박탈. 빈 trace=미관측≠미반증. (구현: runTrace zero-trace 분류)
2. **[OBJ-A] ADR-0019 D1 재작성** — 임계값 기반 커스텀 @kind problem 쿼리(cyclomatic>N, duplicated-block≥M행). metrics 쿼리 사용 불가 명시. 단일 CodeQL 엔진 유지.
3. **[OBJ-C] ADR-0019 D4 코드 의무화** — refactor.ts가 codeql throw를 catch+타임박스로 degraded(diff-only) 변환.
4. **[OBJ-D] 구현 순서 제약(ADR 무수정)** — 세 placeholder를 실 출처로 atomic 교체. barMet→commitTidyStructural는 셋 다 실값일 때만.

## residual risks

1. L2가 ditto named-import effect unit에서 non-empty trace를 낼지 미증명. required_edit 1이 안전화(degrade)하나 full-bar 도달 가능성은 별개 — ① dogfood는 초기엔 pure/injected-object unit에서만 실증될 수 있음.
2. CodeQL DB빌드 비용 ~최대 6분/refactor (opt-in, 비gating).
3. 새 D1 problem 쿼리 임계값(N/M) 기본값 — 방어 가능한 기본값 필요.

원본 JSON: `dialectic-10.json` (ditto.dialectic.v1 스키마 검증 통과).
