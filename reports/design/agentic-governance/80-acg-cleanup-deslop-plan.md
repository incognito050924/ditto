---
title: "ACG 개선 계획 — 정리(Tidy/deslop) 절차를 ACG 게이트 위에 정립 + autopilot 배선 + 사용자 표면 2개"
kind: plan
status: proposed
last_updated: 2026-06-15 KST
revision: v4 (dialectic-9 verdict=revise 반영 — catalog 변환 철회·절대부채 신규측정 정정·trace 회귀탐지 강등·자동커밋 full-bar 조건화·unit-scoped 후속 WU 분리. dialectic-8 정정분 유지)
scope: "LazyCodex/OmO의 remove-ai-slops 운영 패턴을 코드레벨로 검증한 결과 + 사용자가 추가한 강화안을, DITTO ACG에 '정리(Tidy)를 거버넌스 게이트 위에서 도는 단일 워크플로'로 정립하는 구현 계획. 절차·진입게이트·동등성 증거 사다리·CodeQL 정책·autopilot 배선·사용자 표면 2개·작업단위·pre-mortem·미해결질문을 적재한다. 아직 구현 전(proposed)."
parent: 00-framework.md
source_report: reports/harnesses/lazycodex-remove-ai-slops-ast-grep.md
related_adr: [ADR-0006-static-analysis-engine-codeql.md, ADR-0017-cleanup-deslop-on-acg.md]
related_criteria: 40-refactoring-criteria.md
ingests: 60-practice-ingestion-map.md
work_item: wi_2606158xq
---

# ACG 개선 계획 — 정리(Tidy/deslop)를 ACG 게이트 위에 정립

> **이 문서의 위치.** [60-practice-ingestion-map.md](60-practice-ingestion-map.md)가 "외부 engineering practice를 ACG로 흡수하는 후보 지도"라면, 이 문서는 그 지도에서 한 후보 — **LazyCodex/OmO의 `remove-ai-slops` 운영 패턴** — 를 실제로 DITTO ACG에 내리는 구현 계획이다. 사실 근거는 코드레벨 재검증을 마친 [harness 보고서](../../harnesses/lazycodex-remove-ai-slops-ast-grep.md)(2026-06-15 재검증, OmO 루트 v4.10.0 / `245fd8f`)다. 절차의 *게이트·증거·모듈 설계* 부분은 이미 형식화된 [40-refactoring-criteria.md](40-refactoring-criteria.md)와 [10-methodology.md](10-methodology.md)의 8단계 라이프사이클을 재사용한다 — 이 계획의 새 코드는 **기존 원시구성요소의 얇은 오케스트레이션**이다.

> **상태.** `proposed`. 이 문서는 계획이며, WU-1 이후의 코드 구현은 별도 착수 허가가 필요하다(Charter §3 — lazy default). WU-0(ADR-0017)만 이 계획의 일부로 권고한다. **v3는 dialectic-8(verdict=revise)의 [필수] 4건(OBJ-01 fitness 식별자 모순·OBJ-02 provider 선결조건·OBJ-05 D8 diff-only 강등·OBJ-08 분류기 순환 제거) + 부차 정정을 반영했다**(ledger: `reviews/dialectic-8.json`). 잔여 미결 가치판단은 Q1(자동커밋 비가역 경계) 하나다.

## 0. IntentContract (범위 보존)

- **달성할 결과**: OmO `remove-ai-slops`의 검증된 *전술*(테스트 선잠금 → 낮은위험부터 → 병렬 cleanup → 품질 게이트) + 사용자 강화안(동등성 증거 강화·CodeQL 범위분석·DoD replay·deep-module 심문·표면 2개)을, DITTO ACG의 *강제력*(ChangeContract+PreToolUse 차단, SemanticCompatibility, FitnessFunction 델타, Stop 게이트) 위에서 도는 **하나의 정리(Tidy) 워크플로**로 정립한다. 그리고 (a) autopilot 라이프사이클에 조건부 자동 단계로 배선하고(**변경 범위** — 방금 만든 diff), (b) 사용자가 직접 호출하는 표면 2개(`ditto refactor`, `ditto review`)를 연다(**단위 범위** — 코드베이스/컴포넌트/MVC 계층/REST API 단위의 *기존 코드*, §9). 정리가 회귀로 바뀌지 않게 막고, 정리한 slop이 미래 변경까지 추적되는 *fitness 성질*로 승격되게 한다.
- **이 계획이 아닌 것**:
  - OmO `SKILL.md`를 문자열 복제해 prompt-only skill을 만드는 것. (게이트가 없어 흡수의 핵심이 사라진다 — PM-7.)
  - 새 정적 분석 엔진(특히 ast-grep) 도입. **ADR-0006(CodeQL 단일 엔진)을 존중한다.** ast-grep 도입은 WU-X로 분리하고 기본 *보류*한다.
  - 모든 작은 수정에 full ACG ledger 5종을 강제하는 것. 정리는 **축소 ACG 프로파일**로 돈다(§7).
  - 정리 단계를 *정합성/보안 리뷰*로 쓰는 것. 정리는 **동작 보존**만 한다. 버그·위협은 별도 표면(`ditto review`)과 구현 단계의 책임이다(§4의 버그발견 복귀 규약).
- **최소 구현 원칙(Charter §4-3) — 정직화(dialectic-9 OBJ-03·05)**: **change-scoped 코어**(autopilot Tidy: ⓪ 분류기 + 정리 노드 배선 + L1 결선)는 기존 ACG 원시구성요소의 얇은 오케스트레이션이다(범위분석 CodeQL·게이트 PreToolUse/Stop·증거형식·Deep Module Gate 재사용). **그러나 다음은 "얇음"이 아니라 정당한 신규 비용이다**: (i) L2 trace differential 하니스(intercept·녹화·replay·property 생성 — `src/` 0건 신규 프레임워크), (ii) unit-scoped 사용자 표면(scope resolver·배치 분해·집계·절대-부채 측정 — 전부 신규). 이번 증분은 **change-scoped 코어 + diff-mode를 우선**하고, **unit-scoped 표면(WU-4/5)과 L2 하니스는 비용을 적시한 후속 WU로 격리**한다.

## 1. 근거 — 무엇을 흡수하고 무엇을 흡수하지 않는가

코드레벨 재검증으로 확정된 두 시스템의 성격(harness 보고서 §"LazyCodex/OmO와 DITTO ACG 비교"):

- OmO `remove-ai-slops`(`plugins/omo/skills/remove-ai-slops/SKILL.md`, v4.10.0): 좋은 정리 *전술*. 그러나 slop category·품질 게이트가 **markdown 지시**라 agent가 어기면 host가 모른다. 정리 결과가 미래 변경의 적합성 함수로 **승격되지 않는다**.
- AST-grep(`src/packages/ast-grep-mcp` + `ast-grep-core`): `sg run` 기반 구조 검색/치환 *도구*. dry-run 기본·workspace guard·output cap. 변경 의도/forbidden scope/semantic을 모른다.
- DITTO ACG: 변경 *계약·증거·완료 차단·지속 적합성* 런타임. 정리 *전술*은 없었다(있던 것은 `40-refactoring-criteria.md`의 게이트·기준이며, 이를 *돌리는 워크플로*가 비어 있었다).

