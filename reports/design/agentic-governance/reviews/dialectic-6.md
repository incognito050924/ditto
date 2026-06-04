# Dialectic Review 6 — ACG 설계 문서 정합성 (통합 커밋 62f09f3)

- **review_id**: rv_acg6cohere · **mode**: review · **max_rounds**: 1
- **대상**: 00·10·20·30·40·50·60·70 (reports/design/agentic-governance/)
- **질문**: 통합 후 8문서가 문서 간 정합성(용어·교차참조·스키마 일치·개념 연관성)을 유지하는가?
- **baseline**: 66d0160 (통합 전) → 62f09f3 (60 신규심화 / 70 신규 / 00·10·20·30·40 갱신)
- **역할**: Producer=Claude(current-host) · Opponent=**Codex**(codex-plugin-cc, codex:codex-rescue, fallback 없음) · Synthesizer=Claude-opus

## 평결: `revise`

거시 정합(권위 계층 20=schema SoT, 60/70 self-demote)은 유지. 그러나 **행동을 요구하는 정합성 결함 5건**(critical 1 + major 4) + minor 2건이 남아 `accept` 불가. 전부 문서 편집으로 reconcile 가능하고 외부/사용자 blocker 없음 → `revise`.

## 채택된 반론 (admissible: oracle ∧ novel ∧ critical/major)

| # | sev | 결함 | oracle | 최소 수정 |
|---|---|---|---|---|
| 1 | **critical** | 60이 `FitnessFunction(kind=type-safety)` 인용 — 20 §6 enum·30 DSL에 없음 | 20:578, 30:81, 60:197·289 | 기존 kind(consistency/dependency)+metric으로 재표현, type-safety는 라벨 강등 (enum 확장 지양) |
| 2 | major | 60:34가 Evidence Quality 3등급을 "이미 ACG에 있는" 스펙 필드처럼 과장 — 20엔 등급 필드 없음 | 20:518, 60:34 | "등급은 아직 별도 필드 아님 — §3.1·Q1 후보"로 약화 |
| 3 | major | `EvidenceContract` 이름 충돌: 60 폐기 vs 00:197·50:36 재사용 산출물 | 60:202, 00:197, 50:36 | 50:36 출처를 ChangeContract.acceptance+ReviewGraph.evidence로 교체 |
| 4 | major | 60이 leftover_debug/pre-Apply characterization을 done 술어로 단정 — 10:132는 배선 v0 미가동 | 10:132, 60:151·222 | 60에 "배선 v0 미가동 — 흡수 후보" caveat 1줄 |
| 5 | major | 70 §8 흡수계획이 G-F1/G-F2/G-F5만 — G-F3(Immutability)·G-F4(Declarative Bias) 누락 | 70:407 vs 70:300·311 | §8에 G-F3·G-F4 추가 또는 포섭처 명시 |
| 6 | minor | 60:151 'ACG §4-4'는 Charter §4-4 오참조 (00 §4=다섯그래프) | 60:151, 00:139 | 'Charter §4-4'로 정정 (obj-4와 같은 줄) |

## 기각된 반론 (raise만큼의 근거 첨부)

- **70 미인덱스 (minor)**: 사실이나 severity minor라 비강제. 70:412-415가 스스로 "실행 증거 없는 패턴 후보, 00~50 미수정"으로 명시해 권위 혼선 없음. optional edit으로만 둠. (근거: 00:9,16 / 70:7,412-415)

## 합의: 무엇을 고치면 정합해지는가

7개 deterministic 편집(§dialectic-6.json `required_edits`). 핵심은 **60의 한 줄 스키마 오인용(type-safety)** + **50의 EvidenceContract 출처 교체** + **60의 not-yet-wired caveat** + **70 §8 게이트 2개 보강**. 전부 reword/표 보강이며 스펙 확장 아님(minimum-viable).

## 남은 열린 질문

1. Evidence Quality 등급 최종 슬롯(acceptance vs evidence sidecar) — 60 Q1로 열림.
2. risk_reason 어휘·Evidence 등급·70 토큰은 vocabulary 단계 — enum 승격 시 20·30·60·70 동기화 부채(boxwood 2차 바인딩 후).
3. 개별 게이트 설계 타당성은 이번 정합성 심사 범위 밖(인용 정확성만 판정).

## 비고

- Dialectic `revise`는 "작성/정합이 보강 필요"라는 뜻이지 코드 동작 판정이 아니다(작성 품질 검증).
- 결함 다수(1·2·4·6)는 이번 60 재작성/통합에서 유입된 균열이다.
