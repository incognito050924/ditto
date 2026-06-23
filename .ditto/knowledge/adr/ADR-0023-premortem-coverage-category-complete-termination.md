# ADR-0023: pre-mortem coverage 종료 재정의 — novelty-dry에서 카테고리-완전 종료 + 정당화-close 게이트로

- 상태: accepted
- 결정 일자: 2026-06-22
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: ADR-0021 (memory seam — 라이브 entanglement 주입은 이 seam 경유 소비, §8-5 후속·내부 결박 금지), ADR-0020 (결정-모순 가드레일 — close 게이트 fail-closed·정당화-기록 철학과 정합), ADR-0014 (e2e DSL·게이트 — 하류 outcome 게이트가 ac-11 false-negative 루프의 검출원). 코드(권위): `src/core/coverage-loop.ts`(`nextCoverageNode`·`enforceClose`·`recordCoverageRound`), `src/core/coverage-manager.ts`(`isCoverageTerminated`·`closeNode`·`coverageDryK`·`TIER_DEPTH`), `src/core/coverage-taxonomy.ts`(floor·`farFieldLenses`·`farFieldCoverageNodes`·`farFieldCategoriesEnabled` — 카테고리 수의 SoT). 커밋: 9a73bb0·ac962d0·8446459·fb371ca·d060d7f(브랜치 wi_260622vjo-farfield). 메모리: premortem-far-field-redesign.

## 컨텍스트

pre-mortem coverage 엔진(`coverage-loop.ts`·`coverage-manager.ts`)은 autopilot plan-stage에서 위험을 sweep한다. 종료 판정 `isCoverageTerminated`(`coverage-manager.ts`)는 **novelty-dry** — K 연속 라운드 동안 새 가지(admissible branch)가 안 나오면 종료 — 하나에만 의존했다.

핵심 결함:

- novelty-dry는 **시딩된 적 없는 도메인을 영영 안 보여도 종료**시킨다. LLM이 우연히 떠올리지 못한 간접 영향 분야(far-field — 기능적으로 먼 feature·환경·인증·타 도메인 결합) 실패 모드는 "새 가지 없음"으로 보여 dry로 닫힌다 → false-green(거짓 완료)이 한 단계 상승.
- sweep judge input의 `cross_cutting_constraints`가 `[]`로 하드코딩돼(`coverage-loop.ts`), judge가 지역 노드 + 의도 문자열만 보고 먼 도메인 맵을 못 받았다.
- 노드 close에 정당화 기록이 없어 **조용한 skip**이 가능했다(어느 카테고리를 왜 안 봤는지 감사 불가).

## 결정

pre-mortem coverage 종료를 novelty-dry 단독에서 **카테고리-완전 종료 + 정당화-close 게이트**로 재정의한다. 모두 가산적·플래그·기존 테스트 green 유지(회귀 0).

1. **카테고리-완전 종료.** 간접 영향 분야(far-field) floor taxonomy(`coverage-taxonomy.ts` — 카테고리 수의 SoT)의 각 카테고리를 coverage **노드**로 시딩한다(`farFieldCoverageNodes`). `isCoverageTerminated`의 로직은 그대로(모든 노드 closed 요구)이되, 종료가 이제 **각 카테고리의 명시적 sweep+close**를 요구한다. un-swept 카테고리가 열려 있으면 novelty-dry만으로 종료 불가. 노드트리가 곧 per-category sweep ledger다(신규 기계장치 없음).

2. **정당화-close 게이트(fail-closed).** 노드를 resolved 외 상태(out_of_scope/user_owned)로 닫을 때 `close_reason`이 없으면 `enforceClose`(`coverage-loop.ts:209`)가 거부한다. `close_reason`은 노드(`closeNode`, `coverage-manager.ts:72`)·라운드 payload에 기록(감사가능). resolved close는 무영향. → 조용한 skip 차단.

