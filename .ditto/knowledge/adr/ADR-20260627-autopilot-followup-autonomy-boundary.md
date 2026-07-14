# ADR-20260627-autopilot-followup-autonomy-boundary: autopilot 후속 자율성 경계 — materialize≠drive, no-auto-pick 불변식 무완화

- 상태: accepted
- 결정 일자: 2026-06-27
- 결정자: hskim, claude (claude-opus-4-8)

> **클래스-한정 부분 supersede (2026-07-14, wi_2607148yg)** — **ADR-20260714-autopilot-defect-class-drive-carveout**가 이 ADR의 change_condition("진짜 same-session auto-drive는 명시 신호 뒤에서만 허용")을 **재현되는 실동작 버그 한 클래스에 한해** 발동한다: autopilot은 보수적 분류기(ac-2)가 "재현되는 실동작 버그"로 판정한 것을 자기 work item으로 물질화한 뒤 같은 run에서 done까지 체인 구동한다(각자 자기 커밋). **비-결함(아이디어·기능·기술부채·잠복버그) 후속의 `materialize≠drive` / `no-auto-pick` / `single-active-pointer`는 전부 불변** — 예외는 결함 클래스로 봉인되고, 자유-텍스트 라벨이 아니라 분류기 판정에 키드된다(relabel 저항). 두 fail-stop 조건도 예외 중 불변.
- 관련: ADR-0011 (Distribution 횡단 배포계약 축 + session-rooting invariant — 이 결정이 그 D2 "cross-root unsupported"를 same-root 후속에까지 일관 확장; supersede 아님), ADR-0010 (기능 4축 — 축2 autopilot 무거운 경로의 의도잠금이 통제 경계), ADR-20260626-work-lifecycle-lightweight-path (`work follow-up` 물질화·`work stem` 줄기 — 이 결정은 그 물질화가 *구동*으로 번지지 않음을 못박는다). **supersede 없음.** 발의: wi_2606264rm 후속 논의. dialectic 결정(Producer=Claude / Opponent=Codex cross-model / Synthesizer, verdict=revise → 초안 기각). 구현 WI: wi_2606278qa (autopilot complete의 follow_ups_to_pick_up 표면화). 코드(권위): `src/cli/commands/work.ts:1035-1037`·`:1099-1106`, `src/cli/commands/autopilot.ts:119-126`, `src/core/interview-driver.ts` finalize, `src/hooks/user-prompt-submit.ts:106-115`, `src/core/autopilot-loop.ts` (in-scope follow_up forward round), `tests/cli/work-follow-up-batch.test.ts`.

## 컨텍스트

로드맵 §5 미결 D4: "현 run이 만든 후속을 즉시 착수할 것인가 — 현 run에서 자동 start vs 큐 등록만." 이를 풀기 위한 초안은 "same-repo(같은 저장소) 후속을 같은 세션에서 자동 연계 구동하도록 `no-auto-pick`을 완화한다"였다. 이 초안을 3역 dialectic(Producer=Claude, Opponent=Codex cross-model, Synthesizer)으로 코드에 대고 압박 시험했고 verdict=**revise** — 초안은 기각됐다.

핵심 질문: autopilot이 한 work item을 done flip한 뒤, 그 run이 만든 out-of-scope 후속 WI를 자동으로 이어서 구동해야 하는가? 초안의 전제는 "same-root 후속까지 자동 구동을 막는 것은 cross-root 규칙(ADR-0011 D2)의 과잉 확장"이었다. dialectic이 이 전제를 코드로 반증했다.

## 결정

**per-WI 승인 + deep-interview 의도잠금이 autopilot의 의도된 자율성 통제 경계다.** autopilot은 한 work item을 done flip한 뒤, 그 run이 만든 out-of-scope 후속을 **물질화(materialize)만 하고 자동 구동(drive)하지 않는다 — materialize≠drive.** same-repo 후속도 동일하다(cross-root 부작용이 아니라 *의도적 설계*다). **`no-auto-pick` / `single-active-pointer` 불변식은 완화하지 않는다.**

대신 채택된 경로(불변식 무수정):

