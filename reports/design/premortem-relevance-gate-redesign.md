# far-field pre-mortem — 관련성 게이트 재설계 (초안)

> wi_2606258zu (ADR-0023 재검토 트리거 wi_26062227h 실현). 산출물=설계 합의 + ADR 초안. **구현은 후속 WI.**
> 권위는 코드(§4-11). 이 문서의 사실 주장은 모두 file:line으로 결박했고, 인용한 동작은 코드가 SoT다.

## 1. 문제 (코드로 확정)

far-field pre-mortem coverage는 plan-stage(design 노드)에서 위험을 sweep한다(`autopilot-loop.ts:1514` — `design 노드 + plan_brief`일 때만 호출). 핵심 결함:

- **관련성 사전 필터가 없다.** `farFieldCoverageNodes`(`coverage-taxonomy.ts:185-209`)는 taxonomy의 **모든 카테고리(19개)를 무조건 `open` 노드로 시딩**한다. WI별 관련성으로 거르는 단계가 없다.
- 카테고리를 빼려면 그 노드를 `out_of_scope`로 **닫아야** 하는데(`coverage.ts:13` close-state enum, `close_reason` 기록 필수), 그 닫음 자체가 judge 패스를 쓴다. → **"불필요한 카테고리를 빼고 나머지만"이 아니라, 19개 전부 깔고 judge가 비용 써가며 '해당없음'으로 쳐내는** 구조.
- 유일한 차단은 전부-아니면-전무 env 토글(`coverage-taxonomy.ts:223` `farFieldCategoriesEnabled`).
- 비용(ADR-0023 §far-field 자동화 보류): light tier·Opponent-only 카테고리당 ~35k 토큰, 19-floor 외삽 ~670k(Opponent만)~2-3M(3역 dialectic)/소변경. ON/OFF 한계비용 ~20배는 **추정·직접 측정된 적 없음**. 표본 2건 false-negative **0**.

증상: zero-code/저관련 WI도 19개 전수 시딩되어 무관 카테고리에 비용을 치른다(bulk 도그푸딩에서 zero-code WI 3건 전량 실행 재확인).

## 2. 의도 (deep-interview 합의 — interview-state wi_2606258zu)

1차 목표 = **비용 우선**(신뢰성도, 단 비용 먼저). 재오픈 동기 = 위 구체적 통증(추정 아님, 코드 확정).

## 3. 모델 — 카테고리 = 이진 관련성 게이트

pre-mortem의 목적은 "실패를 미리 상상으로 겪어 재현을 막거나 대응"하는 것이다. 이 관점에서 카테고리를 **얕게** 보는 건 목적을 달성하지 못한다(인증을 1각도로 슬쩍 = 인증 실패를 진짜 상상한 게 아니라 "봤다는 표시"). 따라서:

- **관련 있다 → 끝까지 전수**(그 카테고리의 실패를 genuine하게 dry까지 탐색).
- **관련 없다 → 아예 skip**(인증 없는 기능에 인증 질문 생성 안 함).
- **중간(얕은 커버리지)은 없다.**

→ 비용 절감은 **"커버리지"가 아니라 "관련성 판정"에서** 온다. 관련성을 정하는 데만 싸게 쓰고, "관련"이면 비용을 아끼지 않는다.

기존 tier 깊이 다이얼(`coverage-manager.ts:511` `selectCoverageTier`, `:687` `TIER_DEPTH` — light=1각도/standard=3/full=5)은 **결정적**이고 일반 coverage용이다. far-field의 축은 깊이가 아니라 **관련성**이므로 깊이-throttle은 부적합(§9 기각).

## 4. 두 레버 (분리)

| 레버 | 표면 | 목적 | 메커니즘 | ADR-0023 |
|---|---|---|---|---|
| **비용** | plan-stage | 무관 카테고리에 비용 안 씀 | 이진 관련성 게이트(§3) | **폭 계약 supersede**(§6) |
| **신뢰성** | intent-stage (deep-interview) | ③ 요구사항형 LLM 환각 제거 | 렌즈 강조 강화(C2=A) | 불변 |

신뢰성 레버(C2=A): far-field 렌즈는 이미 deep-interview intent-stage에 주입돼 있다(`interview-driver.ts:511-514` — 렌즈 ON, `seedCategories` 미전달=비종료 회피). ③ 요구사항형(감사 필요?·인가 모델?·호환성 보장수준?)을 judge가 더 적극적으로 사용자 질문으로 끌어내도록 **생성기 지침 강화**(코드 변경 0~최소). 종료 책임은 plan-stage 유지 → ADR-0023 불변. ①②를 deep-interview서 묻는 건 QuestionGate 위반(코드가 답함)이므로 제외.

