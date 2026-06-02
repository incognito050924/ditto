# Handoff — DITTO self-dogfooding 증분 스레드

작성: 2026-06-02 · branch `main` · HEAD `1437bd4`
목적: 새 세션이 **이 스레드를 그대로 이어받도록** 최소·충분 컨텍스트 제공. (사용자가 ditto plugin 업데이트 후 새 세션에서 이어감.)

## 스레드 원래 의도 (보존할 것)
ditto를 자기 자신에 dogfooding한다. 매 증분을 **새 work item으로 deep-interview→autopilot**으로 처리한다.
중심 과제 = **부트스트랩 역설 해소**: 구동 엔진은 여전히 3노드 씨앗(design→implement→verify)이고 수동 TDD로만 구현 가능하다. 그 위에서 "그래프를 생성·확장하는 역량"을 한 증분씩 만든다. root_goal/work item은 분할 금지(1 요청 = 1 work item).

## 끝난 것 (전부 main에 커밋, 754 tests pass · lint 0 error)
- **A-1** `wi_260602a0y` — `AutopilotStore.addNodes` + `validateNodeAddition`(중복/dangling/cycle) + `NodeGenerator` 생성 seam(기본=3노드). commits `5c31783 df9c066 7602820 edfe5f6`.
- **A-2(planner)** `wi_260602s66` — `src/core/autopilot-converge.ts` `planForwardReexpansion`(§2.4 forward 재확장, §4.3 2층 탈출: close|expand|escalate) + 스키마 `caps.converge_rounds`(.default 3). **순수 planner.** commits `bf6a150 9b00631`.
- **A-3** `wi_2606022n3` — **planner 콘텐츠 승격**: `recordResult`가 contentful pass 노드의 `payload.generated_nodes`(intent-level `nodeProposal`)를 `proposalsToNodes`로 매핑 후 `addNodes`로 접합. **`addNodes`의 첫 live 호출자.** 승격 직후 `next-node`가 생성 노드를 dispatch → 엔진이 3노드 씨앗을 넘어 실행. `generated_nodes` 부재 시 동작 불변. commits `4b111c6 c4263d0`.
- **A-2(live 배선)** `wi_260602jsb` — **forward 재확장 live 배선**: `recordResult`의 contentful pass 경로에서 `node.kind===review && payload.has_findings===true`이면 `planForwardReexpansion` 호출 — `expand`→`addNodes`로 fix+review 라운드 접합·review pass·`promoted_node_ids` 반환, `escalate`(round≥`converge_rounds`)→노드 `blocked`+`appendDecision`(user_decision_needed/escalate), **닫지 않음(§4.3 never a pass)**. `round`=`forwardRound(id)`(`.rev.r` 마커 수, 그래프 상태에서 결정론적 도출). `has_findings` 부재/비-review 노드는 동작 불변. **`planForwardReexpansion`의 첫 live 호출자.** commits `bf280f8 fc08958`.
- **planner 지능(계약 우선)** `wi_260602cfg` — **그래프 생성 계약**: `buildDelegationPacket`이 `owner===planner` 노드 packet의 `must_do`에 `PLANNER_GENERATE_DIRECTIVE`(generated_nodes 서브그래프·§2.2 라이프사이클 선택·AC 매핑·scale-to-size) 추가 + `expected_outcome`에 subgraph 명시. 비-planner 노드 불변(외과적). `agents/planner.md`를 graph generator 계약으로 개정. **"무슨 노드를" 지능을 LLM planner에 계약 위임, DITTO=결정론적 요청·검증 floor**([[ditto-mental-model]] 정합). 수용·접합은 A-3 재사용. dogfood live 시연: N1이 packet 지시대로 `generated_nodes=[G1 review]` emit→`addNodes` 접합(그래프 3→4)→`next-node`가 생성 노드 G1을 `action=spawn` dispatch. commits `e85cca8 d0155c1`.
- **[VERIFY] owner 제작(3 신규)** `wi_260602evr` — **security·refactor·retro 라이프사이클 owner 배선**: `nodeKind` +`security/refactor/retro`, `nodeOwner` +`security-reviewer/refactorer/retrospective`, `KIND_TO_OWNER` 3 매핑, `OWNER_TOOLS` 3(refactorer만 mutating Edit/Write). **mutating 게이트 중앙화**: `isMutatingOwner(owner)=OWNER_TOOLS[owner].includes('Edit')` 도출 → `isMutatingNode`·`buildDelegationPacket` 공유(refactorer가 approval-gate 대상, gate↔tools 드리프트 차단; `owner==='implementer'` 하드코딩 제거). `agents/security-reviewer.md`(reviewer-output 공유)·`refactorer.md`(Tidy First)·`retrospective.md` 제작 + `surfaces.json` 27. **cleanup은 의도적 미배선**(결정적 드라이버 스텝, 별도 증분). dogfood live: design 노드가 `generated_nodes=[security, retro]` emit→접합(3→5)→`next-node`가 `security` 노드를 신규 owner `security-reviewer`로 dispatch(배선 전엔 schema가 kind reject). commits `6319033 1437bd4`.

