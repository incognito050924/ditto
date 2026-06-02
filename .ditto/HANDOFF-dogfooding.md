# Handoff — DITTO self-dogfooding 증분 스레드 (cross-PC)

작성: 2026-06-02 · branch `main` · HEAD `2e2aed2` (push 후 origin/main 최신)
목적: **다른 PC에서 이 스레드를 그대로 이어받기.** auto-memory는 PC 로컬이라 전파되지 않으므로, 이 문서가 유일한 이어받기 컨텍스트다. (사용자 지시: 평소엔 핸드오프 안 만들지만, PC 전환이라 repo에 커밋.) **픽업 후 불필요하면 삭제 가능.**

## 스레드 원래 의도 (보존할 것)
ditto를 자기 자신에 dogfooding한다. 매 증분을 **새 work item으로 deep-interview→autopilot→completion**으로 처리한다.
중심 과제 = **부트스트랩 역설 해소**: 구동 엔진은 3노드 씨앗(design→implement→verify)이고 수동 TDD로만 구현 가능. 그 위에서 "그래프를 생성·확장·완료하는 역량"을 한 증분씩 만든다. root_goal/work item은 분할 금지(1 요청 = 1 work item). 증거 없는 완료(pass) 금지.

## 끝난 것 (전부 main에 커밋·push, 785 tests pass · lint 0 error · tsc 무회귀)
- **A-1** `wi_260602a0y` — `AutopilotStore.addNodes` + `validateNodeAddition`(중복/dangling/cycle) + `NodeGenerator` seam(기본=3노드). `5c31783 df9c066 7602820 edfe5f6`.
- **A-2(planner)** `wi_260602s66` — `autopilot-converge.ts` `planForwardReexpansion`(§2.4 forward 재확장, §4.3 close|expand|escalate) + `caps.converge_rounds`(.default 3). 순수 planner. `bf6a150 9b00631`.
- **A-3** `wi_2606022n3` — planner 콘텐츠 승격: `recordResult`가 contentful pass 노드의 `generated_nodes`(intent-level `nodeProposal`)를 `proposalsToNodes`→`addNodes`로 접합. **addNodes 첫 live 호출자.** 부재 시 동작 불변. `4b111c6 c4263d0`.
- **A-2(live)** `wi_260602jsb` — forward 재확장 live: `recordResult`에서 `node.kind===review && has_findings===true`면 `planForwardReexpansion` 호출(expand→addNodes 접합, escalate→노드 blocked + `user_decision_needed` 로그, 닫지 않음). `round=forwardRound(id)`(`.rev.r` 마커 수). `bf280f8 fc08958`.
- **planner 지능(계약 우선)** `wi_260602cfg` — `buildDelegationPacket`이 `owner===planner` packet에 `PLANNER_GENERATE_DIRECTIVE`(generated_nodes 서브그래프·§2.2 라이프사이클·AC 매핑·scale) + `expected_outcome` subgraph. `agents/planner.md`를 graph generator 계약으로 개정. 지능=LLM, DITTO=결정론 요청·검증 floor. `e85cca8 d0155c1`.
- **[VERIFY] owner(3 신규)** `wi_260602evr` — `nodeKind` +security/refactor/retro, `nodeOwner` +security-reviewer/refactorer/retrospective, `KIND_TO_OWNER`·`OWNER_TOOLS` 확장. **mutating 게이트 중앙화** `isMutatingOwner(owner)=OWNER_TOOLS[owner].includes('Edit')`(refactorer approval-gated). `agents/{security-reviewer,refactorer,retrospective}.md` + `surfaces.json` 27. cleanup은 의도적 미배선. `6319033 1437bd4`.
- **작은 고정 2건** `wi_260602f93` — `nextNode` 종단 surfacing: (1) `blocked` 노드(running 없을 때) → 새 `action:'blocked'`(blocked_node_ids + decisions reason), waiting과 구분. (2) `done`에 `all_passed:boolean` + reason "완료 판정 필요". **done은 work-item AC를 auto-close 안 함**(증거 기반). `6815e57 f5ae279`.
- **done→completion 자동 어셈블** `wi_2606026fw` — `src/core/autopilot-complete.ts`(`deriveAcVerdicts` 증거 게이트 + `assembleCompletionFromGraph`) + CLI **`ditto autopilot complete --workItem <wi> [--summary]`**. 그래프 evidence를 AC에 매핑, verdict는 증거 게이트(passed+evidence→pass, evidence 없으면 unverified, failed→fail). **auto-pass 아님.** 매 dogfood 수동 buildCompletion 마찰 제거. `e3b2775 be7fdda`.
- **changed_files 자동 수집** `wi_260602ocq` — `recordResultPayload`에 optional `changed_files`(relativePath[]). contentful pass 브랜치에서 owner 보고 changed_files를 work item에 **union**(기존 dedup·순서 보존, **pass-only**, node kind gate 없음). `complete`가 `work-item.changed_files`를 그대로 읽으므로 **수동 핀 제거**. approach (a) node-report 채택, (b) `--changed-files` 플래그 기각(핀 위치만 이동). 라이브 dogfood: work start 빈 changed_files→N2가 2파일 자동 수집. `e84b272 36d4c91`.
- **cleanup 배선** `wi_2606020ud` — §2.2 마지막 [VERIFY] cleanup을 **`driver` pseudo-owner 결정적 드라이버 스텝**으로 확정. `nextNode`가 `owner==='driver'`를 spawn 전 intercept→`action:'cleanup'`+dispatch(no spawn). `autopilot-cleanup.ts`(planCleanup·cleanupApprovalGate·runCleanup) + `worktree.ts`(listRunWorktrees realpath-safe·removeRunWorktree non-forced) + CLI **`ditto autopilot cleanup --workItem --node [--approve]`**. 비가역 git(worktree teardown)은 **명시 승인 게이트**(`--approve`|`approval_gate=approved`만 인가, `not_required` 불충분). v0 스코프=per-run worktree(`.ditto/worktrees/*`); commit=사용자 몫, branch=미생성, temp=임의라 제외. dirty worktree는 non-forced로 skip. 라이브 dogfood: design이 cleanup 노드 생성→intercept→실 repo cleanup(worktree 0 trivial pass). `8bd8751 9531bc7`. + `509faf7` SKILL.md에 cleanup action 배선 + record-result `changed_files` 필드 보완.
- **security forward 재확장** `wi_260602vc1` — §2.4 forward 재확장 게이트를 `recordResult`에서 `kind===review`→`(review||security)`로 확장. `planForwardReexpansion` 재검 노드가 `reviewNode.kind` 보존(security→security 재검, generic review 아님; fix는 implementer). `has_findings` description 갱신. verify는 제외(AC pass/fail이라 findings-to-fix 아님). tests 3건. 라이브 dogfood: N2가 3파일 자동 수집. `7f02388 726c5e0`.
- **real-spawn 데모 (부트스트랩 역설 해소)** `wi_260602n7m` — design→implement→verify를 실제 spawn된 `ditto:planner/implementer/verifier` subagent로 구동(오케스트레이터=select/spawn/judge/독립검증/record). implementer가 `autopilot-complete.ts`에 non-terminal→`remaining_risks` surfacing 실제 구현, verifier가 fresh 증거 독립 검증. complete: final_verdict=pass, graph done이라 `remaining_risks=[]`(빌드한 기능 즉시 dogfood). `634496e 2e2aed2`.

