# ADR-20260625-premortem-relevance-gate: pre-mortem far-field 폭을 '관련 카테고리 전수'로 — 이진 관련성 게이트 (ADR-0023 폭 계약 부분 supersede)

- 상태: accepted
- 결정 일자: 2026-06-25
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: ADR-0023 (premortem coverage 카테고리-완전 종료 — **결정 4 "폭=항상 전수·불변"만 부분 supersede**; 카테고리-완전 종료·정당화-close 게이트·렌즈 주입·stakes-깊이는 불변), ADR-0021 (memory seam — 관련성 근거 결박의 entanglement는 이 seam 경유 소비, gap=가서봐·fail-open=포함), ADR-0020 (결정-모순 가드레일 — skip=감사가능·정당화 기록 철학과 정합), ADR-0018 (옵셔널 도구 우아한 강등 — 근거 도구 부재 시 fail-open=포함), ADR-0001 (ditto는 provider 직접 호출 안 함 — 관련성 판정·refute는 호스트 위임 서브에이전트가 생산, 코드는 구조적 출력만 소비). 코드(권위): `src/core/coverage-taxonomy.ts`(floor·`farFieldCoverageNodes`의 관련성 게이트·`CategoryRelevanceVerdict`·§6-1 원자화), `src/core/coverage-relevance.ts`(`assembleRelevanceVerdicts` — §5 안전 규칙의 결정적 집행), `src/core/coverage-loop.ts`(`nextCoverageNode` seed 배선), `src/cli/commands/autopilot.ts`(`coverage-next --relevance` seam), `agents/relevance-judge.md`(§5-2 producer), `skills/autopilot/SKILL.md`(§2b.0 spawn 배선). 설계 SoT: `reports/design/premortem-relevance-gate-redesign.md`. 메모리: far-field-relevance-gate-thread. 구현 WI: wi_260625l0v(설계 wi_2606258zu).

## 컨텍스트

ADR-0023은 "폭(카테고리 집합)=항상 전수·불변, 깊이만 stakes 비례"로 false-green(미시딩 도메인 silent miss)을 막았다. 그러나 실제 동작은 **floor 카테고리를 전부 `open` 노드로 시딩한 뒤 무관 카테고리를 *유료로* dismiss**하는 구조였다(`coverage-taxonomy.ts` `farFieldCoverageNodes` — 무관 카테고리도 judge 패스를 써서 `out_of_scope`로 닫아야 빠진다). 결과: zero-code/저관련 work item에도 전 카테고리 전수 sweep이 걸려 순수 overhead가 발생한다(ADR-0023 §far-field 자동화 보류의 비용 모델: light tier·Opponent-only 카테고리당 ~35k 토큰, floor 외삽 ~670k(Opponent only)~2–3M(3역 dialectic)/소변경; false-negative 표본 2건 0). 비용이 1차 통증인데, 폭이 항상 전수라 비용 레버가 깊이(tier)밖에 없었다 — 그런데 깊이를 줄이면(얕은 커버리지) pre-mortem이 "실패를 진짜 상상"하지 못하는 연극이 된다.

## 결정

far-field 폭을 "항상 전수" → **"관련 카테고리 전수"**로 재정의한다. 관련성은 **이진 게이트**(관련=끝까지 전수·무관=skip, 얕은 중간 없음)이고, 비용 절감은 *커버리지*가 아니라 *관련성 판정*에서 온다 — 관련성을 정하는 데만 싸게 쓰고, "관련"이면 비용을 아끼지 않는다.

skip은 **4중 안전장치**를 통과해야만 가능하며, 그 집행은 에이전트 재량이 아니라 **코드**(`assembleRelevanceVerdicts`·`farFieldCoverageNodes`)에 있다:

1. **보수적 기본값** — 애매하면 포함(커버). skip은 확신할 때만. (코드: well-formed not-relevant verdict가 아니면 무조건 `open`.)
2. **근거 결박** — "이 변경이 해당 도메인 코드 경로·표면을 건드리나?"를 grep/AST/메모리 entanglement(ADR-0021 seam, gap=가서봐, fail-open=포함)로 확인한 뒤 판정. 순수 LLM 상상으로 skip 불가. (producer: `agents/relevance-judge.md`.)
3. **적대 검증(refute-by-default)** — 한 평가자(dialectic Opponent 재사용)가 **전 skip 후보를 일괄**로 "이 카테고리는 *관련 있다*"를 oracle-linked로 입증 시도(범위 1회 결박 후 후보별). 그럴듯한 경로 하나라도 찾으면 그 skip 취소·카테고리 생존. 일괄인 이유: 후보당 별도 spawn은 비용이 skip 수에 비례(§8-5 실측 — refute 1건 ≈ judge 전체 ~48.5k)하나, 안전 계약(refute-before-skip)은 일괄에서도 불변. (코드: `assembleRelevanceVerdicts`는 refute가 *생존*(`refuted:false`)할 때만 skip 허용 — 없거나 뒤집으면 `open`. 일괄 opponent의 다-id 출력 `{id,refuted}[]`을 그대로 소비.)
4. **감사 + 하류 catch** — 모든 skip은 `out_of_scope` 노드로 `close_reason`+`residual_risk`를 기록(조용한 drop 금지). 하류 verify/review/e2e·`ditto verify`가 skip한 카테고리 실패를 잡으면 사용자 귀속.

