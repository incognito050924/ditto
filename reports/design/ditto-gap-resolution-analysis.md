---
title: "DITTO §9 남은 구현 gap — 실재성·해결방안·철학 적합 조사"
kind: design-analysis
last_updated: 2026-06-14 KST
work_item: wi_2606142uq
audience: 기여자 · 후속 에이전트
scope: "ditto-unified-design.md §9(남은 구현 gap 6건)이 실재하는지 코드로 검증하고, 각 gap의 해결방안을 열거하고, DITTO 철학(PURPOSE 7가치·설계 태도)에 가장 맞는 방안을 근거와 함께 고른다. read-only 조사 — 코드 변경 없음."
method: "gap당 1개 read-only researcher 서브에이전트를 fresh context로 병렬 위임. 각자 src/ grep·읽기 + 일부 테스트 실행으로 실재 검증. 철학 적합 종합은 main agent가 PURPOSE.md·ADR 근거로 수행."
---

# DITTO §9 gap 조사

## 0. 메타 결론 — gap 목록 자체가 stale하다

조사의 가장 큰 발견은 개별 gap이 아니라 **§9 목록 전체의 정직성 문제**다.

`ditto-unified-design.md §9`는 DITTO 제1원칙("증거 없는 완료 선언 금지")을 문서 자신에게 적용한 정직 섹션으로 쓰였다. 그러나 코드를 직접 확인하니 **6건 중 5건이 현실보다 뒤처진(stale) 또는 과대 서술**이다 — 이미 구현되고 테스트까지 통과하는 것을 "미구현/잔여"로 적었다. 즉 §9는 **완료를 미완으로 잘못 선언**하는, 제1원칙의 역방향 위반을 범하고 있다.

| gap | §9 서술 | 코드 실재 | 판정 |
|---|---|---|---|
| ⑥ Senior Pattern Repository | 비권위 후보만, 비준·ADR 저장 자동화 미구현(~30%) | propose 비권위 후보 + PreToolUse/boundary가 spec 집행은 **이미 동작**. 비준(ratify) 명령·ADR 저장 자동화만 부재 | **real** (집행 부재 뉘앙스는 stale) |
| CodeQL WI-4 (Opponent) | 미착수 | CodeQL 결정론 사실이 Stop 종료를 차단하는 효과 **이미 구현·배선·테스트 7 pass**. 단 dialectic ledger가 아닌 acg-review ledger 경로 | **stale** (효과 달성, 경로만 다름) |
| CodeQL WI-5 (Dataflow DoD) | PoC만 | DoD 술어 생성 코드 없음. "PoC만"은 과대(src에 PoC 흔적 없음) | **real** (미구현) |
| Multi-Change Semantic | 다중 시 하나만 감지 | detector는 다중 **전수 감지**. 차단 산출물만 1쌍/작업, 초과 시 fail-closed(exit 65), 나머지는 advisory nudge | **real이나 서술 부정확** |
| fitness executed-mode | 실행 provider·drift 집계 뷰 잔여 | executed 엔진·drift 뷰 **둘 다 구현, 테스트 21 pass** (구현 06-05 < gap텍스트 06-08). 진짜 잔여는 컴파일언어 clean-build provisioning 한 조각 | **stale** |
| 평가 지표 수집 | 측정·집계 파이프라인 없음 | fitness drift·intent-quality-doctor **2개 집계 파이프라인 실재**. §5 7지표 중 ⑥만 전용 뷰, ①②③④⑤⑦은 원천 데이터만 쌓이고 뷰 없음 | **부분 stale** (과대) |
| 축4 durable 판정 휴리스틱 | under/over 줄이는 게이트 미구현 | `knowledgeUpdateGate`가 trigger↔content 정합으로 under/over 둘 다 검사 **실재, 테스트 4 pass**. 진짜 잔여는 (a)hook 강제 미배선 (b)trigger 신고 자체의 정합만 검사 | **부분 stale** |

따라서 **거의 모든 gap에서 가장 높은 가치·최소 비용의 조치는 코드 추가가 아니라 §9를 검증된 현실에 맞게 정정하는 것**이다. 그래야 진짜 남은 잔여가 비로소 보인다.

증거 출처: 아래 각 gap 절. 테스트 pass 수치는 서브에이전트가 fresh로 실행한 `bun test` 출력(단위·주입 mock 수준; full e2e 미실행 — §실재성 한계).

---

## 1. gap별 실재성 + 해결방안 + 추천

### ⑥ Senior Pattern Repository