→ **흡수 대상은 OmO의 전술이지 OmO의 도구가 아니다.** 전술을 ACG 게이트 위에 올리면 OmO가 못 하는 "증거 없는 완료 차단 + slop의 시간축 추적"이 붙는다. 도구(ast-grep)는 ADR-0006과 충돌하므로 분리·보류한다. **구조 분석이 필요하면 ADR-0006대로 CodeQL을 쓴다**(§5).

### 1.1 OmO 단계 + 사용자 강화안 → DITTO ACG 원시구성요소 (파일 지목)

| OmO/사용자 단계 | DITTO ACG로 내리는 방식 | 재사용 자산(파일:심볼) |
| --- | --- | --- |
| (신규) 정리 필요 여부 판정 | ⓪ 진입 분류기 — code-touch/크기/slop 신호로 SKIP/ENTER | planner §2.2 stage 추가(신규) |
| 동작 잠금(regression test first) | ① 동등성 증거 사다리 L1(커버리지)~L4(mutation). green baseline 아니면 중단 | `40-...:38-45`(G-R1), `agents/refactorer.md:20`, `semantic-produce.ts`(`buildSemanticSeed`), `acg-semantic-compatibility.ts:72-105` |
| 범위 산정(merge-base diff) | ② `ChangeContract.allowed_scope`=diff, `forbidden_scope`=그 외(≥1). **범위·영향은 CodeQL로 정확 산정** | `change-contract-store.ts`, `scope/resolve.ts`, `impact/codeql-analyzer.ts`, `scanSignatureChanges`, `boundary/codeql-edges.ts` |
| cleanup category(저위험→고위험) + deep-module 질문 | ③ tidy plan + ⑨ Deep Module Gate를 dialectic식으로 심문. 결정론 category(dup/complexity/dead/coverage)는 ⑥ FitnessFunction 델타. *(catalog 제약 변환 — rename/extract/inline을 구성으로 보존하는 TS 언어서비스/ts-morph 변환 — 은 매력적이나 **현재 repo에 미배선이고**(`src/` 0건) refactorer는 freehand 편집 계약이다. 도입 시 ADR-0006 가드(`scripts/adr-guard.ts`가 `from 'typescript'`를 차단)와 충돌하므로 **별도 ADR 선결**, ast-grep WU-X와 동급 보류 — dialectic-9 OBJ-01)* | `40-...:62-100`, `acg-fitness-function.ts:14-24`, `fitness-runner.ts` |
| 병렬 cleanup(deep agent, batch 5) | ④ autopilot 노드 + implementer/refactorer 위임, PreToolUse forbidden_scope 유지, mutating cap | `ditto:autopilot`, `agents/refactorer.md`, `pre-tool-use.ts:494-518` |
| (사용자) 버그/위협 발견 시 | 고치지 말고 중단 → 구현 단계 복귀 → 수정 → 정리 재진입(Tidy First 경계) | `agents/refactorer.md:20`("report not fix"), G-R2 |
| 품질 게이트(test/lint/typecheck/scan) | ⑥ fitness 델타 + ⑦ DoD replay. Stop 훅이 ledger 독해 → 완료 차단 | `stop.ts`(`acgReviewForcesContinuation`/`assuranceSnapshotForcesContinuation`/`semanticForcesContinuation`/`impactForcesContinuation`) |
| 3회 실패 시 중단·보고 | ⑧ 동일 규칙을 정리 노드 실패 정책으로(3-strike) | autopilot 실패 분류 |
| final report | Change Map + CompletionContract 증거 | `change-map/render.ts`, `cli/commands/change-map.ts` |
| (사용자) 사용자 호출 표면 | `ditto refactor`(정리 엔진) + `ditto review`(정합성/보안 리뷰) | §9 |

## 2. 정리(Tidy) 절차 — ACG 위의 단일 워크플로

전제: **구현 노드의 DoD가 green이 된 직후** 발동. 동작 보존 변경만. 정합성/보안 리뷰가 아니다.

```text
[구현 노드 DoD green]
        │
   ⓪ 진입 분류기 ──SKIP──▶ (정리 불필요: Assure로 / 사유를 산출물에 1줄 — G3)
        │ ENTER
   ① behavior lock      동등성 증거 사다리 L1~L4 (§4). green/적정 아니면 중단
   ② scope contract     ChangeContract allowed=diff, forbidden=그외. 범위·영향은 CodeQL 산정. PreToolUse 차단
   ③ tidy plan          저위험→고위험. 항목별 §40 게이트 + ⑨ Deep Module 심문
   ④ 병렬 정리          refactorer/implementer 배치, cap+파일상한, 드롭은 log(PM-5)
        ├─ 버그/위협 발견 ─▶ 고치지 말고 중단 → 구현 노드 복귀 → 수정·재검증 → 정리 재진입
   ⑤ (③·①에 흡수)      CodeQL 범위분석(②)·동등성(L3)은 같은 캐시 DB 재사용 (§5)
   ⑥ fitness 델타       dup/complexity/coverage 새 위반 0 (델타-only)
   ⑦ DoD 전수 replay    구현단계 AC/DoD 전체(무수정) + 새 characterization 재실행 all-green (+ medium+면 differential)
   ⑧ tidy commit/롤백   항목별 structural 커밋. 실패·3-strike면 그 커밋 revert + 보고
        │
   [Stop 훅 ledger 통과] ──▶ Assure(8 — fitness 승격)
```

각 단계가 **새 기계가 아니라 기존 ACG 원시구성요소의 배선**임은 §1.1 표가 지목한다. ⓪·①(L1·L2)·⑦의 DoD replay 결선·⑧ tidy commit만 신규다.

## 3. ⓪ 진입 분류기 — "이 변경에 정리가 필요한가"

구현 노드가 green DoD를 내면, 정리 단계로 들어갈지 결정한다. **결정론 신호 우선 + agent 판정 보조**, 판정 자체를 산출물로 남긴다(G3 — 축소는 드러낸다).

- **SKIP** (정리 불필요):
  - diff가 코드 파일을 안 건드림(문서/설정만) — 결정론.
  - diff가 smallness 임계 미만 **그리고** slop/complexity 신호 없음 — 결정론 + 신호.
  - 변경이 이미 스펙 구조대로 깔끔(slop 신호 0, complexity 델타 ≤ 0) — agent 판정 보조.
- **ENTER** (정리 필요): 코드 파일을 touch **그리고** cheap 결정론 heuristic 임계 초과(diff 크기 / 파일 수 / complexity 델타). **slop 검출은 ENTER 조건이 아니다**(dialectic-8 OBJ-08) — slop 정밀판정(CodeQL fitness §5(b))은 ENTER *이후* ③ tidy plan에서 한다. 이렇게 해야 "CodeQL을 돌릴지"를 "CodeQL이 줘야 할 slop 신호"로 판정하는 순환이 끊긴다. agent 판정은 ADR-0006 D2와 모순되지 않게 *보조*로만: 분류기는 call-graph류 구조추론이 아니라 표면 휴리스틱(diff stat)이라 "LLM 구조추론 1차 금지" 범위 밖이다.
- SKIP/ENTER 어느 쪽이든 사유 1줄을 work item 산출물에 남긴다.

