# HANNES 참고 하네스 분석 보고서 (DITTO 전신 — 계약 선행구현 · 도려낸 실패양식 · 회수 가능 자산)

## 분석 대상 및 기준

- 대상 저장소(로컬): `/Users/ecoletree/dev/project/boxwood-with-hannes`
- 성격: DITTO의 **직접 전신**. Claude Code 위에 "9-agent 7-stage 자가진화 사이클"을 구현한 제품 개발 하네스.
- 분석 시점 상태: registry 기준 closed project 37건, `lessons.jsonl` 132건, applied mutation 29건 누적(실제 dogfooding 흔적).
- 이하 `path:대상`은 위 로컬 경로 기준이며, 제품 저장소 폴더(`frontend`/`portal-backend`/`automation-engine`/`external-client`/`boxwood-packages`)는 하네스와 무관하므로 분석에서 제외했다.

**범위 한정(의도적).** 이 보고서는 HANNES 전체(bootstrap npm·recipe·21개 Python hook·wiki·measurement)를 감사하지 않는다. **DITTO 설계서가 필요로 하는 것**(`reports/design/ditto-claude-code-harness-design.md` §6 Core Contracts)을 렌즈로 삼아, (1) HANNES가 이미 dogfooding한 선행 구현과의 매핑, (2) DITTO가 의도적으로 도려낸 HANNES의 실패 양식, (3) v0 구현에서 회수 가능한 자산만 본다. MVP 공리에 따라 "DITTO가 차용·반면교사로 쓸 부분만" 조사한 결과다.

연계 문서: 메인 설계 [`reports/design/ditto-claude-code-harness-design.md`](../design/ditto-claude-code-harness-design.md), 상세 [`reports/design/contracts/deep-interview-contract.md`](../design/contracts/deep-interview-contract.md).

## 조사 방법

- HANNES의 헌장(`AGENTS.md`, 335줄), 프로젝트 한정 지침(`CLAUDE.md`), 9개 agent 정의(`.claude/agents/*.md`), 주요 command(`.claude/commands/hannes/{do,new,run,mutations}.md`), hook 설정(`.claude/settings.json`)을 정적으로 읽었다.
- 자가진화 상태(`.hannes/shared/registry.json`, `mutations/applied/*`)와 누적 규모(`lessons.jsonl`, mutations count)를 직접 셌다.
- 동작 테스트나 LLM 호출은 하지 않았다. verdict·anomaly·lesson id는 파일에서 직접 인용했다.

## 0. 한 줄 결론

**DITTO = HANNES − 자가진화 루프 − hook/배포 비대화 + 권위 단일화 + Convergence 쌍대 게이트 + Codex 모델 다양성.**

DITTO 설계서가 v0에 "필요하다"고 나열한 11개 계약(§6.1~6.11) 중 **10개는 HANNES에 이미 살아 돌아간 구현이 있다**. 따라서 DITTO는 greenfield 설계가 아니라 **HANNES의 재구성(리팩토링)** 이며, 신규 발상은 사실상 `ConvergenceContract`(§6.9) 하나에 집중돼 있다. 가장 큰 구현 레버는 HANNES 코드 포팅이 아니라, **HANNES가 비싸게 축적한 132개 lesson을 DITTO 게이트의 fixture로 회수**하는 것이다.

## 1. DITTO 계약 ↔ HANNES 선행 구현 매핑

