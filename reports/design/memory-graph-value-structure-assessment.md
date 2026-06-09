# DITTO Memory-Graph — 가치·구조 평가 (dialectic 2라운드 종합)

> **무엇에 대한 문서인가**: `ditto memory` 설계가 (가치) 사용자 프로젝트에 기존 ditto 자산을 넘어서는 증분 가치를 주는지, (구조) 의도한 시점에 실제로 발화하는지를 적대적으로 검증한 결과와 그로부터 나온 아키텍처 판단. **이 문서는 분석이고, 빌드 범위 결정은 아직 미정이다**(끝 §6).
> **소비자**: 이 work item을 이어받는 세션/사람. 빌드 착수 전 "정말 지을 값어치가 있나"의 판단 근거.
> **작성일**: 2026-06-10 · **work item**: wi_260609m41

## 0. 링크 (원문·근거)

- **원본 설계서**: [`memory-graph-plugin-design.md`](./memory-graph-plugin-design.md) — 무엇을·왜·어떻게(§1 빈틈, §4 메커니즘, §5 통합, §10 구현-등급 계약).
- **companion**: [`graphify-design-reference-companion.md`](../../graphify-design-reference-companion.md) — Graphify 실구현 대조.
- **원 보고서**: [`agent-intelligence-memory-report.md`](../../agent-intelligence-memory-report.md) — SoT/projection/provenance 철학.
- **dialectic 라운드1**(계약 내부정합성): `.ditto/local/work-items/wi_260609m41/reviews/dialectic-1.{json,md}` — verdict=revise, F1~F5·D1~D5 반영(§10-8). ⚠ Tier ③(gitignored) — 다른 PC로 안 따라감.
- **dialectic 라운드2**(가치·구조): `.ditto/local/work-items/wi_260609m41/reviews/dialectic-2.{json,md}` — verdict=revise, 본 문서가 그 종합. ⚠ Tier ③.
- **intent 계약**: `.ditto/local/work-items/wi_260609m41/intent.json` — ac-0~ac-11. ⚠ Tier ③.

> dialectic JSON 원장은 `.ditto/local/`(개인 런타임 tier)이라 git으로 안 간다. 그래서 이 문서를 **git-tracked로 자기완결적**으로 적었다 — 원장이 없어도 결론·근거가 산다.

## 1. 검증 구조 (2라운드)

| 라운드 | 축 | verdict | 결과 |
|---|---|---|---|
| 1 | 계약 **내부정합성**(저장 tier·ACG 매핑·승인 모델·배선) | revise | admissible 13건(critical 1) → F1~F5·D1~D5로 §10에 전부 반영. 기반 견고 확인. |
| 2 | **가치**(증분 가치) + **구조**(의도한 시점 발화) | revise | 아래 §2~§5. 빌드 범위/순서를 바꿔야 한다는 판정. |

Producer(Claude) / Opponent(**Codex**, codex-plugin-cc 위임) / Synthesizer(Claude) 3역 분리. 두 라운드 모두.

## 2. 핵심 발견 — 가치는 좁고 비대칭이다

빈틈 4개(§1: cold-start·헤드라인 knowledge·수동 context·휘발 evidence)는 **코드로 실재**한다(매개변수로 못 채움):
- handoff = 1회 픽업·work_item 종속·자유텍스트 (`src/core/handoff-store.ts:214-227,147`)
- knowledge 투영 = 헤드라인뿐 (`src/core/knowledge-bridge.ts:111-131,61-70`)
- context-packet = goal/AC/git 나열, 위임 경로 자동 안 낌 (`src/core/context-packet.ts:57-87`)
- 위임 패킷 context = 4필드, 색인 0 (`src/core/autopilot-dispatch.ts:16-21`)
- ACG 산출물 = 영속 store 0 (`src/acg/` 전수 확인)

**그러나 가치는 두 곳뿐이고 비대칭이다:**

