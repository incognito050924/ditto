# 근거-주장 사실 일치 checker (oneshot 변형) — 테크스펙

> **소비자**: DITTO(design → implement → verify) + 사람(증분 리뷰).
> **소스**: wi_260610hwd dogfooding — 모드 변형 시연; 본 스펙의 합의본은 fact-consistency-checker.md
> **수명**: §3·§5·§6·§7·§10 = 장수명(빌드 후 ADR 승격) · §8·§11 = 단수명(빌드 후 폐기).
> **모드**: oneshot · **리뷰 커버리지**: finalize 산출물에 섹션별 reviewed/skipped 기록.

---

## 1. 기능

- **이름**: 근거-주장 사실 일치 checker (dialectic-1 obj-8 follow-up — oneshot dogfooding 변형)
- **층위**: tech-spec 표면의 검증 보조 계층. record-section(ac-9 게이트) 뒤에 붙는 검사기 — 사용자 표면 캡(스킬 1개 + 템플릿 1개)을 늘리지 않는다.

## 2. 요약

tech-spec의 ac-9 게이트는 사실 섹션(배경·영향도) 기록 시 근거 조회 증거를 스키마로 강제하지만, 보장 범위는 "조회했다"까지다 — 문서의 주장이 인용한 근거와 실제로 일치하는지는 검증되지 않는다. 이 checker는 사실 주장과 인용 근거(파일:라인, memory projection, ACG 산출물) 사이의 **결정적으로 검증 가능한 불일치**(근거 부존재 · 신선도 위반 · 인용-본문 불일치)를 감지해 advisory 리포트로 플래그한다. 소비자는 증분 리뷰 중인 사용자와 finalize 게이트(DITTO)다.

## 3. 배경 [장]

ac-9 게이트의 한계는 명시돼 있다: "게이트가 보장하는 것은 '조회했다'까지" (tech-spec ac-9 게이트 설계 — `skills/tech-spec/SKILL.md`·`src/core/tech-spec.ts` ac-9에 반영). 구현도 동일 — record-section은 사실 섹션에 grounding evidence **존재**만 요구하고(`src/core/tech-spec.ts:62-63`, `:267`) 일치 여부는 검사하지 않는다. dialectic-1 리뷰의 obj-8이 이 공백을 high severity로 지적했고(failure_mode = 근거 게이트 통과 + 사실 불일치 문서), "checker는 follow-up 후보로 보존"이 명시 결론이다 (`.ditto/local/work-items/wi_260610z2z/reviews/dialectic-1.json`). 이 스펙이 그 follow-up이다. 상세 배경(GSD 선례 포함)은 합의본 `fact-consistency-checker.md` §3.

> 근거 조회: memory projection `proj_9fdb287b9115` (fresh, 2026-06-10) — tech-spec 관련 source 3건 매칭 확인.

## 4. 목표

1. **결정적으로 검증 가능한 불일치 3계층 감지**: (a) 근거 부존재, (b) 신선도 위반(stale/absent projection 인용), (c) 인용-본문 불일치(정규화 후 비교).
2. **산출물은 advisory 리포트** — record-section 응답에 섹션별 mismatch 목록 포함, finalize 시 미해소 mismatch 경고 표면화. 차단 승격은 오탐률 증거 확보 후 별도 결정.
3. **판정 신호는 ac-9 허용 집합(memory ∨ ACG)과 동일** — 게이트 층 간 신호 불일치 재발 방지.
4. **증분 단위 동작** — 불일치는 해당 섹션의 증분 리뷰 시점에 보여야 한다. finalize 일괄 검사 단독은 늦다.

## 5. 비목표 (변경 경계) [장]

- **의미 수준 사실 검증 안 함.** LLM이 주장의 진리값을 판단하는 비결정적 검증은 v1 범위 밖. checker는 리뷰 대체가 아니라 리뷰 입력의 오염 방지다.
- **차단 게이트로 동작하지 않음 (v1).** record-section·finalize를 mismatch 때문에 거부하지 않는다 — advisory만. 차단 승격은 계측 증거 확보 후 별도 결정.
- **기존 계약 변경 없음.** deep-interview(zero diff), record-section 스키마·ac-9 게이트·finalize 컴파일 계약 그대로 — checker는 추가 계층이지 수정이 아니다.
- **일반 문서로 확장 안 함 (v1).** 대상은 tech-spec의 사실 섹션(배경·영향도)뿐. 보고서·ADR 전반의 provenance 검증은 follow-up.
- **신규 사용자 표면 없음.** 스킬·명령 표면을 늘리지 않는다 — 기존 record-section/finalize 흐름 내부에서 동작 (호출 형태 미정, 미해결 질문 2).

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

