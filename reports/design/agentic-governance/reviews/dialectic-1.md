# Dialectic Review #1 — ACG 문서군

- **mode**: review (adversarial)
- **대상**: `reports/design/agentic-governance/` 6개 문서
- **Producer**: Claude (accept 제안)
- **Opponent**: Codex (codex-plugin-cc, read-only) — 14 objections
- **Synthesizer**: `revise`
- **결과**: 7 required_edit 전부 반영 + 4 medium 반영 + 1 기각 + 2 열린질문 유지 → Synthesizer가 명시한 accept 도달 조건 충족.

## verdict 근거

개념적으로 reject 사유는 없다(framing·차용 정합성·DITTO 매핑 견고). 그러나 design-lock 전에 닫아야 할:
- **내부 모순 3건**: 신설 범위(00↔20), ICL↔schema cadence, 리팩토링 생략↔게이트 의존성.
- **중심 차별점 공백**: Assurance Graph 스키마 부재.
- **게이트 기계적 정의 미비**: baseline debt, zero-miss oracle.

## objection 처리표

| OBJ | sev | 내용 | 처리 | 위치 |
|---|---|---|---|---|
| 01 | high | 신설 범위 모순(2개 vs 5개) | **반영** | 00 §6 표·결론 |
| 02 | high | Assurance Graph 시계열 스키마 부재 | **반영** | 20 §6.5 AssuranceSnapshot 신설 |
| 03 | high | baseline debt 미표현 | **반영** | 20 §6 baseline/delta_only 필드 |
| 04 | high | per-change fitness 비용 미해결 | 열린질문 | 00 §9 Q4 |
| 05 | high | ICL↔schema cadence 무손실 컴파일 불가 | **반영** | 30 §2 EBNF + §3 매핑표 |
| 06 | high | ICL 우회 시 anti-drift 미성립 | **반영** | 30 §4 정직한 단서 |
| 07 | high | llm_judged 재현성 부족 | 반영(필드)+열린질문 | 20 §6 reproducibility 구조화, 00 §9 Q1 |
| 08 | high | Characterization Test 약화 | **기각** | 40 §5 증거 서열화 오독 |
| 09 | med | DbC 용어 오적용(frame condition) | **반영** | 20 §1 용어 정밀화 |
| 10 | high | 리팩토링 생략↔게이트 의존성 모순 | **반영** | 10 §4 행 수정 + §2 단계5 입력 |
| 11 | med | Deep Module 게이트 과환원 | 열린질문 | 00 §9 Q7 + 40 §3 단서 |
| 12 | med | ADR linkage 미강제 | **반영** | 20 §1 + 10 §2 게이트 |
| 13 | high | zero-miss 게이트 oracle 없음 | **반영** | 10 §3 게이트 재정의 |
| 14 | med | Change Map grammar 부재 | **반영** | 50 §2.1b 최소 EBNF |

## 기각 사유 (OBJ-08)

40 §5는 의미 보존 증거를 명시적으로 서열화한다: #1 실제 behavior test, #2 생성된 characterization test(실행 가능), #3 llm_judged(차단 권한 없는 warn), #4 증거 불가→partial. 즉 문서는 Feathers의 실행 가능 테스트를 #1/#2로 우선하며 LLM 판정을 동작 보존 *증명*으로 격상하지 않는다. objection의 전제가 §5를 오독.

## 열린 질문으로 이월 (구현 단계)

- **OBJ-04 비용**: 어느 fitness function이 per-change로 도는지 선택 메커니즘, diff→function incremental 의존, budget/fallback. (00 §9 Q4)
- **OBJ-07 재현성**: reproducibility 필드(model_version/prompt_hash/votes/tie_break)는 추가했으나, 3-way 다수결이 실제로 재현 가능한 verdict를 내는지는 경험적 검증 필요. (00 §9 Q1)
- **OBJ-11 추상화 깊이**: 인터페이스 폭/내부 복잡도의 측정 지표는 저장소별 보정 필요. (00 §9 Q7)
