# ditto AX/자율성 개선 — 계획 관리 SoT (living)

> **목적**: ditto의 UX/AX 구조 결함(에이전트가 사람에게 절차·잔여·후속을 전가하고, WI가 안 닫혀 쌓이고, 실제 개발 절차(TDD)·다중 WI·격리가 자율적으로 안 굴러가는 문제)을 한 곳에서 진단·계획·**진척 추적**한다.
> **소비자**: 이 개선을 이어서 착수하는 세션/PC. 이 문서가 계획의 단일 출처(SoT)다.
> **갱신 주기**: 테마/항목이 착수·landed될 때마다 §0 대시보드 + 해당 테마의 체크리스트를 갱신한다.
> **삭제 조건**: 3개 테마가 전부 코드+ADR로 흡수되면 폐기(그때 SoT는 코드·ADR). 부분 폐기는 테마 단위로.
> **권위 주의(§4-11)**: 아래 `file:line`은 **2026-06-26 실측**(HEAD `b908061`). 이 문서는 *계획*이지 코드 SoT가 아니다 — 구현 세션은 착수 시 코드로 재확인할 것. 사실은 코드·테스트·ADR이 권위.

---

## 0. 진척 대시보드 (한눈에)

상태 범례: ⬜ TODO · 🟦 진행중 · ✅ landed·검증 · ⏸ 보류(결정 대기) · ➖ 범위 밖

| 테마 | 다루는 문제 | 상태 | WI | 비고 |
|---|---|---|---|---|
| **T1. autopilot 무-전가** | P3, P4 | ✅ landed | wi_2606266az | 6 AC final_verdict=pass(runtime-artifact 검증) · main 728c009 |
| **T2. 개발 절차 1급화** (TDD 표면·경량 기본값·자동 close·backlog 위생) | P1, P2, P7 | ✅ landed | wi_2606264rm | 4 AC final_verdict=pass · main c6e15a4 · autopilot complete가 자기 WI를 done flip(ac-3 자기참조 실증) |
| **T3. 다중 WI·worktree 자율 구동** | P5, P6 | ⏸ 보류 | _(미생성)_ | ADR-0011 D2 충돌 — 비가역 결정 선행 |

**이미 landed(부분 해결, b8d8163 이후)**: worktree 동시개발 1급 지원(T3 레인) · work-lifecycle 경량 경로 7 AC(T2 일부) · 이 세션 25→2 open WI 정리(T1/T2 사후 실증). 상세 §3.

---

## 1. 뿌리 진단 (두 조사가 수렴)

> **상태는 풍부하고 명시적인데, 단일 work item 위의 자율 제어 루프가 없다.** 닫기(P1)·경량 라우팅(P2)·잔여 처리(P3)·다중 WI(P5)·worktree 구동(P6)이 **전부 "다음 명령을 사람이 친다"에서 끝난다.** 사용자가 겪는 "허송세월"과 "전가"가 같은 뿌리.

추가 모순(P7): **헌장은 에이전트에게 test-first TDD를 강제**(글로벌 CLAUDE.md:50)하는데, **ditto의 표준 절차(autopilot)는 TDD를 모델링하지 않고**(implement-then-verify), TDD 표면은 아예 없다. 그래서 에이전트가 헌장대로 TDD를 하면 그게 "표준 절차 밖"이 되어 ditto가 추적·종결을 못 한다.

---

## 2. 문제 인벤토리 (7) — 근거 + 상태

