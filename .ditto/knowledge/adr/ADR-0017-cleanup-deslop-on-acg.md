# ADR-0017: 정리(Tidy/deslop) 절차를 ACG 게이트 위에 정립한다 — 2차 정적 엔진 없이

- 상태: accepted (2026-06-15 사용자 승인 — wi_2606158xq WU-0. dialectic-8·9 두 라운드 재검증 완료, verdict=revise 정정 5건 반영: catalog 변환 철회(미배선)·절대부채 신규측정(drift 재사용 아님)·trace 회귀탐지 등급강등·자동커밋 full-bar 조건화·unit-scoped 후속 WU 분리. **결정 채택이며 구현은 미착수** — WU-1~(change-scoped 코어·fitness·병렬정리)는 별도 착수 허가 대상이고 coverage/property provider 배선이 선결조건[D5]. ledger: `reviews/dialectic-8.json`·`dialectic-9.json`)
- 결정 일자: 2026-06-15
- 결정자: hskim, claude
- 관련: ADR-0006(정적 분석 엔진 = CodeQL 단일 — 이 ADR이 그 결정을 정리 워크플로에서 *재확인*), `reports/design/agentic-governance/80-acg-cleanup-deslop-plan.md`(구현 계획·작업단위·pre-mortem), `reports/design/agentic-governance/40-refactoring-criteria.md`(리팩토링 허용 게이트·Deep Module Gate·증거형식 — 이 절차가 재사용·확장), `reports/design/agentic-governance/10-methodology.md`(8단계 라이프사이클), `reports/harnesses/lazycodex-remove-ai-slops-ast-grep.md`(코드레벨 근거), wi_2606158xq

## 컨텍스트

DITTO ACG는 변경의 *계약·증거·완료 차단·지속 적합성*을 강제하는 런타임이지만, **정리(cleanup/refactoring) 자체를 돌리는 워크플로**가 비어 있었다. 게이트와 기준(`40-refactoring-criteria.md`의 G-R1~3·Deep Module Gate)은 있었으나, "구현 직후 구조를 동작 보존으로 정리하는 절차"가 오케스트레이션으로 정립돼 있지 않았다.

LazyCodex/OmO의 `remove-ai-slops`(코드레벨 재검증 완료, v4.10.0)는 검증된 정리 *전술*(테스트 선잠금 → 저위험부터 → 병렬 cleanup → 품질 게이트)을 갖지만, slop category·게이트가 markdown 지시라 강제력이 없고 결과가 미래 변경으로 승격되지 않는다. 동시에 OmO는 ast-grep을 구조 검색/치환 *도구*로 쓴다.

이 ADR은 두 결정을 박는다: (1) OmO의 *전술* + 사용자 강화안을 ACG 게이트 위의 단일 정리 워크플로로 흡수하고, (2) 그 과정에서 **2차 정적 엔진(ast-grep)을 도입하지 않는다(ADR-0006 유지)**. 정리에 구조 분석이 필요하면 CodeQL을 쓴다.

## 결정 — 개발 시 지켜야 할 구조

### D1 — 정리는 ACG 위의 "동작 보존 워크플로"로 정립한다

정리는 구현 노드의 DoD가 green이 된 직후 도는 단계다. 절차(80-plan §2): ⓪ 진입 분류기 → ① behavior lock → ② scope contract → ③ tidy plan + Deep Module 심문 → ④ 병렬 정리 → ⑥ fitness 델타 → ⑦ DoD replay → ⑧ tidy commit. 모든 단계는 **기존 ACG 원시구성요소의 배선**이지 새 기계가 아니다.

### D2 — 정리는 동작 보존만 한다. 정합성/보안 리뷰가 아니다

정리 중 버그·위협을 발견하면 **고치지 않는다** — 중단하고 구현 단계로 복귀해 거기서 수정·재검증한 뒤 정리를 재진입한다(Tidy First: 구조적·동작적 변경 불혼합, `agents/refactorer.md`의 "report not fix" 계약). 정합성/보안은 별도 형제 표면(`ditto review`)과 구현 단계의 책임이다.

### D3 — 2차 정적 엔진(ast-grep)을 도입하지 않는다 (ADR-0006 유지)

정리에 구조 분석(호출부 전수·시그니처 영향·클래스 blast radius·구조 검출)이 필요하면 **CodeQL을 쓴다**. ast-grep 등 2차 엔진은 도입하지 않는다. ADR-0006의 "단일 엔진" 유지비 결정을 정리 워크플로에서 재확인한다. (해제 조건은 아래 "철회/재검토".)

### D4 — CodeQL 3분할 정책 + DB 캐시 amortize

CodeQL 용도를 갈라 정책을 단다:
- **(a) 범위·영향 분석**(scope/plan): **무조건 필수**. 정확한 정리 범위의 전제(`impact/codeql-analyzer.ts`, `scanSignatureChanges`, `boundary/codeql-edges.ts`).
- **(b) slop 검출 fitness**(duplication/complexity): 위험-계층/스케줄.
- **(c) dataflow 동등 증거**(source→sink 불변): 위험-계층(보안/dataflow/public).