입도는 **하이브리드**(§6): 명백한 번들(security-privacy → injection/secret-exposure/pii-leak/regulatory, resource-abuse → resource-exhaustion/abuse-vector)을 정적 원자화해 seed 시점 게이트를 정밀하게 하고(facet 단위 include/skip), 나머지 long-tail은 기존 동적 분해(`coverage-loop` derived 노드)로 신규 기계 없이 처리한다.

이 skip은 ADR-0023이 막으려던 "조용한 skip"이 아니라 **근거 + 적대검증 + 기록을 거친 감사가능 skip**이므로 false-green을 재도입하지 않는다 — ADR-0023의 보호 의도(미시딩 도메인 silent miss 방지)는 보수적 기본값 + gap=가서봐 + 적대검증으로 보존된다.

**ADR-0023과의 관계(부분 supersede).** 이 ADR은 ADR-0023의 **결정 4("폭=항상 전수·불변")만** supersede한다. ADR-0023의 나머지 — 카테고리-완전 종료(결정 1), 정당화-close 게이트(결정 2), 렌즈 주입(결정 3), 보존(결정 5), stakes-깊이(결정 4의 깊이 축, 일반 coverage용) — 는 **전부 불변**이다. 깊이 축(tier)을 far-field 비용 레버로 쓰자는 대안은 명시 기각한다(§근거).

## 근거 (rationale)

관련 있는 카테고리를 얕게 보는 건 목적(실패를 미리 상상으로 겪어 재현을 막음)을 달성하지 못한다 — 인증을 1각도로 슬쩍 보는 건 "봤다는 표시"지 인증 실패를 진짜 상상한 게 아니다. 그래서 "관련=끝까지·무관=skip"의 이진이고, 중간(얕은 커버리지)이 없다.

이진 게이트의 위험은 관련 카테고리를 잘못 skip하면 그 질문이 전멸하고 skip이 silent하다는 것 — 이게 ADR-0023이 막으려던 바로 그 false-green이다. 4중 안전장치가 이 위험을 강등한다: 보수적 기본값이 "필요한 거 OFF"를 "무관 facet 과잉 커버=비용 낭비(안전)"로 바꾸고, 적대검증(전 skip 후보 일괄 1패스 — §8-5)이 잘못된 skip을 되살린다. 안전 규칙을 코드에 두어 에이전트가 카테고리 생사를 임의로 정하지 못하게 했다.

기각된 대안:

- **깊이 throttle(얕은 커버리지)를 far-field 비용 레버로** — 관련 카테고리를 light로 슬쩍 봄. pre-mortem 연극(실패를 진짜 상상 못 함), "관련=끝까지" 원칙 위반 → 기각. 깊이 dial은 일반 coverage에서 불변(ADR-0023 결정 4).
- **안전장치 없는 생사 필터** — 순수 LLM이 카테고리 생사 결정 → false-green 재도입(필요 질문 silent 전멸) → 기각(4중 필수).
- **novelty-dry 유지 + 프롬프트만** — 미관련 카테고리에도 전량 비용, 통증 미해결 → 기각.
- **무한 정적 과분해** — taxonomy 비대·완전성 곤란, 과분해 자체가 비용 → 명백한 번들만 정적 원자화 + 나머지 동적 분해(하이브리드) 채택.

## 변경 조건 (change_condition)

- 관련성 게이트의 false-negative(관련 카테고리를 skip)가 하류에서 **반복 검출**되면 → 보수성 강화·근거 신호 보강(필요 시 게이트 기본 off). 깊이 축(tier)은 일반 coverage에서 불변.
- far-field ON/OFF 한계비용 **실측**이 게이트 가치를 부정하면(절감 미미) → 게이트 기본 off. (측정 정의는 설계 §8 — 후속 acceptance.)
- ADR-0021 memory seam이 standalone로 이관되면 → 관련성 근거의 entanglement 주입 소스만 seam 뒤에서 교체(이 게이트 계약 불변).