> ENTER 트리거는 **결정론 함수**로 정의된다(WU-1 수용기준 — 텍스트 존재가 아니라 diff stat 기반 함수). 보수적 ENTER로 시작해 dogfood 측정으로 임계를 조정한다(PM-12). 분류기는 새 스키마가 아니라 planner의 §2.2 stage 선택에 "tidy" stage를 추가하는 게이트다.

## 4. ① behavior lock — 동등성 증거 사다리 (risk-tiered)

**원칙: "기존 suite가 전후로 green"은 동등성 증거의 *바닥*이지 충분조건이 아니다.** 기존 green 테스트는 *그 테스트가 실행하는 경로·그 테스트가 쓴 입력값*에서만 동등을 증명한다. 두 사각이 남는다: (1) 안 덮인 내부 경로로 잘못된 함수를 호출, (2) 테스트가 쓴 파라미터에서만 우연히 맞는 과적합. 이 둘을 다른 증거로 막는다. lock 강도는 리팩토링 위험에 비례한다.

| 증거 | 무엇을 막나 | 어떻게 | §40 §5 연결 |
| --- | --- | --- | --- |
| **L1 변경영역 커버리지 게이트** *(필수)* | 잘못된 내부 함수 호출(커버리지 사각) | tidy plan이 건드릴 함수/분기를 characterization이 **실제 실행**하는지 검사. 미달이면 그 경로 characterization을 **먼저 생성**, 불가하면 정리 착수 차단 | §5-2를 "커버리지 적정성" 조건으로 강화 |
| **L2 old↔new differential** *(medium+ default-on)* | 과적합(입력공간 협소) + 잘못된 내부 호출 | 정리 *전* vs *후* 구현을 **property-based 생성 ∪ 캡처 corpus**로 돌려 비교. 순수 함수는 출력 동등, 부수효과 코드는 **trace 변종**(녹화한 외부호출·인자·순서·반환·예외를 replay해 효과 trace 동등 — §4.2). old는 ⑧ tidy 커밋으로 호출 가능 | §5에 신규 형식 추가 |
| **L3 CodeQL 구조 동등** *(위험-계층: dataflow/보안/public)* | 구조적 잘못된 함수(callee/dataflow 변화) | §5-3(source→sink 불변) + 리팩토링 함수 **callee 집합 델타 정당화/0** | §5-3 존재, 확장 |
| **L4 mutation probe** *(선택: 고위험 hot-path)* | vacuous green(테스트가 동작 미고정) | 정리영역 변이 주입 → 테스트가 *실패*해야 lock 유효 | 신규, 비용 커서 한정 |

### 4.1 위험-계층 매핑 (§40 매트릭스 재사용)

| 리팩토링 유형 | L1 | L2 | L3 |
| --- | --- | --- | --- |
| rename / move (로직 불변) | 필수 | N/A(정의상 동작 불변) | public이면 callee delta |
| 메서드 추출 / inline / 중복제거 (로직 이동) | 필수 | **필수(default-on)** | 조건부 |
| 인터페이스·모듈 도입 (deep-module) | 필수 | **필수** | 조건부 + Deep Module Gate |
| 죽은코드 제거 | 미사용 증명(ImpactGraph) + 그 경로 미실행 확인 | — | — |

> **L1의 두 변종(dialectic-8 OBJ-09).** 일반 정리의 L1은 '경로 실행 증명'(characterization이 변경영역을 실제 실행)이지만, 죽은코드 제거의 L1은 정의상 그 경로가 *실행되지 않으므로* '미사용 증명(ImpactGraph) + 제거 후 DoD replay green'이라는 **별개 증거**다. 같은 'L1 필수' 라벨이 유형마다 다른 증거를 가리킨다는 점을 명시한다.

### 4.2 L2 differential 정의·기전

- **무엇**: `old(x) ≡ new(x)`를 같은 입력 집합에 단언. 정답을 알 필요 없는 **상대 oracle** — "옳은 출력"이 아니라 "old와 new가 일치하는가"만 보므로 동작 *보존* 검증에 정확히 맞는다. 비교 대상은 위험에 따라 둘:
  - **pure 변종**(순수 함수): 반환값 동등.
  - **trace 변종**(부수효과 코드): green baseline 실행 중 대상의 **관측 가능한 효과를 녹화**(외부 호출의 인자·순서, DB/네트워크/fs I/O, 반환, 던진 예외)하고, 정리 후 같은 입력으로 그 **효과 trace가 동일한지** replay 비교. pure seam이 없어도 성립. **단 이것은 회귀 *탐지*이지 보존 *증명*이 아니다(dialectic-9 OBJ-03)** — golden-master/record-replay는 본질상 회귀 탐지이고, 효과 동등이 동작 보존을 함의하지 않는다(내부 상태·지연평가·캐시·호출 순서·동시성은 trace 밖에서 깨질 수 있음; §4.4가 인용한 Rice와 일관). 따라서 **trace 통과 = 미반증, trace 불통과 = 확정 반증**으로 쓴다. OBJ-03(역상관)을 *닫지* 않고 *좁힌다*(부수효과 코드를 미검증 강등에서 일부 끌어냄). 녹화/replay/intercept 하니스는 `src/` 0건 **신규 프레임워크**다(§0 '얇음'에서 제외 — OBJ-05).
- **old 확보**: ⑧이 정리 항목마다 tidy 커밋을 남기니 정리 직전 코드가 알려진 커밋에 있다 → old/new 두 버전 호출/replay 가능.
- **입력 생성**: 리터럴 테스트 입력만 쓰면 과적합을 못 잡으므로 **property-based 생성/fuzz + 캡처 corpus**로 함수 도메인 위 N개 입력(기존 테스트 입력을 시드 + 생성으로 확장). N은 위험도로 제한.
- **medium+ default-on 이유**: rename/move는 정의상 동작 불변 → differential 무의미(끔). extract/inline/dedupe/interface는 *조용히* 동작을 바꿀 수 있음(잘못된 helper·과적합) → 자동 켬. 비용을 위험에 비례.
- **형태**: seam/intercept 식별 → old/new 빌드 또는 trace 녹화 → N입력 생성 → 출력·효과 trace 비교 → 첫 불일치를 **counterexample(재현 입력)**으로 보고 → 정리 revert 근거.

### 4.3 정직한 한계 (숨기지 않음)

