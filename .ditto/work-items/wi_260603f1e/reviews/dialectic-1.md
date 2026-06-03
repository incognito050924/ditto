# Dialectic 1 — ACG Q3·Q4 설계 숙의 (wi_260603f1e)

- mode: decision · review_id: rv_260603f1eq34
- Opponent: codex (codex-plugin-cc:codex-rescue), fallback 없음
- **verdict: revise (양 트랙)** — 입장은 수렴, 단 기록 산출물(ADR·§9·이 ledger) 적용과 활성 선결조건 때문에 accept 아님.

## Q3 — ArchitectureSpec 출처/부트스트랩
**합의**: `produced_by=user` 권위 기본의 수동 카탈로그. agent는 의존/import 그래프에서 관측 가능한 `layers`/`public_surfaces`만 **비권위 candidate**로 제안(사람 비준 시 권위화). `forbidden_dependencies` 자동 박제 금지(현재 위반을 규칙으로 굳히는 위험 — boxwood SB 3종은 규칙 아닌 부채). 소비처인 단계6 boundary 게이트가 v0 범위 밖이라 **deferred 결정**(목표상태). 활성 선결: layers 분류 PoC, 타입드 invariant 표현(주석 규약은 기계 파싱 불가).

## Q4 — 적합성 함수 비용/incremental
**합의**: evaluator.mode별 비용 차등.
- 비용 정직 3구간: `~3.9s`=캐시 DB+단일 커스텀쿼리만 / 변경파일=cold 13~34s / 전체 스위트(104쿼리)=34s~1분.
- deterministic: 싼 커스텀 가드=`per_change`, 전체 스위트=`reviewer/on_release/periodic`.
- executed: `risk_tiered/sampled`+`periodic`(per_change 전수 금지).
- **안전 불변식**: ImpactGraph/boundary 입력 부재 또는 `journey_unknown`이면 **high-risk로 escalate(fail-closed), 절대 sample down 금지**.
- incremental 정직 한정: 쿼리=증분(캐시 DB), 추출(DB)=언어당 전역. delta_only는 violation_identity recipe 생기기 전까지 조건부 유효(부재 시 보고 fail-closed).
- Q4는 **비용 정책 결정까지만** 닫힘. runner/scheduler/ICL emit/ImpactGraph 생산기는 분리 fast-follow.

## Opponent objection 처리
14건 전부 accepted(미해소 0). admissible(critical|high) 11건: OBJ-1·13(기록 산출물=ADR·§9·이 ledger 적용으로 해소), OBJ-8·9(fail-closed escalation으로 해소), OBJ-6·7(비용 3구간 재서술), OBJ-2·3·4·11(활성 선결조건으로 기록), OBJ-10(범위=비용 정책까지만, runner 분리). medium 3건(OBJ-5·12·14) surface.

## required_edits (이 work item에서 적용)
1. 신규 ADR-0004 (Q3·Q4 결정). 2. 00-framework §9 Q3·Q4 결정으로 재서술. 3. 이 ledger 영속화. 4. fast-follow work item 명명. 5. 스키마 변경 없음.
