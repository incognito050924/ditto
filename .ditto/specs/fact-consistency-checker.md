# 근거-주장 사실 일치 checker — 테크스펙

> **소비자**: DITTO(design → implement → verify) + 사람(증분 리뷰).
> **소스**: reports/design/tech-spec-surface-design.md 미해결 후보 (dialectic-1 obj-8 follow-up) + wi_260610hwd dogfooding
> **수명**: §3·§5·§6·§7·§10 = 장수명(빌드 후 ADR 승격) · §8·§11 = 단수명(빌드 후 폐기).
> **모드**: stepwise · **리뷰 커버리지**: finalize 산출물에 섹션별 reviewed/skipped 기록.

---

## 1. 기능

- **이름**: 근거-주장 사실 일치 checker (dialectic-1 obj-8 follow-up. 호출 형태는 가칭 — 미해결 질문 2)
- **층위**: tech-spec 표면의 검증 보조 계층. 사용자 호출 표면이 아니라 record-section(ac-9 게이트) 뒤에 붙는 검사기 — 사용자 표면 캡(스킬 1개 + 템플릿 1개)을 늘리지 않는다.

## 2. 요약

tech-spec의 ac-9 게이트는 사실 섹션(배경·영향도) 기록 시 근거 조회 증거(memory projection_id / ACG 산출물 경로)를 스키마로 강제하지만, 보장 범위는 "조회했다"까지다 — 문서의 주장이 인용한 근거와 실제로 일치하는지는 검증되지 않는다. 이 checker는 에이전트가 쓴 사실 주장과 그 인용 근거(파일:라인, memory projection, 명령 출력) 사이의 **결정적으로 검증 가능한 불일치**(근거 부존재 · 신선도 위반 · 인용-본문 불일치)를 감지해 mismatch 리포트로 플래그한다. 소비자는 증분 리뷰 중인 사용자(오염된 사실 위에서 리뷰하지 않도록)와 finalize 게이트(DITTO)다.

## 3. 배경 [장]

### 3-1. ac-9 게이트의 정직한 한계

tech-spec 기획문서는 근거 강제 게이트(ac-9)를 설계하면서 한계를 명시했다: "게이트가 보장하는 것은 '조회했다'까지다. '결과를 반영했다'는 … 최종적으로는 증분 리뷰(사용자)와 finalize 게이트가 잡는다" (`reports/design/tech-spec-surface-design.md:112`, §8 "강제의 정직한 한계"). 구현도 동일하다 — record-section은 사실 섹션(`background`·`impact`)에 grounding evidence **1개 이상 존재**만 요구하고(`src/core/tech-spec.ts:62-63`, `:267`), evidence가 가리키는 내용과 문서 주장의 일치 여부는 검사하지 않는다.

### 3-2. dialectic-1 obj-8 — 공백의 공식 기록

기획문서의 dialectic 리뷰에서 Opponent가 이 공백을 high severity로 지적했다: "ac-9는 '조회 발생'만 검증 — 근거-주장 사실 일치는 미검증, 문서가 프로젝트 사실과 모순돼도 통과 가능. failure_mode = 근거 게이트 통과 + 사실 불일치 문서" (`.ditto/local/work-items/wi_260610z2z/reviews/dialectic-1.json`, obj-8). 판정은 novelty 탈락(§8이 동일 한계를 이미 명시)이었으나 "checker는 follow-up 후보로 보존"이 명시 결론이다. 이 스펙이 그 follow-up이다.

### 3-3. 선례

GSD(`open-gsd/gsd-core`)는 같은 문제를 provenance tag + 별도 checker로 처리한다 (dialectic-1 obj-8 evidence note, `reports/harnesses/get-shit-done.md` 조사 기반). 단 GSD checker는 일반 문서 대상이고, 여기서는 ac-9가 이미 구조화해 둔 evidence(kind=memory/acg)를 입력으로 쓸 수 있어 검증이 더 결정적이다.

> 근거 조회: memory projection `proj_9fdb287b9115` (fresh, 2026-06-10) — tech-spec 관련 source 3건 매칭 확인.

## 4. 목표