> "출시 후 3일 만에 깨진다면 원인은?" — oneshot 모드에서도 pre-mortem은 동일 고정점(배경·목표 직후, 비목표/AC 증분마다)에서 수행되었다. 각 행의 접두는 발화 지점이다.

| 위험 | 처리 | 플래그 |
|---|---|---|
| [배경·목표 직후] 배경의 코드 사실 인용(`src/core/tech-spec.ts:62-63,267`)이 리팩터링 라인 시프트로 무효화되어 스펙이 낡은 사실 위에 서게 됨 | 라인 인용에 memory projection(`proj_9fdb287b9115`, fresh) 병기 — 단독 라인 의존 제거. 잔여 의심 없음 | — |
| [비목표: 의미 검증 제외] 사용자가 checker를 리뷰 대체로 오해해 의미 수준 오류 리뷰가 약화됨 | §5에 "리뷰 대체가 아니라 리뷰 입력 오염 방지" 경계 문구 명시로 처리 | — |
| [비목표: 차단 안 함] advisory 리포트가 무시되어 사실상 장식이 됨 — ac-9 무력화와 동일 패턴 재발 | finalize 경고 표면화를 AC로 승격(ac-5) + 무시율 계측을 차단 승격 재논의 입력으로 | — |
| [비목표: 계약 무변경] additive 계층이 실수로 record-section 거부 동작을 바꿈 — zero diff 위반 | §9에 "기존 스키마·거부 동작 무변경(additive)" 명시 + 기존 계약 테스트가 가드 | — |
| [비목표: 일반 문서 확장 제외] 보고서 provenance 요구가 새어 들어와 scope creep | 비목표 명시 유지, 일반 문서 확장은 follow-up으로 분리 — 신규 위험 없음 | — |
| [비목표: 신규 표면 없음] 호출 형태 미결정이 새 명령 표면 추가로 흐를 위험 | 미해결 질문 2에 결정 시점 고정(M1 설계 시) — 표면 캡 유지 | — |
| [ac-1 증분] 경로 해석 차이(상대/절대, repo 루트 기준)로 실재하는 ACG 산출물을 부존재로 오탐 | 경로 해석 규칙을 §8 힌트로 고정 + 정상 케이스를 ac-1 테스트 픽스처에 포함 | — |
| [ac-2 증분] 기록 시점과 검사 시점 사이 projection 신선도 변동 — 판정 시점 모호 | 판정 시점 = record-section 호출 시점 고정(§8). 시점 경합은 unknown으로 잔류 | — |
| [ac-3 증분] 공백·개행·라인 시프트로 인용-본문 비교 오탐 다발 → checker 신뢰 철회 | 정규화 규칙(§8) + 오탐률 계측(M2)을 차단 승격 결정(M3) 입력으로 | — |
| [ac-4 증분] "clean"이 "검사 0건"과 구분되지 않음 — checker가 안 돌아도 통과처럼 보임 | AC 승격: ac-4 술어에 검사 건수 ≥1 포함 | — |
| [ac-5 증분] finalize 경고가 출력 노이즈에 묻혀 사용자가 인지 못 함 | 경고를 응답 구조 필드로 표면화(§8 리포트 모양) — 텍스트 로그 단독 의존 금지. 표시 위치 세부는 미정 잔류 | — |
| **비가역성**: advisory 계층 추가만 — 데이터 손실·스키마 마이그레이션·기존 계약 파괴 없음 | 차단 승격(M3) 결정 시점에 재평가 | irreversible=false |

## 8. 계획 (Plan) [단]

> ⚠ **비구속(non-binding) 설계 힌트.** 권위 있는 계약이 아니다.