| DITTO 계약 (§6) | HANNES 대응물 | 위치 | 성숙도 |
|---|---|---|---|
| `IntentContract` — 의도 보존·scope creep 금지 | `state.json.intent_anchor_sha256`/`intent_anchor_text` + Stage 0 crystallize + 헌장 §3-1 Ambiguity First | `commands/hannes/new.md`, `AGENTS.md:80` | 완성(anchor 해시로 drift 측정까지) |
| `QuestionGate` — self-answer 후에만 질문 | 헌장 §3-7 Decision Authority (절차 위임 질문 전면 금지, 욕구 차원만 허용, 우회 패턴 목록 명시) | `AGENTS.md:150-169` | 완성 |
| `DeepInterviewContract` | `interviewer` agent + `interview/SKILL.md` (ambiguity score, greenfield/brownfield 가중 공식, crystallize 게이트) | `.claude/agents/interviewer.md`, `.claude/skills/interview/SKILL.md` | **완성 — DITTO가 재발명 중인 것의 정답지** |
| `DelegationContract` + Context Isolation | `harness` agent "Fan-out & Context Isolation"(supervisor 가설 주입 금지, Task spec 원문만 전달) | `.claude/agents/harness.md` | 완성(문장 거의 동일) |
| `OneShotOrchestrationContract` — 임의 분할·축소 금지 | 헌장 **§3-0 Plan Integrity** + Autopilot Loop | `AGENTS.md:40-78` | **완성 — 가장 피로 배운 부분** |
| `DialecticDeliberationContract` — 생성/반대/합의 3역 | Stage 4 Consensus Gate = `planner`→`architect`→`critic`(4모드) | `.claude/agents/{architect,critic}.md` | 완성, 단 구조 차이(§3) |
| `EvidenceContract` | 헌장 §3-5 Evidence Over Assertion + verifier 7-Dim Verify Grid | `AGENTS.md:128`, `.claude/agents/verifier.md` | 완성 |
| `CompletionContract` | verifier verdict(ALL_PASS/PARTIAL_PASS…) + §3-0-d close 차단 | `.claude/agents/verifier.md`, `AGENTS.md:64-72` | 완성 |
| **`ConvergenceContract`** | **없음** (cap 기반 escalation만 존재) | `state.json.autopilot.{fix_attempts,redesign_attempts}` | **DITTO의 유일한 진짜 신규** |
| `HandoffContract` | `session_handoff.py`(PreCompact/Stop/SessionEnd 3곳) + `handoffs/` | `.claude/settings.json`, `.hannes/shared/handoffs/` | 완성 |
| `KnowledgeContract` | wiki + graphify + lessons | `.hannes/shared/{wiki,lessons.jsonl}` | 완성(오히려 과함) |

핵심: DITTO 설계서 §0의 "이것은 greenfield 설계가 아니다"(§3.3)는 기존 v0.1~v0.3 스키마뿐 아니라 **HANNES라는 살아 돌아간 선행 하네스 전체**를 가리키는 것으로 읽어야 한다.

## 2. DITTO가 의도적으로 도려낸 HANNES의 실패 양식

DITTO 설계서의 비목표(§2)·소유권 경계(§3.1)·위험표(§13)를 HANNES 실측치와 대조하면, 각 결정이 HANNES의 **구체적 병리에 대한 처방**임이 드러난다.

### 2.1 자가진화 루프(lesson→mutation) 전면 제외 — 가장 큰 절제

HANNES의 정체성은 README 첫 줄 "자가 진화하는 제품 개발 하네스"다. `lessons.jsonl` 132건 → `mutations/applied/` 29건의 lesson→mutation 승격 루프(`commands/hannes/mutations.md`)가 본체.

그런데 **DITTO v0 계약·Milestone(§6, §12) 어디에도 이 루프가 없다.** 이건 누락이 아니라 절제다. 근거:

- HANNES `registry.json`의 closed 37건 중 `hannes-cycle3`~`hannes-cycle9`, `cwd-guard-paths`/`cwd-guard-worktree-recognize`/`cwd-guard-worktree-cache-layer`(3연속), `mi-scope-fix`→`mi-scope-redesign` 등 상당수가 **제품이 아니라 하네스 자신을 고치는 작업**이다.
- `CLAUDE.md`에 "9 dogfood cycle 누적 후 self-referential 증식 비판(cycle 9 직후)"이 명시 lesson(`L-2026-05-01-retro-closing-note-induces-cycle-bloat`)으로 박혀 있다. 즉 HANNES 스스로 자기참조 증식을 병리로 인지했다.
- 헌장 335줄이 조항마다 근거 lesson id 각주를 달고 무한 성장 — 규칙이 실패를 흡수하며 커지는 구조.

DITTO는 "제품을 만드는 하네스"로 회귀하고 "자기를 고치는 하네스"를 v0에서 버렸다. **이것이 HANNES→DITTO 전환의 가장 중요한 전략적 결정.**

### 2.2 runtime/배포 모델 경량화

| 축 | HANNES | DITTO v0 |
|---|---|---|
| 설치 | `@ecoletree/hannes-bootstrap` npm + recipe + 6 repo clone + git init | 얕게 감싸지 않음(§3.1), local plugin install(`claude --plugin-dir`) |
| hook 수 | **21개** Python hook(`.claude/hooks/`) | **4개**(UserPromptSubmit/Stop/PreCompact/PostToolUse), 동작은 M1에 2개만(§13) |
| 상태 분리 | `.hannes/shared/` 거대 단일 영역 | `.ditto/work-items/<id>/` 작업 단위 격리 |