- (a) autopilot complete가 done flip 시 이 run이 남긴 미해결 materialized 후속 WI 목록 + 착수 명령을 표면화한다(`follow_ups_to_pick_up`). T1 ac-4의 잔여 *전가 마찰*만 제거하고, 구동 자체는 다음 승인 단위로 넘긴다. (구현: wi_2606278qa)
- (c) in-scope(현 WI 범위 내) 연속 작업은 이미 current-graph 노드로 구동된다(`src/core/autopilot-loop.ts`의 in-scope follow_up forward round) — 무변경.

## 근거 (rationale)

dialectic이 코드로 검증한 근거(외부 문서 경로 대신 본문에 직접 담는다, §4-11):

- **materialize≠drive의 same-root 제외는 의도적 설계다.** `src/cli/commands/work.ts:1035-1037` 주석: "materialize != drive (R9): each created WI ... never auto-started ... Same-rooted sequential creation, no cross-root runner." `tests/cli/work-follow-up-batch.test.ts`가 자식 WI 전부 `status='draft'`임을 단언한다. → "same-root 제외 = cross-root 규칙의 과잉 확장"이라는 초안 전제는 거짓. same-root 제외는 설계의 일부지 사고가 아니다.
- **run-materialized 후속에는 구동 대상이 사실상 공집합이다.** 후속은 placeholder AC로 생성되어(`work.ts:1099-1106`) `intent.json`이 없다. autopilot bootstrap은 WI별 `intent.json`을 요구하고(`src/cli/commands/autopilot.ts:119-126`, 없으면 RUNTIME_ERROR_EXIT), deep-interview finalize는 사용자 확인을 필수로 한다(`src/core/interview-driver.ts` finalize). → 자동 구동하려면 검토 없이 intent를 자동 생성하거나 게이트를 우회해야 하고, 둘 다 heavy-path 의도잠금과 정면 충돌. 자동 구동할 수 있는 대상은 실질적으로 없다.
- **`no-auto-pick`의 carve-out은 사용자 행동에만 열린다.** `explicitWorkItemRef` carve-out(`src/hooks/user-prompt-submit.ts:106-115`)은 "사용자가 프롬프트에 직접 입력한 id = 사용자 행동"일 때만 적용된다. agent-materialized 후속은 이와 동형이 아니므로 carve-out을 빌려 자동 구동을 정당화할 수 없다.
- **헌장 §3과 정합.** 코드 변경 착수는 lazy가 기본값이고, 승인 단위(work item)가 끝나면(done flip) 다음은 다시 계획부터다. per-WI 승인이 곧 통제 경계이며, 자동 체인 구동은 이 게이트를 우회한다.

따라서 D4의 올바른 답은 "큐 등록(물질화) + 표면화"지 "자동 start"가 아니다. 초안의 `no-auto-pick` 완화는 **틀린 레버**였다 — 위 근거로 목표(잔여 전가 마찰 제거)를 달성하지 못하면서 의도잠금 게이트만 약화시킨다.

기각된 대안:

- **`no-auto-pick` / `single-active-pointer` 완화** — 틀린 레버. 자동 구동 대상이 공집합(intent.json 부재)이라 목표를 달성하지 못하고, 통제 경계만 무너뜨린다.
- **same-repo 후속 무조건 자동 구동** — per-WI 의도잠금·승인 게이트와 충돌. placeholder AC를 검토 없이 진짜 intent로 승격하거나 finalize 사용자 확인을 우회해야 한다.

## 변경 조건 (change_condition)

진짜 cross-WI same-session auto-drive가 필요해지면, **명시 신호 뒤에서만** 허용한다:

- 원본 intent에 체인 승인을 명시 기록하거나,
- 사용자 행동인 `ditto work chain drive` 명령(미구현 — 필요 시 신설).

그 경우에도 각 후속 WI는 여전히 per-WI 의도잠금(`intent.json`)을 통과해야 한다. 이는 T3(다중 WI·worktree 자율 구동) 트랙과 연결되며, ADR-0011 D2(cross-root unsupported)는 그대로 유지된다.
