# Dialectic Review — Pre-mortem Coverage Engine Contract

- **대상**: `reports/design/contracts/premortem-coverage-contract.md` (설계 초안, 구현 전)
- **mode**: review (3역 별도 컨텍스트: Producer / Opponent / Synthesizer)
- **일자**: 2026-06-14 KST
- **work item**: wi_260614ojc
- **verdict**: **revise** — 진단·아키텍처 골격은 건전, critical 3건은 제거가 아니라 정직한 재표기·수치화로 닫힘

## Producer 요지
계약이 실패(매몰→암묵 범위 축소)를 정확히 진단하고 헌장 §4-9(fresh context)·§4-6(축소 금지)의 직접 구현. 재사용 주장 다수가 실제 스키마와 일치(dialectic 3역·opponent-router·approval_gate enum·self_answer_attempts). 인정 약점: 비용, 구현 미실증, depth_weight 추정, K 정당화, DAG 종료, dialog 비대화.

## Opponent — admissible blocker (critical 3)
- **OBJ-1**: "누적 판단 지점 0" 거짓 — Manager가 fresh judge에 줄 cross-cutting 제약 선택 자체가 의미 판단.
- **OBJ-2**: "범위별 readiness 게이트 재사용" 코드와 불일치 — `interviewReadinessGate`는 인터뷰 전체 단일(gates.ts:54), depth_weight 0건 → 신규.
- **OBJ-3**: 종료 미보장 — dry=K회 0인데 K 미정, append-only + fresh critic이 새 가지 동기.

major: OBJ-4(비용 모델 부재), OBJ-5(4축 직교성 미검증), OBJ-6(plan_brief/approval_gate 스키마 미검증), OBJ-7(평면↔트리 투영 false-green), OBJ-8(범위 과대), OBJ-9(fresh가 동일모델 상관 사각지대엔 무력). minor: OBJ-10(out_of_scope 승인 부담).

## Synthesizer 판정 (코드 직접 재확인)
재사용 충돌 판정: **Opponent가 옳다** — readiness 게이트·depth_weight·plan_brief gate는 신규/확장(gates.ts:54-71, autopilot.ts:159-165, autopilot-driver.ts:18-22 직접 확인). dialectic 3역·self_answer_attempts는 재사용 사실.

### 채택 → 계약 반영 완료
| OBJ | 수정 | 반영 위치 |
|---|---|---|
| OBJ-1 | "누적 판단 0" → "영속 누적 컨텍스트 0, 제약 선택도 fresh·무상태 judge" | §4.1 |
| OBJ-2 | readiness/depth_weight = 신규+어댑터로 재표기 | §3.2, §4.4, §10 |
| OBJ-3 | dry = admissible-novelty 소진(K=2, critical/major만 리셋) | §4.5, §5, §11 |
| OBJ-4 | 경량화 3등급(light/standard/full) + caps 상한 | §8.2 |
| OBJ-6 | plan_brief = approval_gate 확장(필드 신규+mutationGate 로직) | §7.2, §10 |
| OBJ-7 | false-green 불변식(부모는 서브트리 dry 전 resolved 금지) | §3.2, §11 |

### 기각 (근거)
- **OBJ-5**: 메커니즘은 직교(중립성=leading 검수, 발견=critic loop). 5번째 양상은 oracle 미매핑 → open question으로.
- **OBJ-9**: 모델 다양성 근본 한계(opponent-router 소관). 이미 Codex 우선 + 인간 교정으로 부분 완화. 계약 변경으로 환원 안 됨.
- **OBJ-10**: out_of_scope 승인은 §4-8이 허용하는 가치 판단. 경량화로 완화.

## 사용자 결정 영역 (remaining open)
- **OBJ-8 범위 분리**: 이 계약을 (A) coverage 트리+종료 / (B) per-node 게이트 / (C) plan_brief+gate 세 work item으로 쪼갤지 — §4-8 가치 결정.
- 5번째 매몰 양상(우선순위/시간축)을 축으로 추가할지.