## 부트스트랩 역설 현재 상태
**대부분 해소(생성 계약 + 라이프사이클 owner까지 live).** `addNodes`(A-1) → live 호출자: A-3(design 자유 성장)·A-2(review forward 수렴). **planner 지능**으로 design 노드가 서브그래프를 *계약으로* 생성하고, **[VERIFY] owner 배선**으로 planner가 만들 수 있는 kind가 research~knowledge + security/refactor/retro까지 확장됨(cleanup만 미배선, 결정적). dogfood에서 씨앗 3→5 성장 + 신규 owner dispatch live 입증. **아직 없는 것**: 엔진이 owner subagent를 *실제 spawn*해 LLM 생성을 결정론적으로 측정하는 통합 경로(수동 TDD 한계 — 에이전트=owner 대리 시연). 기본 bootstrap은 여전히 3노드 seed(관찰 동작 불변).

## 다음 결정 (열려 있음 — user-owned)
[VERIFY] owner 3개(security/refactor/retro)까지 완료. 다음 증분 후보(추천 순):
1. **작은 고정 2건** (아래 known issues) — dogfooding 루프 충실도(§6.8 AC 자동 클로징 + escalate blocked surfacing). 작고 확실.
2. **cleanup 배선** — 결정적 드라이버 스텝 + 비가역 git 승인 게이트(마지막 [VERIFY] kind, 다른 형태).
3. **planner/owner subagent 실제 spawn 통합 경로** — 엔진이 노드에서 owner를 spawn해 진짜 LLM 생성/분석을 측정(부트스트랩 역설 완전 해소). 큰 작업.

## Known issues (조치 대기, follow-up)
- **§6.8 배선 공백**: autopilot `done` ≠ work-item AC 자동 클로징. 지금은 `ditto verify`/수동 completion으로 마감해야 함.
- **escalate blocked 노드 surfacing 공백**(A-2): forward budget 소진 → 노드 `blocked`이지만 `next-node`가 `waiting`으로 표면화. `user_decision_needed` 명시 surfacing은 §6.8과 함께(decision 로그엔 정확히 기록됨).
- **security 노드 forward 재확장 미적용**([VERIFY] 신규): A-2 forward 재확장 게이트가 `review` kind만 — §2.4는 `security`도 포함하므로 security findings 루프는 후속(현재 security 노드 `has_findings`는 무시).
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
- 코드 seam: `src/schemas/autopilot.ts`(nodeKind/nodeOwner enum — [VERIFY] kind/owner 포함), `src/core/autopilot-graph.ts`(addNodes 무결성·proposalsToNodes·KIND_TO_OWNER·buildInitialNodes), `src/core/autopilot-converge.ts`(forward 재확장 planner + `forwardRound`), `src/core/autopilot-loop.ts`(nextNode/recordResult + A-3 승격 + A-2 forward 재확장 + `isMutatingNode`), `src/core/autopilot-dispatch.ts`(`buildDelegationPacket` + `OWNER_TOOLS` + `isMutatingOwner` + `PLANNER_GENERATE_DIRECTIVE`), `agents/*`(owner 계약: planner=graph generator, security-reviewer/refactorer/retrospective=[VERIFY] owner), `src/core/autopilot-bootstrap.ts`. **surface 변경 시 `bun run surfaces:gen` + `surface-inventory.plugin.test.ts`의 하드코딩 count 갱신.**

## plugin 업데이트 주의
사용자가 ditto plugin을 업데이트한다 → `skills/*`, `agents/*`가 바뀔 수 있다. **새 세션은 의존 전에 현재 `skills/autopilot/SKILL.md`·`agents/*`·계약 문서를 다시 읽어라.** 단, 핵심 코드 seam(`src/`)은 plugin 업데이트와 무관하게 유지된다.

## 새 세션 첫 체크 + 금지
- 첫 체크: `git log --oneline -6` → `bun test`(754 green 기대) → 계약 §2.2/§2.4/§4.3 재독 → 다음 증분 결정.
- 금지: root 요청 분할/스코프 확장, 증거 없는 완료 선언, 미검증을 성공처럼 표기.
- 미커밋 잔재: `bun.lockb`(이 스레드와 무관한 사전 변경, 손대지 않음).
