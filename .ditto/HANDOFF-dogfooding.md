# Handoff — DITTO self-dogfooding 증분 스레드

작성: 2026-06-02 · branch `main` · HEAD `d0155c1`
목적: 새 세션이 **이 스레드를 그대로 이어받도록** 최소·충분 컨텍스트 제공. (사용자가 ditto plugin 업데이트 후 새 세션에서 이어감.)

## 스레드 원래 의도 (보존할 것)
ditto를 자기 자신에 dogfooding한다. 매 증분을 **새 work item으로 deep-interview→autopilot**으로 처리한다.
중심 과제 = **부트스트랩 역설 해소**: 구동 엔진은 여전히 3노드 씨앗(design→implement→verify)이고 수동 TDD로만 구현 가능하다. 그 위에서 "그래프를 생성·확장하는 역량"을 한 증분씩 만든다. root_goal/work item은 분할 금지(1 요청 = 1 work item).

## 끝난 것 (전부 main에 커밋, 750 tests pass · lint 0 error)
- **A-1** `wi_260602a0y` — `AutopilotStore.addNodes` + `validateNodeAddition`(중복/dangling/cycle) + `NodeGenerator` 생성 seam(기본=3노드). commits `5c31783 df9c066 7602820 edfe5f6`.
- **A-2(planner)** `wi_260602s66` — `src/core/autopilot-converge.ts` `planForwardReexpansion`(§2.4 forward 재확장, §4.3 2층 탈출: close|expand|escalate) + 스키마 `caps.converge_rounds`(.default 3). **순수 planner.** commits `bf6a150 9b00631`.
- **A-3** `wi_2606022n3` — **planner 콘텐츠 승격**: `recordResult`가 contentful pass 노드의 `payload.generated_nodes`(intent-level `nodeProposal`)를 `proposalsToNodes`로 매핑 후 `addNodes`로 접합. **`addNodes`의 첫 live 호출자.** 승격 직후 `next-node`가 생성 노드를 dispatch → 엔진이 3노드 씨앗을 넘어 실행. `generated_nodes` 부재 시 동작 불변. commits `4b111c6 c4263d0`.
- **A-2(live 배선)** `wi_260602jsb` — **forward 재확장 live 배선**: `recordResult`의 contentful pass 경로에서 `node.kind===review && payload.has_findings===true`이면 `planForwardReexpansion` 호출 — `expand`→`addNodes`로 fix+review 라운드 접합·review pass·`promoted_node_ids` 반환, `escalate`(round≥`converge_rounds`)→노드 `blocked`+`appendDecision`(user_decision_needed/escalate), **닫지 않음(§4.3 never a pass)**. `round`=`forwardRound(id)`(`.rev.r` 마커 수, 그래프 상태에서 결정론적 도출). `has_findings` 부재/비-review 노드는 동작 불변. **`planForwardReexpansion`의 첫 live 호출자.** commits `bf280f8 fc08958`.
- **planner 지능(계약 우선)** `wi_260602cfg` — **그래프 생성 계약**: `buildDelegationPacket`이 `owner===planner` 노드 packet의 `must_do`에 `PLANNER_GENERATE_DIRECTIVE`(generated_nodes 서브그래프·§2.2 라이프사이클 선택·AC 매핑·scale-to-size) 추가 + `expected_outcome`에 subgraph 명시. 비-planner 노드 불변(외과적). `agents/planner.md`를 graph generator 계약으로 개정. **"무슨 노드를" 지능을 LLM planner에 계약 위임, DITTO=결정론적 요청·검증 floor**([[ditto-mental-model]] 정합). 수용·접합은 A-3 재사용. dogfood live 시연: N1이 packet 지시대로 `generated_nodes=[G1 review]` emit→`addNodes` 접합(그래프 3→4)→`next-node`가 생성 노드 G1을 `action=spawn` dispatch. commits `e85cca8 d0155c1`.

## 부트스트랩 역설 현재 상태
**대부분 해소(생성 계약까지 live).** `addNodes`(A-1) → 두 live 호출자: A-3(design `generated_nodes` 자유 성장)·A-2(review findings forward 수렴, budget 지배). **planner 지능**으로 design 노드 packet이 이제 서브그래프 생성을 *계약으로 요청*하고 planner.md가 그 역할을 규정 → "무슨 노드를"의 책임이 LLM planner에 계약 위임됨(dogfood에서 씨앗 3→4 성장 live 입증). **아직 없는 것**: 엔진이 planner subagent를 *실제 spawn*해 LLM 생성을 결정론적으로 측정하는 통합 경로(수동 TDD 한계 — 현재는 에이전트=planner 대리 시연). 기본 bootstrap은 여전히 3노드 seed(관찰 동작 불변); 생성은 design 노드 실행 시점에 일어남.