DB는 commit별 캐시(`cli/commands/codeql.ts` `cacheKey(commitSha, language)`)이므로 (a)로 한 번 빌드하면 (b)·(c)가 재사용한다. trivial/문서뿐 변경은 ⓪ 분류기가 SKIP해 DB 빌드를 막는다. (무차별 CodeQL 강제는 채택하지 않는다 — 80-plan PM-6.)

### D5 — behavior lock은 동등성 증거 사다리다 (risk-tiered)

"기존 suite가 전후 green"은 동등성 증거의 *바닥*이지 충분조건이 아니다(안 덮인 경로로 잘못된 함수 호출, 테스트 입력에만 맞는 과적합). 위험에 비례해 증거를 쌓는다:
- **L1 변경영역 커버리지 게이트 (필수)**: 정리할 함수/분기를 characterization이 실제 실행해야 한다. 미달이면 먼저 생성, 불가하면 정리 차단.
- **L2 old↔new differential (medium+ default-on)**: 정리 전/후 구현을 property-based 생성 ∪ 캡처 corpus로 비교(`old ≡ new`, 상대 oracle). 순수 함수는 출력 동등, **부수효과 코드는 trace 변종**(녹화한 외부호출·인자·순서·반환·예외를 replay). **단 trace는 회귀 *탐지*이지 보존 *증명*이 아니다(dialectic-9 OBJ-03)** — 효과 동등이 동작 보존을 함의하지 않고(내부상태·순서·동시성), golden-master는 본질상 회귀 탐지다. trace 통과=미반증, 불통과=확정 반증. OBJ-03(역상관)을 닫지 않고 *좁힌다*. 녹화/replay/intercept 하니스는 `src/` 0건 신규 프레임워크(얇은 오케스트레이션 아님). rename/move는 N/A, extract/inline/dedupe/interface는 자동 켬. 진짜 비재현 비결정성·미배선 provider는 자동 정리 부적격 → 좁은 잔여 질문(D8).
- **catalog 제약 변환(보류)**: rename/extract/inline을 구성으로 보존하는 TS 언어서비스/ts-morph 변환은 매력적이나 **repo에 미배선(`src/` 0건)**이고 ADR-0006 가드(`scripts/adr-guard.ts`가 `from 'typescript'` 차단)와 충돌한다 → 도입 시 **별도 ADR 선결**(ast-grep WU-X와 동급). '재사용 자산' 아님(dialectic-9 OBJ-01).
- **L3 CodeQL 구조 동등 (위험-계층)**: dataflow/callee 집합 불변.
- **L4 mutation probe (선택, 고위험 hot-path)**.

이로써 `semantic_safe=yes`의 정당성은 `characterizationTestRef` 존재가 아니라 **L1 충족 or L2 통과**를 요구한다(이 적정성 꼬리표는 `acg-semantic-compatibility` 스키마 확장을 요구 — 80-plan WU-2). **L1·L2는 coverage/property 러너에 의존하는데 현재 저장소에 미배선이다(provider 0건). 따라서 L1 '필수'는 provider 배선 후에만 hard-block로 작동하고, 부재 시 미검증-강등으로 fail-open한다 — 무조건 차단도 조용한 우회도 아니다(dialectic-8 OBJ-02).** provider 배선은 정리 워크플로 구현의 선결조건이다.

### D6 — DoD는 불변, replay만 한다

리팩토링은 동작 보존이므로 구현 단계 DoD를 **고치지 않는다**. 정리 후 DoD 전체를 무수정 재실행해 green을 확인하고(⑦), medium+ 리팩토링은 differential(L2)을 동반한다. DoD가 내부 구조에 결합돼 정당한 리팩토링에 red면, 그것은 정리를 막을 사유가 아니라 그 DoD가 over-coupled라는 신호로 표면화한다.

### D7 — 사용자 표면 2개를 형제로 연다 (unit-scoped)

사용자 표면은 autopilot의 **변경 범위(change-scoped)**와 달리 **단위 범위(unit-scoped)**다 — 사용자가 지정한 아키텍처 단위(코드베이스/컴포넌트/MVC 계층/REST API)의 *기존(standing) 코드*가 대상이다. 같은 behavior-preservation 엔진을 쓰되, baseline=HEAD, 진입 분류기 없음, fitness 게이트가 **절대 부채 감소**(델타-only가 아니라)다 — 사용자 표면의 목적이 기존 부채 제거이기 때문(80-plan §9).

- `ditto refactor --scope <unit>`: 단위 standing 코드를 동작 보존 정리, full-bar-gated 자동커밋을 격리 브랜치에.

> **시퀀싱(dialectic-9 OBJ-05).** unit-scoped 표면은 scope resolver·배치·집계·절대-부채 측정이 전부 신규이고, 저커버리지 standing 코드(40-criteria boxwood 2.7%)에서 L1 게이트가 대부분을 막아 대량 characterization 비용 또는 대량 skip을 부른다 → **change-scoped 코어 이후의 후속 WU(WU-4/5)**로 격리하고, 첫 단계는 한 컴포넌트 dogfood로 비용·skip율을 *측정*한다. 절대-부채 fitness는 drift(델타-추세) 재사용이 아니라 **신규 단위 스냅샷 측정**이다(OBJ-02).
- `ditto review --scope <unit> [--security]`: 단위 standing 코드 정합성/보안 감사 → `acg-review.json` ledger.

