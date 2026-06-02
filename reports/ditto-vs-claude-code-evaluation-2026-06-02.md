# ditto는 순수 Claude Code보다 나은가 — 균형 평가 보고서

> **성격**: 일회성 평가 스냅샷 (2026-06-02). **소비자**: ditto 설계 결정자.
> **방법**: 하이브리드 딥리서치 워크플로(26 에이전트) — ditto 저장소를 1차 자료로 인벤토리(4) + 웹 베이스라인/문헌(5) + 도구×6목표 평가(4) + 3-vote 적대검증(12) + 종합(1).
> **갱신/삭제 조건**: §5 수정안이 반영되면 해당 항목 재평가; 코드가 크게 바뀌면 폐기하고 재실행.
> **신뢰도**: §4의 #1·#2·#6은 본 보고서 작성자가 `grep`으로 **독립 재확인**함(아래 검증 부록). 나머지는 워크플로 에이전트 근거.

## 평가 축 — 6개 목표
- **G1** 사용자 인지비용 감소
- **G2** 불필요한 사용자 개입 제거
- **G3** 장기간 수행 가능한 자율 오케스트레이션
- **G4** 의도 정확 파악 + 이해수준 동기화(사용자↔에이전트)
- **G5** 적은 할루시네이션
- **G6** 장기 유지보수·확장성(AX, agent experience)

---

## 1. 한 줄 결론

ditto는 **장기 자율 오케스트레이션(G3)·증거 기반 완료의 구조(G4/G5 일부)·에이전트 친화 상태/지식 관리(G6)**에서 순수 Claude Code(이하 CC)가 정책 텍스트로만 남긴 자리를 결정론 코드로 메워 실질적으로 낫다. 그러나 **인지비용(G1)·개입 제거(G2)**는 CC 네이티브(subagents·auto mode·output style)와 크게 겹쳐 차별화 폭이 작고, **핵심 안전 약속의 load-bearing 조각(`completionEvidenceGate` = "승인≠검증" 차단)이 미배선이라 G5의 강한 버전은 현재 코드로 실현되지 않았다**[근거: src/core/gates.ts:182 정의, src/hooks/stop.ts:4가 completionGate·convergenceGate만 import — 호출처 0 grep 확인]. ditto의 메커니즘 자체는 진짜 코드이고 CC 네이티브에 없지만, 그 메커니즘이 모두 CC의 hook/skill/Task 프리미티브 *위에* 얹힌 payload라는 점, 그리고 실제 장기 실행에서 실패 파이프라인이 한 번도 발화하지 않은 채 happy-path만 검증되었다는 점에서 "과설계 대비 실현 가치"의 경계가 아직 선명하지 않다.

## 2. 목표별 스코어카드 (G1~G6)

| 목표 | Verdict | 핵심 근거 |
|---|---|---|
| **G1 인지비용 감소** | **혼재(차별화 작음)** | CC가 이미 subagent 컨텍스트 격리·output-style Proactive·tool search로 동일 방향 제공[출처: code.claude.com/docs/en/sub-agents]. ditto의 evidence 외부화는 transparency 레버와 정합하나[출처: arxiv.org/pdf/2502.13767], 매 프롬프트 charter 5줄 주입은 영구 토큰 비용[근거: src/core/charter.ts:76-94]. |
| **G2 불필요 개입 제거** | **비슷~약간 나음** | autopilot이 retry/switch/escalate를 caps 내 자동 분기[근거: src/core/autopilot-dispatch.ts:113-131]. 단 CC auto mode/dontAsk가 이미 prompt 피로를 줄임[출처: code.claude.com/docs/en/permission-modes]. PreToolUse block-by-default는 진짜 추가분이나 오탐 비용 존재(§4). |
| **G3 장기 자율 오케스트레이션** | **낫다(핵심 가치)** | CC subagent는 중첩 불가라 다단계 위임이 메인 스레드 산문에 묶임[출처: code.claude.com/docs/en/sub-agents]. ditto는 노드 그래프를 결정론 전이표+atomic store로 구동[근거: autopilot-graph.ts NODE_TRANSITIONS, autopilot-store.ts]. 결정론 오케스트레이션 문헌 정합[출처: opensource.microsoft.com/blog/2026/05/14/conductor-...]. **단 cap 초과→handoff 자동 인계는 미배선**[근거: autopilot-driver.ts:88 호출처 0]. |
| **G4 의도 정렬·이해 동기화** | **낫다(구조적)** | deep-interview readiness gate가 critical 미해결+자기보고 readiness를 결정론 floor로 cap[근거: gates.ts:33,52]. intentContract가 source_request verbatim 박제[근거: schemas/intent.ts]. 사전 정렬>사후 repair 문헌 지지[출처: arxiv.org/html/2604.16198v1]. 단 floor 가중치 약함, gate가 stop.ts엔 미배선. |
| **G5 적은 할루시네이션** | **혼재(약속과 실현 격차)** | completion-contract superRefine·completionGate가 거짓 pass를 schema·게이트로 차단하는 골격은 실재[근거: schemas/completion-contract.ts, gates.ts:136]. 이중 게이트 문헌 지지[출처: arxiv.org/html/2511.05524v1]. **그러나 "승인≠검증" 핵심 가드(completionEvidenceGate)가 미배선이라 note-only evidence + 빈 verifications의 pass가 통과**[근거: gates.ts:182 호출처 0]. |
| **G6 유지보수·확장성(AX)** | **낫다(약한 회귀 동반)** | doctor의 결정론 drift 게이트·평문 JSON+ADR 지식·schema-at-write atomic store는 CC에 네이티브 대응 없음[근거: fs.ts:76-121, doctor.ts]. '평문>커스텀 추상화' 원칙 정합[출처: leehanchung.github.io/blogs/2026/05/08/hidden-technical-debt-agent-harness/]. 단 죽은 코드·이중 buildCompletion·네이밍 충돌이 comprehension debt(§4). |