| 층 | 성질 | 가치 | 문제 |
|---|---|---|---|
| **EXTRACTED(구조)** | day-1 결정적·LLM무관 | ditto가 `impact`/`codeql`로 **이미 on-demand로 주는 사실의 영속 재서빙**. 새것은 "사실"이 아니라 "지속·질의 가능" | 증분 가치 실재하나 **modest·미측정** |
| **INFERRED(의미)** | 비싸고·비결정·수동 | warm-start·과거결정 연관 등 **헤드라인 가치 전부 여기** | §4-6이 자동루프에서 제외 → 보통 사용 시 **구조-fresh/의미-empty-or-stale** → 가치 push가 무결과/stale로 붕괴 (critical) |

**구조 축**: pull은 advisory(프롬프트 습관 1줄), `ac-8`은 텍스트 존재만 검사하지 실제 query 발화를 안 봄 → **그래프 짓고 아무도 안 부를 수 있음**(critical).

## 3. 워크드 시나리오 (ditto 자기 적용)

작업: "autopilot의 wave 분할 로직 고쳐줘."

1. **오늘(메모리 없음)**: researcher가 grep으로 재탐색. 과거 `wi_260603wno`의 wave-clobber 처리·"mutating 1 cap" 결정을 모름. `duplicateSearch`는 제목 토큰만 비교.
2. **빈 그래프(bootstrap·semantic 안 함)**: `query wave` → 무결과 → grep. **오늘과 동일 + 유지비.** ← 순손실.
3. **bootstrap만(기존 knowledge/handoff ingest, semantic 없음)**: `query wave` → handoff·ADR **본문 검색**으로 `wi_260603wno` 포인터가 warm-start에 실림. 제목-토큰보다 나음. **싸고·결정적·day-1.** ← 방어 가능한 핵심.
4. **+ semantic build(비싸고 명시 실행)**: 키워드 안 겹치는 결정과 **의미로** 연결. 크지만 **최근 build 돌렸을 때만**, 아니면 stale. ← 오버셀된 부분.

→ 설계는 가치를 ④로 팔았으나 실제 자주 도는 건 ②·③.

## 4. 본질적인 것 vs 고칠 수 있는 것

| 약점 | 판정 | 비고 |
|---|---|---|
| cold-start | 고칠 수 있음 | bootstrap ingest |
| 발화 미보장 | 고칠 수 있음 | push 결정적 자동주입 + 계측 |
| 싼 층 ACG 중복 | 고칠 수 있음(프레이밍) | 영속 read-model로 재포지셔닝 |
| **의미층 비용·신선도·비결정성** | **본질적** | 못 없앰, 절충점만. 자동화=commit마다 LLM 비용 / 수동=stale. **freshness↔비용 직접 충돌.** LLM 추출 일반의 성질 — *이 설계*만의 결함 아님 |

→ 본질적인 건 의미층(④) 하나. 나머지는 설계로 메울 수 있다.

## 5. 아키텍처 판단 — 틀리지 않았으나 이르다(과설계)

결정적 정렬:

```
싸고 증명된 가치(③)        →  검색 가능한 색인이면 충분 (그래프 기계장치 불필요)
그래프가 정당화하는 가치     →  의미층(④) = 비싸고·stale·미검증
```

시나리오 ③이 한 일은 **그래프가 아니라 색인**(저장된 handoff·ADR 본문 검색)이다. 노드/엣지/traversal/path/하이퍼엣지/confidence 밴드/projection/serving layer 중 ③에 필요한 건 없다. 반대로 그래프*만*의 가치(`path`·타입 엣지 traversal·의미 관계)는 전부 ④(비싸고 미검증)다.

**즉 색인 수준 가치를 내려고 그래프 기계장치(IR builder·projection·serving·reducer)를 짓고 있고, 그 기계장치를 정당화하는 가치는 아직 증명 안 됐다.** charter §4-3(단순 해법·얕은 추상화 금지·프레임워크화 경계)의 교과서적 사례.

