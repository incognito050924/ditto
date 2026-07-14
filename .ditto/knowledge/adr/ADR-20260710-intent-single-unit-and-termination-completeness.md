# ADR-20260710-intent-single-unit-and-termination-completeness: 종료 완전성 게이트 + 하나의 의도=하나의 단위 불변식 — pass-close에서 in-scope agent-owned 잔여 무단 축소 차단·slice/phase 단위 부재 (ADR-20260627 materialize≠drive 보존, ADR-20260706 정합)

- 상태: accepted
- 결정 일자: 2026-07-10
- 결정자: hskim, claude (claude-opus-4-8)

> **클래스-한정 부분 supersede (2026-07-14, wi_2607148yg)** — **ADR-20260714-autopilot-defect-class-drive-carveout**가 D4의 "capture≠drive는 통과 조건 / out-of-scope 후속은 물질화만"과 same-run 단일 승인단위 경계를, **재현되는 실동작 버그 한 클래스에 한해** "물질화→구동(각자 자기 커밋)"으로 확장한다. 그 버그는 분류기(ac-2) 판정에 키드되어 자기 work item으로 물질화된 뒤 같은 run에서 done까지 구동된다. **D1 종료 완전성 게이트, 비-결함 슬라이스 금지, priority advisory-only, 두 fail-stop 조건은 전부 불변** — 종료 완전성은 오히려 강화된다(in-scope 잔여를 out-of-scope 후속으로 개명해 도망치는 경로가 좁아진다). 비-결함 후속의 capture≠drive는 온전.
- 관련: ADR-20260627-autopilot-followup-autonomy-boundary (materialize≠drive / no-auto-pick 불변식 — 이 ADR은 그 불변식을 **보존**한다; supersede 아님. capture≠drive가 종료 게이트의 통과 조건이 된다), ADR-20260706-work-item-record-run-split (work-item Record/Run 2-tier — 동적 task 단위에 **새 tier를 도입하지 않는다**, 정합), ADR-0024 (완료=per-AC oracle 수렴 — 종료 완전성 게이트는 그 수렴 위에 얹히는 잔여-처분 검사이지 oracle 대체가 아님), 진단 배경 wi_260710676/#18 ("완료-판정 채널 갭" — terminal flip이 Stop 게이트를 우회하는 패턴). 코드(권위): `src/core/gates.ts`(`passCloseResidualBlockers`:323 — 기존 `resolvabilityBlockers`:214 [unverified[]] + `riskRecordBlockers`:289 [remaining_risk_records[]] 재사용, R11 단일 라벨공간), `src/core/autopilot-complete.ts`(`deriveNonPassStatus`:480 · `loopStuckBlocked`:472 — non-terminal 교착 그래프에 `state:'blocked'` 방출), `src/cli/commands/work.ts`(`work done` close 경로 `passCloseResidualBlockers` 배선:2134 · `work follow-up --priority` 스탬프:2525), `src/cli/commands/autopilot.ts`(`autopilot complete` close 경로:534 · `follow_ups_to_pick_up` priority 정렬:675/:725), `src/schemas/work-item.ts`(`followUp.priority`:181 — additive optional int 1..5). 회귀 락: `tests/core/intent-single-unit-invariant.test.ts`. 구현 WI: wi_260710tjd (이슈 #19). 전 결정 landed + verified.

## 컨텍스트

이슈 #19는 autopilot 오케스트레이션의 두 경계를 물었다.