| # | 문제 | b8d8163 이후 | 정확한 공백 (file:line, 2026-06-26 실측) |
|---|---|---|---|
| **P1** | WI 종결 안 됨 → 쌓여서 SLOP. 나중에 완료/폐기·연관수정 판별 불가 | 경량 close·stem·follow-up landed | **자동 닫기 0**: autopilot은 `completion.json`만 쓰고 WI status 절대 안 바꿈(`src/cli/commands/autopilot.ts:330-444`; `autopilot-loop`에 `store.close` 0). **stale/backlog 위생 표면 0**(`work archive`는 terminal만; `doctor`는 intent-quality만). **연관 추적**: `follows`/`stem`은 양방향이라 "뒤이은 WI"는 답하나(`work-item-store.ts:330-339`), `changed_files` 교차참조 없어 *"나중에 같은 코드 만진 WI"는 불가*. memory-graph는 WI를 모델링 안 함 |
| **P2** | autopilot 외 간단·가역 작업용 정규 경로 부재 → 무겁게 처리 | 경량 경로 fully built | **opt-in·미광고**: 매 턴 charter 투영은 *무거운* deep-interview만(`src/core/charter.ts:45-46,101-124`), `work start` Next-steps도 deep-interview+autopilot만(`work.ts:306-312`), 어떤 skill도 `--criteria`/`verify`/`work done` 언급 0. 라우팅은 risk→heavy 한 방향뿐(`work.ts:799-830`), simple→light 없음 |
| **P3** | autopilot가 '미검증·남은위험·후속'을 사용자에게 전가 | **거의 0** | **미검증 누출**: non-pass 완료가 미검증 AC 안고 Stop 통과→exit 0. residual 게이트가 `completion.unverified[]`만 보고 `acceptance[].verdict`는 안 봄(`stop.ts:420-430`), verify 노드는 미검증 *기록만*·재구동 면제(`autopilot-loop.ts:1237-1238`). **위험**: review/security `has_findings`만 fix 자동(`autopilot-converge.ts:95-133`), `remaining_risks`·residual은 record+표면화만. **후속**: `work follow-up` 수동 CLI뿐(`work.ts:1067-1089`), 루프 배선 0, `intent.follow_up_candidates` 소비자 0 |
| **P4** | 의도 축소 — 계획/검증에서 슬라이스로 일부만 구현·종결 | seed floor + Stop H2 백스톱 | **plan-time 완전성 게이트 0**. 커버리지는 seed가 모든 AC를 노드에 매핑(`autopilot-bootstrap.ts:114`) + Stop H2(`intentDriftGate`, `gates.ts:712-721`)가 "모든 AC가 ≥1 노드에 *id 매핑*" 확인 — **증거로 검증됐는지는 안 봄**. `validateNodeAddition`은 no-grow만(`autopilot-graph.ts:331-341`). P3 미검증-누출과 합쳐져 슬라이스로 "완료" 가능 |
| **P5** | 다중 WI 순차/병렬 필요한데 사람이 매번 "다음" 입력 | 0 | autopilot=**단일 WI**(`completion_boundary:'entire_work_item'`, `autopilot-bootstrap.ts:106-129`), 드라이버는 *한 그래프 노드만* 구동(`autopilot-driver.ts:102-115`). 세션=single-active·no-auto-pick(`user-prompt-submit.ts:117-193`). **WI 위 큐/러너 부재** |
| **P6** | 격리·병렬 진행 미고려(A 작업 중 다른 세션서 B 설계/개발) | worktree 1급 landed | 레인은 생김(격리+공유 `.ditto/local`+auto-bind: `worktree.ts:308-361`, `fs.ts:52-61`, `session-start.ts:20-36`) → "A 격리 중 B 설계"는 구조적 지원. but **차를 모는 게 없음**: auto-launch·auto-merge·cross-worktree 러너 0(`skills/worktree/SKILL.md:32,60,65-66`). 라이브 동시 autopilot·Windows·SessionStart-cwd 계약은 저자 미검증(SKILL.md:80-84) |
| **P7** | 표준절차 아닌 즉흥 TDD로 임시구현 → WI 종결 불가 (구조적 모순) | **미해결** | **TDD 표면 0**(grep `tdd\|red-green\|failing test first` = skills/·cli/·agents/·core/ 0 파일). `implementer`는 **implement-then-check**(코드 먼저, 검사 나중; `agents/implementer.md:20`). 헌장은 **TDD 강제**(글로벌 CLAUDE.md:50). ditto 모델(delegate-and-verify) ⊥ 실제 실천(test-first) → TDD가 곧 "절차 밖" |

---

## 3. b8d8163 이후 landed (델타 — "어디까지" 답)

`b8d81639..HEAD` = 16커밋. 비-doc 실작업 두 줄기:

- **worktree 동시개발**(6aa95e0·36eee19·8cbcc14·20bd801·347e9e5): git worktree 1급, 격리+공유 `.ditto/local`, `ditto worktree create|list|remove` + `work start --worktree`. → **P6 레인** ✅ / **P6 드라이브** ⬜.
- **work-lifecycle 경량 경로**(cf4a73a~e88e9d9 + 머지 a7440e1, 이번 세션·wi_260626wnv): `work set-criteria`/`--criteria`, 경량 `verify→done`, partial/blocked 상태, light/heavy logged-override 게이트+risk 트리거, `work follow-up`(버그→discovered_by WI), `work promote`, `follows`+`work stem`, pull-only `work push-ready`. ADR-20260626-work-lifecycle-lightweight-path. → **P1/P2 부분** ✅(닫는 메커니즘은 있으나 기본값·자동화 아님).
- **이 세션 정리**: 25 open WI → 2(landed 증거로 23 done, lj6/t8o keep). 자기비판: residual 있던 WI(pcw 이중래핑·pyj 라이브검증)를 done으로 닫으며 후속 WI로 물질화 안 함 = **P3 재현**.
- **배포**: release v0.3.0(b908061) → v0.3.1 → v0.4.0(5104c7e, T1 무-전가) → v0.5.0(T2 개발 절차 1급화).

---

## 4. 빌드 테마 (3) — 범위·변경지점·체크리스트

