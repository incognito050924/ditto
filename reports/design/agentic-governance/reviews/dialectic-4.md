# Dialectic-4 — ACG 구현 착수 가부 (review)

- **target**: `reports/design/agentic-governance/` 6 docs + idea base (3회 리뷰 후 최종본)
- **question**: 구현 착수해도 되는가 — (1) 정합성·cross-ref 닫힘, (2) v0 표면 구현 가능성, (3) 00 §9 열린질문 blocker/deferred 분류
- **verdict**: `revise` (조건부 GO) — Opponent=codex(must-fix-first), Producer=accept(v0 한정)

## 핵심 판정 (문서 직접 대조)

| cross-ref | Producer 주장 | 판정 | 근거 |
|---|---|---|---|
| evidence_kind | 일치 | **TRUE** | 20:91 / 30:66 / 50:87 |
| fitness_kind 9종 | 일치 | **TRUE** | 20:498 / 30:81-82 |
| journey_id | 닫힘 | **PARTIAL-FALSE** | 20:169 path required·journey_id optional; 20:441 ReviewGraph엔 journey_id 없음 (OBJ-31) |
| surface vs public_surface | (일치로 봄) | **FALSE** | 30:58 `surface` vs 20:106 `public_surface`, 매핑표 미명시 (OBJ-33) |
| ICL check vs evaluator.mode | (격리됨) | **FALSE** | 30:77 cmd/query/judge vs 20:501 det/llm/exec; 30:218 예시 schema-invalid (OBJ-34) |

→ Opponent의 fresh code 대조가 정확. Producer의 "blocker 0"은 v0 축소 + cross-ref 오분류 위에 성립.

## Blocker (must-fix-first, 문서에서 닫을 것 — 코드 아님)

1. **OBJ-35 envelope** — ACG(`schema/work_item/produced_by`) vs DITTO(`schema_version/work_item_id/id`). 어댑터 없이 ACG 산출물이 기존 DITTO 계약 통과 못함.
2. **OBJ-36/38/39 재사용 CLAIM 거짓** — ReviewGraph↔reviewer-output, evidence_kind↔evidenceRef, JourneyRun↔e2eJourney 필드 매핑 미명세. "재사용"이 코드 대조에서 거짓.
3. **OBJ-33/34 ICL 컴파일** — surface→public_surface·check→mode 매핑 누락, 예시 schema-invalid.
4. **OBJ-31/32 스키마 결함** — journey 노드 path/journey_id 조건부 미적용, AssuranceSnapshot이 delta_only 감사 불가(count만).
5. **OBJ-37/48 (Q6) completion gate** — 00 §6 "재사용" 단정 vs §9 "open" 내부모순. stop.ts에 ReviewGraph 소비 슬롯 없음 → high-risk 무시 가능.

## 00 §9 열린질문 분류

| Q | 판정 | 이유 |
|---|---|---|
| Q1 재현성 | DEFERRED | warn 기본 격리 |
| Q3 ArchitectureSpec 부트스트랩 | CONDITIONAL-BLOCKER | 단계3/6 게이트 blocker, 게이트 v0 제외 시 병행 |
| Q4 fitness 비용 | CONDITIONAL-BLOCKER | 단계8 runner blocker, schema-only면 defer |
| Q6 completion gate | **BLOCKER** | v0 게이트의 정체, 내부모순, 영구 defer 불가 |
| Q7 추상화 측정 | DEFERRED | 수동 리뷰로 v0 가능 |
| Q8 코드↔제품 | SPLIT | 이해갭=영구 deferred / surfaces freshness=게이트 쓰면 blocker |

## 사용자 권고: CONDITIONAL-GO

- **지금 전면 구현**: NO (Q3/Q4 미해소)
- **must-fix 5건 문서 수정 후 좁은 v0 슬라이스**: YES
  - include: 9개 JSON Schema(ajv valid 증명) · ICL→ChangeContract 컴파일러 · ReviewGraph 어댑터 · completion gate ReviewGraph 슬롯 1개
  - exclude: 단계3 impact 게이트 · 단계6 boundary/semantic 게이트 · 단계8 fitness runner · PreToolUse scope 집행
- v0에서 닫을 fixture: ICL→스키마 valid, ReviewGraph→reviewer-output 직렬화+CompletionContract 소비, high-risk ReviewGraph가 Stop continuation 강제, AssuranceSnapshot delta_only, journey 노드 without fake path

**검증 한계**: read-only라 ajv/ICL 파서 실제 실행은 미수행, 문서/소스 정적 대조만.