근거: HANNES 헌장 §3-2의 `lever-self-check`는 "`cost_gate` 200→1000 patch(commit cf59fb9) 후 사용자 정정으로 hard block 제거(commit e0769bd)"라는 hook 비대화 사건에서 역으로 만들어졌다. DITTO §3.1 "DITTO는 이 기능을 얕게 감싸지 않는다"는 이 양식의 직접 차단.

### 2.3 schema-first + 기존 재사용 강제

DITTO §3.3은 "새 status enum 만들지 않는다", "문서와 스키마가 다르면 스키마가 우선"을 못 박는다. HANNES `registry.json`에는 상태 모델이 사후 패치로 누더기 된 흔적이 남아 있다:

- `hannes-dogfood-v1`: `closed_at=2026-04-23T07:20:42Z < created_at=2026-04-23T08:00:00Z` (B-2 anomaly, "legacy-frozen"으로 동결).
- `state.json.stage`: `string|int` 하이브리드 union (정수 0~7 + `"pre"` sentinel), `new.md`에 "P2.5 이후 임시 hybrid"로 미봉책 명시.
- `mi-scope-fix`: `verdict_post_close_amendment`로 close 후 PARTIAL 정정 — 상태가 비가역이지 않았다.

DITTO §5.5 "`done`은 되돌릴 수 없다"는 이 비가역성 붕괴에 대한 처방.

### 2.4 Scope Authority 단일 표(§12)

HANNES엔 범위 권위의 단일 출처가 없어 헌장이 lesson을 흡수하며 무한 성장했다(현 DITTO repo git status의 "scope drift" 정리 커밋들이 그 후유증). DITTO §12는 §7.1/§9/§13/§14보다 우선하는 표 하나로 "무엇이 v0인가"를 (a)계약/skeleton ↔ (b)runtime 동작 두 축으로 못 박는다.

## 3. 두 가지 결정적 진전 (HANNES가 못 했거나 늦게 깨달은 것)

### 3.1 Convergence Contract — HANNES에 없던 유일한 새 발상

HANNES의 반복 종료는 `state.json.autopilot.{fix_attempts, redesign_attempts}` **카운트 기반 escalation**이다. DITTO §6.9는 방향이 반대인 **두 게이트의 교집합**으로 고정점을 정의한다:

- `CompletionGate`(§6.8): 모든 AC가 증거로 충족돼야 STOP/done — 조기 멈춤·거짓 done 차단.
- `ConvergenceGate`(§6.9): grounded·novel·admissible 반론이 있어야 CONTINUE — treadmill·트집 무한루프 차단.
- "**cap-reached ≠ converged**", 최선본 보존(ratchet), decision ledger(기각 반론 재제기 자동 각하), admissibility gate(criterion-linked 반론은 묵살 불가).

HANNES의 `PARTIAL_PASS`가 임의 축소를 완료로 위장한 P-9 사건(헌장 §3-0-d, `guard-boundary-aware`의 verdict=FAIL classification)은 *완료 게이트* 단독으로는 못 막는다 — DITTO는 그 쌍대인 *수렴 게이트*를 추가해 양방향으로 막는다. **설계서의 가장 독창적 기여.**

### 3.2 Codex-as-Opponent — HANNES가 닫은 뒤에야 발견한 교훈

HANNES Stage 4 critic은 전부 Claude opus(`.claude/agents/critic.md`의 `model: opus`, 동일 계열). 그런데 `registry.json`의 `mi-scope-fix`를 보면:

```
"verdict_post_close_amendment": {
  "amended_verdict": "PARTIAL — adversarial review (codex + critic) post-close 에서 두 BLOCKER 발견",
  "blockers": ["sequential subProcess MI chain shape assumption unverified",
               "sequential iteration isolation violation"],
  "succeeded_by": "mi-scope-redesign"
}
```

즉 HANNES는 모델 다양성의 가치를 **close 후 비싸게(재작업 1사이클)** 학습했다. DITTO §6.6은 이걸 설계에 내장 — Opponent를 **Codex 우선, Claude opus→sonnet fallback**으로 라우팅해 "같은 Claude 계열 공통 맹점"을 깬다. **HANNES의 가장 비싼 lesson이 DITTO의 기본 라우팅 정책이 됐다.**

## 4. v0 구현에서 회수 가능한 HANNES 자산

설계서가 명시적으로 활용하지 않지만, 가져오면 구현 비용이 크게 주는 것들:

1. **`lessons.jsonl` 132건 = DITTO 게이트의 기성 fixture/acceptance.** 자가진화 루프(§2.1)는 버리되 그 *산물*(검증된 실패 패턴)은 회수할 가치가 있다. 직결 예:
   - `L-20260515-partial-user-response-treated-as-full-delegation`(침묵=pending, 위임 아님) → DITTO `QuestionGate`(§6.2) fixture.
   - `L-20260513-plan-integrity-anchor`(Tidy First 오용 + 임의 축소) → `OneShotOrchestrationContract`(§6.5) fixture.
   - `L-20260515-structural-fix-over-incremental-raise`(lever 자체가 wrong인가 self-check) → 코드 품질 원칙(§11) fixture.

2. **interview ambiguity scoring 공식.** DITTO `contracts/deep-interview-contract.md`가 "how"를 새로 쓰는 중인데, HANNES `interview/SKILL.md`의 greenfield/brownfield 가중 공식(`1 - (goal×0.40 + constraints×0.30 + criteria×0.30)` 등)과 crystallize 게이트가 검증된 정답지다.

3. **`llm_judge_stop.py`** — DITTO Stop gate(완료/질문/handoff 판정, §7.2)의 직접 선행 구현. LLM이 stop을 막는 메커니즘의 prior art.

4. **§3-0-d close-blocking 로직** — "임의 축소 정황 포착 시 PASS 종료 금지, cancel/deactivate만 허용"은 DITTO `CompletionGate`가 "scope 축소 시 `out_of_scope` 근거 필수"(§6.8)로 요구하는 것의 enforcement 설계 그대로다.

## 5. 결정론 vs 판단: Python 과다의 진짜 진단

HANNES가 hook·script를 Python으로 과하게 작성해 유지보수가 어려웠다는 체감은 정확하다. 다만 근본 원인은 **분량**이 아니라 **판단(judgment)을 결정론 코드에 넣은 것**이다.

### 5.1 hook 21개 triage

| 구분 | hook | 판정 |
|---|---|---|
| **(A) 결정론이 맞음** | `validate_tasks_schema`, `task_lock`, `git_init_guard`, `journal_append`, `_atomic_io`, `cwd_guard`(경로), `commit_isolation` | 정답이 하나뿐 — 코드에 있어야 함. 여기서 얻는 일관성은 순수 이득 |
| **(B) 판단을 코드로 굳힘** | `intent_detect`(키워드 분류), `cost_gate`(임계치 200), `output_rule_check`(정규식), `stop_progression` | 맥락 의존 판단을 작성 시점 휴리스틱으로 동결 → 새 케이스마다 코드 수정→mutation→cycle |

(B)의 비용 구조가 §2.1의 cycle3~9 자기참조 증식과 직결된다. `cost_gate 200→1000→제거`(헌장 §3-2 lever-self-check) 사가가 표본 — 임계치 200은 *얼어붙은 판단*이라 현실과 어긋날 때마다 코드 패치를 요구했다. `/hannes:do`의 4-category 키워드 라우터(`do.md`)도 같은 양식: LLM 판단이어야 할 분류를 키워드 표로 얼려 상시 튜닝 대상이 됐다.

결정적 증거: HANNES는 결국 `llm_judge_stop.py`를 만들었다. "언제 멈출지"를 Python 휴리스틱으로 못 잡으니 hook 안에서 LLM을 호출한 것 — **시스템이 스스로 "이 판단은 LLM 몫이었다"고 자백한 셈.**

### 5.2 반론: 결정론을 버리면 HANNES가 유일하게 잘한 걸 잃는다

판단을 전부 프롬프트로 옮기면 게이트가 무력화된다. 완료 게이트를 프롬프트로 두면 모델이 말로 우회한다("이 정도면 됐다"). HANNES의 evidence-only completion이 작동한 건 일부가 *기계적으로 강제*됐기 때문이다. 따라서 **바(bar)는 결정론으로 박고, 무엇이 바를 넘는지는 LLM이 판단**해야 한다. LLM 판단도 안정된 선언적 기준(acceptance criterion)에 묶으면 유연하면서 일관된다 — 일관성은 코드가 아니라 *앵커*에서 온다. "일관성 vs 유연성" 트레이드오프는 앵커를 코드가 아니라 스키마/기준에 두면 양립한다.

### 5.3 3층 분리 (HANNES "훅은 집행, 프롬프트는 판단"의 정정)