3. **렌즈 주입(무조건).** sweep judge input의 `cross_cutting_constraints`를 `[]`에서 `farFieldLenses()`(floor 카테고리를 명사가 아니라 *probing question*으로)로 바꾼다. 종료/close-gate를 안 건드리고 judge가 보는 것만 바꾸므로 무조건 ON이며, 공유 엔진(`nextCoverageNode`)을 구동하는 모든 표면(autopilot plan-stage·deep-interview intent-stage)에 닿는다.

4. **강도 = 깊이(폭 불변).** 종료 깊이 K를 고정 상수에서 stakes tier 도출로 바꾼다(`coverageDryK(tier)` → `TIER_DEPTH[tier].maxRoundsPerNode`: light=1 / standard=2 / full=3, `coverage-manager.ts:576-597`). tier 입력 없으면 standard(K=2) = 기존 기본값. **폭(카테고리 집합)은 항상 전수·불변, 깊이만 stakes 비례.**

5. **보존(가산·플래그).** 카테고리-노드 시딩은 `farFieldCategoriesEnabled()`(env `DITTO_FARFIELD_CATEGORIES`=0/off/false로 끔, 기본 ON·opt-out, autopilot plan-stage CLI에서만 소비; `coverage-taxonomy.ts:172`)로 게이트. off = root-only 트리 = 기존 novelty-dry 동작 그대로. 엔진 직접 호출자 `nextCoverageNode`는 `seedCategories` 기본 false 유지. → 기존 autopilot plan-stage coverage 동작 보존(전체 2671 테스트 green).

핵심: 망라 종료가 "novelty가 말랐다"가 아니라 **"시딩된 모든 카테고리가 명시적으로 다뤄졌다(swept-dry 또는 정당화-close)"**로 증명 가능해진다.

## 적용 범위 · 미착지 (정직)

이 ADR이 기록하는 landed 계약: 정적 taxonomy floor 기반 카테고리-완전 종료 + 정당화-close 게이트 + 렌즈 주입 + stakes-깊이(위 커밋들).

아직 미착지 — **이 종료 계약을 무효화하지 않는 가산 확장**(후속):

- **적대 증거 게이트(anti-SLOP)**: 위험마다 refute-by-default 독립 검증(dialectic Opponent 재사용)을 통과해야 "유효"로 카운트. 종료 재정의가 아니라 *카운트 자격*에 얹는 가산 레이어라 이 ADR과 호환(별도 ADR/amendment 불요).
- **memory seam entanglement**: 라이브 그래프 결박을 ADR-0021 seam 경유로 카테고리 시딩에 주입. gap=가서봐(미확인을 "결합 없음=안전"으로 종료 근거 삼지 않음), fail-open=taxonomy floor.
- **deep-interview 카테고리-노드 시딩**: 렌즈 주입(결정 3)은 deep-interview intent-stage에 이미 닿으나(`interview-driver.ts`가 `nextCoverageNode` 호출), 카테고리-노드 하드 종료(결정 1)는 autopilot plan-stage 전용 — intent-stage에 시딩하면 카테고리 전수 close 요구로 비종료 위험이 있어 별도 처리 선행 필요.

#### tech-spec 표면 — autopilot plan-stage 위임 (option B, 2026-06-22 결정 · ac-5)

tech-spec은 **자체 far-field sweep을 돌리지 않는다.** tech-spec finalize(`tech-spec.ts`)는 deep-interview와 **동일한** `bootstrapAutopilot` 경로를 거쳐 같은 초기 그래프(`buildInitialNodes`의 N1 `design` 노드)를 만들고, 그 design 노드의 plan-stage sweep이 far-field 카테고리를 시딩한다(`farFieldCategoriesEnabled()` 기본 ON). 즉 tech-spec에서 출발한 work item의 간접 영향 분야(far-field) coverage는 autopilot plan-stage에서 **transitive하게** 실현된다 — tech-spec 단계에 별도 엔진을 연결하지 않는 것이 의도다. (대안 A=tech-spec finalize 전 자체 sweep은 비용·중복 때문에 기각; "세 표면 공유 엔진"은 공유 bootstrap→plan-stage 경로로 충족.) 검증: 체인이 코드로 성립 — tech-spec.ts→bootstrapAutopilot→N1 design(autopilot-graph.ts)→SKILL §2b plan-stage coverage-next(라이브 e2e에서 19 카테고리 시딩 확인).

