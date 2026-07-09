# intent-dissent opponent — 실측 + localization 재조정 결정

- work item: wi_260709e4c (follows wi_260709x5w → #13)
- 측정 세션: 2026-07-09
- agent: `ditto:intent-dissent-opponent` (전용 persona, dist/plugin 레지스트리 로드 확인 — stand-in 아님)
- 방법: 각 대상 WI의 실제 original intent(source_request)를 brief로 emit → 전용 opponent를 그 intent에 **blind**하게 spawn(인터뷰 transcript 미제공, SKILL §5.5) → 반환 verdict envelope `{verdict, impact, text}` 포착. verdict 분포는 persist된 interview-state가 아니라 **agent 반환 envelope**에서 계측한다(근거: `dissent-record`는 verdict/impact를 버리고 text 유무로 engaged/host_absent만 persist·verdict를 무조건 revise로 접음 — interview-driver.ts:620-629).

## ac-1 — 전용 agent 라이브 발화 (증거)

`ditto:intent-dissent-opponent`가 실제 deep-interview run(#14 = wi_260709d00, critical dim `d-termination-contract`)에서 spawn돼 발화:
- 반환: `verdict=revise, impact=high` (host_absent 아님).
- persist 확인: `.ditto/local/work-items/wi_260709d00/interview-state.json` → `d-termination-contract.dissent = {status: engaged, verdict: revise, impact: high, acknowledged: false}`.
- **full seam end-to-end**: `ditto deep-interview finalize`가 이 engaged high dissent 위에서 `blocked_by_dissent`로 차단, `intent.json` 미기록(아무것도 커밋 안 됨) 확인. (finalize payload의 user_confirmation은 seam probe로 명시 — 차단되어 무기록.)

→ **ac-1 충족**: 전용 agent가 critical dimension에 발화(engaged, not host_absent), 게이트가 그 위에서 end-to-end로 걸림.

## ac-2 — 발화 빈도 + verdict 분포 (5 data points)

### A. critical dimension (localization이 **발화하는** 곳) — 3건

| # | WI | dimension | verdict | impact | engaged | 요지 |
|---|---|---|---|---|---|---|
| 1 | wi_260709d00 (#14 novelty-종료) | d-termination-contract | revise | high | ✅ | 모호한 "병행/우선순위 명시"를 명시적 OR-가산exit로 sharpen; coverage의 AND는 서로 다른 완전성 축임을 구분 |
| 2 | wi_2607095fz (통합검증 부재) | d-integration-surface | revise | high | ✅ | crux를 "통합을 어디서 돌릴까(위치)"에서 "공백을 masked-green 아닌 정직 unverified로 floor(oracle-tiering A)"로 재중심화 |
| 3 | wi_260707oi1 (prism 재구축) | d-prism-boundary | revise | high | ✅ | "두 peer 표면 분할"을 "단일 intent writer 재사용"으로 교정 — 원 프레이밍이 사용자가 없애려는 프록시 anti-pattern 재생산 위험 |

### B. non-critical dimension (localization이 **발화 안 하는** 곳 — under-fire probe) — 2건

기존 실 인터뷰(wi_260709mqt = #13 dissent 작업)에서 **non-critical**로 마킹된 실 dim에 동일 opponent를 구동해, critical-only가 실 high-impact mis-intent를 놓쳤는지 직접 검사.

| # | WI | dimension | verdict | impact | engaged | 요지 |
|---|---|---|---|---|---|---|
| 4 | wi_260709mqt | d-host-absent | revise | **low** | ✅ | host_absent 트리거를 "부재만"→"부재 OR empty/null OR throw"로 명확화 — 코드가 이미 그러함, wording only |
| 5 | wi_260709mqt | d-dissent-direction | revise | **low** | ✅ | "더 강한"=강한 CORRECT 읽기 + already-accurate면 accept, 양방향 상한 명확화 — 코드가 이미 realizes, wording only |

### 집계

- **발화 빈도**: 5/5 spawn이 실제 발화(non-host_absent). 전용 agent는 brief만으로 매번 실 verdict 산출 — dormant/degrade 없음.
- **verdict 분포**: revise=5, accept=0, reject=0.
- **impact 분포**: high=3, low=2.
- **finalize-gating (critical ∧ engaged ∧ high ∧ unack)**: critical 3건 전부 차단 자격. non-critical 2건은 low-impact라 발화해도 게이트 무관.
- **핵심 상관**: agent가 **독립 판정한 impact가 criticality를 정확히 추종** — high는 critical dim 3개에만, low는 non-critical dim 2개에만. (impact는 agent envelope 값이지 CLI의 critical-파생 값이 아님 → 동어반복 아닌 실 상관.)

## ac-3 — localization 재조정 결정: **현행 critical-only 유지**

### 결정
`src/core/interview-driver.ts`의 `if (d.critical)` 분기(opponent를 critical dimension에만 국소 발화, deep-interview.ts:653의 `dissent-briefs` 동일 필터)를 **변경하지 않는다.** 코드 변경 없음.

### 데이터 근거
1. **critical에서 발화는 생산적**: 3/3이 high-impact 실 dissent. localization이 발화하는 곳은 gating-relevant mis-intent가 실제로 사는 곳이었다.
2. **non-critical에 놓친 high-impact 없음 (under-fire 반증)**: 비-critical dim 2건 probe에서 나온 건 low-impact wording 뉘앙스뿐. finalize 게이트는 high-impact에만 걸리므로, localization을 비-critical로 넓혀도 **게이트에 잡히지 않는 low-impact noise + spawn 비용 + 사용자 검토 부담**만 늘고 gating 가치는 0. 이는 §4-3(단순 해법)과 #13 intent의 "소수·고임팩트로 국소화 / 사용자 루프 안, 질문 폭증 금지" 제약에 정면 배치.
3. **over-fire 신호 없음**: critical 표본에 spurious/wasted 발화(accept) 0. (단 표본이 모호 WI로 편향돼 base accept율은 미계측 — 아래 한계.)
4. impact가 criticality를 정확히 추종 → critical-only는 high-impact가 발생하는 곳과 정렬. 임계 이동을 **정당화할 미스캘리브레이션 증거가 없다**; 변경은 근거 없는 코드 변경(§4-4)이 된다.

### 한계 (정직)
- N=5(critical 3 + non-critical 2), 단일 세션, 대상은 "모호함"으로 선별 → selection-biased. base over-fire율(쉬운 critical dim의 accept 빈도)은 미계측.
- 이 결론은 "**변경을 정당화할 증거 없음 → 유지**"이지, "critical-only가 보편 최적"의 강한 주장이 아니다. 재조정은 미스캘리브레이션의 양성 증거가 쌓일 때 재검토(철회 조건).

## 산출물 부산물
- wi_260709d00(#14): 종료 계약 critical 결정 = **OR**(사용자 답변) + 전용 opponent가 독립 수렴한 sharper 재진술 persist. #14 실 build는 별도 heavy-path(이후).
- wi_2607095fz / wi_260707oi1: 측정용 scaffolding interview-state는 측정 후 제거(원 상태 복원) — opponent verdict는 본 산출물에 보존.