> 각 테마는 착수 시 **deep-interview/tech-spec로 의도를 잠그고** 시작. 코드 변경은 사용자 허가 후. 아래 "변경 지점"은 조사 기반 *후보*이지 확정 설계 아님.

### T1. autopilot 무-전가 (P3 + P4) — ✅ landed (wi_2606266az · main 728c009)

목표(달성): autopilot가 미검증/위험/후속을 사용자에게 전가하지 않고, 오케스트레이션 흐름이 작업 완결 또는 사용자 명시 종료 외에는 끊기지 않는다. verify가 단일 work item의 실질 종료 게이트.

구현 (6 AC, runtime-artifact 검증 — 라이브 `hook stop` exit code · `complete` ledger · `--batch` 실 WI):

- [x] **ac-1 미검증 누출 차단**: Stop 게이트가 `acceptance[].verdict` 열거 — 비-pass 완료의 미검증 in-scope AC를 사유·근거 없이 park하면 차단(exit≠0), 정직한 partial/blocked는 종료 허용(D2 보존). `gates.ts nonPassTerminationGate` + `stop.ts riskRecordForcesContinuation`.
- [x] **ac-2 자동 재검증**: 증거 gatherable한 미검증 AC 종료 전 자동 reverify; tool-absence는 `blocked_external`(ADR-0018, 무한루프 회피).
- [x] **ac-3 위험 자동 라우터**: `planForwardReexpansion` **1개 확장**(3 fork 아님)으로 agent-resolvable 위험 자동 fix; **4사유**(결정/ADR충돌·복수해결방안·범위밖·정말위험)만 in-flow 표면화; 자동처리 원장(auto_fix/surface/batch_escalate + reason-category).
- [x] **ac-4 후속**: in-scope=현재 그래프 노드 자동 / out-of-scope=1회 batch materialize(draft·미구동·idempotent, materialize≠drive, ADR-0011 D2 same-rooted).
- [x] **ac-5 무중단 자기완결**: in-scope 잔여 0까지 구동 + `no_progress_rounds` in-flow escalate(capped≠converged, silent pass 아님); 모든 splice `loop_rounds`-capped.
- [x] **ac-6 positive 완료 계약**: 종료 시 AC별 증언(검증됨|정직한 partial|사용자 결정) + 자동처리 원장 출력. status flip 없음.
- 자율 경계(확정): 위험·후속 **기본 자동 처리**, 4사유만 in-flow 표면화. **무중단 north star** — 흐름은 완결 또는 사용자 명시 종료 외 안 끊긴다(deep-interview 잠금).
- 잔여: P1 autopilot 자동 status close(현재 `complete`는 final_verdict만, status flip은 **T2** 범위). intent-drift file-level(change_surface 예측 < 실제 — `autopilot-store`/테스트/json 추가, AC scope 6개 보존).

### T2. 개발 절차 1급화 (P1 + P2 + P7) — ✅ landed (wi_2606264rm · main c6e15a4)

목표(달성): 실제 개발 절차(TDD)를 ditto 1급 표면으로, 경량 경로를 노출로, 종결을 자동으로.

- [x] **red-first 교정**(D3 결정 = 새 `ditto tdd` 표면 아님, `implementer` 노드 교정): 코드-동작 AC(design-assigned `dynamic_test` oracle)인 implementer 노드는 dispatch packet에 red-first 지시를 받는다 — 실패 테스트 먼저, AC 단언 실패(헛-red 아님) 확인 후 최소 green. 비-코드(`soft_judgment`)·경량(no-oracle)·refactorer 면제. `autopilot-dispatch.ts isRedFirstImplement` + committed 테스트. _후속(R7) ✅: 별도 WI(wi_260627f2d, env-flag trim fix)를 autopilot으로 구동해 implementer red-first behavioral 라이브 실증 완료 — dispatch packet에 red-first 실림 + 두 코드-동작 AC 모두 RED(AC 단언 실패=헛-red 아님)→GREEN 관찰. main c81f23d._
- [x] **경량 경로 노출**: charter 투영·`work start` Next-steps·deep-interview skill 3표면 모두 `set-criteria→verify→done` 노출. _후속(②) ✅: simple/reversible→light **능동 라우팅**을 (A) 에이전트 가이드 샤프니징으로 landed — PRIME_DIRECTIVE에 weight-routing 가이드(advisory·에이전트 판단, 자동 분류기/라우터 아님). 자동 분류·자동 라우팅은 D4 ADR 경계로 명시 배제. wi_260627v93, main 2f08c73._
- [x] **autopilot 완료 시 자동 close**: `complete` final_verdict=pass면 WI status를 done으로 flip(수동 `work done`과 동일 게이트). 비-pass 불변(양방향)·abandoned 미덮어쓰기(R1)·reopen 경로(R2). 본 WI 자신이 이 기능으로 done flip됨(ac-3 자기참조 실증).
- [x] **backlog 위생 표면**: `doctor`가 stale draft(structural)·"완료-미종결"(completion pass인데 status≠done, terminal 제외)·open-count를 read-only 출력. parked-with-reason 미오판. _후속 ✅: 각 항목에 advisory 제안 명령(stale→resume/abandon, unclosed→done) suggested_action 추가 — read-only 유지, silent auto-action은 D4 경계로 배제(stale draft=실제 미래작업, 자동 abandon=백로그 파괴). wi_260627pfa, main f12d6f4._
- 검증: 4 AC final_verdict=pass(autopilot orch_2606268v8 무중단 구동) · `autopilot-complete-flip-cli`/`doctor-backlog-cli`/`autopilot-dispatch` 테스트 · full suite 3191 pass(4 fail은 pre-existing Codex host capability, T2 무관).