## 3. 도구별 평가

### 3-1. Commands
ditto는 사용자 직접 호출 CLI를 일부만 노출하고, 핵심 워크플로(e2e·knowledge)는 autopilot의 `KIND_TO_OWNER` 매핑으로만 진입한다[근거: autopilot-graph.ts:15,17]. autopilot 흐름 밖 독립 구동이 불가해 일회성 web 검증/지식 갱신은 순수 CC가 더 빠르다. **AX 관점에서 진입점 부재가 실질 제약.**

### 3-2. Skills (9) + Agents (10)
**순수 이득:**
- **autopilot**: CC가 못 하는 결정론 노드 루프. next-node/record-result 2 CLI가 선택·dispatch·실패분류를 고정하고 LLM은 pass/fail/class만 판단[근거: autopilot-loop.ts]. `guardChildResult`가 빈/ack-only("done"/"ok"/✅)를 fixable로 강등 — false-green floor는 CC에 없는 순수 이득[근거: autopilot-dispatch.ts:90-103].
- **deep-interview**: 4 CLI 상태기계+readiness gate가 모호 의도 진입 차단.
- **reviewer/verifier/knowledge-curator**: 본문 채워진 schema-강제 owner. reviewer는 모든 finding에 oracle(AC id/file:line) 링크 필수, "안 돌린 건 unverified".

**오히려 안 좋은 점:**
- **plan (skill)**: placeholder. 실제 그래프 생성은 bootstrapAutopilot이 하고 plan skill은 standalone 배선점 없음 — 얇은 죽은 추상화[근거: autopilot-bootstrap.ts:47]. planner agent와 중복.
- **dialectic-review (skill)**: `--mode review` 순수 alias(10줄). 자체 가치 ≈0.
- **owner 성숙도 편차**: implementer/planner/researcher 3개 agent는 'v0 skeleton' 마커 상태로 콘텐츠 로직 미완. 루프 메커닉은 완성됐으나 spawn하는 핵심 owner 본문이 비어 dispatch 품질이 네이티브 general-purpose subagent 이하일 수 있다.

**적대검증: 생존(주장 유지).** "ditto가 CC에 부재한 강제·상태·검증 레이어를 더한다" → 1/3 반박. 메커니즘 자체(전이표·gate 순수함수·exit-2 강제)는 실제 코드+테스트 통과(stop 15/15, 전체 635 pass). **단 "미해결 적대 리뷰를 구조적으로 차단"은 미검증** — 실제 work item에 dialectic ledger 생성 0건, happy-path만 입증.

### 3-3. Hooks (5)
**순수 이득:**
- **runHook 2레이어**: 크래시=fail-OPEN(exit0), exit2=fail-CLOSED. '깨진 hook이 세션 영구 차단' 방지[근거: hooks/runtime.ts:35-45].
- **stopHandler 완료 게이트**: completionGate+convergenceGate+dialecticForcesContinuation+NON_TERMINAL strong-block을 exit2로 강제[근거: stop.ts:133-226]. CC Stop hook은 차단 메커니즘만 주고 '무엇이 완료인가'는 사용자 몫.
- **preCompactHandler**: compaction 직전 intent/state/evidence를 디스크 handoff로 박아 요약 손실 방어[근거: pre-compact.ts:16-52].