## 다음 결정 (열려 있음 — user-owned)
planner 지능(계약 우선)까지 완료. 다음 증분 후보(추천 순):
1. **[VERIFY] owner 제작**(security/refactor/retro/cleanup) — 이제 planner가 해당 kind 노드를 *생성*할 수 있으므로 owner 배선이 자연스러운 다음 단계(§2.2 표 확장 + agents/* 제작).
2. **작은 고정 2건** (아래 known issues) — dogfooding 루프 충실도(§6.8 AC 자동 클로징 + escalate blocked surfacing).
3. **planner subagent 실제 spawn 통합 경로** — 엔진이 design 노드에서 planner를 spawn해 진짜 LLM 서브그래프 생성을 측정(부트스트랩 역설 완전 해소). 큰 작업.

## Known issues (조치 대기, follow-up)
- **§6.8 배선 공백**: autopilot `done` ≠ work-item AC 자동 클로징. 지금은 `ditto verify`/수동 completion으로 마감해야 함.
- **escalate blocked 노드 surfacing 공백**(A-2 신규): forward budget 소진 → 노드 `blocked`이지만 `next-node`가 `waiting`("dependencies unmet or running")으로 표면화. `user_decision_needed`로 명시 surfacing은 §6.8 배선과 함께 처리 권장(decision 로그엔 정확히 기록됨).
- **`ditto work handoff` changed_files 과대산출**: 오래된 base ref로 무관 파일 수십 개를 나열(예: `.ditto/work-items/wi_260602a0y/handoff.md` 참고). 우회 = `--base <tight-ref>` 전달. 이 핸드오프 문서는 그래서 자동생성 대신 손으로 씀.

## 증분 처리 절차 (확립된 패턴 — 그대로 재사용)
1. `bun run src/cli/index.ts work start "<goal>" --request "<verbatim>" --title "<t>" --output json` → `wi_*`.
2. **deep-interview**: `interview-driver`의 `startInterview` → `recordTurn`×N(critical dimension을 `state:'resolved'`, 에이전트 판단은 `kind:'assumption'` 정직 표기, `readiness_score` 0.85+) → `finalizeInterview`(intent.json 작성 + AC mirror + autopilot bootstrap 한 방). 일회용 `bun` 스크립트로 구동(`~/core/fs` 정확한 export는 `findRepoRoot`).
   - **함정**: AC statement는 `acceptanceTestable` 게이트를 통과해야 함 — 관찰 술어(영문 `returns/rejects/shows/exits/equals/contains/...` 또는 숫자) 1개 이상 포함, VAGUE 단어(`robust/efficient/properly/...`) 금지. 통과 못 하면 `bootstrapAutopilot`이 `intent_not_ready`로 throw.
3. **autopilot loop (dogfood)**: `autopilot next-node --workItem <wi> --output json` → owner 결정 → `autopilot record-result --workItem <wi> --json '{node_id,result_text,outcome,evidence_refs?,generated_nodes?}'` → 반복 → `done`. (mutating=implementer 노드만 approval gate; not_required면 통과. `result_text`는 G7 content 가드 — 빈/ack-only는 fixable로 강등.)
4. **completion**: `buildCompletion`(`CompletionStore`, `declaredBy:'verifier'`)로 per-AC pass+evidence, `final_verdict` 자동 도출. changed_files는 **이 증분 실제 파일만** 수동 지정(과대산출 회피).
5. **commit**: main에 2개 — `feat(...) (동작적)` 코드 / `chore(work-items): <wi> ... 산출물 (런타임 상태)`.

## 권위 컨텍스트 (먼저 읽을 것)
- `reports/design/contracts/autopilot-contract.md` — §2.2~2.4(그래프 생성·확장·forward 재확장), §4.3(수렴 2층 탈출), §3.2(CLI step 경계). **스키마가 최우선 권위**(`src/schemas/autopilot.ts`).
- 코드 seam: `src/core/autopilot-graph.ts`(addNodes 무결성·proposalsToNodes·buildInitialNodes), `src/core/autopilot-converge.ts`(forward 재확장 planner + `forwardRound` 도출), `src/core/autopilot-loop.ts`(nextNode/recordResult + A-3 generated_nodes 승격 + A-2 forward 재확장 배선), `src/core/autopilot-dispatch.ts`(`buildDelegationPacket` + planner 생성 계약 `PLANNER_GENERATE_DIRECTIVE`), `agents/planner.md`(graph generator 계약), `src/core/autopilot-bootstrap.ts`.

## plugin 업데이트 주의
사용자가 ditto plugin을 업데이트한다 → `skills/*`, `agents/*`가 바뀔 수 있다. **새 세션은 의존 전에 현재 `skills/autopilot/SKILL.md`·`agents/*`·계약 문서를 다시 읽어라.** 단, 핵심 코드 seam(`src/`)은 plugin 업데이트와 무관하게 유지된다.

## 새 세션 첫 체크 + 금지
- 첫 체크: `git log --oneline -6` → `bun test`(750 green 기대) → 계약 §2.2/§2.4/§4.3 재독 → 다음 증분 결정.
- 금지: root 요청 분할/스코프 확장, 증거 없는 완료 선언, 미검증을 성공처럼 표기.
- 미커밋 잔재: `bun.lockb`(이 스레드와 무관한 사전 변경, 손대지 않음).