- L2(특히 trace 변종)는 효과를 intercept할 경계가 있어야 성립. 부수효과 코드는 trace 녹화로 구제되지만, **진짜 비재현 비결정성**(정규화 불가한 시간·랜덤·동시성 race)은 trace도 안정적이지 않다. 그 잔여는 'seam 부족'이 아니라 **본질적으로 자동 검증 불가**이고, §4.4의 *충분 bar 미달*로 처리한다(자동 정리 부적격 → 좁은 잔여 질문).
- L1·L2·L4는 toolchain provider(커버리지·property 러너·mutation)에 의존한다. **현재 저장소에 이 러너들이 배선돼 있지 않다(provider 0건 — dialectic-8 OBJ-02).** 그래서 'L1 필수'는 provider 배선 후에만 hard-block로 작동하고, 부재 시 L1은 '미충족→무조건 차단'도 '조용한 우회'도 아니라 **위 미검증-강등 경로로 fail-open**한다. provider 선정·배선 + 부재 시 강등 동작 테스트가 WU-1/2의 *선결 산출물*이다(§14 Q3 = 선결조건).
- 이 강화로 `semantic_safe=yes`(`src/schemas/acg-semantic-compatibility.ts:72-105`) 정당성 조건이 바뀐다: `characterizationTestRef`(`semantic-produce.ts:72`)가 그냥 존재가 아니라 **L1 충족 or L2 통과**라는 적정성 꼬리표를 달아야 yes로 친다. **이 꼬리표는 스키마 변경을 요구한다(dialectic-8 OBJ-11)** — `characterizationTestRef`에 adequacy 필드(`l1_met`/`l2_passed`)를 추가하거나 무-스키마 별도 ledger로 표현하는 것을 **WU-2 작업단위로 명시**한다(현재 ref는 메타데이터 없는 optional string).

### 4.4 "충분 bar" — 무엇이 자동 커밋을 정당화하는가

절대적 동등성 증명은 불가능하다(프로그램 동등성은 결정 불가 — Rice). 그래서 목표는 *증명*이 아니라 **사람의 diff 검토가 잡을 것을 증거 스택이 지배하는 측정 가능한 임계**다. 한 정리 항목이 다음을 모두 충족하면 **충분 bar 도달**으로 본다:

1. **L1 변경영역 커버리지** ≥ 임계(건드린 함수/분기가 실제 실행됨). 미커버 경로는 애초에 정리 대상에서 제외(먼저 characterization).
2. **L2 differential 발산 0** — pure 또는 trace 변종으로 [기존테스트 ∪ 생성입력 ∪ 캡처corpus]에서 old↔new 효과 동일.
3. **L3 dataflow 동등**(보안/dataflow/public 차원, 해당 시).
4. **fitness 델타 clean**(이동 보정 후 새 위반 0).

이 bar는 *사람보다 더 많은 입력을 기계적으로* 본다. **대량 리팩토링 diff를 사람에게 "승인하라"고 내미는 것은 검증 연극(theater)이다** — 사용자는 앞부분만 보고 승인하므로 결함을 못 잡으면서 *가짜 확신*만 만든다(사용자 통찰, 2026-06-15). 그래서 사람 승인 게이트 대신 이 증거 bar가 게이트다:

- **full bar 충족 → 자동 커밋**(⑧). 사람 승인 게이트 없음. **단 "full bar"는 L1·L2 provider가 실제 배선돼 그 항목에서 hard-block로 발화함을 요구한다(dialectic-9 OBJ-04)** — provider 미배선·미검증-강등 경로에서는 bar가 L3(위험계층 해당 시)+fitness-delta로 쪼그라들어 비-dataflow 리팩토링의 *동작 보존*을 구조적으로 못 본다. 그 위 자동 커밋은 배격한 '검증 연극'을 자동 재생산하므로, **강등·미배선 경로는 자동 커밋 금지 → diff-only(격리 브랜치 누적, 사람이 일괄 검토)**.
- **bar 미달**(비재현 비결정·커버 불가·provider 미배선) → 그 항목은 **자동 정리 부적격**. 사용자에게 *대량 diff*가 아니라 **좁게 프레이밍된 잔여 질문**만 올린다(예: "이 함수는 정규화 불가한 시간 의존이 있어 효과 replay가 불안정 — 이 변경이 의도된 것인가?"). 떠넘기는 정보량을 최소화한다.
- **bar가 구조적으로 못 보는 결함 클래스(잔여)**: 동시성 race, 성능 회귀(빅오·할당), 계약 미스매치, trace에 안 잡히는 내부 상태(OBJ-03). 이 클래스에 인접한 정리(hot-path·async·public 계약)는 자동 커밋 부적격으로 분리한다 — bar는 "더 많은 입력을 기계적으로" 보는 축에서 사람을 이기지만 이 의미·구조 의심 축은 대체하지 못한다.

## 5. CodeQL 정책 — 3분할 + DB 캐시 amortize (ADR-0006 유지)

CodeQL의 *용도*를 갈라 정책을 단다. 무차별 강제(PM-6)도, 범위분석 누락(부정확)도 피한다.