### T3. 다중 WI·worktree 자율 구동 (P5 + P6) — ⏸ 보류(결정 선행)

목표: 여러 WI(및 worktree)를 사람 개입 없이 순차/병렬로 완료까지 구동.

- [ ] WI 큐/러너(autopilot 위 오케스트레이터): enqueue 다수 WI → 순차/병렬 구동, WI별 사람 프롬프트 없이.
- [ ] worktree 자율 구동: worktree 세션 auto-launch·드라이브·auto-merge 조정.
- **제약·결정 D2(비가역)**: ADR-0011 D2(session-rooting — "faithful subagent-delegating autopilot은 target repo에 rooted된 세션 필요, cross-root remote 오케스트레이션 unsupported")와 single-active·no-auto-pick 불변식과 **정면 충돌**. ADR 수정/우회 결정이 선행돼야 착수 가능.

---

## 5. 결정 로그

미해결(사용자만 풀 수 있음):

- **D1 — 테마 순서**: 추천 T1 → T2(둘은 "verify가 진짜 게이트"로 맞닿아 묶음 설계 가능) → T3. _(미정)_
- **D2 — T3 ADR-0011 충돌(비가역)**: session-rooting 불변식을 풀지(ADR 수정) / 유지하며 우회할지. _(미정)_
- **D3 — TDD 표면 형태**: ✅ 확정 — 기존 `implementer` 노드 red-first 교정(새 `ditto tdd` 표면 아님). T2 landed(wi_2606264rm).
- **D4 — 후속 "즉시 착수" 의미**: ✅ 확정 — no-auto-pick **완화 안 함**. (a) done-flip이 후속 착수명령 surface(wi_2606278qa) + (c) in-scope는 current-graph 노드로 구동. 진짜 cross-WI auto-drive는 명시 신호 뒤로(T3). dialectic verdict=revise(Opponent=Codex), ADR-20260627-autopilot-followup-autonomy-boundary 참조.

확정:

- (이번 세션) work-lifecycle 경량 경로 10결정·7 AC landed — ADR-20260626-work-lifecycle-lightweight-path 참조.
- **D3·D4 (2026-06-27)**: D3=implementer red-first 교정(T2), D4=per-WI 승인이 의도된 자율성 경계·no-auto-pick 미완화(dialectic revise, ADR-20260627-autopilot-followup-autonomy-boundary). T3는 D1·D2 여전히 미정.

---

## 6. 제약 (착수 전 반드시 확인)

- **ADR-0011 D2 — session-rooting 불변식**: faithful subagent-delegating autopilot은 target repo에 rooted된 세션을 요구; cross-root remote 오케스트레이션은 unsupported(`.ditto/knowledge/adr/ADR-0011-distribution-cross-cutting-axis-session-rooting.md:34-39`). T3의 상위 오케스트레이터가 여기에 걸린다.
- **single-active-pointer / no-auto-pick**: 세션당 활성 WI 1개, 자동 선택 금지(`src/hooks/user-prompt-submit.ts:117-193`). 다중 WI 자동 진행과 충돌.
- **컨텍스트 위생(§4-9)**: 각 테마 구현은 fresh 세션 + 핸드오프 권장(이 분석 세션은 매우 길어 context rot 위험). 결정(D1~D4)은 이 문서로 운반.

---

## 7. 이 SoT 사용·갱신 규칙

1. 테마 착수 = `ditto work start`로 WI 생성 → 이 문서 §0 대시보드의 해당 WI 칸 채우고 상태 🟦.
2. 테마 내 항목 landed = 체크박스 `[x]` + 커밋 sha 주석.
3. 테마 완료 = §0 ✅ + 흡수된 결정은 ADR로, file:line 근거는 코드로 옮기고 해당 절을 폐기 표시.
4. 결정 확정 = §5 미해결→확정 이동(근거 한 줄).
5. 전 테마 완료 = 이 문서 폐기(삭제 조건 충족).
