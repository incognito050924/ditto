# Handoff — DITTO self-dogfooding 증분 스레드

작성: 2026-06-02 · branch `main` · HEAD `c4263d0`
목적: 새 세션이 **이 스레드를 그대로 이어받도록** 최소·충분 컨텍스트 제공. (사용자가 ditto plugin 업데이트 후 새 세션에서 이어감.)

## 스레드 원래 의도 (보존할 것)
ditto를 자기 자신에 dogfooding한다. 매 증분을 **새 work item으로 deep-interview→autopilot**으로 처리한다.
중심 과제 = **부트스트랩 역설 해소**: 구동 엔진은 여전히 3노드 씨앗(design→implement→verify)이고 수동 TDD로만 구현 가능하다. 그 위에서 "그래프를 생성·확장하는 역량"을 한 증분씩 만든다. root_goal/work item은 분할 금지(1 요청 = 1 work item).

## 끝난 것 (전부 main에 커밋, 743 tests pass · lint 0 error)
- **A-1** `wi_260602a0y` — `AutopilotStore.addNodes` + `validateNodeAddition`(중복/dangling/cycle) + `NodeGenerator` 생성 seam(기본=3노드). commits `5c31783 df9c066 7602820 edfe5f6`.
- **A-2** `wi_260602s66` — `src/core/autopilot-converge.ts` `planForwardReexpansion`(§2.4 forward 재확장, §4.3 2층 탈출: close|expand|escalate) + 스키마 `caps.converge_rounds`(.default 3). **순수 planner, live 호출자 없음.** commits `bf6a150 9b00631`.
- **A-3** `wi_2606022n3` — **planner 콘텐츠 승격**: `recordResult`가 contentful pass 노드의 `payload.generated_nodes`(intent-level `nodeProposal`)를 `proposalsToNodes`로 매핑 후 `addNodes`로 접합. **`addNodes`의 첫 live 호출자.** 승격 직후 `next-node`가 생성 노드를 dispatch → 엔진이 3노드 씨앗을 넘어 실행. `generated_nodes` 부재 시 동작 불변. commits `4b111c6 c4263d0`.

## 부트스트랩 역설 현재 상태
**부분 해소.** `addNodes`(A-1)가 A-3로 live 호출자를 얻어, design 노드가 `generated_nodes`를 공급하면 그래프가 씨앗을 넘어 성장한다. **아직 없는 것 = 지능**: LLM planner가 root_goal/AC를 보고 *무슨 노드를* 만들지 결정하는 부분. 기본 bootstrap은 여전히 3노드를 seed한다(관찰 동작 불변).

## 다음 결정 (열려 있음 — user-owned)
직전 세션에서 사용자가 "planner 콘텐츠 승격(A-3)"을 골라 처리 완료. 다음 증분 후보(추천 순):
1. **planner 지능** — LLM이 root_goal/AC로 노드 서브그래프를 *생성*. A-3로 메커니즘이 다 깔려 가장 자연스러움. (수동 TDD 한계 주의: 진짜 LLM 생성은 엔진이 owner subagent를 spawn해야 실측 가능 — 결정론 부분/계약부터.)
2. **A-2 forward 재확장 live 배선** — 같은 `generated_nodes`/`addNodes` 경로 재사용. review 노드가 findings 시 fix+review 승격.
3. **작은 고정 2건** (아래 known issues) — dogfooding 루프 충실도.
4. **[VERIFY] owner 제작**(security/test/refactor/retro/cleanup) — planner 지능 선행 필요.

## Known issues (조치 대기, follow-up)
- **§6.8 배선 공백**: autopilot `done` ≠ work-item AC 자동 클로징. 지금은 `ditto verify`/수동 completion으로 마감해야 함.
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
- 코드 seam: `src/core/autopilot-graph.ts`(addNodes 무결성·proposalsToNodes·buildInitialNodes), `src/core/autopilot-converge.ts`(forward 재확장), `src/core/autopilot-loop.ts`(nextNode/recordResult+승격), `src/core/autopilot-bootstrap.ts`.

## plugin 업데이트 주의
사용자가 ditto plugin을 업데이트한다 → `skills/*`, `agents/*`가 바뀔 수 있다. **새 세션은 의존 전에 현재 `skills/autopilot/SKILL.md`·`agents/*`·계약 문서를 다시 읽어라.** 단, 핵심 코드 seam(`src/`)은 plugin 업데이트와 무관하게 유지된다.

## 새 세션 첫 체크 + 금지
- 첫 체크: `git log --oneline -6` → `bun test`(743 green 기대) → 계약 §2.4/§4.3 재독 → 다음 증분 결정.
- 금지: root 요청 분할/스코프 확장, 증거 없는 완료 선언, 미검증을 성공처럼 표기.
- 미커밋 잔재: `bun.lockb`(이 스레드와 무관한 사전 변경, 손대지 않음).
