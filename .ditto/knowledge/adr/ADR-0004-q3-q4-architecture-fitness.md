# ADR-0004: ACG Q3·Q4 — ArchitectureSpec 출처 & 적합성 함수 비용 정책

- 상태: accepted
- 결정 일자: 2026-06-04
- 결정자: hskim, claude (claude-opus-4-8) · Opponent: codex (codex-plugin-cc)
- 관련: ADR-0002 (Schema SoT), 00-framework.md §9 Q3/Q4, wi_260603f1e, reviews/dialectic-1 (verdict=revise)

## 컨텍스트

ACG 00-framework §9는 후속 구체화에서 닫을 열린질문을 둔다. 그중 Q3(ArchitectureSpec의 출처/부트스트랩)·Q4(적합성 함수의 비용/incremental)를 3역 적대적 숙의(Producer / Opponent=codex / Synthesizer)로 다뤘다. dialectic-1 ledger 참조. 이 결정은 **설계 정책**이며 게이트/러너 코드 구현은 별도 work item이다. 스펙 본문(00~50)은 dialectic-5까지 lock — 이 결정은 §9(닫을 질문 영역)만 갱신하고 본문 규칙·스키마를 바꾸지 않는다.

## 결정

### Q3 — ArchitectureSpec 출처: 하이브리드 부트스트랩 (user 권위 기본)

- ArchitectureSpec은 **`produced_by=user` 권위 기본**의 수동 카탈로그(저장소당 1회). 스키마는 `produced_by=agent|user` 둘 다 이미 허용(acg-common.ts:20).
- agent는 의존/import 그래프에서 **관측 가능한 `layers`/`public_surfaces`만 비권위 candidate로 제안**하고, 사람 비준 시 권위화한다.
- **`forbidden_dependencies`·`layers.can_call`는 관측에서 자동 박제 금지** — 현재 코드의 (있거나 없는) 의존을 규칙으로 굳히면 위반을 정상으로 동결하거나 우연한 부재를 강제 규칙으로 만든다. boxwood의 SB 버전 3종은 도입 시점에 이미 위반이지 규칙이 아니다(20-contracts.md:407).
- 소비처인 단계6 boundary 게이트가 v0 범위 밖이므로 이 결정은 **deferred(목표상태)** — Q6 선례(00-framework.md:239) 형식.

활성 선결조건(충족 전엔 agent 경로 비활성):
- layers/public_surfaces 자동분류 정밀도 PoC (00-framework.md:134은 boundary 검사를 "추론" 등급으로 둠).
- "관측된 현실 vs 의도된 규칙"의 **기계 판독 표현** — `module_invariants`(array<string>)의 주석 규약은 기계 파싱 불가이므로, boundary 게이트가 invariant를 소비하기 전에 타입드 invariant 레코드(또는 파서테스트 있는 정규화 규약/별도 debt registry)가 필요하다.

### Q4 — 적합성 함수 비용: mode별 차등 + fail-closed escalation

비용 정직 3구간(실측, codeql-research-ko.md:448-452, 493-494, 524):
- `~3.9s` = **캐시 DB + 단일 커스텀쿼리 재실행만**.
- 변경/신규 파일 = cold DB create/analyze **13.8s~34s**(대형 frontend DB~30s·분석~1분, Kotlin clean build 추출 3분26초).
- security-extended 전체(104쿼리) = **34s~1분**.

evaluator.mode별 스케줄:
- **deterministic**: 싼 커스텀 가드 → `cadence.per_change`(세션 시작 DB 1회 캐시 후 쿼리만 증분). 전체 스위트 → `reviewer / on_release / periodic`(per_change 금지). 동등성은 정규화 `violation_identity`(rule + semantic symbol + enclosing function + normalized path hash), raw `file:line` 금지(20-contracts.md:419). `baseline.delta_only`로 신규 위반만 `on_violation`.
- **llm_judged**: 변경 표면만 평가 + vote budget 상한. `on_violation=warn` 기본.
- **executed**: `execution.selection ∈ {risk_tiered, sampled}` + `cadence.periodic=on_release`. **per_change 전수 금지**(20-contracts.md:602).

**안전 불변식 (load-bearing):** risk tiering의 base는 `ChangeContract.risk_default`(수동 enum, 계산 점수 아님; acg-change-contract.ts:52). ImpactGraph/boundary 입력이 **부재하거나 `journey_unknown`이면 high-risk로 escalate(fail-closed) — 절대 sample down 금지**. ImpactGraph는 현재 스키마만 있고 생산기가 없다(acg-impact-graph.ts).

incremental 정직 한정: **쿼리 평가 = 증분(캐시 DB 위), DB 추출 = 언어당 전역**. per-file 증분 추출은 미실증이므로 약속하지 않는다. delta_only는 **violation_identity recipe가 생기기 전까지 조건부 유효** — 안정 식별자 부재 시 위반을 은닉하지 말고 보고한다(fail-closed).

범위: Q4는 **비용 정책 결정까지만** 닫는다. fitness runner/scheduler·ICL emit·ImpactGraph 생산기는 분리된 fast-follow work item(아래).

## 근거

- 스키마가 두 결정을 이미 수용: `produced_by`(agent|user), `execution.selection`(per_change/risk_tiered/sampled/periodic), `baseline.delta_only`, `cadence`, `unresolved.journey_unknown` 모두 기존 필드. 신규 스키마 0 = ADR-0002 SoT·단순성 원칙 준수.
- 실측이 mode별 차등을 강제: 캐시 후 단일쿼리는 인터랙티브(~3.9s)지만 cold 추출·전체 스위트·컴파일 build는 루프 부담 → executed 매변경 전수 금지가 측정으로 뒷받침됨.
- forbidden_dependencies 자동 박제 금지·fail-closed escalation은 Opponent의 admissible objection(OBJ-3/4/8/9)에서 도출된 안전 결정.

## 대안 (기각)

- **ArchitectureSpec 전자동 추출**: 현재 코드를 의도된 경계로 박제 → 위반 동결. 기각.
- **ArchitectureSpec 전수동만**: boxwood처럼 암묵적 경계에서 빈 산출물·낙후 위험. 하이브리드(관측은 candidate, 규칙은 사람)가 양쪽을 막음.
- **risk tiering을 ImpactGraph 의존으로**: 생산기 없음 → 미상 시 sample down하면 위험 변경을 놓침. 대신 미상=escalate(fail-closed).

## 철회/재검토 조건

- per-file 증분 DB 추출이 실증되면 incremental 단위 한정을 완화.
- ImpactGraph 생산기·boundary 게이트가 구현되면 risk tiering base를 risk_default에서 ImpactGraph로 승급하고 Q3 agent candidate 경로를 활성.
- 타입드 invariant 표현이 도입되면 module_invariants 주석 규약을 대체.

## Fast-follow work item (이 결정에서 분리, silently fold 금지)

1. 단계6 boundary 게이트 (타입드 invariant 표현 선결).
2. ArchitectureSpec agent candidate 경로 + layers 분류 PoC.
3. FitnessFunction runner/scheduler + violation_identity recipe(라인이동/리네임/source-sink 테스트) + AssuranceSnapshot 산출.
4. ImpactGraph 생산기 (변경 표면 → affected_nodes; 미상 시 journey_unknown).