둘을 분리해야 D2의 "정리=동작 보존" 경계가 산다.

### D8 — 정리 커밋 정책 (충분 bar 충족 시 자동 커밋)

Q1이 사용자 결정으로 해소됐다(2026-06-15). 한 정리 항목이 **full bar**(L1 커버리지 + L2 differential 발산 0[pure 또는 trace] + 해당 시 L3 dataflow 동등 + fitness 델타 clean — 80-plan §4.4)를 충족하면 **자동으로 structural 커밋**한다(Tidy First — 구조/동작 커밋 분리, **격리 브랜치, push는 절대 금지**). 실패·3-strike면 그 커밋 revert로 복원·보고.

**"full bar"는 L1·L2 provider가 실제 배선돼 발화함을 요구한다(dialectic-9 OBJ-04).** provider 미배선·미검증-강등 경로에서는 bar가 L3+fitness-delta로 축소돼 비-dataflow 리팩토링의 동작보존을 구조적으로 못 보므로, **그 경로의 자동 커밋은 금지 → diff-only(격리 브랜치 누적, 사람 일괄 검토)**. 그렇지 않으면 자동 커밋이 배격한 '검증 연극'을 재생산한다(stop.ts:548-558에 L1·L2 enforcement leg가 없음을 근거로 확인).

근거: (a) 로컬 커밋은 가역적(`git reset`/`revert`)이라 push 금지 하에 비가역 위험이 낮고, (b) **대량 리팩토링 diff를 사람이 '승인'하는 게이트는 검증 연극**이다 — 사용자는 앞부분만 보고 승인하므로 결함을 못 잡으면서 가짜 확신만 만든다(사용자 통찰). 따라서 사람 승인 게이트 대신 측정 가능한 증거 bar가 게이트다. **단 bar가 구조적으로 못 보는 잔여 결함 클래스**(동시성 race·성능 회귀·계약 미스매치·trace 밖 내부 상태)에 인접한 정리는 자동 커밋 부적격으로 분리한다.

**bar 미달 항목**(비재현 비결정·커버 불가·provider 미배선)은 자동 커밋하지 않고 자동 정리 부적격으로 빼되, 사용자에겐 대량 diff가 아니라 **좁게 프레이밍된 잔여 질문**만 올린다. 이 결정은 dialectic-8 OBJ-05의 '권한 자기부여' 우려를 *사용자 명시 결정*으로, '미완 검증 위 자동 커밋' 우려를 *full-bar 조건화*로 해소한다.

## 대안 (기각/보류)

- **OmO SKILL.md 문자열 복제(prompt-only skill)** — 기각. 게이트가 없어 강제력(흡수의 핵심)이 사라진다.
- **ast-grep 도입으로 구조 검출** — 보류(WU-X). ADR-0006 유지비 결정과 충돌. CodeQL로 먼저 시도한다.
- **모든 리팩토링에 full ACG ledger 5종 강제** — 기각. 축소 cleanup profile로 돈다(scope+behavior-lock+fitness델타, Impact/Review는 public surface일 때만).
- **CodeQL 무차별 강제** — 기각. 3분할 + DB amortize(D4).
- **behavior lock = 기존 suite green만** — 기각. 과적합·커버리지 사각을 못 막는다(D5).

## 철회/재검토 조건

- **ast-grep 재고(D3 해제)**: (1) CodeQL/command provider가 정리 detection에서 비용 때문에 실사용 불가로 *측정*되고, **그리고** (2) 동일 검출을 CodeQL 쿼리로 표현 시 표현력/비용이 명백히 열위임이 실측되면 → 별도 ADR로 ast-grep 재고. 둘 다 충족 전에는 도입하지 않는다.
- **L2 강등 비율이 높으면(D5)**: dogfood에서 seam 부재로 미검증 강등이 과반이면 → L2 적용 범위/capture harness 전략을 재검토(80-plan PM-9). **역상관 주의(dialectic-8 OBJ-03)**: 강등이 seam-hard 코드(부수효과·비결정)에 집중되면 lock이 L1만 남아 출력 보존을 못 본다 — 강등 비율과 *강등된 코드에서 회귀가 새는지*를 함께 측정한다.
- **fitness 델타 오탐(80-plan PM-13)**: method move/extract가 옮긴 기존 부채를 새 위반으로 잡으면(`normalizeViolationIdentity` enclosing 의존) → 이동 보정(relocation-aware baseline)이 듣지 않는 것이므로 델타 정의를 재검토.
- **DB amortize 실패(D4)**: tidy 커밋이 캐시키를 무효화해 재빌드가 빈발하면 → 분석을 baseline DB 1회 + 정리후 1회로 고정하는 전략 재점검(PM-10).
- **ADR-0006이 바뀌면** → D3·D4 전제 재검토.