## 5. 관련성 판정 안전장치 (4중) — 급소

이진 게이트의 위험: 관련 있는 카테고리를 잘못 skip하면 그 질문이 **전멸**하고, skip은 silent하다(얕게라도 봤으면 흔적이 남지만 skip은 흔적 없음). 이건 ADR-0023이 "폭=항상 전수"로 막으려던 false-green을 다시 들이는 길이다. 그래서 관련성 판정은 4중 안전장치를 통과해야 한다:

1. **보수적 기본값** — 애매하면 → 포함(커버). skip은 *확신할 때만*. ADR-0023의 "미확인=가서 봐(gap)" 원칙 재사용. *효과: 위험한 "필요한 거 OFF"를 "무관 facet 과잉 커버=비용 낭비(안전)"로 강등.*
2. **근거 결박(상상 아님)** — "이 변경이 해당 도메인 코드 경로·표면을 건드리나?"를 grep/AST/메모리그래프 entanglement로 **확인**한 뒤 판정. 순수 LLM 상상으로 skip하지 않는다. (entanglement는 ADR-0021 seam 경유 소비, gap=가서봐, fail-open=포함.)
3. **적대 검증(refute-by-default)** — skip 후보당 별도 평가자가 "이 카테고리는 *관련 있다*"를 입증 시도 → 그럴듯한 경로 하나라도 찾으면 skip 취소·카테고리 생존. dialectic Opponent + oracle-linked objection 재사용(`dialectic.ts` Opponent 축). skip 후보당 1패스로 full 커버리지보다 싸다.
4. **감사 + 하류 catch** — 모든 skip은 이유 기록(기존 `close_reason`+`residual_risk`, `coverage.ts:13` 재사용 — 조용한 drop 금지). verify/review/e2e 또는 `ditto verify`가 skip한 카테고리 실패를 잡으면 사용자 귀속(ac-11b outcome 루프, 커밋 d225209).

→ 에이전트가 "카테고리 생사"를 정하되, **죽이려면 근거+적대검증+기록을 통과**해야 하므로 함부로 못 죽인다.

## 6. 입도 정책 — 하이브리드

거친 분류는 이진 게이트 정밀도를 해친다(번들에 이질 facet). 다만 **보수적 기본값(§5-1)이 있으면 거친 분류의 주된 해악은 안전이 아니라 비용**(관련 facet 하나라도 있으면 포함→무관 facet까지 과잉 커버)이다. 세분화는 그 낭비를 회수하는 레버. 그러나 과분해도 비용(유지·완전성·판정 수)이 있으므로:

- **원칙**: "독립적으로 *근거 잡히고* 독립적으로 *커버 가능한* 단위"까지만 쪼갠다. 그 아래는 정밀도 없이 오버헤드.
- **floor 23개(§6-1 원자화 landed)**: 원래 `security-privacy`(인젝션+시크릿+PII+규제)·`resource-abuse`(용량+오남용)가 이질 번들이라 facet으로 분할했고, `time-clock`·`input-validation`은 원래부터 원자적.
- **하이브리드**:
  - (1) 명백한 번들만 **정적 원자화**(landed — `coverage-taxonomy.ts`: security-privacy → injection / secret-exposure / pii-leak / regulatory, resource-abuse → resource-exhaustion / abuse-vector) → seed 시점 게이트 정밀.
  - (2) 나머지 long-tail은 **관련 카테고리 내 적응형 동적 분해** — sweep이 이미 derived/child 노드를 동적 생성(`coverage-loop.ts:372-419`), 신규 기계장치 없이 재사용. 무관 카테고리는 안 켜지니 분해 비용 0.
  - (3) 완전성 critic(ac-6)은 분해 입도에서도 새 카테고리/facet 시딩 — 틈 backstop. 잔여 거칠음은 §5 보수+적대가 책임.

## 7. 기존 landed 기계장치 매핑 (재사용 / supersede / 보존)