- **실재**: real. `src/acg/architecture/propose.ts:40-53`이 불변식 강제 — `produced_by='agent'`, `forbidden_dependencies=[]` 항상(ADR-0004 "자동 박제 금지"). ratify/promote 명령 없음(CLI는 propose/internal-packages 둘뿐, `architecture.ts:44-97`). ADR 저장 자동화 없음. 단 `--write`한 spec은 PreToolUse(`pre-tool-use.ts:481-485`)·boundary(`boundary.ts:75-95`)가 **이미 집행** — :271 표의 "집행 게이트 없음"은 stale.
- **해결방안**: (A) `architecture ratify` 명령 — 후보를 사람이 검토 후 `produced_by=user`로 승격, forbidden_dependencies는 사람 인자로만. (B) 문서화로 종결(수기 비준). (C) `module_invariants`→FitnessFunction 승격(본래 의도이나 타입드 invariant 선결 필요, ADR-0004 §23). (D) :271 표 정정.
- **추천: A + D.** ADR-0004의 "사람 권위·자동 박제 금지" 불변식을 그대로 지키면서 "관찰→비준→집행" 고리의 마지막 칸을 닫는다. 스키마·게이트가 이미 있어 얇은 wrapper가 아닌 기존 깊은 구현 위의 작은 연결(Deep Module 정신). ADR-0004 철회조건·fast-follow가 정확히 A를 예고. B는 "효과는 런타임 게이트로 강제"라는 핵심 태도에 어긋나 기각. C는 선결 미충족이라 시기상조.

### CodeQL WI-4 (Opponent) / WI-5 (Dataflow DoD)

- **실재**: WI-4 = **stale**. CodeQL 결정론 사실이 종료를 차단하는 효과는 `review-to-ledger.ts:58`→`acg-review.json`→`stop.ts:207`(high-risk without evidence면 continuation)→exit 2로 **완성**(테스트 7 pass). 계획서가 적은 dialectic ledger 경로(`sarif-adapter.ts:67` `toObjection`)는 **호출자 0인 죽은 코드**. 즉 "dialectic opponent"라는 문자 그대로의 WI-4는 미구현이나 그 효과는 더 안전한 경로(evidence로 수렴 보장)로 달성됨. WI-5 = **real**(미구현), 단 "PoC만"은 과대.
- **해결방안**: WI-4 — (W4-a) 문서 정정, (W4-b) 죽은 dialectic 경로 정리, (W4-c) reviewer lane 자동 배선. WI-5 — (W5-a) dataflow→DoD 술어 생성(GIVEN untrusted input/WHEN reaches sink/THEN blocked, 보안·데이터흐름 DoD 한정), (W5-b) evidence-only 유지, (W5-c) 비범위 선언 종결.
- **추천: WI-4 = W4-a + W4-b 즉시.** 같은 차단 효과를 두 경로로 만드는 것은 단일 사용 추상화 금지·외과적 변경 원칙 위반. 살아있는 acg-review 경로가 무한루프 방지 면에서 오히려 우월(evidence 한 건으로 해소). **WI-5 = W5-a를 본 구현으로**(단 코드 신설이라 사용자 허가 후 착수). "테스트 통과"를 "source→sink가 sanitizer로 차단됨"이라는 검증가능 명제로 바꾸는 것이 의도 이탈의 구조적 차단(가치3)·할루시네이션 방지(가치2)에 직결. DoD는 게이트가 아닌 명세라 무한루프 부담 없음.

### Multi-Change Semantic

- **실재**: real이나 §9 서술("하나만 감지")이 부정확. detector(`signature-codeql.ts:195-207`)는 다중 변경 전수 감지하고 observe 산출물에 전부 기록. 제한은 **차단 산출물**(`acg-semantic-compatibility.ts:23` 단수 `change`)에만 있고, 두 번째 차단 시드 시도는 fail-closed(exit 65, `semantic.ts:262-269`). 나머지는 advisory nudge로 표면화 — **조용히 사라지는 경로 없음**(테스트 14 pass).
- **해결방안**: (A) 스키마 단수→복수 `changes[]` 확장. (B) nudge를 차단으로 승격. (C) 현 fail-closed 유지 + 문서 서술 정정.
- **추천: C.** silent false-pass 경로가 없어 안전 불변식을 이미 만족 — DITTO는 거짓 양성보다 "막힘/모름"을 선호(가치2). 진짜 문제는 기능 누락이 아니라 문서 서술 부정확. "실제 다중 차단이 필요한가"는 도메인 가치 판단이라 사용자 확인 영역. 필요 판단 시에만 A(detector 무변경, 거짓 양성 추가 없음). 과잉 구현 회피 공리에 C가 가장 부합.

### fitness executed-mode