HANNES `harness.md`엔 이미 "훅은 집행, 프롬프트는 판단"이 적혀 있다. HANNES의 실패는 자기 원칙 위반 — 판단을 hook에 넣고(B), 동시에 스키마 층이 약했다(`state.json` B-2 anomaly, `string|int` hybrid). 처방은 "코드를 줄이자"가 아니라 **층을 가르자**다.

| 층 | 무엇 | HANNES | DITTO |
|---|---|---|---|
| 1. 선언적 스키마 (바 정의) | 계약·기준. 결정론이되 *데이터*지 코드 아님 | Python validator + 별도 JSON schema가 drift | Zod 단일 소스 `src/schemas/*.ts` |
| 2. 얇은 결정론 glue | 라우팅·IO·lock·schema 검증 | hook 21개(판단까지 흡수) | hook 4개, fail-open·advisory(§7.2) |
| 3. LLM 판단 | 모호성·증거 충족·admissibility 등 맥락 전부 | 일부 (B)로 코드 누출 | skill/agent 프롬프트 |

### 5.4 언어: Python → TS/JS

DITTO 설계는 이미 이 방향이다 — hook이 `.mjs`(§7.1), 계약이 `src/schemas/*.ts` Zod(§3.3). HANNES의 Python hook/script + 별도 JSON schema 조합은 둘 사이 drift와 유지보수 비용을 낳았다. TS/JS 통일의 이득은 언어 취향이 아니라 **schema가 곧 단일 타입 소스가 되어 1층 drift를 타입 시스템이 막는다**는 것. 단 언어 선택은 부차적이고 본질은 §5.3의 판단 배치다 — TS/JS 통일은 그 배치를 단일 타입 시스템 안에서 강제하는 수단일 뿐이다.

**설계 명제:** 코드는 바를 강제하고, LLM은 무엇이 바를 넘는지 판단한다. 판단을 코드에 얼리면 그게 mutation cycle을 부른다.

## 6. DITTO 설계서에 대한 시사점(actionable)

- **§15 "다음 구현 후보" 6개의 fixture 출처를 HANNES lessons로 지정**하면 fixture 작성 비용이 준다(특히 QuestionGate·OneShot·Completion·Convergence).
- **`ConvergenceContract`만 HANNES 선행구현이 없으므로 설계 검증 우선순위 최상위**다. 나머지 10개는 HANNES에서 "이미 동작했다"는 사실이 일종의 사전 evidence.
- **Codex-as-Opponent(§6.6) 라우팅은 HANNES `mi-scope-fix` 사례를 acceptance 근거로 인용** 가능 — "모델 다양성이 동일계열 맹점을 잡는다"는 가설에 대한 실측 사례.
- **§5(결정론 vs 판단 층위, TS/JS 통일)를 메인 설계서 §11 코드 품질 원칙에 반영** — HANNES hook triage가 "판단을 코드에 얼리면 mutation cycle을 부른다"의 실측. DITTO hook은 얇은 glue로, 판단은 skill/agent로, 바 정의는 Zod schema로 둔다.
- **HANNES `harness` 오케스트레이터 패턴을 DITTO `orchestrator` 에이전트로 채택** — 설계서 §7.4 subagent 표에 worker(researcher/planner/…)만 있고 conductor(드라이버)가 없던 구멍을 메움. one-shot graph의 노드 dispatch·실패 분류·재시도/전환/에스컬레이트 *판단* 주체(메인 설계서 §6.5, §7.4). 오케스트레이션 층은 provider agent loop 재구현이 아니라 그 위에 얹는 기능 추가로 본다(§2 비목표 #1 명확화). 단 content 생성 금지(판단·dispatch만), 그래프 상태는 schema, 루프 지속은 Stop hook으로 §5 3층 분리를 유지.

## 7. 한계와 미조사 영역

- HANNES hook 21개의 개별 동작(특히 `cwd_guard`·`stop_progression`·`llm_judge_stop`)은 코드 수준으로 읽지 않았다. DITTO Stop/PreCompact hook 구현 직전에 `llm_judge_stop.py`/`session_handoff.py`는 코드 수준 추가 조사 권장.
- `lessons.jsonl` 132건의 계약별 분류는 본 보고서 범위 밖이다(별도 작업 후보).
- HANNES wiki/graphify/measurement 서브시스템은 DITTO `KnowledgeContract`(§6.11)가 post-v0(M6)이므로 의도적으로 생략했다.
