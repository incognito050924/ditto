---
title: "DITTO v0 구현 적합성(conformance) 매트릭스"
kind: verification
last_updated: 2026-05-28 KST
parent: reports/design/ditto-v0-implementation-plan.md
scope: "plan §2~§4 (M0.1~M2.5) 각 build unit 의 acceptance 를 문서에서 직접 인코딩한 적합성 테스트와 그 판정 결과."
tests:
  - tests/conformance/m0.conformance.test.ts
  - tests/conformance/m1.conformance.test.ts
  - tests/conformance/m2.conformance.test.ts
---

# DITTO v0 구현 적합성 매트릭스

## 0. 이 문서가 답하는 것

> "[`ditto-v0-implementation-plan.md`](./ditto-v0-implementation-plan.md) 의 각 build unit 이 **문서대로 구현됐는가?**"

`tests/conformance/` 의 세 파일은 plan §2~§4 의 **acceptance 조항을 문서에서 직접 인코딩**한 적합성 테스트다. 기존 `tests/` 의 단위 테스트(구현자가 작성)와 독립적으로, 계획서가 요구하는 동작을 외부에서 단언한다. 따라서 **구현이 문서를 벗어나면 통과가 아니라 FAIL** 하며, 그 FAIL 이 곧 발견(finding)이다.

실행:

```bash
bun test tests/conformance              # 전체 적합성
bun test tests/conformance/m1.conformance.test.ts   # 특정 milestone
```

현재 판정: **58 케이스 중 57 conforms, 1 deviation**(M1.6 부재 catalog — §3 참조).

## 1. 매핑표 (build unit → 적합성 케이스 → 판정)

판정: ✅ CONFORMS = 문서대로 동작 / ⚠️ DEVIATION = 문서 요구 미충족(테스트 FAIL).

### Milestone 0 — 계약·스키마·fixture (`m0.conformance.test.ts`)