**오히려 안 좋은 점 / 충돌:**
- **classifyPromptAdvisory 한국어 오분류**: 영어 의문사·'?' 기준이라 주 언어 한국어는 거의 항상 'execution'. self-answer hint 미부착, deep-interview directive 오발[근거: user-prompt-submit.ts:17-23]. **실측 회귀.**
- **광범위 fail-open**: pointer 없는 세션에선 stop/postToolUse/preCompact가 조용히 exit0 — 게이트·증거·handoff 통째 no-op[근거: stop.ts:142-152].
- **preCompact 덮어쓰기**: 매 compaction마다 HandoffStore.write로 덮어써 직전 풍부한 handoff를 정적 템플릿으로 회귀 위험.

**적대검증: CONTESTED(주장 약화).** "stopHandler가 증거 없는 완료를 코드 수준에서 차단해 false-completion 0%" → **3/3 반박**. (1) 핵심 가드 completionEvidenceGate 미배선=무동작, (2) false-completion 0% 실증 0건(오히려 plan.md가 "약속 outcome 60-70% 미발화" 자인), (3) cross-check는 status='ok'+verdict='pass'일 때만 도는 사후 정합 검사이지 코드 차단 아님. **→ "AC 정합 cross-check 골격은 실재하나 '증거 없는 완료 0% 차단'은 코드로 뒷받침 안 됨."**

### 3-4. Contracts/Schemas (20) + 결정론 게이트
**순수 이득:**
- **completionContract + completionGate**: 실행 전 acceptance schema 검증+게이트. pass인데 non-pass AC 또는 in-scope unverified면 parse 단계 reject[근거: completion-contract.ts superRefine, gates.ts:136].
- **acceptanceTestable**: 모호어 19개+observable predicate로 검증불가 AC를 계획 진입 전 차단[근거: gates.ts:125].
- **fs.writeJson/atomicWriteText**: 모든 store write 전 safeParse+temp→rename atomic[근거: fs.ts:76-121].

**오히려 안 좋은 점:**
- **completionEvidenceGate 미배선([worse], 효과 0)**: ack≠verification 유일 결정 가드인데 src 호출처 0[근거: gates.ts:182, stop.ts:4 import에 없음]. 테스트만 통과해 '구현됨' 인상. **헌장 4-5 위반 지점, G5 약속 최대 균열.**
- **convergenceGate 생산자 부재**: ConvergenceStore가 src 어디서도 write 안 됨 — agent가 손으로 convergence.json 써야 발동하는 사후 검증.
- **acceptanceTestable 한국어 미적용 + VAGUE_TERMS substring 오탐**: 영어 모호어라 한국어 AC 미적용; 'Breakfast/steadfast/improvement' substring false-positive(probe 재현).

**적대검증: 생존, 단 강제 범위 과대표현 지적.** 결정론 강제는 completionGate·convergenceGate 둘뿐, acceptanceTestable는 bootstrap 1곳만, intent/placeholder 진입은 advisory(exit0). **→ "completion/convergence 둘만 결정론 강제, 나머지는 advisory 또는 단일 진입점."**

### 3-5. Core Orchestration
**순수 이득:**
- **nextNode/recordResult 결정론 라운드**: 노드 선택→dispatch→전이를 pure function+명시 전이표, 불법 전이는 throw[근거: autopilot-loop.ts:43-93].
- **decideOnFailure cap 정책**: fixable→retry, wrong_approach→switch, blocked/user→escalate를 caps 내 결정론 분기[근거: autopilot-dispatch.ts:113-131].
- **doctor + collectCapabilityInventory**: CI-게이트 가능한 결정론 drift 체크. CC에 네이티브 대응 없는 진짜 G6 도구.

