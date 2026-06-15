# Dialectic-8 — 정리(Tidy/deslop) 절차 설계 적대 검증 (mode=review, round 1/1)

- 대상: `80-acg-cleanup-deslop-plan.md` (v2) + `ADR-0017-cleanup-deslop-on-acg.md` (proposed)
- work item: wi_2606158xq
- 일자: 2026-06-15 KST
- **verdict: revise** — 개념적 reject 없음. admissible high 5건 + grounded-reject 1건. [필수] 4건 반영 시 accept 도달.

## 역할 실행
- **Producer** (codex 경로 인라인 반환, verdict_proposed=accept): "정리는 새 기계가 아닌 기존 ACG 원시구성요소 배선 — §1.1 셀이 실재 자산 지목, 동등성 사다리는 acg-semantic-compatibility.ts:75-94 실존 enforcement 위에 적정성만 올림." known_limit 5건 자인.
- **Opponent** (codex:codex-rescue 비동기 미반환 → Claude `dialectic-opponent` fallback, 13 objections).
- **Synthesizer** (verdict=revise, dispositions + 8 required_edits).

## admissible high 5건 (전부 처리됨)

| OBJ | 핵심 | oracle | disposition |
|---|---|---|---|
| **01** | ⑥ fitness 델타-only가 정리에서 **false-positive 신규 위반** — move/extract가 enclosing/path를 바꿔 옮긴 기존 부채를 새 identity로 잡아 차단. 설계가 코드를 oracle로 인용하며 정반대 결론 | `fitness-runner.ts:56-59,119` + `tests/acg/fitness-runner.test.ts:93-97` | **fixed** (§6 ⑥ 정정 + PM-13 + WU-2 move-debt 테스트) |
| **02** | L1(필수)·L2(default-on)가 **부재 toolchain**(coverage/property/fuzz 0건) 의존 — Q3은 미해결 *전제* | package.json grep 0건 | **deferred** (Q3 선결조건 승격 + fail-open 명시) |
| **03** | 사다리가 seam-hard 코드에서 **L1으로 붕괴** — 정리가 깨기 쉬운 코드에서 L2 강등 역상관, L1은 출력 보존 미증명 | §4.3·PM-9 | **open_question** (역상관 명시 + 측정 게이트) |
| **05** | 자동 tidy 커밋 **standing authorization은 자기부여 가정** — 전역 "커밋은 요청 시만"·§4-8 충돌, D8이 미확정 권한을 결정으로 박음 | 전역 CLAUDE.md, §4-8, ADR-0017 D8 | **open_question** (D8 diff-only 강등 → blocked 회피) |
| **08** | ⓪ 분류기 ENTER 신호가 **측정가능 결정론 사실 미정의** — slop 검출=CodeQL인데 분류기가 그 전 단계 → 순환, 또는 LLM 판정인데 ADR-0006 D2 위반 | §3 ⓪, ADR-0006 D2 | **open_question** (cheap heuristic만 트리거, slop 검출 ③로 분리) |

## grounded-reject
- **OBJ-10** (ast-grep 비도입이 검출 표현력 과소평가?): **rejected.** ADR-0006 D2/D3 정합, WU-X 철회조건이 'CodeQL 표현력 열위 실측 시 재고'를 이미 둠. 표현력 부족은 .ql 미실측 상태의 선반증, ADR-0006 §검증이 JS 14/14·25/25 동등 정밀도 실측으로 닫음.

## 채택한 대안
- working-tree diff(자동커밋 대신) → D8 기본값 [OBJ-05]
- 검출은 ENTER 게이트 안 함 → ⓪ 신호 분리에 부분 채택(동등성은 게이트 유지) [OBJ-08]
- 무신규 기계(refactorer 1회) → WU-1 dogfood 비교 기준으로 적재(채택 아닌 측정 기준)

## 유지된 열린질문
- **Q1**(tidy commit 비가역성) — 사용자 가치판단. D8 강등으로 design-lock 비차단, 자동커밋 활성화는 Q1 답 후.
- L2 강등 비율·seam-hard 회귀 누출 — dogfood 측정으로만 닫힘.
- Q3 toolchain provider — WU-1/2 선결조건.

## accept 도달 조건
[필수] 4건(OBJ-01/02/05/08) + OBJ-03 한계 적재가 80-plan/ADR-0017에 반영되면 admissible high 5건 전부 닫힘. **WU-0(ADR-0017) 착수는 정정된 D5/D8 상태로만 권고** — 현재 본문 그대로면 OBJ-01/05 결함을 박제.

> 정정은 본 ledger 직후 80-plan v3 + ADR-0017에 적용함(아래 커밋/diff 참조).