| CodeQL 용도 | 정책 | 자산 |
| --- | --- | --- |
| **(a) 범위·영향 분석** (② scope, ③ plan): 호출부 전수, 시그니처 변경 영향, 클래스 변경 blast radius | **무조건 필수** — 정확한 정리 범위의 전제 | `impact/codeql-analyzer.ts`(CodeqlImpactAnalyzer), `scanSignatureChanges`, `boundary/codeql-edges.ts`(CodeqlEdgeAnalyzer) |
| **(b) slop 검출 fitness** (⑥): duplication/complexity 등 | 위험-계층/스케줄 (PM-6) | CodeQL/command/executed provider |
| **(c) dataflow 동등 증거** (L3): source→sink 불변 | 위험-계층(보안/dataflow/public) | `40-...:120`(증거형식 #3, 실증됨) |

**DB 캐시 amortize**: CodeQL DB는 commit별로 캐시된다(`cli/commands/codeql.ts:148` `cacheKey(commitSha, language)` → `.ditto/local/cache/codeql/<key>/db`). 그래서 (a)를 위해 DB를 *한 번* 빌드하면 (b)·(c)가 **거의 공짜로 재사용**한다. PM-6이 죽이려던 건 "trivial 정리에 매번 DB 빌드"인데, 그건 ⓪ 분류기가 문서뿐/no-code를 SKIP하면 안 생긴다. 실제 코드 리팩토링이면 DB는 정당한 비용이고 한 번 짓고 다 쓴다. (앞선 충돌 (가) 정정 — 범위분석은 위험-계층이 아니라 필수.)

## 6. ⑥ fitness 델타 · ⑦ DoD replay · ⑧ tidy commit

- **⑥ fitness 델타 (델타-only)**: 정리 전·후 snapshot의 **델타(새 위반)만** 게이트. duplication/complexity/coverage 새 위반 0. 기존(이전부터 있던) 부채는 게이트하지 않는다. delta>0이면 Stop 훅이 완료 차단(`assuranceSnapshotForcesContinuation` 이미 소비).
  - **⚠ 이동 보정 필수(dialectic-8 OBJ-01).** `normalizeViolationIdentity`(`fitness-runner.ts:56-59`)는 raw line은 빼지만 `rule@path#enclosing`을 식별자로 쓴다(테스트 `fitness-runner.test.ts:93-97`이 "다른 enclosing → 다른 identity"를 못박음). 정리의 핵심 동작(method move/extract/dedupe/rename)은 enclosing/path를 바꾸므로 **보정 없이는 옮긴 *기존* 부채가 새 identity로 잡혀 위 '기존 부채 게이트 안 함' 약속을 깨고 정리를 false-positive로 차단한다.** 따라서 delta는 (a) baseline을 **pre-tidy 커밋 스냅샷**과 비교하고, (b) move/rename으로 enclosing/path가 바뀐 site의 기존 위반을 **relocation-aware 매칭**으로 baseline에 귀속(또는 델타를 '룰별 위반 *개수* 증가'로 재정의)해야 한다. WU-2 수용기준이 'move/extract로 기존 부채를 옮겨도 델타 0'을 주입 테스트로 고정한다(라인 이동만 테스트하면 이 결함을 놓친다).
- **⑦ DoD 전수 replay**: 구현 단계가 닫은 AC/DoD 전체를 **무수정으로 재실행**해 전부 green인지 본다. DoD는 관측 가능한 수용기준이고 리팩토링은 동작 보존이므로 **DoD를 고치지 않는다** — replay만. 여기에 ① L1에서 새로 만든 characterization을 추가하고, **medium+ 리팩토링은 differential(L2)을 ⑦의 최강 형태로 동반**한다(DoD suite의 완전성을 믿지 않고 old↔new를 직접 비교). 엣지: DoD가 내부 구조에 결합(내부 함수명·호출순서 단언)되어 정당한 리팩토링에도 red면, ⑦ 약화 사유가 아니라 **그 DoD가 과결합(over-coupled)됐다는 신호**로 표면화한다(PM-11).
- **⑧ tidy commit/롤백 — full bar 충족 시 자동 커밋(Q1 해소, 2026-06-15)**: 한 정리 항목이 **§4.4 full bar(L1·L2 provider 배선+실제 발화 포함)**를 충족하면 **자동으로 structural 커밋**(Tidy First — 구조/동작 커밋 분리, 메시지에 structural 명시), **격리 브랜치에서, push는 절대 금지.** 항목 실패·한 파일 3회 실패 시 그 커밋 revert로 복원·보고. **provider 미배선·미검증-강등 경로(bar가 축소된 경우)는 자동 커밋 금지 → diff-only로 격리 브랜치에 누적, 사람이 일괄 검토(dialectic-9 OBJ-04).** bar 미달 항목은 자동 정리 부적격으로 빼서 좁은 잔여 질문만 올린다(대량 diff 승인 요구 = 검증 연극이라 두지 않음 — §4.4). 근거: 로컬 커밋은 가역적(`git reset`/`revert`)이고 push 금지라 비가역 위험이 낮다.

## 7. 축소 ACG 프로파일 — "cleanup profile"

정리는 본질적으로 *동작 보존* 변경이므로 full 거버넌스(Impact/Review까지)는 과하다. cleanup profile은 다음만 강제한다:

1. **scope gate (필수)**: ChangeContract `allowed_scope`/`forbidden_scope` + PreToolUse 차단. 정리가 범위를 넘어 다른 코드까지 손대는 가장 흔한 사고를 hot-path에서 막는다.
2. **behavior lock (필수)**: ① 동등성 증거 사다리. green/적정 baseline 없으면 정리 착수 금지.
3. **fitness 델타 (필수, 델타-only)**: ⑥. 이번 정리가 만든 증분만 본다.
4. **Impact/Review (조건부)**: public surface(공개 시그니처/UI 표면)를 건드릴 때만 켠다. 순수 내부 정리는 생략. (public surface 감지 시 Impact/Semantic 자동 승격 — PM-8.)

> 프로파일은 새 스키마가 아니라 기존 ledger들을 *어떤 것을 켜고 끄는지*의 결선 규칙이다. 토글은 work item intent에 플래그 하나(`profile: "cleanup"`)로 적재한다(§14 Q… 아래).

## 8. autopilot 배선

- planner가 §2.2 stage 선택 시 **tidy stage**를 메뉴에 추가. 구현 노드가 green DoD를 내면 ⓪ 분류기 노드가 SKIP/ENTER 판정(판정을 산출물로).
- ENTER → tidy 서브그래프 자동 생성: behavior-lock(①) → tidy-plan(③) → 병렬 refactorer 노드들(④) → fitness-delta(⑥) → DoD-replay(⑦).
- refactorer는 이미 approval-gated mutating owner(`agents/refactorer.md`). 단 **병렬 노드 격리의 진실원은 forbidden_scope가 아니라 autopilot lease(node별 `file_scope`)다**(dialectic-8 OBJ-06): `checkForbiddenScope`는 session→단일 workItemId→**단일 ChangeContract**로 풀므로(`pre-tool-use.ts:502-506`), 병렬 정리 노드들이 같은 work item 계약을 공유해 allowed_scope가 노드 합집합이 된다 → forbidden_scope로는 노드 상호침범을 못 막는다. 노드별 file_scope 격리는 lease(`pre-tool-use.ts:719-723`)가 강제하고, forbidden_scope는 work item 전역 금지구역만 막는다. WU-3가 'lease가 노드별 침범을 막음'을 테스트로 고정한다.
- 실패 분류: **bug-found → 구현 노드 복귀**(고치지 말고), **3-strike → stop+report**(OmO 미러).
- 배치 cap: autopilot mutating-node cap 재사용 + 파일수 상한. 드롭된 파일은 log 명시(silent truncation 금지 — PM-5).

## 9. 사용자 표면 2개 — **단위 범위(unit-scoped)** 운영 모드

> **핵심 구분(사용자 명시, 2026-06-15).** autopilot/ACG 내부의 정리는 **변경 범위(change-scoped)** — session+work-item이 *방금 만든* diff(merge-base)를 정리한다. **사용자 표면은 단위 범위(unit-scoped)** — 사용자가 지정한 *아키텍처 단위*(전체 코드베이스 / 특정 컴포넌트 / MVC 계층 / REST API)의 **기존(standing) 코드**를 정리·리뷰한다. *변경*이 아니라 *이미 있는 코드*가 대상이다. **같은 behavior-preservation 엔진**(L1 커버리지·L2 trace-differential·L3 dataflow·Deep Module Gate·catalog 변환·§4.4 bar-gated 자동커밋)을 쓰되, 아래가 갈린다.

| 축 | autopilot Tidy (change-scoped) | 사용자 표면 (unit-scoped) |
| --- | --- | --- |
| 범위 입력 | merge-base diff (방금 변경) | **아키텍처 단위** → 파일집합 resolver |
| baseline | 변경 직전(pre-change) | **현재 HEAD**(standing code) |
| 진입 | ⓪ 분류기(변경이 정리 필요한가) | **없음** — 사용자가 단위를 명시 |
| **fitness 게이트** | **델타-only**(새 위반 0, 기존 부채 무시) | **절대 부채 감소**(단위 파일집합의 위반 총수 before/after 스냅샷 diff — **신규 측정**, `drift`(델타-추세 엔진) 재사용 아님; dialectic-9 OBJ-02) |
| 행동 잠금 | diff 영역 characterization | 단위의 standing 동작 — 커버리지 낮으면 characterization 선행 또는 그 부분 **제외/escalate** |
| 규모 | 작음 | **큼 → 파일/모듈 배치 분해, 진행률, 부분완료, 드롭 log** |
| 커밋 검토 | autopilot 노드 | bar-gated 자동커밋을 **격리 브랜치**에 쌓아 사용자가 *PR 단위로* 검토(중간 승인 요구 없음) |

> **가장 큰 분기 = fitness 모델.** autopilot은 작은 변경이 *추가한* 부채만 본다(델타-only). 사용자 표면의 *목적 자체*가 기존 부채 제거이므로, 델타-only면 정작 줄이려는 부채를 게이트가 무시해 무의미하다 → **단위 내 절대 부채의 before/after 감소**로 측정한다(behavior-preservation은 그대로 "새 위반 0"도 요구). **이 절대-부채 측정은 신규 능력이다(dialectic-9 OBJ-02)** — 기존 `drift`(`src/acg/fitness/drift.ts`)는 work-item을 가로지른 *신규위반 누적-추세* 엔진이라 '단위 절대 before/after'를 재지 않는다. 따라서 drift 재사용이 아니라 단위 스냅샷 diff를 새로 만들어야 한다(unit-WU 선결). 게이밍 유인(쉬운 위반만 제거·코드 삭제로 카운트↓)은 'behavior-green 동반 시에만 카운트 + 삭제 감소는 G-R3 미사용 증명 조건'으로 막는다(OBJ-06).

**Scope resolver(unit → 파일집합).** "component/layer/REST API"는 ArchitectureSpec layers(`can_call`)·boundary(`CodeqlEdgeAnalyzer`)·path glob·`internal-packages`를 재사용해 파일집합으로 푼다. "REST API"=controllers/routes 계층, "whole"=repo root.

| 표면 | 하는 일 | 재사용 |
| --- | --- | --- |
| `ditto refactor --scope <unit>` (`all`\|`component:<name>`\|`layer:<name>`\|`api`\|`<glob>`\|`diff`\|`<files>`) | 지정 단위의 standing 코드를 동작 보존 정리(①~⑧, unit-scoped baseline=HEAD), bar-gated 자동커밋을 격리 브랜치에 | tidy 엔진, refactorer, scope resolver(ArchitectureSpec/boundary), `fitness drift` |
| `ditto review --scope <unit> [--security]` | 지정 단위의 standing 코드 **정합성/보안 감사** → `acg-review.json` ledger(work-item diff가 아니라 *단위 전체*) | `ditto:reviewer`/`security-reviewer`, 기존 `acg-review`(`cli/commands/acg-review.ts`) |

정리(동작 보존)와 리뷰(정합성/보안)를 **분리된 형제 표면**으로 둬야 정리 단계의 "버그 발견 시 중단·복귀" 규약과 Tidy First 경계가 산다. 두 표면 다 unit-scoped 입력을 1차로 받고, `diff`/`<files>`는 보조 모드.

## 10. 결정 기록 (설계 충돌 해소)

- **(가) CodeQL 강제 — 정정**: 무차별이 아니라 §5의 3분할. **범위·영향 분석은 필수**, slop fitness·dataflow 동등은 위험-계층. DB 캐시로 amortize. (앞서 "위험-계층 일괄"은 두 용도를 뭉뚱그린 오류였다.)
- **(나) 자동 phase**: ⓪ 분류기로 게이트되는 **조건부 자동** + `ditto refactor` 수동 병행. "ACG·autopilot 맞물림" 충족.
- **(다) tidy commit — full-bar-gated 자동(Q1 해소, 2026-06-15)**: **§4.4 full bar(L1·L2 provider 배선+발화) 충족 시 자동 structural 커밋**(격리 브랜치, push 절대 금지, Tidy First 분리). **provider 미배선·강등 경로는 diff-only(자동 커밋 금지)** — 빈약한 bar 위 자동커밋은 '연극' 재생산(dialectic-9 OBJ-04). bar 미달은 자동 정리 부적격 → 좁은 잔여 질문만. 대량 diff 사람 승인은 검증 연극이라 두지 않는다.
- **(라) 리뷰 표면 분리**: §9처럼 형제 표면으로 확정(사용자의 "측면 2개" 요청).
- **L2 medium+ default-on + seam 없을 때 미검증 강등**: 사용자 합의(§4.2·§4.3).

## 11. 작업단위 (착수 표면)

각 WU: 목표 / 변경 대상 / 수용기준(관측 가능) / 검증 / 의존 / 되돌리기. WU-0만 이 계획의 일부로 권고하고, WU-1~ 이후는 별도 착수 허가 대상. 모든 게이트 수용기준은 *텍스트 존재*가 아니라 **훅이 실제로 차단함을 테스트로** 요구한다(PM-7).

### WU-0 — ADR-0017 작성 (structural; 이 계획의 일부)
- **목표**: 결정을 권위있게 박는다. (a) 정리 절차를 ACG-grounded `Tidy` 워크플로로 흡수, (b) **2차 정적 엔진(ast-grep) 비도입 — ADR-0006 유지**, (c) **CodeQL 3분할 정책**(범위 필수/fitness·dataflow 위험계층/DB amortize), (d) **동등성 증거 사다리**(L1 필수·L2 medium+ default-on·seam없으면 미검증 강등), (e) tidy commit 정책(내부 커밋 허용·push 금지), (f) 정리=동작보존(버그리뷰 아님)·리뷰는 형제 표면.
- **변경 대상**: `.ditto/knowledge/adr/ADR-0017-cleanup-deslop-on-acg.md`(신규), CLAUDE.md ACG projection 갱신.
- **수용기준**: 기존 ADR 포맷(상태/일자/결정자/컨텍스트/결정/대안/철회조건) 준수. ADR-0006과의 관계(보강·비충돌) 명시. ast-grep "도입 안 함 + 철회조건" 명시.
- **검증**: `ls .ditto/knowledge/adr/ADR-0017*` + 본문 ADR-0006 참조 grep.
- **의존**: 없음. **되돌리기**: 파일 삭제 + projection revert.

### WU-1 — ⓪ 진입 분류기 + ① L1 behavior lock + ② scope contract
- **목표**: 정리 진입 판정, 변경영역 커버리지 게이트(L1), CodeQL 범위 산정 기반 ChangeContract.
- **변경 대상**: 분류기(planner stage), L1 커버리지 검사 + characterization seed(`semantic-produce.ts` 재사용), ChangeContract 생성(`change-contract-store.ts`) + CodeQL 범위(`impact/codeql-analyzer.ts`), dist projection.
- **수용기준**: (1) 더러운 브랜치에서 `change-contract.json` 생성·allowed=diff·forbidden=그외. (2) forbidden 편집 시도가 PreToolUse `exitCode:2` 차단(실제 차단 로그/테스트). (3) baseline red 또는 L1 커버리지 미달이면 정리 착수 없이 중단·보고. (4) 분류기 SKIP/ENTER 판정이 산출물로 남고, **ENTER 트리거가 결정론 함수(diff stat 기반)로 정의**된다 — slop 검출은 ENTER 조건에서 빠져 있다(OBJ-08). (5) coverage provider 부재 시 L1이 '무조건 차단'이 아니라 미검증-강등으로 **fail-open**함을 테스트(OBJ-02).
- **검증**: DITTO 자체 dogfood(의도적 slop 브랜치). `tests/acg/` scope·분류기 단위 테스트. `bun test tests/hooks/pre-tool-use.test.ts`.
- **의존**: WU-0. **되돌리기**: 분류기·L1 결선 제거(ChangeContract는 기존 자산).

### WU-2 — ⑥ fitness 델타 + ① L2 differential + L3 CodeQL 동등
- **목표**: dup/complexity/coverage 델타-only 게이트, medium+ differential, dataflow 동등.
- **변경 대상**: fitness 선언(command/executed/CodeQL provider — **신규 엔진 없음**), `fitness-runner.ts` delta 재사용 **+ 이동 보정(relocation-aware baseline 매칭 — OBJ-01)**, L2 differential 하니스(seam·property 생성·counterexample), L3 callee/dataflow 동등(`40-...:120` 확장), `acg-semantic-compatibility` 적정성 꼬리표 스키마(OBJ-11), **coverage/property provider 선정·배선(OBJ-02 선결)**.
- **수용기준**: (1) 정리가 새 dup/complexity 위반을 만들면 Stop 차단(테스트). (2) 기존 부채는 게이트 안 함(델타-only) — **특히 method move/extract로 기존 부채를 옮겨도 델타 0**(주입 테스트, 라인 이동만이 아니라 enclosing/path 이동까지 — OBJ-01). (3) medium+ 리팩토링에서 differential이 과적합 회귀를 counterexample로 잡음(주입 시나리오). (4) seam 없으면 미검증 강등 + Review high-risk(테스트). (5) semantic_safe=yes 적정성 꼬리표용 스키마 변경(또는 별도 ledger)이 반영됨(OBJ-11).
- **검증**: `bun test tests/acg/fitness-runner.test.ts` + 델타·differential 신규 테스트. dogfood 전·후 snapshot 대조.
- **의존**: WU-1. **되돌리기**: fitness 선언·differential 하니스 제거.

### WU-3 — ④ 병렬 정리 노드 + autopilot 배선 + ⑦ DoD replay + ⑧ tidy commit
- **목표**: 파일 단위 정리 배치 위임, DoD 전수 replay, tidy 커밋/3-strike.
- **변경 대상**: tidy 서브그래프 템플릿, autopilot stage 배선, DoD replay 결선(CompletionContract), tidy commit/revert, 실패 정책(bug→복귀, 3-strike→stop).
- **수용기준**: (1) 의도적 slop 브랜치 정리 완료 → reviewer behavior-preserving verdict. (2) 정리 중 forbidden 편집 차단(병렬에서도). (3) fitness 델타 ≤ 0 + DoD 전수 replay green + medium+ differential pass. (4) 정리 중 버그 발견 → 고치지 않고 구현 노드 복귀(테스트). (5) 한 파일 3회 실패 → 보고하고 멈춤.
- **검증**: DITTO 자체 dogfood end-to-end. reviewer verdict + `ditto verify`.
- **의존**: WU-1, WU-2. **되돌리기**: 서브그래프 템플릿 제거(autopilot 코어 무변경).

### WU-4 — `ditto refactor` 사용자 표면 (unit-scoped) — **후속 WU(이번 증분 밖)**
> **분리 사유(dialectic-9 OBJ-05).** unit-scoped는 scope resolver·배치 분해·집계·절대-부채 측정이 전부 신규이고, 저커버리지 standing 코드(40-criteria:45 — boxwood automation-engine 2.7%·portal 11%)에서 L1 게이트가 컴포넌트 대부분을 막는다 → **대량 characterization 선작성(거대 비용)** 또는 **대부분 skip/escalate(목적 무효화)**로 갈린다. 그래서 이번 증분에서 분리해 후속 WU로 두고, **WU-4의 첫 단계는 한 컴포넌트 dogfood로 skip율·characterization 비용을 *측정***한 뒤 전체 표면을 결정한다(설계 단계에서 고정 금지).
- **목표**: 사용자 지정 *아키텍처 단위*(코드베이스/컴포넌트/계층/REST API)의 standing 코드를 정리 엔진(①~⑧, baseline=HEAD)으로 동작 보존 정리. **변경 대상**: scope resolver(unit→파일집합, ArchitectureSpec/boundary 재사용), unit-scoped baseline·fitness(**절대 부채 감소**), 격리 브랜치 자동커밋, 대규모 배치 분해. **수용기준**: (1) `--scope component:<name>`/`layer:<name>`/`api`/`all`이 올바른 파일집합으로 풀림. (2) 단위 정리 후 단위 fitness 위반이 **감소**하고 behavior-preservation(L1 + medium+ L2) green. (3) bar 미달 부분은 자동 정리 부적격으로 빠지고 좁은 잔여 질문만. (4) 격리 브랜치에 bar-gated 자동커밋, push 안 함. **검증**: CLI 통합 테스트 + dogfood(DITTO 한 컴포넌트). **의존**: WU-3.

### WU-5 — `ditto review` 사용자 표면 (unit-scoped) — **후속 WU(이번 증분 밖)**
> **분리 사유.** `acg-review.ts`는 work-item 스코프(reviewer-output 투영)라 unit 집계는 thin wrapper가 아닌 신규(scope resolver·배치·집계 — dialectic-9 OBJ-10). WU-4와 scope resolver를 공유하므로 함께 후속.
- **목표**: 사용자 지정 *단위*의 standing 코드 정합성/보안 감사 → `acg-review.json` ledger(work-item diff가 아니라 *단위 전체*). **변경 대상**: scope resolver 공유(WU-4), reviewer/security-reviewer를 단위 파일집합에 배치 실행, ledger 집계. **수용기준**: (1) `--scope <unit>`가 단위 파일집합으로 풀려 reviewer/security-reviewer 실행. (2) 단위 감사 결과가 `acg-review.json` ledger로 생성되고 high-risk·evidence부재면 Stop 차단 유효(기존 경로). (3) 대규모 단위에서 배치 분해·진행률·드롭 log. **검증**: CLI 통합 테스트. **의존**: scope resolver는 WU-4와 공유(resolver 선행 필요).

### WU-X — (보류) 구조 검출 헬퍼 / ast-grep 평가
- **상태**: **기본 보류.** WU-0 ADR이 2차 정적 엔진 비도입을 박는다.
- **철회조건(보류 해제 트리거)**: (1) WU-2의 CodeQL/command provider가 정리 detection에서 비용 때문에 실사용 불가로 *측정*됨, **그리고** (2) 동일 검출을 CodeQL 쿼리로 표현 시 표현력/비용이 명백히 열위임이 실측됨. 둘 다 충족 전 도입 안 함. **검증(해제 시)**: 별도 ADR + dialectic-review.

## 12. Pre-mortem — "6개월 뒤 이 개선이 실패했다면 왜인가"

| # | 실패 시나리오 | 근본 원인 | 완화책 | 어디서 막나 |
| --- | --- | --- | --- | --- |
| **PM-1** | 정리용으로 ast-grep을 "잠깐만" 추가 → 2차 엔진 영구화, ADR-0006이 죽인 유지비 재발 | 편의 엔진 도입 creep | WU-0 ADR이 비도입을 결정으로 박고 ast-grep은 WU-X로 분리·보류 | WU-0, WU-X |
| **PM-2** | full ACG ledger가 무거워 정리가 손편집보다 느림 → 아무도 안 씀 | 정리에 거버넌스 과적용 | **축소 cleanup profile**(§7): scope+behavior-lock+fitness델타만, Impact/Review는 public surface일 때만 | §7, WU-1 |
| **PM-3** | dup/complexity 결정론 게이트가 노이즈 → agent가 게이트와 싸우거나 끔 | 절대 부채를 게이트 | **델타-only**(이번 정리가 만든 위반만), 기존 부채 무시 | ⑥, WU-2 |
| **PM-4** | characterization을 정리하는 같은 agent가 작성 → 상상한 동작 검증(horizontal slicing) | 테스트가 동작 아닌 가정 고정 | characterization은 정리 *전* green, SemanticCompatibility가 passing ref 요구. **L1 커버리지 적정성으로 vacuous green 차단** | ①L1, WU-1 |
| **PM-5** | 큰 diff에 정리 → 노드 폭발, 컨텍스트/비용 blowup | 배치/파일수 무제한 | autopilot cap + 파일수 상한, **드롭은 log 명시** | §8, WU-3 |
| **PM-6** | 5파일 정리에 CodeQL DB 빌드 → 비현실적 오버헤드 | 무거운 엔진을 경량 작업에 | **DB 캐시 amortize**(§5): 범위분석으로 어차피 빌드, fitness/동등은 재사용. trivial은 ⓪가 SKIP | §5, ⓪ |
| **PM-7** | OmO SKILL.md 그대로 복제 → prompt-only, 게이트 미결선 → 강제력 상실 | "도구 복제"를 "흡수"로 착각 | 수용기준이 *텍스트 존재*가 아니라 **PreToolUse/Stop이 실제 차단함을 테스트로** 요구 | WU-1/2/3 |
| **PM-8** | 정리가 public 시그니처 건드렸는데 Semantic/Impact 안 켜서 호출자 깨짐 | 축소 profile 과다 절삭 | public surface 감지 시 Impact/Semantic **자동 승격**(§7-4), child 제약에 "public API 시그니처 불변", **②가 CodeQL로 호출부 전수 파악** | §5,§7, WU-3 |
| **PM-9** | L2 켰지만 seam 부재로 대부분 미검증 강등 → lock이 L1만 → 과적합 사각 재발. **역상관(OBJ-03)**: seam 만들기 가장 어려운 코드(부수효과·비결정)가 정리로 조용히 깨지기 가장 쉬운 코드라, 가장 위험한 정리에서 사다리가 가장 약한 L1(경로 실행만 증명, 출력 보존 미증명)로 떨어진다 | seam 만들 수 없는 코드 다수 | ③에서 **seam 가능성 선판정**, 부수효과는 capture harness, 미검증은 Review high-risk로 **가시화**(측정만으로 사각이 닫히지 않음을 인정). **강등 비율 + 강등된 코드에서 회귀가 dogfood로 새는지**를 측정 게이트로 추적 | ①L2, WU-2 |
| **PM-10** | CodeQL DB가 정리 항목 커밋마다 캐시미스로 재빌드 → tidy phase 지연(amortize 실패) | tidy 커밋이 commitSha 캐시키 무효화 | 범위분석은 **정리-직전 baseline DB 1회**, 동등(L3)은 **정리-후 1회 재빌드**로 한정. DB는 work item 단위 | §5, WU-1/2 |
| **PM-11** | DoD가 내부 구조에 결합 → 정당한 리팩토링에도 red → 정리가 영구히 막힘 | over-coupled DoD | ⑦은 행동적 DoD 전제. 구조결합 red는 **DoD smell로 표면화**(차단 사유 아님), 동작적 DoD로 교정 권고 | ⑦, WU-3 |
| **PM-12** | ⓪가 너무 자주 ENTER → 모든 코드 변경이 무거워짐 | 분류기 과민 | 결정론 신호 우선(문서뿐/small+no-signal SKIP), ENTER 보수적, 임계는 dogfood 측정으로 조정 | ⓪, WU-1 |
| **PM-13** | fitness 델타-only가 정리(method move/extract/rename)에서 **옮긴 기존 부채를 새 위반으로 오탐** → Stop이 정상 정리를 차단 | violation 식별자가 enclosing/path 의존(`fitness-runner.ts:56-59`) | §6 ⑥ 이동 보정(pre-tidy 커밋 baseline 비교 + relocation-aware 매칭), WU-2 수용기준에 move-debt 주입 테스트 | §6 ⑥, WU-2 |

## 13. 검증 전략(전체)

- 정리가 회귀로 바뀌지 않는다 = **DITTO 자체 dogfood**가 1차 증거. 의도적 slop을 심은 브랜치에 정리를 돌려 (a) scope 차단, (b) behavior-lock(L1 + medium+ L2), (c) fitness 델타 ≤ 0, (d) DoD 전수 replay green, (e) reviewer behavior-preserving verdict, (f) CompletionContract 통과를 모두 fresh evidence로 확인.
- 각 WU는 단위 테스트(`tests/acg/`, `tests/hooks/`)로 게이트 동작을 고정하고, 통합은 dogfood로 닫는다.
- 모든 게이트 주장은 "차단됨"의 실제 exit code/로그로 증명한다(Charter 완료 게이트).
- L2 differential은 주입한 과적합/잘못된-호출 시나리오에서 counterexample을 *실제로* 잡는 것으로 검증한다(가짜 통과 방지).

## 14. 미해결 질문

- **Q1 (tidy commit 비가역성) — 해소(2026-06-15).** 사용자 결정: **§4.4 충분 bar 충족 시 자동 structural 커밋**(격리 브랜치, push 절대 금지). 근거: 로컬 커밋은 가역적이고, 대량 diff 사람 승인은 검증 연극(앞부분만 보고 승인)이라 UX만 깎고 안전은 안 늘린다. bar 미달은 자동 정리 부적격 → 좁은 잔여 질문만.
- **Q2 (⓪ 분류기 SKIP 기준 정밀화).** 결정론 신호 우선(문서뿐/small+no-slop-signal SKIP) + agent 판정 보조로 잡음. 저위험 구현세부(agent 결정 영역)지만 dogfood로 임계 조정. — 의도 차원 이견 있으면 확인.
- **Q3 (toolchain provider) — 선결조건으로 승격(dialectic-8 OBJ-02/13).** L1 커버리지·L2 property 러너·dup/complexity 결정론 evaluator를 어떤 command provider로 채울지. **현재 저장소에 이 러너들은 배선돼 있지 않다(provider 0건).** 이는 '저위험 구현세부'가 아니라 L1 '필수'·L2 'default-on' 게이트의 **강제력 성립 전제**다. WU-1/2의 첫 산출물 = provider 선정·배선 + 부재 시 fail-open 강등 동작 테스트. (DITTO의 'coverage'는 작업노드 트리 completion-coverage이지 테스트 라인 커버리지가 아님에 주의.)
- **Q4 (cleanup profile 토글 적재).** intent에 `profile: "cleanup"` 한 필드(추천) vs 전용 intent kind. 비가역 아님 → agent 결정 가능.

> Q2·Q4는 구현 세부(저위험)라 agent 판단 영역이다(Charter §4-8). **Q3은 게이트 강제력의 선결조건**으로 승격됐다(저위험 아님 — dialectic-8). **Q1(자동커밋)은 사용자 결정으로 해소**(§4.4 bar-gated 자동 커밋). 남은 사용자 가치 판단은 **없음**.
