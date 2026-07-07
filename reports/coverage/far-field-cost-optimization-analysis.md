# far-field pre-mortem 비용 최적화 — 조사·비교 (v3)

> **성격**: 점-시점 조사 문서(코드 변경 없음). 권위는 코드(`coverage-loop.ts`·SKILL.md §2b)와 실측 산출물(`relevance-provenance.json`·`wi_260706n4w-fabrication-baseline.md`). 수치 **[실측]/[추정]** 표시.
> **작성**: 2026-07-07, **v3 갱신 2026-07-08**. v1의 "disposition=비용 레버" 전제가 틀렸음(§3, 사용자 2회 교정). v3: §6 "느림의 정체"가 far-field 비용이 아니라 **autopilot 멈춤**으로 판명 → 수정 landed 반영.

## 1. 지금 비용이 어디서 나오나 (현 비용 모델) — [유효]

far-field sweep 총비용 ≈ **관련 카테고리 수 × 카테고리당 sweep 비용 × dry까지 라운드 수** + 관련성 게이트 상수.

| 구성요소 | spawn | intensity 영향 | 근거 |
|---|---|---|---|
| 관련성 게이트(seed 1회) | relevance-judge ×1 + batch opponent ×1 | 없음 | SKILL.md §2b.0 |
| **카테고리당 sweep 1라운드** | **sweepAngles(1/3/5) + 3역할 dialectic(P/O/S) + per-axis judges** | **sweepAngles·K만 scaling. dialectic·judge는 고정** | SKILL.md §2b.2 |
| dry 라운드 | completeness-critic ×1 | — | §2b.2 |

**[실측] 이 WI**: 23 seed → 6 skip(26%) → 17 관련 sweep. judge 1개 ≈ 48.5k 토큰 [실측 §8-5]. **[추정] standard 1라운드 ≈ 17 × ~8 spawn ≈ 6.6M 토큰.** 3역할 dialectic + judge는 **모든 관련 카테고리에 intensity 무관 고정**으로 돈다 — 고정비의 핵심.

## 2. 이미 있는 절감 장치 — [유효]

- **관련성 게이트**: 무관 카테고리를 이유와 함께 skip(이 WI 26%). batch refute로 21× 절감 [실측].
- **intensity 다이얼**: `sweepAngles`·K를 stakes로 축소(1/3/5).

이 둘은 "관련성"·"각도 수" 축을 이미 최적화. dialectic·judge 고정비는 안 건드림.

## 3. v1 오분석 정정 — disposition은 비용 레버가 아니다

v1은 "code-verify 카테고리를 grep으로 옮겨 LLM fan-out을 제거"라 했다. **틀렸다:**

- **code-verify = "위험이 코드로 *검증* 가능"** (문장화되면 confirm/refute) **≠ "grep이 위험을 *연상·발견* 가능"**. oracle(grep)은 이미 만들어진 claim의 **검증 뒷단**이지 위험 **생성기**가 아니다. 비싼 부분은 blind angle + dialectic의 **상상적 생성**이고, **grep으로 연상 안 되는 위험이라 이 카테고리들이 LLM sweep을 필요로 한다.** → **disposition = 신뢰성·라우팅 레버지 비용 레버가 아니다. Option A 철회.**
- **runtime → "런타임 연기"도 틀렸다.** pre-mortem은 정의상 **사전** 검증(초기 교정 << 사후 재작업). 런타임에만 최종 확인 가능한 위험도 plan 단계에서 **표면화는 해야** 사전 교정이 된다. runtime disposition ≠ "plan 단계 skip". **Option D(연기) 철회.**

## 4. 두 전제(상상적 생성 + 사전 시점)를 지키는 실제 레버

LLM 생성도 사전 시점도 지키면서 줄이는 것만 남긴다. 전부 **상수배(2~3×)**지 order-of-magnitude 아님 — 관련성 게이트가 큰 축을 이미 먹음.

| # | 접근 | [추정] 절감 | rigor tradeoff |
|---|---|---|---|
| **L1** | **역할별 모델 티어**: blind 생성=싼·빠른 모델, 적대 Opponent+judge=강 모델 | 토큰 ~2-3× (구조·시점 불변) | **낮음** — Opponent refute-by-default 바닥 보존 |
| **L2** | **단계적 escalation**: 싼 1-pass 탐지 → 후보 난 카테고리만 full dialectic+judge | spawn ~2-4× | **중** — 싼 탐지 놓침=coverage 하락, ADR-0023 false-green 위험. recall이 관건 |
| **L3** | **관련 저-stakes 카테고리 생성 배칭** | 토큰 ~2-3× | **중~높음** — §4.1 격리 일부 포기(교차 편향) |

## 5. 권고 (정직하게 축소됨)

1. **가장 안전한 win = L1(모델 티어).** rigor 바닥(적대 Opponent) 불변, 토큰만 ~2-3×. 구조·시점 불변이라 신뢰성 회귀 최소. **먼저 실증할 값어치.**
2. **L2는 더 크지만 신뢰성과 맞바꾼다.** 부모 WI가 방금 신뢰성에 투자 — 싼 탐지가 위험을 놓치면 그 투자를 깎음. recall 측정 없이 도입 불가.
3. **관련성 게이트가 원칙적 비용통제의 본체**이고 landed. 그 위 추가 절감은 전부 rigor와의 거래.

## 6. [해결됨] "느림"의 정체는 far-field 비용이 아니라 autopilot 멈춤이었다

v1이 물었던 "어느 느림이냐"의 답(2026-07-08 사용자): **far-field sweep 비용이 아니라 autopilot이 루틴 게이트마다 멈추던 interaction friction**이었다. 근거는 이 분석을 낳은 세션 자체 — autopilot 12노드를 도는 동안 Stop hook이 노드마다 "keep going — 1 item remain"을 뱉어 매번 사람이 `next-node`를 다시 눌러야 했다. 그 stop/resume 반복이 "느림"의 실체.

**수정 landed (커밋 `264da67`, wi_260707loq 무중단 자율성 계약, origin/main):** Stop-hook의 옛 "pending이면 무조건 yield(정지)"를 **P0-P6 순서 분류기**로 교체 — 루틴 pending(승인대기·진행확인)은 **force-continue**하고, 진짜 결정 4종만 yield(P1 direction-fork·P2 ADR-0020 intent 충돌·P3 high-risk·P4 oracle-gap). producePlanGate auto-waive가 present_plan 루틴 정지 제거. → **autopilot이 이제 스스로 완주.**

**far-field 비용과의 관계**: 이 수정은 **interaction friction**을 고쳤을 뿐 far-field **compute 비용**(§1~§5)은 안 건드린다(264da67의 coverage-manager 변경은 approval-gate fallback뿐, sweep 구조 무변경 — §1~§5 그대로 유효). → **실제 felt 통증은 해결됐고, far-field compute 최적화(L1)는 별개의·이제 더 낮은 우선순위 사안.**

## 7. 미검증 / 다음 단계

- [추정] 수치는 handoff(170 spawn)·§8-5(48.5k/judge) 도출 — 정밀값은 실 sweep 계측(wi_26062227h cost tally seam).
- L1: 역할별 모델 티어의 실제 토큰·품질(싼 생성이 Opponent 통과 recall을 얼마나 떨어뜨리나) 실측 필요.
- L2: 싼 탐지 recall = escalation 안전성의 핵심 미검증.
- **264da67 무중단 수정의 실효**: 다음 autopilot 실행에서 루틴 정지 없이 완주하는지 라이브 관찰은 미검증(커밋은 suite 4160/0·7 AC pass 주장).