| 설계 요소 | 코드 (file:line) | 처리 |
|---|---|---|
| 카테고리 시딩 | `coverage-taxonomy.ts:185-209` `farFieldCoverageNodes` | **supersede** — 전수 시딩 → 관련성 게이트 통과분만 시딩 |
| 관련성 close 어휘 | `coverage.ts:13` `resolved/user_owned/out_of_scope` + `close_reason`/`residual_risk` | **재사용** — skip=감사가능 close(§5-4) |
| 적대 검증 | `dialectic.ts` Opponent + oracle-linked objection | **재사용** — skip refute(§5-3) |
| 동적 분해 | `coverage-loop.ts:372-419` derived/child 노드 | **재사용** — 적응형 입도(§6-2) |
| 렌즈 주입 | `coverage-loop.ts:198,214` `farFieldLenses()` | **재사용** — 신뢰성 레버 C2=A(§4) |
| tier(깊이) | `coverage-manager.ts:511,687` | **보존** — 일반 coverage용, far-field 축 아님(§3) |
| 하류 catch | ac-11b outcome 루프(d225209) | **재사용** — skip false-negative 귀속 |
| env 토글 | `coverage-taxonomy.ts:223` | **대체** — 관련성 게이트 + (ac-10) 프로젝트 config |

**회귀 방지(ac-7 보존)**: 관련성 게이트는 가산·플래그로 도입하고, 게이트 off=기존 전수 시딩 동작 보존. 기존 coverage/autopilot 테스트 green 유지. 엔진 직접 호출자(`nextCoverageNode` `seedCategories` 기본 false)는 불변.

## 8. 비용 측정 (정의 — 실측은 라이브)

ADR-0023이 ON/OFF 한계비용을 "추정(~20배)·직접 측정 안 됨"이라 명시(`coverage-manager.ts` 비용 모델 근거). 비용이 1차 목표이므로 ON/OFF 한계비용 실측을 **명시 acceptance**로 둔다. **코드에 per-run 토큰 회계가 없다**(검증: `run-manifest`·`autopilot`·`evidence-log` 스키마에 token/usage 필드 부재) → 토큰 실측은 자동으로 못 읽고 아래 프로토콜로 *수동* 수행한다. 이 슬라이스는 측정을 **정의**하고, 실측치 수집은 라이브 autopilot 런(별도)이다.

### 8-1. 메트릭 (두 축, 혼동 금지)

1. **far-field feature ON/OFF** (ADR-0023의 "~20배" 축): far-field 카테고리 시딩 자체를 켜고(`DITTO_FARFIELD_CATEGORIES=1`, 전 카테고리 sweep) 끔(`=0`, root-only). 한계비용 = feature가 더 쓰는 sweep 토큰.
2. **relevance gate ON/OFF** (이 WI가 더한 축): feature는 ON인 채, 관련성 게이트로 무관 카테고리를 사전 close하느냐(`coverage-next --relevance`로 verdict 주입) 전수 sweep하느냐. 한계 *절감* = 게이트가 사전 close해 sweep을 피한 카테고리의 토큰.

### 8-2. 프로토콜 (수동, 라이브)

1. **표본 선정**: 관련성이 갈리는 work item 2–3건(예: zero-code/문서 변경 = 무관 다수, 인증·결제 변경 = 관련 다수). 각각 design 노드가 있는 실제 WI.
2. **OFF run**: `DITTO_FARFIELD_CATEGORIES`/`--relevance` 없이 plan-stage coverage sweep을 dry까지 구동. 호스트 세션 토큰 사용량(ditto 내부 회계 없음 → Claude Code/Codex 세션 usage 리포트)을 sweep 구간에 대해 기록.
3. **ON run**: 같은 WI를 §2b.0 관련성 게이트와 함께 구동(judge+refute→`--relevance`). 같은 방식으로 토큰 기록.
4. **델타**: `한계절감 = tokens(OFF) − tokens(ON)`, `절감률 = 델타/tokens(OFF)`. 사전 close된 카테고리 수는 `farFieldCoverageReport.skipped`(결정적)로 교차검증 — 토큰 절감이 사전 close 비율에 비례해야 한다.
5. **기록**: 실측치와 보정 판정을 retro 메트릭(`retroMetricSnapshot.metrics.process_health.post_cost`, 사후 비용 필드)에 또는 이 §8 하위 표에 남긴다.

### 8-3. 결정적 프록시 (지금 측정 가능)

토큰 실측 전이라도 게이트의 **폭 축소 효과**는 결정적으로 관측된다: `farFieldCoverageReport`의 `skipped`(사전 close된 카테고리)가 곧 "sweep을 피한 카테고리 수"다. 토큰은 ADR-0023 표본의 카테고리당 ~35k(light·Opponent-only)를 곱한 *추정*일 뿐이고, §8-2가 그 추정을 실측으로 대체한다.

### 8-4. 보정 기준 (acceptance)

