---
title: "DITTO v0 구현 적합성(conformance) 매트릭스"
kind: verification
last_updated: 2026-05-28 KST
status: closed
parent: reports/design/ditto-v0-implementation-plan.md
scope: "plan §2~§5 (M0.1~M2.5 detailed + M3·M4 outline) 각 build unit의 acceptance를 문서에서 직접 인코딩한 적합성 테스트와 그 판정 결과. M5(Playwright E2E)·M6(Knowledge/PM)는 미구현 — v0 closure 범위 밖."
tests:
  - tests/conformance/m0.conformance.test.ts
  - tests/conformance/m1.conformance.test.ts
  - tests/conformance/m2.conformance.test.ts
  - tests/conformance/m3.conformance.test.ts
  - tests/conformance/m4.conformance.test.ts
---

# DITTO v0 구현 적합성 매트릭스

## 0. v0 closure 선언

> "[`ditto-v0-implementation-plan.md`](./ditto-v0-implementation-plan.md) 의 각 build unit 이 **문서대로 구현됐는가?**"

`tests/conformance/` 의 다섯 파일은 plan §2~§5 의 **acceptance 조항을 문서에서 직접 인코딩**한 적합성 테스트다(기존 단위 테스트와 독립). 구현이 문서를 벗어나면 통과가 아니라 FAIL 하며, 그 FAIL 이 곧 발견(finding)이다.

실행:

```bash
bun test tests/conformance              # 전체 v0 적합성
bun test tests/conformance/m{N}.conformance.test.ts   # 특정 milestone
```

**현재 판정: 138 케이스 전부 ✅ CONFORMS — v0(M0~M4) closed. wi_v04dialectic_runtime (2026-06-01): M3 dialectic 런타임 — 3역 agent 본문 + /ditto:dialectic skill driver + OpponentModelRouter(codex→claude fallback provenance) + Stop hook dialectic ledger admissibility cross-check. 결정: dialectic은 새 nodeKind 아니라 review/high-impact 노드 메커니즘(권위 문서). (직전: wi_v04evidence_record_sidecar 2026-06-01 EvidenceRecord sidecar + evidence-index.json ledger; wi_v04verifier_body_and_declared_by declared_by→declarerRole.)**

| milestone | unit count | 적합성 케이스 | 판정 |
|---|---|---:|---|
| M0 (계약·스키마·게이트) | 4 | 17 | ✅ |
| M1 (plugin·hook·skill·agent·inventory) | 6 | 46 | ✅ |
| M2 (autopilot skeleton) | 6 | 30 | ✅ |
| M3 (Evidence·verifier 런타임) | 5 | 32 | ✅ |
| M4 (Context rot 방지) | 2 + cross | 13 | ✅ |
| **v0 합계** | **23** | **138** | **✅** |

**M5(Playwright E2E)·M6(Knowledge/PM)는 runtime 미구현 — v0 closure 범위 밖**(plan §0 / 설계서 §12.5 "v0 범위는 M0~M2 skeleton, M3 이후는 hardening/확장"; M3·M4는 본 closure에 포함, M5·M6 runtime은 별도 milestone). 단 아래 **post-v0 design-lock** 참조 — M5/M6의 contract schema는 박혔고 agent runtime만 보존된다.

### post-v0 design-locked contracts (schema + 설계문서, runtime은 M5/M6)

v0 합계(138)에 **포함하지 않는다**(post-v0). 2026-06-01 wi_v04knowledge_curator가 contract를 design-lock:

| contract | schema | 설계문서 | runtime(보류) | agent invariant |
|---|---|---|---|---|
| **KnowledgeContract**(M6) | `knowledge-record.ts`(`knowledgeRecord`, cross-field superseded⇒superseded_by) | `contracts/knowledge-contract.md` | knowledge-curator agent·`/ditto:knowledge-update`·CLAUDE.md projection | M1.5b: `knowledge-curator.md` v0 부재 유지 ✅ |

schema parse/reject·등록(barrel/registry/sidecar-registration)은 `tests/schemas/knowledge-record.test.ts`로 검증(v0 합계 무관).

## 1. 매핑표 (build unit → 적합성 케이스 → 판정)

### Milestone 0 — 계약·스키마·fixture (`m0.conformance.test.ts`)

