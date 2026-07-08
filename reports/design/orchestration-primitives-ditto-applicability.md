# Claude Code 오케스트레이션 프리미티브의 ditto 적용성 조사

- work item: wi_2607082xk (조사·설계 리포트)
- 일자: 2026-07-08
- 성격: **설계 조사 리포트 (drift 대상, 권위 아님 — §4-11).** 방향이 채택되면 ADR로 승격한다. 사실 근거는 코드·계약·아래 인용 문서.
- 조사 근거: Claude Code 공식 문서(`code.claude.com/docs/en/{sub-agents,agent-teams,workflows,agents,headless}`, 2026-07-08 fetch) + ditto 코드베이스 매핑(서브에이전트 2건 병렬 위임). ADR-0016(dual-host)·ADR-0018(선택적 도구 우아한 강등).

---

## 0. 요약 (TL;DR)

동기: 메인 에이전트가 fan-out 오케스트레이션의 드라이버를 겸하면서 서브에이전트 반환을 자기 컨텍스트에 적재 → context rot("관제탑이 화물도 검사"). 이걸 오케스트레이션을 메인 밖으로 빼서 줄일 수 있나?

판정 3줄:

1. **네 프리미티브(subagents·agent teams·dynamic workflows·headless) 전부 Claude-Code / Anthropic Agent SDK 전용이다.** Codex 등 비-Anthropic 호스트에는 없다. 유일한 크로스-호스트 계약은 **MCP**. → dual-host 의무가 있는 ditto 실행 표면(autopilot·coverage sweep·deep-interview 등)은 이들에 **하드 의존 불가**(ADR-0016).
2. 그렇다고 못 쓰는 건 아니다. **ADR-0018(우아한 강등)** 방식으로 "Claude Code 한정 가속기 + 강등"이면 채택 가능. 단, 강등 대상이 *도구*가 아니라 *오케스트레이션 자체*면 이중 구현을 유지하게 되어 비용이 크다(§5).
3. 가장 큰 이득은 CC-전용 프리미티브가 아니라 **호스트 이식 가능한 두 레버**에서 나온다: ① **compact-return 규율**(owner가 산문 대신 요약+디스크 아티팩트를 반환) ② coverage sweep에 **nested subagents(v2.1.172)** — workflows보다 나은 fit(같은 Task 프리미티브, Codex엔 flat fan-out으로 자연 강등, 이중 구현 없음).

권고 우선순위: **① compact-return 규율(포터블·최대 레버·지금) → ② nested-subagent로 coverage sweep offload(CC 가속기·강등) → ③ workflows/agent-teams는 좁은 적용 또는 보류.**

---

## 1. 프리미티브 사실 + 결정적 이식성 판정

각 프리미티브의 핵심(전부 문서 원문 인용 근거):

