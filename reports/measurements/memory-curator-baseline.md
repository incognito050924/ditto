# Memory 큐레이터 — 환각 감소 측정 정의 + baseline

> **목적**: ac-5(memory-librarian §6) 충족 — "기각된 대안 재제안율·불변식 위반율을
> baseline 대비 측정하는 정의와 산출 경로". measure-before-expand 게이트(ADR-0013 D4)의
> 데이터원.
> **소비자**: M3/M4 확장 여부 판정(증분 추가 전).
> **산출 경로**: `ditto memory measure [--against <file,…>] [--output json]`
> (`src/core/memory-measure.ts` + `src/cli/commands/memory.ts`).
> **수명**: 단수명(빌드 후 ADR 승격 시 정의만 보존, 수치는 재산출).

## 1. 지표 정의

### 재제안율 (re-proposal rate) — 측정 가능

- **분모**: 지배 ADR에 카탈로그된 기각된 대안의 총수. ADR의 `## 대안 (기각)` 섹션
  (변형: `대안과 폐기 사유`, `대안 (기각/보류)`) bullet을 결정적 파싱.
- **분자**: 후보 계획·결정 텍스트가 이미 기각된 대안을 다시 제안한 검출 수.
  매칭은 결정적·crude — 기각대안 bold lead에서 추출한 distinctive 토큰(라틴 단어 ≥4자
  또는 괄호 안 용어)이 후보 텍스트에 등장하면 1건. 임베딩 없음(ADR-0013 D1).
- **재제안율** = 분자 / 분모. baseline(후보 없음) = 0.

### 불변식 위반율 (invariant violation rate) — **아직 결정적 미실현**

- ADR의 불변식은 전용 섹션 없이 산문에 흩어져 있다(`불변식`/`invariant` 키워드).
  따라서 분모는 **저정밀 키워드 스캔**으로만 집계하고, 위반 분자는 결정적으로 계산하지
  않는다(`invariant_violations_computed=false`).
- 이 갭 자체가 measure-before-expand 신호다(아래 §3).

## 2. Baseline (1회 산출, 2026-06-19, `git HEAD`)

`ditto memory measure --output json` over `.ditto/knowledge/adr/`:

| 지표 | 값 |
|---|---|
| ADR 총수 | 20 |
| `## 대안` 섹션 보유 ADR | 18 (커버리지 90%) |
| 섹션 미보유 ADR | ADR-0002, ADR-0014 |
| 기각된 대안 카탈로그 총수 (분모) | 67 |
| 불변식 라인 (저정밀) | 20 |
| 후보 스캔 수 | 0 |
| 재제안 검출 (분자) | 0 |
| 재제안율 | 0.000 |

## 3. measure-before-expand 판정 (ADR-0013 D4)

- **재제안율은 실현 가능**: 분모(기각대안)가 전용 섹션에 구조화되어 90% ADR에서
  결정적으로 카탈로그된다(67건). 후보 텍스트만 주면(`--against`) 분자·율을 즉시 산출.
- **불변식 위반율은 미실현**: 산문 흩어짐 → 분모가 저정밀이고 분자 미계산. 위반율을 진짜
  지표로 쓰려면 ADR에 불변식을 구조화 기재하는 선행 작업이 필요 → 그 전까지 **재보류**.
- **재제안 매칭 recall 한계**: distinctive 토큰(라틴/괄호) 의존이라 순수 한국어 기각대안은
  놓칠 수 있다. baseline의 재제안율 0은 "위반 없음"이 아니라 "후보 미투입"이며, recall은
  토큰 분포에 묶인다 — 율을 절대지표가 아닌 추세지표로 읽는다.

## 4. 한계 / 잔여 위험 (§7 Pre-mortem 연계)

- 매칭은 의도적으로 crude(결정적 유지). 정밀 매칭은 임베딩이 필요해 비목표(ADR-0013 D1).
- ac-2 cite-or-abstain(소비 강제)의 "진짜 소비"는 이 재제안율로 **간접** 검증한다 —
  주입했는데도 재제안율이 안 떨어지면 소비가 표식뿐이라는 신호(두 AC 교차, §7).