**오히려 안 좋은 점 / 회귀:**
- **이중 buildCompletion + handoff clobber(확인됨)**: completion-store.ts:48(verifier-aware)와 work-item-handoff.ts:106(local, verifications:[] 하드코딩 line 132)이 따로. 실제 closure 경로 `ditto work handoff`는 local 버전으로 completion.json **무조건 writeJson**[근거: work-item-handoff.ts:282]. 선행 `ditto verify`가 쓴 verifications[]·richer remaining_risks를 빈 버전으로 덮어씀 — **실측 회귀.**
- **buildContinuationSignal/nextReadyNodeId/ContinuationSignal 죽은 코드(확인됨)**: 호출처 0[근거: autopilot-driver.ts:74,80,88]. G3 헤드라인 'cap 초과→자동 handoff' 미연결.
- **buildDelegationPacket는 prompt 권고일 뿐**: required_tools를 산문 서술만 하고 native subagent의 tools/disallowedTools frontmatter 미설정 — read-only reviewer가 Edit 호출해도 모델 순응에만 의존, **네이티브 CC subagent config보다 약함**[근거: autopilot-dispatch.ts:10-61].
- **네이밍 충돌**: buildDelegationPacket(6-section)과 context-packet.ts(.md)가 같은 'packet' 어휘; context-packet.md와 handoff.md가 둘 다 'pick this up' 산출물로 선후 불명.

**적대검증: CONTESTED(주장 약화).** "CC는 evidence-gated 루프를 전혀 못 하고 ditto만 한다" → **3/3 반박**. (1) subagent 중첩 불가는 ditto도 동일 제약, (2) ditto 실행 기반이 전부 CC 프리미티브(skill+Task 1-level+Stop hook+JSON)라 "CC cannot at all"은 거짓, (3) 진짜 게이팅 판단은 여전히 모델 산문, false-green floor는 빈/ack-only만 잡음. 실제 autopilot 4건 전부 happy-path(attempts=0). **→ "CC가 못 하는 능력이 아니라 CC 프리미티브 위의 결정론 규율 한 겹, 실패 경로 미검증."**

## 4. 충돌·회귀 목록 (심각도순)