1. **결정적으로 검증 가능한 불일치 계층을 감지한다**: (a) 근거 부존재 — 인용한 경로·projection_id가 실재하지 않음, (b) 신선도 위반 — stale/absent projection 인용, (c) 인용-본문 불일치 — 인용한 파일:라인의 실제 내용이 문서의 인용문과 (정규화 후) 다름.
2. **산출물은 advisory 리포트다** — 섹션별 mismatch 목록을 record-section 응답에 포함하고, finalize 시 미해소 mismatch를 경고로 표면화한다. 차단 게이트 승격은 오탐률 증거 확보 후 별도 결정 (hypothesis 가정 — §12 인터뷰 기록).
3. **판정 신호는 ac-9 허용 집합(memory ∨ ACG)과 동일**하게 유지한다 — 게이트 층 간 신호 불일치(dialectic-1 obj-9 류) 재발 방지.
4. **증분 단위로 동작한다** — finalize 일괄 검사만으로는 늦다. 불일치는 해당 섹션의 증분 리뷰 시점에 보여야 리뷰가 오염된 사실 위에서 진행되지 않는다.

## 5. 비목표 (변경 경계) [장]

- **의미 수준 사실 검증 안 함.** 주장의 진리값을 LLM이 판단하는 비결정적 검증은 v1 범위 밖이다. checker는 결정적 계층(부존재·신선도·인용-본문)만 판정하고, 의미 공백은 기존대로 증분 리뷰(사용자)가 잡는다 — checker는 리뷰 대체가 아니라 리뷰 입력의 오염 방지다 (§12 인터뷰 가정).
- **차단 게이트로 동작하지 않음 (v1).** record-section·finalize를 mismatch 때문에 거부하지 않는다 — advisory 리포트만. 차단 승격은 오탐률 계측 증거 확보 후 별도 결정이다.
- **기존 계약 변경 없음.** deep-interview(zero diff 불변), tech-spec record-section 스키마·ac-9 게이트·finalize 컴파일 계약은 그대로다 — checker는 추가 계층이지 수정이 아니다.
- **일반 문서로 확장 안 함 (v1).** 대상은 tech-spec의 사실 섹션(배경·영향도)뿐이다. 보고서·ADR 전반의 provenance 검증은 follow-up.
- **신규 사용자 표면 없음.** 스킬·명령 표면을 늘리지 않는다 — 기존 record-section/finalize 흐름 내부에서 동작한다 (호출 형태 미정, 미해결 질문 2).

## 6. 완료 조건 (Acceptance Criteria)

> 관찰 가능한 술어 + evidence 종류(`test|diff|doc|browser|log`). 목표(포부)의 복붙 금지 — AC는 목표 충족을 증명하는 관문이다.

| id | 완료 조건 (관찰가능 술어) | evidence |
|---|---|---|
| ac-1 | 사실 섹션이 인용한 근거(ACG 경로·projection_id)가 실재하지 않으면 checker 리포트에 해당 섹션의 mismatch 행이 생성된다 | test |
| ac-2 | stale 또는 absent projection을 인용하면 신선도 위반으로 플래그된다 | test |
| ac-3 | 인용한 파일:라인의 실제 내용이 문서 인용문과 정규화(공백·개행 collapse) 후에도 다르면 mismatch로 플래그된다 | test |
| ac-4 | 검사된 인용이 1건 이상이고 mismatch가 0건일 때만 리포트가 clean 판정을 내며, 검사 건수와 mismatch 수를 함께 보고한다 — 검사 0건은 clean이 아니라 not-checked로 구분된다 | test |
| ac-5 | finalize 시점에 미해소 mismatch가 있으면 경고가 표면화된다 (advisory — 차단 아님) | test |

## 7. 위험 / Pre-mortem

> "출시 후 3일 만에 깨진다면 원인은?" — 각 답을 AC 승격(§6) / 비목표(§5) / unknown(여기 잔류) 중 하나로 처리하고, 비가역(데이터 손실·스키마 마이그레이션·공개 API)이면 플래그한다.