## 부트스트랩 역설 현재 상태 — **해소(실증 완료)**
**그래프 생성·확장·완료 3축 + 실제 spawn 모두 live.** addNodes(A-1)→A-3(자유 성장)·A-2(forward 수렴, review+security). planner 지능으로 design 노드가 서브그래프를 *계약으로* 생성. [VERIFY] owner 전부 배선(cleanup=driver step 포함). `autopilot complete`로 done→completion 어셈블(증거 기반) + non-terminal surfacing. **역설 해소 실증** `wi_260602n7m`: design→implement→verify를 **실제 spawn된 `ditto:planner/implementer/verifier` subagent**가 수행(오케스트레이터=main agent는 select/spawn/judge/독립검증/record만, owner 대리 안 함). implementer가 `autopilot-complete.ts` 실제 수정, verifier가 fresh 증거로 독립 검증. 코드 spawn seam은 처음부터 완성이었고(`autopilot-dispatch.ts:108-113` 네이티브 Task), 남아 있던 건 코드가 아니라 *실행*이었음 — 이제 실행됨. 기본 bootstrap은 여전히 3노드 seed(관찰 동작 불변).

## 다음 결정 (열려 있음 — user-owned)
핸드오프 후보 목록 **전부 소진**(changed_files·cleanup·security forward·real-spawn). 다음 증분은 새 의도에서 시작. 후보 씨앗(미합의):
- **real-spawn을 기본 워크플로로**: 지금은 데모 1회. autopilot SKILL 구동 시 항상 실제 subagent를 띄우는 운영 패턴 정립(토큰 비용 트레이드오프).
- **done 가드 강화**: complete가 non-terminal을 surfacing은 하지만 여전히 assemble은 허용. 거부/`--allow-partial` 게이트는 별건(현재 surfacing까지가 합의 범위).
- **reviewer/refactor/retro/knowledge owner 라이브 실행**: 이번 데모는 planner/implementer/verifier만. 나머지 owner도 실제 spawn으로 한 번씩.