- **실재**: stale. executed 실행 provider(`executed-provider.ts:122`)·Assurance drift 집계 뷰(`drift.ts:84` + `ditto fitness drift` CLI) **둘 다 구현, 테스트 21 pass**. 구현 커밋(06-05)이 gap 텍스트(06-08)보다 앞섬. 진짜 잔여 하나: **컴파일언어 clean-build provisioning** — 스키마 `acgExecution.environment`(`acg-fitness-function.ts:39`)가 어떤 provider에도 소비 안 됨(grep 0건). 참고로 "컴파일언어 clean build 보장" 안전 불변식은 CodeQL doctor 경로엔 이미 있음(`doctor.ts:129-139`), executed fitness 경로에만 없음.
- **해결방안**: (A1) 문서 정정. (A2) `execution.environment` 소비 — 컴파일언어인데 clean 미입증이면 fail-closed skip(doctor probe 재사용, 신규 스키마 0). (A3) 언어별 toolchain 자동 셋업(기각 — stack-agnostic 위반). drift 뷰는 done이므로 (B1) 정정뿐.
- **추천: A1 우선(+ B1).** gap 텍스트의 두 주장 중 하나(drift)는 명백히 거짓, 다른 하나도 부정확. A2는 작은 fail-closed 가드로 분리 제안 가능(빈/부분 추출을 pass로 오판하는 위험을 정적분석 경로와 일관되게 차단) — 단 executed fitness가 실타겟에서 컴파일언어에 쓰인 사례를 못 찾아 **수요 불확실**, 사용자 가치 판단 영역. A3는 ADR-0008 stack-agnostic 위반으로 기각.

### 평가 지표 수집

- **실재**: 부분 stale. fitness drift(§5 ⑥)와 intent-quality-doctor(`intent-quality-doctor.ts`, `ditto doctor intent-quality`) **2개 집계 파이프라인 실재** — 둘 다 "이미 쌓인 데이터에서, 새 instrumentation 0"으로 동작. §5 7지표 중 ⑥만 전용 뷰, ①②③④⑤⑦은 원천 데이터(completion.json 등)는 쌓이나 가로지른 집계 뷰 없음. ":317 파이프라인 없다"는 과대 주장.
- **해결방안**: (A) 문서 정정. (B) `ditto doctor completion-coverage` — intent-quality-doctor 패턴 복제, 이미 100% 존재하는 completion.json에서 "evidence로 닫힌 AC/전체" 집계(새 로깅 0). (C) 7지표 통합 대시보드(기각 — 측정을 위한 측정, 현 데이터 모수에서 통계 빈약, 단일 사용 추상화).
- **추천: A 필수, B는 소비자 있을 때만.** §9가 이미 있는 능력을 "없다"고 깎아 정직성 원칙을 역으로 위반 중 — 문서를 사실에 맞추는 것이 비용 0·정직성 직접 회복. B는 검증된 doctor 패턴 재활용이라 저비용이나, 누가 이 수치를 소비하는지 불명확하면 보류(단일 사용 추상화 회피). C는 가치7·과잉구현 회피에 정면 충돌.

### 축4 durable 판정 휴리스틱

- **실재**: 부분 stale. `knowledgeUpdateGate`(`gates.ts:311-331`)가 curator 신고 트리거 ↔ 실제 기록 delta의 정합을 검사 — over(트리거 0인데 기록>0)·under(트리거 fired인데 기록 0) 둘 다 fail(테스트 4 pass, dogfooding 실증). 스키마도 supersedes 강제(`knowledge-record.ts:41`). 진짜 잔여 둘: **(a) hook 강제 미배선** — `src/hooks/` 어디서도 호출 안 됨, SKILL.md가 "실행하라" 권고만(다른 4개 게이트는 Stop hook이 강제). **(b) 게이트는 정합만 검사** — "trigger 신고가 옳은가"(놓침)는 못 잡음. ADR-0010 (b)("에이전트 판단")와 모순 없음 — 게이트는 기록 여부를 강제 안 하고 정합만 본다.
- **해결방안**: (0) 현행 유지 + 문서 정정. (1) knowledge 노드 완료에 게이트 배선(강제 시점 추가). (2) under-recording 후보 제안 게이트(놓침 검출 — 단 또 다른 휴리스틱 추출기, curator가 명시 거부한 것과 충돌). (3) knowledge-record 중복/미선언 supersedes 검출(over 정제, Context Rot·토큰 기여).
- **추천: 1 + 0.** 게이트 함수·CLI·테스트가 다 있는데 hook 배선만 없다 — "효과는 런타임 게이트로 강제"라는 핵심 정신에 정확히 미달한 지점이고, 배선이 가장 적은 코드로 메운다(다른 4개 게이트와 일관). ADR-0010 (b)와 무충돌(정합만 강제). 2는 과잉 구현 위험 최대(노이즈 advisory가 인지비용↑, curator 본문과 충돌)라 보류. 3은 독립 fast-follow 후보.