| 위험 | 처리 | 플래그 |
|---|---|---|
| [비목표 증분] advisory 리포트가 무시되어 사실상 장식이 됨 — ac-9 무력화와 동일 패턴 재발 | finalize 미해소 mismatch 경고 표면화를 AC로 승격(§6) + 무시율(미해소 mismatch 잔존율)을 M1 사용 증거로 계측 → 차단 승격 재논의 입력 | — |
| [ac-1 증분] 경로 해석 차이(상대/절대, repo 루트 기준)로 실재하는 ACG 산출물을 부존재로 오탐 | 경로 해석 규칙을 §8 힌트로 고정 + 정상 케이스(실재 산출물 통과)를 ac-1 테스트 픽스처에 포함 | — |
| [ac-2 증분] 기록 시점과 검사 시점 사이에 projection 신선도가 바뀜 — 판정 시점 모호 | 판정 시점 = record-section 호출 시점으로 고정(§8 힌트). 시점 경합(검사 직후 stale 전환)은 unknown으로 잔류 | — |
| [ac-3 증분] 공백·개행·라인 시프트로 인용-본문 비교가 오탐 다발 → 사용자가 checker 신뢰 철회 | 정규화 규칙(§8 힌트) + 오탐률 계측을 M2 산출물로 — 차단 승격 결정(M3)의 입력 | — |
| [ac-4 증분] "clean" 판정이 "검사 0건 수행"과 구분되지 않음 — checker가 아예 안 돌아도 통과처럼 보임 | AC 승격: ac-4 술어에 검사 수행 건수 ≥1 포함 (리뷰 1차 피드백과 수렴, v2 반영) | — |
| **비가역성**: advisory 계층 추가만 — 데이터 손실·스키마 마이그레이션·기존 계약 파괴 없음. 차단 승격(M3)이 결정되면 그 시점에 재평가 | — | irreversible=false |

## 8. 계획 (Plan) [단]

> ⚠ **비구속(non-binding) 설계 힌트.** 구현 시 참고만 하며 더 나은 설계로 대체할 수 있다. 권위 있는 계약이 아니다. 데이터·API는 모양을 암시하는 수준까지만 — 정밀 스키마는 설계 단계의 산출물이다.

- **호출 형태**: 미정 — (a) record-section 내부 advisory 단계 vs (b) 전용 명령(`ditto tech-spec check-facts` 가칭). M1 설계 시 결정 (미해결 질문 2).
- **검증 3계층 (목표 1과 1:1)**: ① 존재 — evidence kind=acg면 경로 stat, kind=memory면 projection_id 실재 확인; ② 신선도 — `ditto memory status` freshness 재조회, stale/absent면 위반; ③ 인용 일치 — 문서의 파일:라인 인용을 실제 파일 내용과 정규화 후 비교. 의미 일치는 범위 밖(§5).
- **경로 해석 규칙**: repo 루트 기준 상대 경로로 정규화 — §7 오탐 위험 대응. 세부 미정.
- **인용-본문 정규화**: 공백·개행 collapse + 라인 범위 허용 오차(±N) — N 미정, M2 오탐률 계측으로 튜닝.
- **판정 시점**: record-section 호출 시점 고정(§7). finalize는 미해소 mismatch 잔존 여부만 재확인(경고 표면화, ac-5).
- **신호 재사용**: `ditto memory status/query` + ACG 산출물 stat — 신규 조회 인프라 없음 (목표 3).
- **리포트 모양**: 섹션 id별 `{checked, mismatches[], verdict: clean|mismatch|not-checked}` 수준 암시까지만 — 정밀 스키마는 설계 단계 산출물.

## 9. 영향도 · 의존성

- **tech-spec record-section 흐름** (`src/core/tech-spec.ts`): ac-9 게이트(evidence 존재 검사, `:267`) 뒤에 advisory 검사 단계가 붙는다 — 기존 스키마·거부 동작 무변경, 응답에 리포트 필드 추가(additive).
- **tech-spec finalize**: 미해소 mismatch 경고 표면화(ac-5) 추가 — 컴파일·게이트 로직 무변경, 차단 없음.
- **memory 서브시스템**: 읽기 전용 소비(`ditto memory status/query` — projection_id 실재·freshness 확인). 변경 없음.
- **ACG 산출물**: 읽기 전용 소비(경로 stat). 변경 없음.
- **deep-interview / autopilot**: 접점 없음 (zero diff).

non_local 신호: 없음 — 추가 지점이 tech-spec 모듈 내부로 국소화되고 나머지는 전부 읽기 전용 소비다.

> 근거 조회: memory projection `proj_9fdb287b9115` (fresh) — record-section 관련 source 3건 매칭; 게이트 위치는 `src/core/tech-spec.ts:62-63,267` 직접 확인.

## 10. 기각된 대안 [장]