| unit | 검증하는 acceptance | 판정 |
|---|---|---|
| **M0.1** | 사이드카가 work-item status enum / evidenceRef 재정의 없음, common 재사용 | ✅ |
| **M0.2** | 신규 7종이 barrel·export 레지스트리 양쪽 등록, export 시 7개 `*.schema.json` 생성 | ✅ |
| **M0.2** | flag① Opponent severity = common severity 재사용 | ✅ |
| **M0.2** | flag② Synthesizer verdict 가 completion verdict 와 분리(교차 거부) | ✅ |
| **M0.2** | flag③ `honestyKind`·`ledgerStatus` 신규 enum | ✅ |
| **M0.3** | 각 스키마 valid→parse 성공/invalid→실패, AC 불일치 3종 fixture | ✅ |
| **M0.4** | `completionGate` 집합 일치→PASS, 누락/잉여/중복(count 검사)→FAIL | ✅ |
| **M0.4** | `convergenceGate` converged→PASS, treadmill/early-converge→FAIL | ✅ |
| **M0.4** | `acceptanceTestable`, `interviewReadinessGate`, `deterministicFloor`, risk 술어 | ✅ |

### Milestone 1 — plugin skeleton + hook 동작 (`m1.conformance.test.ts`)

| unit | 검증하는 acceptance | 판정 |
|---|---|---|
| **M1.1** | plugin.json name=ditto, layout(hooks/skills/agents) 존재 | ✅ |
| **M1.2** | v0 표면 4개 hook 등록; 크래시→fail-open; kill-switch; no-op stub; exit 2 전달 | ✅ |
| **M1.3** | 빈→create+pointer, 기존→load, 다중 draft+포인터 없음→ask, 포인터 존재→1개 active | ✅ |
| **M1.3** | UPS 절대 block 안 함; Stop과 같은 포인터 공유 | ✅ |
| **M1.3** | 자동 생성 placeholder-only AC → charter에 placeholder advisory inject (§AC-3, wi_v04runtimewiring 2026-05-31) | ✅ |
| **M1.3** | real AC 1개 이상 → placeholder advisory 미발화 (false-positive 차단) | ✅ |
| **M1.3** | placeholder-only + execution prompt → `▶ Run /ditto:deep-interview now` directive inject (§AC-1, wi_v04intent_autopilot_entry 2026-06-01) | ✅ |
| **M1.3** | placeholder-only + question prompt → directive NOT injected (보수성) | ✅ |
| **M1.3** | question + codebase-locatable surface → `⚠ self-answer from code/docs/web first … QuestionGate` hint (§AC-5, wi_v04intent_autopilot_entry 2026-06-01) | ✅ |
| **M1.3** | question without codebase mention → no QuestionGate hint (false-positive 차단) | ✅ |
| **M1.4** | 미검증 완료→exit 2 / 완료→exit 0 | ✅ |
| **M1.4** | 완료 부재 + ready 노드→exit 2 | ✅ |
| **M1.4** | 완료 부재 + active autopilot 없음 + NON_TERMINAL→exit 2 (§M1.4 strong-block 2026-05-31, wi_v04runtimewiring) | ✅ |
| **M1.4** | 완료 부재 + active autopilot 없음 + terminal(done/abandoned)→exit 0 | ✅ |
| **M1.4** | approval pending(+노드)→exit 0; blocked 노드만→exit 0 | ✅ |
| **M1.4** | malformed artifact→exit 2; `stop_hook_active`→exit 0 | ✅ |
| **M1.5** | v0 skill 7표면; plan/autopilot `user-invocable:false`; 노출 4종 무제한 | ✅ |
| **M1.5** | dialectic-review→dialectic --mode review 라우팅 | ✅ |
| **M1.5b** | v0 agent 8종 + frontmatter; orchestrator 부재; post-v0 agent 부재 | ✅ |
| **M1.6** | plugin-root 스캔 ↔ catalog drift 0; hook·plugin 포함 | ✅ |
| **M1.6** | 선언 surface 부재→missing drift; present-but-empty→throw | ✅ |
| **M1.6** | **부재 catalog → fail** (`92da9ee fix(M1.6)` 으로 closed — F-1 §3 참조) | ✅ |

### Milestone 2 — autopilot skeleton (`m2.conformance.test.ts`)

