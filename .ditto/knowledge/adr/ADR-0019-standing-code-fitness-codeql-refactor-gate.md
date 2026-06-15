# ADR-0019: standing-code fitness 분석기 — CodeQL을 refactor 게이트로

- 상태: proposed (2026-06-15 사용자 결정 — "① CLI 단독 full-bar" 조사 후 옵션 채택. **결정 채택이며 구현 검증은 미완** — implementation으로 검증되기 전까지 proposed 유지. dialectic-10(review, verdict=revise) 통과 — OBJ-A 반영해 D1 재작성(metrics→custom problem 쿼리), OBJ-C 반영해 D4 코드의무화. 관련: wi_260615t8o + full-bar-wiring WI, reports/design/agentic-governance/reviews/dialectic-10.md)
- 결정 일자: 2026-06-15
- 결정자: hskim, claude
- 관련: ADR-0006(정적 분석 엔진 = CodeQL 단일 — 이 ADR의 D2가 그 "work-item-gated" 스코프를 명시적으로 넓힘), ADR-0017(정리 워크플로 — 이 ADR이 그 D7 unit-scoped 표면의 절대-부채 게이트를 분석기로 채움), `src/acg/tidy/unit-refactor.ts`(`assessUnitDebt`·before/after debt), `src/core/worktree.ts`(`createWorktreeForRun` — HEAD 베이스라인 materialize), `reports/design/agentic-governance/80-acg-cleanup-deslop-plan.md`, wi_260615t8o

## 컨텍스트

`ditto refactor --scope`(unit-scoped standing 코드)의 §4.4 full-bar는 "위반 감소(debt decrease)"를 요구한다. 그러나 duplication / complexity는 스키마 / ICL 라벨일 뿐 분석기 0건이고, `ditto refactor`엔 `--work-item`이 없어 fitness 함수 자체가 0개다 → 측정할 위반이 없어 full-bar 도달 불가다.

ADR-0006은 CodeQL 단일 엔진을 정하되 그 비용을 work-item · 변경파일 한정 · commit-sha 캐시 실행으로 스코프했다. 분석기로 TS-AST를 쓰는 것은 ADR-0006 D2로 금지되어 있다. 따라서 standing-code 부채를 측정하려면 (1) CodeQL을 분석기로 쓰고, (2) ADR-0006의 work-item-gated 스코프를 standing-code 게이트까지 명시적으로 넓혀야 한다.

## 결정 — 개발 시 지켜야 할 구조

### D1 — standing-code 위반을 임계값 기반 커스텀 `@kind problem` 쿼리로 산출한다 (dialectic-10 OBJ-A)

duplication / complexity 위반을 **임계값 기반 커스텀 `@kind problem` 쿼리**(예: cyclomatic complexity > N, duplicated block ≥ M행)로 산출한다(정책 내 단일 엔진 — ADR-0006 준수, 2차 엔진 미도입). `codeql` CLI는 로컬 가용(2.25.6 확인).

**기성 metrics 쿼리는 쓸 수 없다(검증 확정).** CodeQL 표준 js 쿼리팩(2.3.11)의 `Metrics/*.ql`은 전부 `@kind treemap`이고 duplication(`FLinesOfDuplicatedCode.ql`·`FLinesOfSimilarCode.ql`)은 `where none()`라, `codeql database analyze --format=sarif`가 SARIF `results[]`(alert)를 산출하지 않는다 — `sarifToViolationIds`(`src/acg/fitness/codeql-provider.ts`)가 읽는 `runs[].results`가 비어 violation이 0건이 된다. 따라서 metric 값을 alert로 바꾸는 임계값 술어를 가진 커스텀 problem 쿼리를 작성한다. 이는 D1의 원래 철회조건(metrics 쿼리 부적합 시 교체)을 발동한 것이며, 같은 CodeQL 엔진을 쓰므로 ADR-0006(2차 엔진 금지)에 위배되지 않는다. 임계값 N·M의 기본값은 구현 시 방어 가능한 값으로 고정하고 근거를 남긴다.

### D2 — ADR-0006 스코프 확장: work-item 없는 standing-code refactor 게이트 허용

CodeQL을 work-item 없는 standing-code refactor 게이트로도 허용한다. 이는 ADR-0006의 "work-item-gated" 스코프를 **명시적으로 넓히는 결정**이다. 비용(DB 빌드 ~9.5s–3min/회)은 commit-sha + language 캐시로 amortize하고, ⓪ 분류기 / 스코프 축소로 불필요한 빌드를 막는다. `ditto refactor`는 opt-in 표면이라 이 지연을 수용한다.

### D3 — HEAD↔worktree debt 측정

기존 `src/core/worktree.ts`의 `createWorktreeForRun`(HEAD를 격리 워크트리로 materialize)로 HEAD 베이스라인을 떠서 분석기를 돌려 `beforeIds`, 워킹트리에서 `afterIds`를 얻어 `assessUnitDebt`(`unit-refactor.ts`)로 before / after debt를 계산한다. `before == after` placeholder를 대체한다.

### D4 — fail-open 보존 (OBJ-02 일관) — 텍스트가 아니라 호출부 코드에서 (dialectic-10 OBJ-C)

`codeql` 부재 / 실패 / 타임아웃 시 debt 측정 불가로 degraded(diff-only), hard-block 금지. full-bar는 분석기가 실제 발화할 때만.

fail-open은 ADR 문장이 아니라 **호출부 코드**에서 보존해야 성립한다. `runCodeqlAnalysis`(`src/core/codeql/runner.ts`)는 DB create/analyze 실패 시 **throw**하므로, `ditto refactor`(refactor.ts)는 이 호출을 `try/catch` + 타임박스로 감싸 throw·타임아웃을 degraded(diff-only)로 변환해야 한다. 변환을 빠뜨리면 refactor가 `RUNTIME_ERROR_EXIT`로 fail-**closed**가 되어 D4 불변식이 깨진다.

## 철회/재검토 조건

- refactor 게이트의 CodeQL 비용이 실사용에서 과하면 → 캐시 / 스코프 정책 강화, 또는 게이트에서 제외(측정 표면으로 강등).
- CodeQL metrics 쿼리가 duplication / complexity에 부적합하면 → 쿼리 교체.

## 대안과 기각 이유

- **(a) debt 게이트 제외** — full-bar 도달 불가로 ① 목표 미달. 사용자 기각.
- **(b) TS-AST 기반 분석기** — ADR-0006 D2 위반. 기각.
- **(c) 새 2차 정적 엔진 도입** — ADR-0006 / ADR-0017 D3 위반. 기각.