- **호출 형태**: 미정 — record-section 내부 advisory 단계 vs 전용 명령. M1 설계 시 결정.
- **검증 3계층**: ① 존재(acg 경로 stat / projection_id 실재) ② 신선도(freshness 재조회) ③ 인용 일치(정규화 후 비교). 의미 일치는 범위 밖(§5).
- **판정 시점**: record-section 호출 시점 고정. finalize는 미해소 mismatch 잔존 재확인만(ac-5).
- **신호 재사용**: `ditto memory status/query` + ACG 산출물 stat — 신규 조회 인프라 없음.
- **리포트 모양**: 섹션 id별 `{checked, mismatches[], verdict: clean|mismatch|not-checked}` 암시 수준까지만.

## 9. 영향도 · 의존성

- **tech-spec record-section** (`src/core/tech-spec.ts`): ac-9 게이트(`:267`) 뒤에 advisory 단계 추가 — 기존 스키마·거부 동작 무변경(additive).
- **tech-spec finalize**: 미해소 mismatch 경고 표면화(ac-5) 추가 — 컴파일·게이트 로직 무변경.
- **memory 서브시스템 / ACG 산출물**: 읽기 전용 소비. 변경 없음.
- **deep-interview / autopilot**: 접점 없음 (zero diff).

non_local 신호: 없음 — 추가 지점이 tech-spec 모듈 내부로 국소화.

> 근거 조회: memory projection `proj_9fdb287b9115` (fresh) — record-section 관련 source 3건 매칭; 게이트 위치는 `src/core/tech-spec.ts:62-63,267` 직접 확인.

## 10. 기각된 대안 [장]

- **LLM 기반 의미 수준 검증 v1 포함** → 기각. 비결정적 판정기는 게이트 신뢰를 훼손하고 test evidence로 AC를 닫을 수 없다.
- **차단 게이트로 즉시 출시** → 기각. 오탐률 미지 상태의 차단은 우회 유발 — advisory-first + 계측 후 승격 결정.
- **finalize 일괄 검사 단독** → 기각. 불일치는 증분 리뷰 시점에 보여야 한다 — 늦은 발견은 수정 비용 증가 + 오염된 리뷰.
- **일반 문서 전체로 시작** → 기각. ac-9가 구조화한 evidence가 있는 tech-spec 사실 섹션이 결정적 검증의 최소 발판.

상세 근거는 합의본 `fact-consistency-checker.md` §10.

## 11. 마일스톤 [단]

| 단계 | 산출물 |
|---|---|
| M1 | 존재·신선도 계층 + advisory 리포트 — ac-1/2/4. 호출 형태 결정 포함 |
| M2 | 인용-본문 일치 계층 + 오탐률 계측 — ac-3 |
| M3 | finalize 경고 표면화(ac-5) + 차단 승격 여부 결정 |

일정 추정: 미정.

## 12. 인터뷰 기록

없음 — 이 oneshot 변형 세션에서는 deep-interview가 내부 호출되지 않았다(의도 수준 모호성이 새로 발생하지 않음 — 강제 수준·검증 깊이 결정은 합의본 `fact-consistency-checker.md` §12의 인터뷰가 이미 좁혔다). 진입 조건 미충족 시 강제 진입하지 않는다.

## 13. 빌드 후 처리

- **ADR 승격(잔존)**: §3·§5·§6·§7·§10 → "근거-주장 일치 검증은 결정적 계층 한정 + advisory-first, 차단 승격은 계측 증거 기반 별도 결정" (`ditto:knowledge-update`).
- **폐기**: §8 계획·§11 마일스톤 → 코드가 SoT가 되면 archived.
- **링크**: `wi_260610irs` ↔ 이 문서 ↔ 합의본 `fact-consistency-checker.md` (`wi_2606101qn`).

---

## 미해결 질문

1. **차단 게이트 승격 기준** — 오탐률 임계·계측 기간. M3 착수 전 결정.
2. **checker 호출 형태** — record-section 내장 vs 전용 명령. M1 설계 시 결정.
3. **시뮬레이션 가정의 실사용자 확인** — 합의본 §12의 assumption 2건은 실사용자 재확인 전까지 hypothesis. 이 스펙 계열의 finalize 전 결정.