## Known issues / 주의
- **`autopilot complete`는 그래프 done을 강제하지 않음**: 노드가 running이어도 어셈블 가능(addressing 노드가 passed+evidence면 pass 도출). 이제 non-terminal 노드를 `remaining_risks`에 **surfacing**함(`wi_260602n7m`, `634496e`) — 다만 assemble 자체는 여전히 허용(거부/`--allow-partial` 게이트는 별건).
- **evidenceRef.kind = `command|file|artifact|url|note`** (≠ `evidence_required` enum `test|diff|browser|doc|log`). record-result evidence_refs에 test/log 쓰면 검증 실패로 노드가 running 잔류 — 주의.
- **`ditto work handoff` changed_files 과대산출**: 오래된 base ref로 무관 파일 나열. 우회 `--base <tight-ref>`. 핸드오프는 그래서 손으로 씀.

## 증분 처리 절차 (확립된 패턴 — 그대로 재사용)
1. `bun run src/cli/index.ts work start "<goal>" --request "<verbatim>" --title "<t>" --output json` → `wi_*`.
2. **deep-interview**: 일회용 `bun` 스크립트로 `interview-driver`의 `startInterview`→`recordTurn`×N(critical dim `state:'resolved'`, 에이전트 판단 `kind:'assumption'`, `readiness_score` 0.85+)→`finalizeInterview`(intent + AC mirror + autopilot bootstrap). repo root는 `~/core/fs`의 `findRepoRoot`. **AC statement는 `acceptanceTestable` 게이트 통과 필수**(영문 관찰 술어 `returns/rejects/shows/exits/equals/contains/...` 또는 숫자 1개+, VAGUE `robust/efficient/properly/...` 금지) — 못 통과하면 `bootstrapAutopilot`이 `intent_not_ready` throw. `evidence_required` enum = `test|diff|browser|doc|log`.
3. **autopilot loop**: `autopilot next-node`→owner 판단→`autopilot record-result --json '{node_id,result_text,outcome,evidence_refs?,generated_nodes?,has_findings?}'`→반복→`done`. (mutating 노드만 approval gate; `result_text`는 G7 content 가드 — 빈/ack-only는 fixable 강등. evidence_refs kind는 위 evidenceRef enum.)
4. **completion**: `ditto autopilot complete --workItem <wi> --summary "..."` (신규, 증거 게이트 자동 어셈블). changed_files는 complete 전 work-item에 핀(이 증분 실제 파일만). 또는 복잡하면 `buildCompletion` 직접.
5. **commit**: main 2개 — `feat(...) (동작적)` 코드 / `chore(work-items): <wi> ... 산출물 (런타임 상태)`.

## 권위 컨텍스트 (먼저 읽을 것)
- `reports/design/contracts/autopilot-contract.md` — §2.2(라이프사이클·owner 매핑), §2.4(그래프 생성·forward 재확장), §4.3(수렴 2층 탈출), §6.8(Completion: graph 상태 ≠ 완료 판정). **스키마 최우선 권위**(`src/schemas/autopilot.ts`).
- 코드 seam: `src/schemas/autopilot.ts`(nodeKind/nodeOwner), `autopilot-graph.ts`(addNodes·proposalsToNodes·KIND_TO_OWNER), `autopilot-converge.ts`(forward 재확장·forwardRound), `autopilot-loop.ts`(nextNode 종단 surfacing·driver intercept·recordResult·승격·changed_files union·isMutatingNode), `autopilot-dispatch.ts`(buildDelegationPacket·OWNER_TOOLS·isMutatingOwner·PLANNER_GENERATE_DIRECTIVE), `autopilot-complete.ts`(done→completion 어셈블), `autopilot-cleanup.ts`(driver step: planCleanup·cleanupApprovalGate·runCleanup), `worktree.ts`(listRunWorktrees·removeRunWorktree), `completion-store.ts`(buildCompletion), `agents/*`, `skills/autopilot/SKILL.md`.

## plugin 업데이트 / 새 세션 첫 체크 + 금지
- plugin(`skills/*`·`agents/*`) 업데이트 시 의존 전 다시 읽기. 핵심 코드 seam(`src/`)은 유지.
- 첫 체크: `git log --oneline -8` → `bun test`(766 green 기대) → 계약 §2.2/§2.4/§4.3/§6.8 재독 → 다음 증분 결정.
- 금지: root 요청 분할/스코프 확장, 증거 없는 완료 선언, 미검증을 성공처럼 표기.
- surface(agents/skills) 추가/삭제 시 `bun run surfaces:gen` + `tests/core/surface-inventory.plugin.test.ts` 하드코딩 count 갱신.
- 미커밋 잔재: `bun.lockb`(이 스레드와 무관한 사전 변경, 손대지 않음).