| 프리미티브 | 오케스트레이션/컨텍스트 | 중첩 | 반환 | 중간 사용자 개입 | 호스트 |
|---|---|---|---|---|---|
| **Subagents** (Task, `.claude/agents/*.md`) | 각자 독립 컨텍스트; 결과는 caller로 돌아옴 — "results return to your main conversation" | **가능(v2.1.172+)**: "a subagent can spawn its own subagents", depth 5 cap, "Only the top-level subagent's summary returns" | **요약만** — "the verbose output stays in the subagent's context while only the relevant summary returns". 단 "many subagents that each return detailed results can consume significant context" | **불가** — `AskUserQuestion` 등이 서브에이전트에서 stripped. permission prompt만 버블업 | **CC 전용** (Codex 미언급, `CLAUDE_CODE_*`·버전 게이트) |
| **Agent teams** | lead가 조율, teammate 독립 컨텍스트, 상태는 공유 task list+mailbox | **불가** — "No nested teams: teammates cannot spawn their own teammates" | mailbox 메시지 + lead가 synthesize | **가능** — teammate가 lead(라이브 세션)에 plan approval 요청, 사용자가 승인 | **CC 전용 + 실험적** — `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, "disabled by default" |
| **Dynamic workflows** | JS 스크립트가 루프·분기·중간결과 보유 → "Claude's context holds only the final answer" | 워크플로 중첩 = **UNSTATED**(문서는 "run each stage as its own workflow"로 대체 권장). agent 16 동시/1000 총 cap | **최종 답만** — "one report at the end instead of a turn-by-turn transcript" | **불가** — "No mid-run user input… For sign-off between stages, run each stage as its own workflow" | **CC 전용** — "require Claude Code v2.1.154+", paid plans, Anthropic providers |
| **Headless `claude -p`** | Agent SDK를 CLI로; 서브에이전트/워크플로 spawn·대기 | subagent depth-5 동일 | `--output-format text\|json\|stream-json` | **불가**(비대화) — 권한은 플래그로 | **CC 전용** — `claude` 바이너리 자체(Codex는 `codex`) |

**이식성 판정(결정적):** 문서 어디에도 Codex/비-Anthropic 호스트 지원 언급이 없다. 넷 다 "workers are Claude sessions"이고 프로토콜 수준(host-agnostic)이 아니다. **비-Anthropic 호스트에 이식 가능한 오케스트레이션 프리미티브는 없다. 크로스-호스트 계약은 MCP뿐.** ("To involve a different tool, expose it to Claude as an MCP server.")

정정(정직): 이전 대화에서 "서브에이전트는 서브에이전트를 못 띄운다"고 단언했는데, **v2.1.172부터 중첩이 가능**하다(depth 5). autopilot 스킬의 D3 주석("a subagent cannot spawn the stage subagents", `skills/autopilot/SKILL.md:9`)은 그 premise가 이제 CC에선 outdated다. 단 이 중첩도 CC 전용이라 dual-host 결론은 불변. 즉 **"드라이버는 메인이어야 한다"는 절대 플랫폼 제약이 아니라 dual-host 이식성 제약으로 재분류**된다.

---

## 2. ditto fan-out 표면 지도 (main-context 누적 순위)

메인 에이전트가 드라이버를 겸하며 반환이 컨텍스트에 쌓이는 표면 전수(코드 매핑):

| 순위 | 표면 | fan-out (회당) | 결과가 메인 컨텍스트에? | 중간 사용자 게이트 | 호스트 의무 |
|---|---|---|---|---|---|
| **1** | **Coverage sweep** (plan-stage far-field, autopilot 내부 중첩) | wave 노드당 sweepAngles(1/3/5)+3-role dialectic+6 axis judge ≈ 10–14, **× N 노드 × K라운드** | 부분 — 구조 신호만 수집(전문 아님)하나 라운드 누적 큼 | 없음(자율; design 노드 승인 게이트만) | **둘 다** (opponent host-aware) |
| **2** | **Autopilot 드라이버 루프** | 노드당 owner 1(또는 wave 병렬), 그래프 전체 수십 spawn | **전부(full `result_text` verbatim, `autopilot-loop.ts:1025,1317`)** — 최고 충실도 누적 | **있음**(present_plan/blocked/rollback) | **둘 다** (ADR-0016) |
| **3** | **Deep-interview** | 라운드당 N generator+1 gate+critical당 1 reviewer, × 라운드 | 있음(pool+all_scored) | **있음**(AskUserQuestion) | 둘 다 |
| 4 | **Classify** | 문서당 1 서브에이전트(수십 가능) | 부분 — 작은 결정 봉투만(wide-but-shallow) | 없음 | host-agnostic |
| 5 | **Dialectic** | 3역 × max_rounds(기본1) | 있음(전 역할 산출 full, 소량) | 없음 | 둘 다(host-aware 중심) |
| 6 | memory build --semantic | 20–25파일당 extractor 1(다수 청크) | 부분/디스크(IR 조각 결정론 병합) | 없음 | 둘 다 |
| 7 | prism opponent seam | critique cap 3 + dissent 1 | 있음(텍스트 반환) | 없음 | seam host-aware, but prism v1 **CC 전용** |
| 8–10 | e2e / e2e-author / verify / knowledge-update | 단일 spawn(fan-out 아님) | 미미 | 일부(e2e-author 대화) | 둘 다 |

**최악 = coverage sweep(#1)**, 그다음 **autopilot(#2)**. 나머지는 얕거나(classify) 작거나(dialectic) 대화 필수(deep-interview).

정직한 보정: #1의 "50–100 에이전트/3.8M tok"는 **batching 이전** 수치다. far-field 일괄-refute 재설계(wi_260623uap, memory `far-field-relevance-gate`)가 이미 ~92% 절감(≈13 에이전트/0.65M)했다. 따라서 #1의 잔여 누적은 headline보다 작고, 추가 offload의 한계 이득도 그만큼 작다 — "이미 한 번 공격당한 표면"임을 감안할 것.

---

## 3. 적용성 판정 — 표면 × 프리미티브

핵심 제약 3개로 필터: (A) dual-host 의무 → CC-전용 프리미티브 하드 의존 불가, (B) 중간 사용자 개입 필요 → workflows 실격, (C) 강등 대상이 오케스트레이션이면 이중 구현 비용.

| 표면 | workflows | agent teams | nested subagents | compact-return(프리미티브 아님) |
|---|---|---|---|---|
| Coverage sweep #1 | ✗ 이중 구현(C) | ✗ 실험적+이중 구현 | **△ 최적 후보** — 같은 Task, Codex엔 flat fan-out 강등 | ○ 보완적 |
| Autopilot #2 | ✗ 중간 게이트(B)+이중 구현(C) | ✗ 실험적 | ✗ 드라이버 전체를 서브로 = Codex 이중 구현 | **◎ 최대 레버·포터블** |
| Deep-interview #3 | ✗ 대화 필수(B) | △ lead 대화 가능하나 실험적+CC전용 | ✗ 대화 stripped | ○ 보완적 |
| Classify #4 | △ 비대화·배치형 fit이나 얕아서 이득 작음 | ✗ | △ | ○ |
| Dialectic #5 | ✗ 소량 | ✗ | ✗ | ○ |
| prism opponent #7 | △ (이미 CC전용이라 강등 twin 불필요) but 소량 | ✗ | △ | ○ |

기호: ◎ 강력 추천 / ○ 추천 / △ 조건부·저이득 / ✗ 부적합.

---

## 4. 왜 workflows가 ditto 실행 표면에 나쁜 fit인가

workflows의 강점(오케스트레이션을 메인 밖 스크립트로, 최종 답만 반환)은 네 control-tower 이상과 정확히 일치한다. 그런데 ditto에 얹으면 세 벽에 부딪힌다:

1. **dual-host(A).** coverage sweep·autopilot은 Codex에서도 돌아야 한다. workflow는 CC 전용이므로 Codex용 subagent-loop을 **따로 유지** → 같은 오케스트레이션 로직 2벌.
2. **이중 구현 = ADR-0018이 이미 기각한 것(C).** ADR-0018 대안(d)("도구마다 동등 대체를 영구 유지")를 **기각**했다. 강등이 깨끗한 건 대상이 *리프 도구*(CodeQL 있으면 쓰고 없으면 게이트 inert)일 때다. 대상이 *오케스트레이션 자체*면 강등 = 오케스트레이터 2벌 유지 = 바로 그 기각된 부담. workflow-as-accelerator는 이 함정에 빠진다.
3. **중간 사용자 개입(B).** autopilot·deep-interview는 실행 도중 사용자에게 멈춰 묻는다(승인·질문). workflow는 "No mid-run user input". 스테이지별 워크플로로 쪼개면 되지만, 그건 autopilot의 ReAct 루프를 스테이지 경계마다 끊어 재구성하는 대공사다.

결론: **workflow는 "dual-host 의무 없고 + 비대화 + 배치형"인 표면에만 fit.** ditto의 무거운 표면은 대개 이 셋 중 하나를 위반한다.

---

## 5. 왜 nested subagents가 더 나은 fit인가 (coverage sweep 한정)

coverage sweep(#1)의 문제는 wave 노드당 fan-out(angle+dialectic+judge)이 **메인**에서 터진다는 것. v2.1.172 중첩을 쓰면:

- 드라이버가 wave 노드마다 **중간 sweep-subagent 1개**를 띄우고, 그 subagent가 angle/dialectic/judge를 자기 컨텍스트에서 fan-out → **top-level 요약만 메인으로 반환**. 라운드 누적이 메인에서 사라진다.
- **같은 Task 프리미티브**라 별도 오케스트레이터 언어(JS) 도입 없음.
- **Codex 강등이 자연스럽다**: 중첩 미지원이면 현행 flat fan-out으로 폴백 — 로직 2벌이 아니라 "한 레벨 접기/펴기" 차이. §4의 이중 구현 함정을 피한다.

주의: 이건 CC 가속기이므로 ADR-0018 D1/D2를 따라 강등을 **가드로** 보장해야 한다(부재 시 flat fan-out, 완료 판정 불변). 그리고 §2 보정대로 이미 batching으로 최적화된 표면이라 **한계 이득이 크지 않을 수 있다** — 착수 전 현행 실측(라운드당 실제 spawn 수·토큰) 필요.

---

## 6. 가장 큰 레버는 프리미티브가 아니다 — compact-return 규율

autopilot(#2)의 누적 근원은 owner가 **full `result_text`를 verbatim 반환**하고 드라이버가 통째 삼키는 것(`autopilot-loop.ts:1025,1317`; 앞서 본 console2.txt 36줄 산문이 실례). 이미 owner-return envelope에 `summary`(유일 적재 슬롯)+`artifact_location`(bulk는 디스크)이 있는데(`agents/implementer.md:30-33`), **강제되지 않아** owner가 산문을 뱉는다.

레버: owner의 **최종 메시지 자체**를 compact 신호(요약+디스크 포인터)로 강제(반환 크기 게이트, 또는 envelope 필수화). 그러면:
- 프리미티브 도입 0, **두 호스트 다** 적용, autopilot·deep-interview·dialectic 전부에 즉시 효과.
- 네 control-tower 이상의 실질적 핵심("관제탑은 화물 명세서가 아니라 트랜스폰더 핑만 받는다")을 CC-전용 기능 없이 실현.

이게 우선순위 1인 이유: 최저 비용, 최대 커버리지, 완전 이식, 기존 스키마가 이미 절반 깔아놓음.

---

## 7. 후속 work item 후보 (착수는 별도 승인)

1. **compact-return 강제** (포터블, 최우선) — owner 최종 반환을 요약+아티팩트로 조이는 게이트. envelope 필수화 or 반환-크기 검출. 영향: autopilot·deep-interview·dialectic. *heavy(계약·가드 변경).*
2. **coverage sweep nested-subagent offload** (CC 가속기+강등) — wave 노드 sweep을 중간 서브에이전트로 위임, Codex flat 폴백, ADR-0018 가드. **선행: 현행 실측**으로 한계 이득 확인. *heavy.*
3. **workflow 좁은 적용 탐색** (저우선) — dual-host 의무 없고 비대화·배치형인 ditto 개발자-편의 작업이 실제 있는지 식별(예: repo 전역 감사 헬퍼). 없으면 폐기. *조사.*
4. **agent teams: 보류·관찰** — 실험적 플래그 해제 전까지 채택 안 함. 재검토 조건: GA + dual-host 지원.

방향이 정해지면 ADR로 승격(§4-11): "CC-전용 오케스트레이션 프리미티브는 ditto 실행 표면의 substrate가 아니라 ADR-0018 하의 선택적 가속기로만 채택한다"가 후보 결정문.

---

## 8. 정직한 미검증·한계

- 프리미티브의 Codex 미지원은 **문서 부재로 추론**(문서가 명시 부정한 게 아니라 언급이 없음). 방향은 일방향·결정적이나 "명시 확인"은 아님.
- coverage sweep 한계 이득은 **실측 안 함** — #2 착수 전 현행 라운드당 spawn/토큰 측정 필요.
- nested-subagent depth-5 cap이 autopilot(자신이 이미 owner를 spawn) 안에서 coverage sweep을 또 중첩할 때 깊이 예산에 걸리는지 **미검증** — autopilot 드라이버가 메인(depth 0)이면 sweep-subagent(1)+angle(2)로 여유 있으나, 실제 depth 회계 확인 필요.