| unit | 검증하는 acceptance | 판정 |
|---|---|---|
| **M2.1** | AutopilotStore write→get; updateNode 단일 노드·id 변경/부재 throw; decisions append-only | ✅ |
| **M2.1b** | ready intent→graph(root_goal·design→implement→verify) | ✅ |
| **M2.1b** | high-risk→pending / safe→not_required / approved 입력→approved | ✅ |
| **M2.1b** | vague intent→graph 미생성(intent_not_ready); 루프 입력으로 동작 | ✅ |
| **M2.1b** | `ditto deep-interview finalize` 가 ready 상태에서 bootstrapAutopilot 자동 호출 → intent.json + autopilot.json 동시 생성 (§AC-3, wi_v04intent_autopilot_entry 2026-06-01) | ✅ |
| **M2.2** | kind→owner; depends_on; N1→N2→N3 루프; terminal | ✅ |
| **M2.2** | ready 노드+approval 아님→Stop continuation 강제 | ✅ |
| **M2.3** | pending→present_plan / approved·not_required→proceed / rejected→blocked | ✅ |
| **M2.3** | mutationGate 는 status 만 소비(risk 인자 없음) | ✅ |
| **M2.4** | 6-section delegation packet + context | ✅ |
| **M2.4** | implementer→Edit/Write; read-only→"mutate 금지" MUST NOT | ✅ |
| **M2.4** | decideOnFailure: fixable/wrong_approach/external/user_decision 매핑 + cap_exceeded | ✅ |
| **M2.5** | passed 후 nextReadyNodeId 자동 선택 | ✅ |
| **M2.5** | buildContinuationSignal: 같은 autopilot_id resume, artifact 파일 미작성(M4) | ✅ |

### Milestone 3 — Evidence·verifier 런타임 (`m3.conformance.test.ts`)

| unit | 검증하는 acceptance (§12 M3 + commit 44d8f2c) | 판정 |
|---|---|---|
| **M3.1** | PostToolUse Bash → `commands.jsonl` 에 commandLogEntry append | ✅ |
| **M3.1** | best-effort exit code: `exit_code`/`exitCode`/`is_error` 모든 형태 | ✅ |
| **M3.1** | 비차단(항상 exit 0); Bash 아님·세션 없음·포인터 없음 → no-op | ✅ |
| **M3.1** | append-only, 순서 보존 | ✅ |
| **M3.2** | work item AC당 정확히 1 entry → completionGate(M0.4) PASS | ✅ |
| **M3.2** | 미기록 criterion → unverified 결정론 default | ✅ |
| **M3.2** | final_verdict 도출: 모든 pass∧in-scope unverified 0→pass, fail 있으면→fail | ✅ |
| **M3.2** | CompletionStore write→exists→get 라운드트립 | ✅ |
| **M3.2** | declared_by='verifier' completion CONFORMS (설계서 line 700 판정 주체) | ✅ |
| **M3.2** | declared_by에 실행 프로파일(workspace-write 등)/빈 문자열 → declarerRole reject (사칭 차단) | ✅ |
| **M3.3** | argmax: selected_version = max(score) (ratchet — 최선본 보존) | ✅ |
| **M3.3** | open_admissible_count = (admissible ∧ deferred) 수 — 결정론 재계산 | ✅ |
| **M3.3** | converged = completion_gate=pass ∧ open_admissible=0 (두 게이트 결합) | ✅ |
| **M3.3** | 캡 도달 → exit.reason=cap_reached + handoff_path (non-pass 닫힘) | ✅ |
| **M3.3** | 빌더 산출이 M0.4 convergenceGate 통과 | ✅ |
| **M3.3** | admissibility 는 *입력*(판정 아님) — 같은 ledger 에 flag 만 바꿔도 결과가 따른다 | ✅ |
| **M3.3** | appendLedgerEntry: append-only ratchet + gate 재계산 (in-place 아님) | ✅ |
| **M3.4** | EvidenceRecord 유효 레코드 default(stale_reason null·key_lines []) 적용 | ✅ |
| **M3.4** | cross-field: stale⇒stale_reason 필수 / fresh⇒stale_reason null / committed⇒artifact_available=true (위반 reject) | ✅ |
| **M3.4** | clone 환경 fallback: local-artifact+artifact_available=false 라도 summary/exit_code/sha256/key_lines 로 판정 가능 | ✅ |
| **M3.4** | evidence-index.json ledger: appendRecord→readIndex append-only 라운드트립 (커밋 대상, evidence/ gitignore 와 분리) | ✅ |
| **M3.5** | OpponentModelRouter: Codex 우선, 가용 시 fallback 없음(provenance none) | ✅ |
| **M3.5** | OpponentModelRouter: Codex 불가 → claude fallback + 사유 기록(침묵 금지, §3.2/§3.5) | ✅ |
| **M3.5** | dialectic admissibility: maps_to∧critical\|high 해결+accept→통과 / 미해결→continuation | ✅ |
| **M3.5** | dialectic verdict reject\|blocked → continuation; taste(medium·oracle 없음)는 non-blocker | ✅ |
| **M3.5** | Stop hook 통합: reviews/dialectic-*.json verdict=blocked → exit 2, malformed → fail-closed | ✅ |