| unit | 검증하는 acceptance (문서 근거) | 판정 |
|---|---|---|
| **M0.1** | 사이드카가 work-item status enum / evidenceRef 를 재정의하지 않음(중복 enum 0), common 재사용 | ✅ |
| **M0.2** | 신규 7종이 barrel·export 레지스트리 양쪽 등록, export 시 7개 `*.schema.json` 생성 | ✅ |
| **M0.2** | flag① Opponent severity = common severity 재사용(major/minor 별도 enum 아님) | ✅ |
| **M0.2** | flag② Synthesizer verdict 가 completion verdict 와 분리된 enum (교차 거부) | ✅ |
| **M0.2** | flag③ convergence `kind`(finding/hypothesis/taste)·`status`(acted/deferred/dismissed) enum | ✅ |
| **M0.3** | 각 스키마 valid→parse 성공 / invalid→실패, AC 불일치 3종(누락·잉여·중복) fixture 존재 | ✅ |
| **M0.4** | `completionGate` 집합 일치→PASS, 누락/잉여/**중복(count 검사)**→FAIL | ✅ |
| **M0.4** | `convergenceGate` converged→PASS, treadmill/early-converge→FAIL | ✅ |
| **M0.4** | `acceptanceTestable` vague→FAIL/observable→PASS, `interviewReadinessGate` ready/blocked | ✅ |
| **M0.4** | `deterministicFloor` 가중합·[0,1] clamp, `highRiskAssumption`/`safeDefaultable` 양면 | ✅ |

### Milestone 1 — plugin skeleton + hook 동작 (`m1.conformance.test.ts`)

| unit | 검증하는 acceptance (문서 근거) | 판정 |
|---|---|---|
| **M1.1** | `plugin.json` name=ditto·description·version, layout(hooks/skills/agents) 존재 | ✅ |
| **M1.2** | hooks.json 에 v0 4표면 등록; hook 크래시→fail-open(exit 0); kill-switch→미실행; no-op stub | ✅ |
| **M1.2** | 게이트 판정(exit 2)은 wrapper 가 삼키지 않고 전달 (fail-open ≠ fail-closed, D4) | ✅ |
| **M1.3** | 빈 상태→work item 생성+포인터 set+charter 주입; 기존 포인터→loaded | ✅ |
| **M1.3** | 다중 draft+포인터 없음→ask(임의 선택·신규 생성 금지); 포인터 존재→그 1개만 active | ✅ |
| **M1.3** | UserPromptSubmit 은 절대 block 안 함(exit 0); Stop 과 같은 포인터 공유 | ✅ |
| **M1.4** | 미검증 완료→exit 2 / 완료→exit 0 | ✅ |
| **M1.4** | 완료 부재 + ready 노드→exit 2 / active autopilot 없음→exit 0 | ✅ |
| **M1.4** | approval pending(+노드)→exit 0(양보); blocked 노드만→exit 0 | ✅ |
| **M1.4** | malformed completion/autopilot.json→exit 2(게이트 입력 위반); `stop_hook_active`→exit 0 | ✅ |
| **M1.5** | v0 skill 7표면 존재; plan/autopilot `user-invocable:false`·`disable-model-invocation` 미사용 | ✅ |
| **M1.5** | 노출 4종 비노출 플래그 없음; dialectic-review→dialectic --mode review 라우팅 | ✅ |
| **M1.5b** | v0 agent 8종 존재+frontmatter(name·desc·tools); orchestrator 파일 없음; post-v0 agent 부재 | ✅ |
| **M1.6** | 실제 plugin-root 스캔 ↔ checked-in catalog drift 0; hook·plugin surface 포함 | ✅ |
| **M1.6** | 선언 surface 디스크 부재→missing drift; present-but-empty catalog→throw | ✅ |
| **M1.6** | **부재 catalog → fail 이어야 함** (plan §3 M1.6 "부재·빈 목록 → fail") | ⚠️ **DEVIATION** |

### Milestone 2 — autopilot skeleton (`m2.conformance.test.ts`)

| unit | 검증하는 acceptance (문서 근거) | 판정 |
|---|---|---|
| **M2.1** | `AutopilotStore` write→get 라운드트립; `updateNode` 단일 노드·id 변경/부재 노드 throw | ✅ |
| **M2.1** | `autopilot-decisions.jsonl` append-only, 순서 보존 | ✅ |
| **M2.1b** | ready intent→graph(root_goal·design→implement→verify nodes) 생성 | ✅ |
| **M2.1b** | high-risk→pending / safe→not_required / approvedSource→approved | ✅ |
| **M2.1b** | vague intent→graph 미생성(intent_not_ready); 생성 graph 가 루프 입력으로 동작 | ✅ |
| **M2.2** | kind→owner 매핑; depends_on 미충족 노드 미선택; N1→N2→N3 루프; 모두 passed→terminal | ✅ |
| **M2.2** | ready 노드+approval 아님→Stop continuation 강제(내부 checkpoint 만으로 종료 안 함) | ✅ |
| **M2.3** | pending→present_plan(차단)/approved·not_required→proceed/rejected→blocked | ✅ |
| **M2.3** | `mutationGate` 는 graph status 만 소비(risk 인자 없음 — 재판정 안 함) | ✅ |
| **M2.4** | 6-section delegation packet + context(work_item_id·file_scope·done_when·acceptance_refs) | ✅ |
| **M2.4** | implementer→Edit/Write; read-only owner→"mutate 금지" MUST NOT | ✅ |
| **M2.4** | `decideOnFailure`: fixable→retry, wrong_approach→switch, cap 도달→escalate+cap_exceeded | ✅ |
| **M2.5** | passed 후 다음 ready 노드 자동 선택; `buildContinuationSignal` 같은 autopilot_id resume | ✅ |
| **M2.5** | 신호만 남기고 handoff artifact 파일은 만들지 않음(M4 runtime) | ✅ |

## 2. 적합성 테스트가 의도적으로 *다루지 않는* 것

문서가 v0 범위 밖으로 명시했거나, 자동 단위 테스트로 판정 불가한 항목:

- **`claude plugin validate .` / `claude --plugin-dir` 실로드(M1.1)** — `claude` CLI 가 있어야 검증 가능. 환경 의존이라 적합성 스위트에서 제외(doctor 의 런타임 책임, D6).
- **StopFailure(rate-limit/auth/API) 무시(M1.4)** — 별도 이벤트라 output 이 무시됨. Stop 핸들러가 이를 분기하지 않음은 코드 부재로 확인되나, 이벤트 자체를 단위 테스트로 주입할 표면이 없어 제외.
- **실제 subagent spawn·블로킹 승인 채널(§8-1)** — post-v0. M2.2 의 spawn 자체가 아니라 *루프 결정 로직*(ready 선택·packet·continuation)만 단언.
- **LLM 판단(admissibility·classification)** — D5 에 따라 게이트는 기록된 필드만 본다. 적합성도 결정론 게이트만 단언.

## 3. 발견 (DEVIATION)

### F-1 (M1.6) 부재 catalog 가 silent-pass 한다 — 문서는 fail 요구

- **문서 요구**: plan §3 M1.6 acceptance 및 false-green 절 —
  > "`.ditto/surfaces.json` **부재·빈 목록 → fail**(통과 금지)" / "M1.6 은 ① catalog **부재**·빈 목록 자체를 fail 로 판정(통과 아님)".
- **실제 구현**: `src/core/surface-inventory.ts:23` — `loadExpected` 가 파일 *부재*(`raw === null`)면 `[]` 를 반환하고, `collectSurfaceInventory:50-52` 가 `expected.length === 0` 이면 `mismatch_count: 0` 으로 **조용히 통과**한다. *present-but-empty*(`surfaces: []`)와 *malformed* 는 `throw` 로 막지만(:28-31, :19-22), **부재는 막지 않는다**. `doctor surface` 도 `mismatch_count`→`exitForFindings` 경로라 부재 시 exit 0.
- **영향**: catalog 파일을 실수로 지우거나 누락하면 surface drift 검사가 항상 green 이 된다 — M1.6 이 막으려던 바로 그 false-green.
- **수정 방향(택1)**: ① `loadExpected` 에서 `raw === null`(부재)도 `throw`(빈 목록과 동일 취급), 또는 ② `collectSurfaceInventory` 가 "catalog 존재"를 전제로 부재를 finding 으로 보고. ①이 plan 의 "부재·빈 목록 → fail" 문구에 가장 직접 부합.
- **적합성 테스트**: `m1.conformance.test.ts` › "M1.6 … [plan 요구] 부재 catalog → fail" — 수정 전까지 의도적으로 FAIL 상태를 유지(편차 가시화). 수정 후 자동 green.

## 4. 갱신 규칙

- build unit 의 acceptance 가 바뀌면 plan 문서와 본 매트릭스·해당 적합성 테스트를 **함께** 고친다(권위 = plan 문서).
- 적합성 테스트는 *구현 세부*가 아니라 *문서 조항*을 단언한다. 구현 리팩터로 내부가 바뀌어도 조항이 유지되면 테스트는 그대로여야 한다(깨지면 그게 신호).