1. **[높음·✓확인]** `completionEvidenceGate` 미배선 — "승인≠검증" 차단 런타임 무동작. note-only + 빈 verifications의 pass가 schema·게이트·Stop hook 전부 통과[gates.ts:182 호출처 0].
2. **[높음·✓확인]** handoff CLI가 completion.json clobber — local buildCompletion이 verifications:[] 하드코딩 무조건 덮어써 verifier 실증 evidence 소실[work-item-handoff.ts:132,282].
3. **[중간·실측]** classifyPromptAdvisory 한국어 오분류 — 한국어가 거의 항상 'execution', QuestionGate nudge·self-answer hint 죽음[user-prompt-submit.ts:17-23].
4. **[중간·실측]** PreToolUse secret-token false-positive — Bash 모든 토큰을 isSecretPath 검사해 'git log credentials.example', 'grep -r credential .', 'cat docs/credentials.md' 등 메타/문서 명령도 차단[pre-tool-use.ts:131-135]. *(이번 세션에 bun test/lint가 막혀 DITTO_SKIP_HOOKS=1 prefix 필요했던 것과 동류.)*
5. **[중간·실측]** VAGUE_TERMS substring 오탐 — testable AC를 bootstrap에서 잘못 차단.
6. **[중간·✓확인·해소 2026-06-02]** 죽은 코드/미런타임 — ~~buildContinuationSignal·nextReadyNodeId·ContinuationSignal 호출처 0(삭제, selectReadyNode 단수 포함)~~; ~~FailureDecision 'continue' unreachable(두 union에서 제거)~~; ~~e2e/knowledge 독립 CLI 미등록 → `ditto e2e run`·`ditto bridge knowledge` 배선~~. 배선 중 노출된 잠복 버그 2건 동반 수정: index.ts `await runMain`(미await 시 spawn 명령이 완료 전 exit 0), browser.ts lazy `runnerScriptPath`(compiled 바이너리 startup crash).
7. **[중간·해소 2026-06-02]** ~~NON_TERMINAL strong-block 우회 — 빈 autopilot.json 하나로 stop.ts:179 exit0~~ → pending-yield를 `hasPendingMutatingNode`로 가드(정당 승인대기 보존) + strong-block을 `isDegeneratePendingAutopilot`(pending ∧ mutating 노드 0)에도 발동하도록 확장. autopilot wi_26060206h 독립검증 707 pass(§5#7).
8. **[중간]** dialecticForcesContinuation verbatim-echo 취약 — synthesizer가 opponent.claim을 paraphrase하면 미해결로 읽혀 false-continuation.
9. **[낮음·해소 2026-06-02]** 광범위 fail-open — ~~session pointer 없는 세션에서 게이트 no-op이나 표면화 안 됨~~ → D3 결정대로 stop.ts의 session_id 부재 branch가 stderr 경고를 내보냄(비차단, exit 0). autopilot wi_260602nkj 독립검증 704 pass.
10. **[낮음·중복]** G1/G2가 CC 네이티브와 중복 — output-style/auto mode/subagent 격리가 이미 동일 방향. charter advisory 주입은 강제력 0+영구 토큰 비용.
11. **[낮음]** 자기선언 boolean — RiskAxes.non_local, reviewerOutput.different_provider, languageChange.agreed_with_user, decisionLedger.admissible 모두 schema 검증 불가.

## 5. 우선순위 수정 제안

| # | 문제 | 수정 | 기대효과 | 난이도 |
|---|---|---|---|---|
| 1 | completionEvidenceGate 미배선 | stop.ts 완료 게이트에 `completionEvidenceGate(completion)` 호출 추가(reasons 합류) + completion-contract superRefine에 'pass면 verifications>0 OR non-note evidence' 조항 | **G5** 핵심 약속 실현 | 낮음 |
| 2 | handoff가 completion.json clobber | handoff가 기존 completion.json READ해 verifications·remaining_risks 보존/merge, 또는 non-empty면 fail-loud. 두 buildCompletion을 completion-store로 통일 | **G5/G4** 증거 소실 방지 | 중간 |
| 3 | 한국어 프롬프트 오분류 | classifyPromptAdvisory에 한국어 의문 신호(까/나요/는가, 무엇/왜/어떻게) 추가, 최소 '한국어면 execution 단정 금지' | **G4/G1** 회귀 제거 | 낮음 |
| 4 | PreToolUse secret 오탐 | secret 토큰 차단을 노출 동사(cat/less/grep -·cp/scp/curl --upload) 컨텍스트로 한정, log/ls/git log 제외 | **G2/G5** 정상작업 차단 해소 | 낮음 |
| 5 | VAGUE_TERMS substring 오탐 | 단어 경계(\b) 매칭 전환 + 한국어 모호어(견고/적절히/제대로) 추가 | **G4** 정밀도 | 낮음 |
| 6 | ~~continuation signal 미배선~~ **[해소 2026-06-02]** | **죽은 export 삭제 채택**(사용자 승인): buildContinuationSignal·nextReadyNodeId·ContinuationSignal·selectReadyNode(단수) + 전용 테스트 제거. cap 초과→escalate→node fail→graceful stop 은 기존대로 유지(배선 불필요). | **G6** 부채 제거 | 중간 |
| 7 | ~~빈 autopilot.json 우회~~ **[해소 2026-06-02]** | pending-yield를 hasPendingMutatingNode로 가드 + strong-block을 degenerate pending autopilot에 확장 | **G3/G5** 종료 게이트 우회 차단 | 낮음 |
| 8 | dialectic verbatim-echo | objection에 안정 id 부여, synthesizer가 id로 해소 매칭(paraphrase 허용) | **G5** false-continuation 제거 | 중간 |
| 9 | 죽은/얇은 추상화 정리 | plan skill·dialectic-review skill·~~selectReadyNode(단수)~~ **(삭제됨, #6)**·FailureDecision.continue 제거/흡수 | **G6** comprehension debt↓ | 낮음 |
| 10 | ~~owner skeleton 미완~~ **[해소 2026-06-02]** | implementer/planner/researcher 본문에 You-do-not-receive·Procedure·You-return 추가(reviewer/verifier 수준), v0 skeleton 마커 제거, frontmatter·dispatch 코드 불변. You-return은 실제 계약 인용(recordResultPayload+G7·approvalGate+RiskAxes·evidenceRecord). autopilot(wi_260602rls) N1→N2→N3 독립검증 703 pass. | **G3** dispatch 품질 | 중간~높음 |

## 6. 냉정한 종합 판단

**순효과.** ditto는 CC가 "메커니즘은 주되 판단·증거·상태·검증은 정책 텍스트로만 남긴다"는 정확한 빈자리에, 결정론 게이트·schema-validated atomic store·노드 그래프 오케스트레이션·도구화된 drift 검사를 얹는다. 이 레이어는 **G3·G6에서 진짜 신규 가치**이고 문헌(EviBound 이중 게이트, Conductor 결정론 오케스트레이션, Anthropic 평문 하니스, 사전 정렬 우위)이 방향을 지지한다. 메커니즘은 vapor가 아니라 실재 코드, 전체 테스트 635 pass.

**가장 큰 리스크 — 과설계 vs 진짜 가치의 경계.** 세 신호가 겹친다. (1) **load-bearing 가드 미배선**: G5 강한 버전을 떠받칠 completionEvidenceGate가 코드 경로에 없어 "증거 없는 완료 차단"이 '정직하게 쓰인 산출물 한정 사후 정합 검사'에 그친다. (2) **실패 경로 미검증**: 실제 autopilot 실행이 전부 happy-path여서 cap-decision/retry/switch/false-green floor/dialectic 강제가 단위 테스트에서만 살아있고 실전 미발화 — 유지비용은 지금 내지만 부하는 안 받은 경로. (3) **CC 프리미티브 위의 한 겹**: 적대검증 4건 중 3건이 CONTESTED로 기운 핵심 이유는 ditto의 강제력이 모두 CC hook/Task/skill 위 payload이고 진짜 게이팅 판단은 여전히 모델 산문이라는 점. 차별점은 "CC가 못 하는 능력"이 아니라 "CC 위의 결정론 규율"이며, 그 규율의 실효성은 미배선·오탐·죽은 코드만큼 깎인다.

**무엇을 버리고 무엇을 강화할지.**
- **즉시 강화(낮은 비용·높은 효과)**: §5 #1(evidenceGate 배선)·#2(handoff clobber)·#3(한국어 분류)·#4(secret 오탐). 한 줄~소규모 수정으로 G5/G4 약속-실현 격차를 가장 크게 메운다. 특히 #1은 ditto 핵심 정체성("승인≠검증")을 코드로 되살리는 최우선.
- **버리거나 흡수**: plan skill, dialectic-review skill, buildContinuationSignal/nextReadyNodeId/selectReadyNode(단수)/FailureDecision.continue 등 죽은·얇은 추상화. '제거가 1시간이면 옵션, 1주면 부채' 원칙상 미배선 'autonomy glue'를 안고 가는 것이 곧 AX 부채.
- **재고**: G1/G2는 CC 네이티브와 중복이 커 charter advisory 주입을 더 얇게(또는 hook 강제로 전환)하지 않으면 토큰 비용만 영구 부담. fileOverlapGate·host-neutral 어댑터는 단일-driver/단일-host 현 시점에선 '오늘 필요한 문제'(헌장 4-3)를 넘는 선제 일반화 — 병렬 dispatch/멀티 host 실현 전까지 얇게 묶는 편이 낫다.

**결론**: ditto는 순수 CC보다 **장기 자율·증거 구조·AX에서 분명히 낫지만, 그 우위는 "설계된 보장"이지 아직 "전부 실현된 보장"이 아니다.** §5 #1~#4를 닫으면 G5의 강한 주장이 코드 위에 서고, 죽은 코드를 정리하면 과설계 인상이 준다. 그 전까지는 "메커니즘은 실재하나 핵심 한 조각이 미배선이고 실패 경로는 미검증"이라는 단서를 단 채로만 "낫다"고 말할 수 있다.

---

## 부록 — 독립 검증 (보고서 작성자 grep, 2026-06-02)

워크플로의 최강 주장 3건을 본 보고서 작성자가 저장소에서 직접 재확인:

| 주장 | 명령 | 결과 |
|---|---|---|
| #1 completionEvidenceGate 미배선 | `grep -rn completionEvidenceGate src/ tests/` | src 호출처 **0**(gates.ts 정의 1 + gates.test.ts 5). stop.ts:4 = `import { completionGate, convergenceGate }`만. **확정** |
| #2 handoff clobber | `grep -n "buildCompletion\|writeJson\|verifications" src/core/work-item-handoff.ts` | :106 local buildCompletion, :132 `verifications: []`, :282 무조건 `writeJson`. **확정**(이번 세션 실측 회귀의 구조적 원인) |
| #6 continuation 죽은 코드 | `grep -rn "buildContinuationSignal\|nextReadyNodeId\|ContinuationSignal" src/` | driver 정의부 외 호출처 **0**. **확정** → **2026-06-02 삭제 해소**(grep 0, 698 pass·lint clean) |

> 방법론 한계: 웹 인용 url 일부는 워크플로 에이전트가 수집한 것으로 본 보고서 작성자가 개별 재검증하지 않음(코드 근거는 재확인함). arxiv 미래 날짜(2604.xxxxx) 등은 에이전트 환각 가능성이 있어 url 자체보다 코드 근거를 우선 신뢰할 것.