### Milestone 4 — Context rot 방지 (`m4.conformance.test.ts`)

| unit | 검증하는 acceptance (§12 M4 + commit 3da00ab) | 판정 |
|---|---|---|
| **M4.1** | buildHandoff: schema 통과 + original_intent/current_state/next_first_check 필수 | ✅ |
| **M4.1** | evidence_refs 는 인라인 요약(raw artifact 아님) | ✅ |
| **M4.1** | HandoffStore.write 는 handoff.json + work item handoff_path 자동 링크 | ✅ |
| **M4.1** | autopilot_id 로 resume target (scope 불변) | ✅ |
| **M4.1** | handoff 만으로 resume 가능한 5요소(원래 의도·상태·다음 확인·결정·미해결) | ✅ |
| **M4.2** | active work item → 압축 전 handoff.json 작성 | ✅ |
| **M4.2** | 세션 없음·포인터 없음·work item 없음 → exit 0 + handoff 미작성 | ✅ |
| **M4.2** | trigger 메타가 from_context 에 반영 | ✅ |
| **M4.2** | re_entry.command → handoff open_threads 운반 | ✅ |
| **M4.2** | invariant: PreCompact 후 work item handoff_path 가 artifact 가리킴 | ✅ |
| **M4.2** | active autopilot 존재 → handoff.autopilot_id = autopilot.autopilot_id (§AC-1, wi_v04runtimewiring 2026-05-31) | ✅ |
| **M4.2** | autopilot 부재 → handoff.autopilot_id 미포함 (backward compat) | ✅ |
| **M4 cross** | UserPromptSubmit charter projection 으로 active work item 식별자 매 턴 주입 | ✅ |

## 2. 적합성 테스트가 의도적으로 *다루지 않는* 것

문서가 v0 범위 밖으로 명시했거나, 자동 단위 테스트로 판정 불가한 항목:

- **`claude plugin validate .` / `claude --plugin-dir` 실로드** — `claude` CLI 환경 의존(doctor 의 런타임 책임, D6).
- **StopFailure(rate-limit/auth/API)** — 별도 이벤트 output 무시; Stop 핸들러가 분기하지 않음은 코드 부재로만 확인.
- **인터랙티브 블로킹 승인 채널(§8-1)** — post-v0. M2.3 은 status 소비만 단언.
- **LLM 판단부**(admissibility 판정·verifier 실행·dialectic 본문) — D5 결정론 1차 / LLM 2차. 적합성도 결정론 게이트·빌더만 단언.
- **M5 Playwright E2E·M6 Knowledge/PM** — 본 closure 범위 밖(별도 milestone).

## 3. 발견 이력

### F-1 (M1.6) 부재 catalog silent-pass — ✅ CLOSED (`92da9ee fix(M1.6)`)

- **문서 요구**: plan §3 M1.6 — "`.ditto/surfaces.json` 부재·빈 목록 → fail(통과 금지)".
- **편차(closure 이전)**: `loadExpected` 가 `raw === null`(부재)에 `[]` 반환 → `collectSurfaceInventory` 가 `mismatch_count: 0` 으로 silent-pass. catalog 삭제 회귀가 항상 green.
- **수정**: `92da9ee fix(M1.6): absent surface catalog must fail loudly (동작적)` — `raw === null` 분기에서 `throw`(present-but-empty 와 대칭).
- **검증**: m1.conformance.test.ts › "M1.6 … [plan 요구] 부재 catalog → fail" 케이스가 closure 이후 자동 green. 

## 4. 갱신 규칙

- build unit 의 acceptance 가 바뀌면 plan 문서와 본 매트릭스·해당 적합성 테스트를 **함께** 고친다(권위 = plan 문서).
- 적합성 테스트는 *구현 세부*가 아니라 *문서 조항*을 단언한다. 구현 리팩터로 내부가 바뀌어도 조항이 유지되면 테스트는 그대로여야 한다(깨지면 그게 신호).
- v0 이후 milestone(M5/M6 등)을 시작할 때 해당 plan 문서를 새로 작성하고 별도 conformance 매트릭스를 만든다(본 매트릭스에 *추가하지 않음* — 본 문서는 v0 closure 의 동결 스냅샷).