- **LLM 기반 의미 수준 검증을 v1에 포함** → 기각. 비결정적 판정기는 오탐·확신 오답으로 게이트 신뢰를 훼손하고 test evidence로 AC를 닫을 수 없다. 결정적 계층을 먼저 출시하고 의미 공백은 증분 리뷰가 잡는다 (§12 인터뷰 d-verification-depth 가정).
- **차단 게이트(fail-closed)로 즉시 출시** → 기각. 오탐률 미지 상태의 차단은 사용자 우회를 유발한다 — digest 과민 위험과 동형 선례(`reports/design/tech-spec-surface-design.md` §7). advisory-first + 계측 후 승격 결정 (§12 인터뷰 d-enforcement 가정).
- **finalize 일괄 검사 단독** → 기각. 불일치는 섹션 증분 리뷰 시점에 보여야 한다 — finalize에서야 발견하면 수정 비용이 커지고, 그때까지의 증분 리뷰가 오염된 사실 위에서 진행된다 (목표 4의 반대 방향).
- **일반 문서(보고서·ADR) 전체로 시작** → 기각. ac-9가 이미 구조화해 둔 evidence(kind=memory/acg)가 있는 tech-spec 사실 섹션이 결정적 검증의 최소 발판이다. 비구조 문서는 인용 추출부터 비결정적이라 v1 범위 밖 (§5).

## 11. 마일스톤 [단]

| 단계 | 산출물 |
|---|---|
| M1 | 존재·신선도 계층 + advisory 리포트(record-section 응답) — ac-1/2/4. 호출 형태 결정 포함 |
| M2 | 인용-본문 일치 계층(정규화 매칭) + 오탐률 계측 — ac-3 |
| M3 | finalize 경고 표면화(ac-5) + 차단 승격 여부 결정(M1·M2 계측 증거 기반) — 승격 시 별도 스펙 |

일정 추정: 미정.

## 12. 인터뷰 기록

> 이 인터뷰의 답변자는 시뮬레이션 사용자다(wi_260610hwd dogfooding) — 모든 답변이 `kind: "assumption"`(hypothesis 라벨)으로 기록되었고, 실사용자 확인 전까지는 가정이다.

- 진입 사유: §4 목표 초안에서 checker의 강제 수준이 미결정으로 드러남 — 차단 게이트(fail-closed)와 advisory 리포트는 product-visible하게 다른 2+ 구현이고, 결정 없이는 단일 AC 작성 불가 (deep-interview 진입 조건 충족).
- 결과 요약 (3턴, readiness 0.75 ≥ threshold 0.7, gate pass):
  - **d-enforcement** (critical, resolved): advisory-first — 오탐률 증거 없는 차단은 우회 유발(digest 과민 선례). 차단 승격은 M1·M2 계측 후 별도 결정. 표면화 의무 = record-section 응답 + finalize 경고까지 v1 범위.
  - **d-verification-depth** (critical, resolved): 결정적 계층(부존재·신선도·인용-본문)만 v1. 의미 수준 검증은 비목표 — checker는 리뷰 대체가 아니라 리뷰 입력의 오염 방지.
  - 범위 변화: 목표 2가 "차단" → "advisory 리포트"로 교체, 목표 1이 3계층으로 한정, §5에 의미 검증·차단 비목표 추가.
- 원본: `.ditto/local/work-items/wi_2606101qn/interview-state.json` (finalize는 수행하지 않음 — 이 dogfood 세션의 범위 밖)

## 13. 빌드 후 처리

- **ADR 승격(잔존)**: §3·§5·§6·§7·§10 → "근거-주장 일치 검증은 결정적 계층(부존재·신선도·인용-본문) 한정 + advisory-first, 차단 승격은 계측 증거 기반 별도 결정" (`ditto:knowledge-update`).
- **폐기**: §8 계획·§11 마일스톤 → 코드가 SoT가 되면 archived.
- **링크**: `wi_2606101qn` ↔ 이 문서 ↔ 생성 ADR 상호 링크.

---

## 미해결 질문

1. **차단 게이트 승격 기준** — 어떤 오탐률 임계·계측 기간이면 advisory → 차단 승격을 정당화하는가. M3 착수 전 결정 (입력: M1·M2 계측).
2. **checker 호출 형태** — record-section 내장 단계 vs 전용 명령. M1 설계 시 결정.
3. **시뮬레이션 가정의 실사용자 확인** — §12의 assumption 2건(d-enforcement, d-verification-depth)은 실사용자 인터뷰로 재확인 전까지 hypothesis다. 이 스펙의 finalize 전 결정.