1. **종료 완전성 (axis: 완료 정직성).** autopilot이 `final_verdict=pass`로 work item을 닫을 때, in-scope agent-owned 잔여(에이전트가 해결할 수 있는데 미처분으로 남긴 위험·미검증 AC)를 **조용히 떨어뜨리고** done flip 할 수 있었다. 이는 헌장 §4-6("계획을 조용히 줄이지 않는다")의 위반 표면이다. 특히 terminal flip은 Stop 훅의 잔여 게이트(`resolvabilityBlockers`/`riskRecordBlockers`)를 **우회**한다 — flip이 Stop의 NON_TERMINAL 가드를 건드려, Stop-훅-only 배선은 무력화된다(wi_260710676/#18이 문서화한 "완료-판정 채널 갭": 새 완료 GATE는 판정 채널로의 WRITE 경로가 필요하지 Stop-only면 false-green).

2. **작업 단위 (axis: 동적 분해).** autopilot이 실행 중 동적으로 만드는 task 단위와, 사용자가 헌장 §4-6에서 요구한 "하나의 의도 = 하나의 단위 / 임의 슬라이싱 금지"가 충돌하는가? work-item과 typed node 사이에 "slice/phase" 같은 중간 작업 단위가 있어야 하는가? 그렇다면 그 단위마다 사용자 승인이 필요한가?

두 질문 모두 "잔여를 어떻게 처분하고, 무엇을 하나의 승인 단위로 보는가"의 문제다.

## 결정

### D1 — 종료 완전성 게이트 (ac-1): pass-close는 in-scope agent-owned 잔여를 무단으로 떨어뜨릴 수 없다

`work done` **그리고** `autopilot complete` 두 terminal-flip close 경로에서, in-scope agent-owned 잔여가 조용히 미처분이면 `final_verdict=pass` close를 **BLOCK**한다. 구현은 **재사용(REUSE)**이다 — 새 분류기를 만들지 않는다:

- `passCloseResidualBlockers`(`src/core/gates.ts:323`)가 Stop 훅이 이미 쓰는 두 분류기를 합친다: `resolvabilityBlockers`(`unverified[]` 위) + `riskRecordBlockers`(`remaining_risk_records[]` 위). **단일 라벨공간(R11)** — 두 번째 분류기 없음, 병렬 enum 없음.
- **capture≠drive는 통과 조건이다.** 잡아둔 out-of-scope idea/candidate 후속(루프의 `batch_escalate`/materialized 원장)은 `unverified[]`에도 `remaining_risk_records[]`에도 살지 않으므로 게이트가 건드리지 않는다 — 유효한 처분이고 close를 막지 않는다(ADR-20260627 정합). 게이트는 **조용한 축소(silent shrink)**만 겨냥하지 기록된 모든 메모를 막지 않는다.
- **Presence-keyed grandfather.** 두 잔여 표면이 부재인 레거시 in-flight completion은 그대로 close된다(byte-identical round-trip).
- **교착 그래프 데드락 수정.** `deriveNonPassStatus`(`src/core/autopilot-complete.ts:480`)가 non-terminal 그래프가 runnable 노드 없이 막혔을 때(`loopStuckBlocked`) `state:'blocked'`를 방출한다 — 무인 완료(unattended completion)를 보존해, 게이트가 pass를 막아도 흐름이 정직한 non-pass 종료로 착지한다(멈춰 서서 사용자를 기다리지 않는다).

### D2 — 후속 생성 시점 advisory 우선순위 (ac-2): priority는 표면화 순서만 정하고 아무것도 구동하지 않는다

`followUp.priority`(`src/schemas/work-item.ts:181`, `z.number().int().min(1).max(5).optional()`, **additive**)를 생성 에이전트가 `work follow-up --priority`(`src/cli/commands/work.ts:2525`)에서 스탬프한다. 이 값은 `follow_ups_to_pick_up` 표면화 정렬만 좌우한다(`src/cli/commands/autopilot.ts:675` — undefined는 `Number.POSITIVE_INFINITY`로 **맨 뒤**). **ADVISORY 전용** — 자동 실행을 구동하지 않는다(no-auto-pick 보존). 노드 선택·구동 경로 어디도 이 필드를 읽지 않는다.

### D3 — 동적 task 단위 = 기존 단위 매핑 (ac-2/axis-2): work-item과 node 사이에 새 스키마 tier 없음

동적 task 단위는 **기존 단위**에 매핑한다 — typed node fan-out / follow-up / child WI. work-item과 typed node 사이에 새 스키마 tier를 두지 않는다. ADR-20260706(새 tier 도입 금지)과 정합이다.

### D4 — 하나의 의도 = 하나의 단위 / slice·phase 단위 부재 불변식 (ac-3)

work-item과 typed autopilot node 사이에 "slice/phase" 작업 단위는 **존재하지 않는다**. 회귀 테스트(`tests/core/intent-single-unit-invariant.test.ts`)로 락한다: `nodeKind`는 slice/phase를 제외하고(정확히 sanctioned typed-node 집합), `completionBoundary`는 `['entire_work_item']`뿐이며(mid-run 축소 불가), 커밋된 것보다 적은 AC 전달은 **기존** 보존 게이트(`intentDriftGate` AC id-set 보존 H1/H3, `completionGate` missing-criteria)가 잡는다 — 새 게이트를 추가하지 않고 커버리지를 *증명*한다.

정당한 typed node fan-out(하나의 frozen-AC 그래프 아래 여러 implement/fix/verify 노드)은 **금지된 슬라이스가 아니다.** "임의 슬라이싱 금지(axis-1)"와 "동적 단위 허용(axis-2)"을 공존시키는 판별자(discriminator)는: **같은 frozen root_goal + AC id-set 보존(intentDriftGate), 하나의 승인 단위로 구동, per-slice 사용자 승인 없음**. fan-out은 노드가 더 많되 goal은 하나·AC id는 동일하고, 슬라이스는 scope를 쪼갠다 — 이 차이가 판별자다.

## 근거 (rationale)

- **종료 완전성은 재사용으로 푼다(R11).** 잔여 처분 정책은 이미 Stop 훅에 있다(default-DENY over resolvability 라벨). terminal-flip close가 그 게이트를 우회하는 것이 갭이었으므로, 답은 새 정책이 아니라 *같은 분류기를 close 경로에도 배선*하는 것이다. 두 번째 분류기는 조용히 갈라질(§4-11 drift) 위험만 낳는다.
- **capture≠drive를 통과 조건으로 삼는 것이 ADR-20260627 보존의 핵심이다.** 게이트가 out-of-scope 후속을 막으면 "잡아두되 구동 안 함"이 처벌받아, 에이전트가 후속을 아예 안 잡거나 억지로 구동하게 몰린다 — 둘 다 no-auto-pick을 무너뜨린다. 그래서 게이트는 in-scope agent-owned 잔여(unverified/risk-record)만 겨냥하고 원장은 건드리지 않는다.
- **교착 그래프 blocked 상태가 게이트를 무인 안전하게 만든다.** 게이트가 pass를 막아도 흐름이 사용자를 기다리며 멈추면 autopilot 자율성 불변식이 깨진다. `deriveNonPassStatus`가 막힌 그래프를 정직한 `blocked` non-pass로 착지시켜, "막았다"가 "멈췄다"가 되지 않는다.
- **priority가 advisory-only여야 no-auto-pick이 산다.** 우선순위가 구동을 좌우하는 순간 그것은 자동 픽업이고 ADR-20260627 위반이다. 표면화 순서(사람이 다음 승인 단위를 고르는 힌트)만 정하는 것이 불변식과 양립하는 유일한 위치다.
- **slice/phase 단위 부재를 락으로 증명하는 것이 §4-6 정합이다.** "임의 슬라이싱 금지"는 이미 스키마(nodeKind·completionBoundary)와 게이트(intentDriftGate·completionGate)가 강제한다. 새 방어를 만드는 대신 그 커버리지를 회귀 테스트로 못박아, 미래에 slice/phase 중간 단위가 스키마로 새어들면 red가 되게 한다.

## 기각된 대안 (rejected alternative)

- **Direction B — autopilot이 종료 전에 out-of-scope 후속을 자동 구동.** "잔여를 남기지 말라"를 "종료 전에 다 처리하라"로 해석해, autopilot이 현 run이 만든 out-of-scope 후속 WI를 스스로 이어 구동하게 하는 방향. **기각.** 이는 ADR-20260627 materialize≠drive / no-auto-pick 불변식을 정면으로 완화하고(같은 ADR이 이미 dialectic으로 기각한 레버), per-WI 의도잠금·승인 게이트를 우회한다. 채택된 Direction A는 in-scope agent-owned 잔여만 close 게이트로 막고(무단 축소 차단), out-of-scope 후속은 capture만 하고 다음 승인 단위로 표면화한다(구동은 사용자 승인 뒤).

## 변경 조건 (change_condition)

- **진짜 cross-WI same-session auto-drive가 필요해지면** — 이 종료 게이트를 완화하는 게 아니라, ADR-20260627의 change_condition대로 명시 신호 `ditto work chain drive`(미구현, 필요 시 신설) 뒤에서만 허용한다. 각 후속 WI는 여전히 per-WI 의도잠금(intent.json)을 통과해야 한다.
- **in-scope/out-of-scope 잔여 경계가 실사용에서 너무 좁거나 넓다고 판명되면**(정당한 close가 반복 차단되거나, 반대로 조용한 축소가 여전히 새면) → 어떤 잔여 클래스가 pass-close를 막아야 하는지 재검토. R11 단일 라벨공간은 유지하되 경계 라벨을 재조정.
- ADR-20260627의 no-auto-pick / materialize≠drive가 바뀌면 → D2 priority advisory-only 위치와 D1 capture≠drive 통과 조건을 재확인.