- 관련성 게이트가 저관련 표본에서 **유의미한 절감**(무관 카테고리 다수를 사전 close → 비례 토큰 절감)을 보이면 → 게이트 기본 ON 유지.
- 절감이 미미하면 → 게이트 기본 OFF(ADR-20260625 change_condition과 동일 트리거).
- 관련 카테고리를 잘못 skip한 false-negative가 하류에서 검출되면 → 보수성·근거 신호 강화(절감보다 안전 우선).

(미충족 — 라이브: §8-2 실측치 수집은 multi-M 토큰 sweep 2회를 요하므로 본 슬라이스에 미포함. 정의·프록시·기준은 확정.)

## 9. 기각된 대안

- **깊이 throttle(얕은 커버리지)**: 관련 카테고리를 light로 슬쩍 보기 → pre-mortem 연극(실패를 진짜 상상 못 함). "관련=끝까지" 원칙 위반 → 기각.
- **안전장치 없는 생사 필터**: 순수 LLM이 카테고리 생사 결정 → false-green 재도입(필요 질문 silent 전멸) → 기각(§5 4중 필수).
- **novelty-dry 유지 + 프롬프트만**: 미관련 카테고리에도 전량 비용 → 통증 미해결 → 기각.
- **무한 정적 과분해**: taxonomy 비대·완전성 곤란 → 하이브리드(§6) 채택.

---

## 부록 A — ADR 초안 (정식화됨 → ADR-20260625-premortem-relevance-gate)

> 정식화 완료: `.ditto/knowledge/adr/ADR-20260625-premortem-relevance-gate.md`(accepted, landed)가 권위. 아래는 그 초안의 역사적 기록.

**제목**: pre-mortem far-field 폭을 '관련 카테고리 전수'로 — 이진 관련성 게이트 (ADR-0023 폭 계약 부분 supersede)

**상태**: accepted (landed as ADR-20260625)

**관련**: ADR-0023(supersede 대상 — 폭 계약), ADR-0021(entanglement seam 경유), ADR-0020(skip=감사가능·정당화 기록), ADR-0018(근거 도구 부재 시 우아한 강등=fail-open 포함).

**컨텍스트**: ADR-0023은 "폭(카테고리 집합)=항상 전수·불변, 깊이만 stakes 비례"로 false-green을 막았다. 그러나 실제 동작은 19개 전수 시딩 후 무관 카테고리를 *유료로* dismiss(`coverage-taxonomy.ts:185-209`)라, zero-code/저관련 WI에 순수 overhead(670k~3M 토큰/소변경, false-negative 0).

**결정**: far-field 폭을 "항상 전수" → **"관련 카테고리 전수"**로 재정의한다. 관련성은 **이진 게이트**(관련=끝까지 전수·무관=skip, 얕은 중간 없음)이고, skip은 **4중 안전장치**(보수적 기본값·근거 결박·적대 검증 refute-by-default·감사기록+하류 catch)를 통과해야만 가능하다. 이 skip은 ADR-0023이 막으려던 "조용한 skip"이 아니라 **근거+적대검증+기록을 거친 감사가능 skip**이므로 false-green을 재도입하지 않는다 — ADR-0023의 보호 의도(미시딩 도메인 silent miss 방지)는 보수적 기본값+gap=가서봐+적대 검증으로 보존된다.

**기각된 대안**: §9.

**철회·재검토 조건**: 관련성 게이트의 false-negative(관련 카테고리를 skip)가 하류에서 반복 검출되면 → 보수성 강화·근거 신호 보강. ON/OFF 실측이 게이트 가치를 부정하면(절감 미미) → 게이트 기본 off. 깊이 축(tier)은 일반 coverage에서 불변.

---

## 부록 B — 미해결 / 후속

**landed(wi_260625l0v)**: 관련성 게이트·§5 안전 assembler·producer 에이전트(relevance-judge)·적대 refute(dialectic-opponent 재사용)·SKILL §2b.0 배선·taxonomy 정적 분할(§6-1, floor 23)·ADR 정식화(ADR-20260625)·§8 비용 측정 정의. `coverage-taxonomy.ts` 주석 카테고리 수 drift도 정정(→23).

**남은 후속**: ① **ON/OFF 토큰 실측치 수집**(§8-2 — 라이브 autopilot 런 필요) ② **§2b.0 spawn 라이브 실증**(실 design 노드 sweep에서 judge+opponent 자동 작동) ③ 신뢰성 레버 C2=A 구현(deep-interview intent-stage 생성기 지침 강화 — 코드 변경 0~최소).