**판정**:
- 그래프 접근 자체는 **틀리지 않았다** — 타입 엣지·provenance·통합 모델은 진짜 장점, 의미층 증명 시 옳은 그릇.
- 틀린 건 **altitude·timing** — 증명된 게 색인-shaped인데 그래프부터 다 짓는 것.
- 고치는 방향은 "그래프에 설계 *추가*"가 아니라 "**축소**"다. coverage 게이트·freshness 정책·auto-audit·bootstrap·계측을 다 붙이면 미검증 위에 무게만 더함.

## 6. 선택지 (결정 미정 — 사용자 사인오프 필요)

> charter §4-6: 사용자가 2026-06-10에 "코어+§5 5지점"을 v0 경계로 사인오프했다. 아래는 그 범위를 좁히므로 묵시 적용 불가 — 의도-레벨 결정.

| 옵션 | 내용 | "한번에" | 리스크 |
|---|---|---|---|
| **A′ 색인 먼저 (권고)** | #2(scan+sources/events store) + bootstrap(knowledge/handoff/closed-work ingest) + 키워드·구조 `query` + warm-start push 1개+계측. **IR·semantic·projection·path/explain 안 지음.** 계측이 "query 불리고 행동 바뀐다"를 숫자로 보이면 → 그때 그래프 기계장치(#3/#4/#5/#6)로 ④ 개방. #1 스키마는 sources/events 저장에 그대로 씀(버리는 것 없음) | 색인 핵심을 한번에, 그래프는 증거로 | 가장 작음. 의미·traversal 이번엔 미제공 |
| **A 척추+1push** | #2~#7 + bootstrap + 1 instrumented push, 나머지 4 push·audit 자동화는 hit율 게이트 | 척추 한번에 | 그래프 기계장치는 짓되 push만 게이트(A′보다 큼) |
| **원안 강행** | #2~#9 + §5 5지점 전부 | 문자 그대로 최대 | **미검증 가치를 done 처리** — ②붕괴·발화 미보장 감수 |

권고(작성 시점): **A′**. — 단 §6-1 의사결정에서 **A로 확정**됨.

## 6-1. 의사결정 (2026-06-10) — 옵션 A 확정

**사용자 결정: 옵션 A (척추 #2~#7 + bootstrap + warm-start push 1개 계측; 나머지 4 push·audit 자동화는 hit율 게이트).**

**근거(사용자 진술)**: "가치가 실재한다면 도전해보고 싶다. 잃는 것과 얻는 것 중 얻는 효과가 확실하다면." → A는 **확실한 바닥**(지속·질의 가능 capability + bootstrap day-1 내용 + 본문검색이 현행 title-token duplicateSearch 초과)과 **측정되는 상방**(의미층 ④을 직접 query·계측)을 동시에 준다. A′보다 데이터·효과 둘 다 많고, 손실은 bounded·reversible.

**명시 전제(과장 금지)**: 이건 **"확실한 바닥 + 측정되는 상방"이지 "보장된 전체 승리"가 아니다.** 상방(의미층 relevance)의 효과는 사전 확실 불가 — 지어서 계측해야 안다. A는 그 베팅을 싸고·측정 가능하고·되돌릴 수 있게 만드는 그릇.

**사용자 추가 요구**: ① 전체를 **나중에 되돌릴 수 있는 구조**(단일 플래그 비활성 + 제거 경로). ② **자율주행으로 합의 범위(A)를 한번에 구현 시작.**

**A vs 원안 차이(범위 축소 명시, charter §4-6)**: §5 push를 5지점→1지점 배선+4지점 게이트로 좁힘. 사용자 사인오프 완료. bootstrap 증분은 in-scope로 추가(U2 해소).

## 7. 상태

- ac-0(설계 동결): 1라운드(계약) + 2라운드(가치·구조) 반영 완료 → **closed**.
- 옵션 A 확정 → §10-9(설계서) + intent(ac-12 가치게이트·ac-13 되돌림·ac-14 bootstrap, §5 1+4게이트로 재범위)에 반영.
- **다음: 자율주행(autopilot) 빌드 — 옵션 A 전 범위. §10-9 빌드 순서대로.**