---

## 2. 철학 적합 종합 — 무엇을, 왜 먼저 하나

DITTO 최상위 기준 셋으로 모든 방안을 거른다: ① 효과는 문서 권고가 아니라 **런타임 게이트로 강제**, ② **증거 없는 완료/미완 선언 금지**, ③ **가장 간단하되 검증된 최소 구현**(과잉 회피).

**1순위 — §9 정직성 정정 (gap 6건 전부 공통).**
§9가 완료를 미완으로 잘못 선언하는 것 자체가 기준②의 역방향 위반이다. 코드 0줄, 비용 0, 정직성 직접 회복. 이것이 "gap을 메운다"의 첫 번째 의미 — 가짜 gap을 지운다. 정정 후 진짜 잔여만 남는다.

**2순위 — 이미 만든 게이트를 강제 시점에 배선 (축4 방안1).**
가장 높은 철학 적합. 게이트가 실재하는데 문서 권고(SKILL.md)에만 머문 것은 기준①에 정확히 미달한 지점이고, 배선만으로 최소 코드로 메운다. 신규 추상화 0, ADR 충돌 0.

**3순위 — observe→ratify→enforce 고리 닫기 (⑥ 방안A `architecture ratify`).**
ADR-0004가 예고한 fast-follow. "사람 권위·자동 박제 금지" 불변식 보존하며 기존 깊은 구현 위 작은 연결. 기준①③ 부합.

**4순위(코드 신설, 사용자 허가 후) — dataflow→DoD 술어 (WI-5 방안W5-a).**
"테스트 통과"를 검증가능 명제로 바꿔 기준②와 의도 이탈 구조적 차단에 직결. 단 src 신설이라 lazy 게이트 대상 — 착수 전 사용자 허가.

**보류/leave-as-is가 오히려 철학 적합인 것:**
- **Multi-Change(방안C)**: fail-closed라 이미 안전. 다중 차단 추가는 도메인 가치 판단 없이는 과잉.
- **fitness A2·평가지표 B**: 작은 가드/집계로 저비용이나 **실수요 불확실** — 소비자가 분명할 때만. 지금 만들면 단일 사용 추상화·미래 추상화 위험.
- **CodeQL 죽은 dialectic 경로**: 부활이 아니라 정리(W4-b)가 정답.

---

## 3. 개념적 한계(§9:320-323)에 대하여

사용자 요청은 "gap을 메우려는 것"이나, §9의 개념적 한계 3건(코드↔제품 이해 갭, 적합성 함수 비용, ArchitectureSpec 출처)은 **메울 대상이 아니라 스펙이 정직하게 열어둔 설계 사실**이다.
- 코드↔제품 이해 갭: 증거는 결과를 검증할 뿐 agent의 이해를 만들지 못함 — 원리상 닫히지 않는 한계(메울 gap 아님).
- 적합성 함수 비용: ADR-0004가 cadence 정책(per_change/risk_tiered/periodic)으로 이미 관리 — 안전 불변식(fail-closed escalate)도 박힘. 해소된 설계 결정.
- ArchitectureSpec 출처: ⑥ 방안A(ratify)가 이 한계의 운용 답.

즉 개념적 한계는 정정·관리 대상이지 구현으로 "메우는" 대상이 아니다.

---

## 4. 불확실성 (전 gap 공통)

- **테스트는 서브에이전트가 fresh 실행한 단위·주입 mock 수준**(7/21/14/4 pass). CodeQL 실 바이너리로 target repo를 분석해 stop을 exit 2로 막는 full e2e, `ditto fitness drift`/`doctor intent-quality`의 실 출력은 이 조사에서 직접 실행하지 않음 — 차단/집계 *로직*은 검증, 실 *동작*은 미검증.
- **"~30%" 등 진척률 수치**는 코드에서 근거 못 찾음(추론).
- **stale 판정의 시점 근거**(gap 텍스트가 구현 후 쓰였다)는 일부 git blame 미실행 — 커밋 날짜 대조·테스트 존재로부터의 추론 포함.
- **fitness A2·평가지표 ①②③④⑤ 집계 가능성·실수요**는 미검증 — 가치·우선순위 판단이라 사용자 확인 영역.
- 본 조사는 read-only. 어떤 파일도 수정하지 않음. 문서 정정·코드 착수는 모두 사용자 허가 사항.