## 기각된 대안

- **novelty-dry 유지 + 프롬프트만 강화**: 미시딩 도메인 맹점을 못 푼다(우연한 상상 의존 그대로) → 기각.
- **별도 망라-검증 레이어 신설**: 기존 노드트리·close-gate·dry-counter가 이미 sweep ledger·종료 계약을 제공한다. 신규 기계장치 없이 배선으로 충분(얕은 추상화 회피) → 기각.
- **플래그 없이 카테고리 무조건 강제**: 기존 autopilot plan-stage 종료를 회귀시킨다 → 플래그·가산 채택(보존이 비목표 회귀를 막음).

## 철회 · 재검토 조건

- 카테고리-완전 종료가 실측에서 **비용 때문에 기능 OFF**를 유발하면(비싸서 끄는 역설) → 강도 dial 기본값·per-plan 예산을 재조정. 종료 재정의 자체는 불변.
- ADR-0021 memory seam이 standalone로 이관되면 → entanglement 주입 소스만 seam 뒤에서 교체(이 종료 계약 불변, 내부 결박 금지).
- 하류 게이트(autopilot verify/review/e2e·`ditto verify`)가 **dry로 닫았거나 미시딩한 카테고리의 실패를 반복 검출**하면 → 사용자 귀속 결정으로 floor taxonomy를 보강한다(카테고리는 닫힌 목록이 아니다; completeness critic이 새 카테고리를 시딩할 수 있다).

### far-field 자동화 보류 (2026-06-23 · wi_26062257r ac-4)

far-field outcome-loop **자동화**(자동 집계 · 임계 트리거 · 자동 sweep)는 **보류(미채택)**. detect + propose + manual(on-demand) 설계가 충분하다고 확정한다. (이번 작업에서 새 far-field sweep을 돌리지 않고 §3 기존 비용 표본 2건으로 판정.)

근거(기존 비용 실측, 임베드):

- far-field sweep 비용 = light tier·Opponent-only 기준 카테고리당 **~35.25k 토큰** (표본 2건: authentication 25.2k, reuse 45.3k). 19-카테고리 floor로 외삽 ≈ **670k 토큰(Opponent only)** ~ **2–3M 토큰(3역 dialectic 전체 + judges)** — 작은 변경 1건당.
- false-negative: 두 표본 모두 **0** (sweep 위험 0, verify 전수 pass와 일치).
- 결론: 작은 작업에 자동 far-field sweep은 비실용적(수십만~수백만 토큰)이고 false-negative는 희소 → detect + propose + manual 설계가 정당. 자동 집계·임계 트리거·자동 sweep은 비용 대비 가치가 낮다.

재검토 트리거: far-field **비용 구조 재측정**은 별도 work item **wi_26062227h**("far-field 비용 구조 측정·재설계")로 분리한다 — (a) far-field ON vs OFF 한계비용(노드 1→20, ~20배 추정이나 직접 측정된 적 없음), (b) 19-sweep 분할 vs 단일-통합 sweep의 품질/비용 비교. 둘 중 하나라도 이 보류를 재개할 수 있다.

(주: 이 기록은 ADR-0023 자체의 기존 철회 경로 — "비용 때문에 기능 OFF면 강도 dial·예산 재조정", 위 첫 bullet — 를 비용 측정으로 자동화 판정에 적용한 **정렬**이지, 새 모순 결정이 아니다. ADR-0023을 supersede하지 않는다.)
