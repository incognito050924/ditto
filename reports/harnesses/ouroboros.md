# ouroboros 참고 하네스 분석 보고서 (구현 참조 — 의도 정렬 · 모호성 측정 · 온톨로지)

## 분석 대상 및 기준 커밋

- 대상 저장소: `https://github.com/Q00/ouroboros`
- 로컬 분석 경로: `/tmp/ouroboros-analysis`
- 기준 커밋: `d47b14314e23ee2b898b42d830ce516e723c2267`
- 이하 모든 `repo-relative/path:line` 근거는 위 기준 커밋을 기준으로 한다.

**범위 한정(의도적).** 이 보고서는 ouroboros 전체(CLI, plugin, team, TUI, MCP, sandbox)를 감사하지 않는다. DITTO 계약 구현에 직접 재사용 가능한 **두 서브시스템만** 코드 수준으로 본다: (1) 자율 Socratic 인터뷰 + 모호성 측정 + 품질 게이트(`src/ouroboros/auto/*`, `src/ouroboros/core/seed*`), (2) 온톨로지 분석 프레임워크(`src/ouroboros/core/ontology_*`, `src/ouroboros/agents/ontolog*`). 이는 MVP 공리에 따라 "DITTO가 차용할 부분만 조사"한 결과다.

연계 설계문서: [`reports/design/contracts/deep-interview-contract.md`](../design/contracts/deep-interview-contract.md), 메인 §6.1/§6.2/§6.3/§6.8/§6.9/§6.11.

## 조사 방법

- 저장소를 임시 경로에 `--depth 1` 클론하고 `git rev-parse HEAD`로 기준 커밋을 확정했다.
- `auto/interview_driver.py`, `auto/grading.py`, `auto/ledger.py`, `auto/gap_detector.py`, `core/seed.py`, `core/ontology_aspect.py`, `core/ontology_questions.py`, agent 프롬프트(`agents/socratic-interviewer.md`, `agents/ontologist.md`, `agents/ontology-analyst.md`, `agents/semantic-evaluator.md`)를 정적으로 읽었다.
- 동작 테스트나 실제 LLM 호출은 하지 않았다. 점수 공식과 게이트 임계치는 코드 상수에서 직접 인용했다.

## 핵심 메커니즘

### 1. 모호성 측정은 2계층이고, 코드 바닥이 LLM 자기보고를 누른다

ouroboros는 ambiguity를 **두 출처**로 측정한 뒤 **보수적으로 결합**한다.

- LLM(인터뷰 backend)의 의미적 ambiguity 자기보고: `InterviewTurn.ambiguity_score`(`auto/interview_driver.py:44-48`). 단, 드라이버는 **여기에 게이트하지 않는다** — blocker 메시지 작성용 진단 표면일 뿐이라고 주석으로 못 박는다.
- 코드가 객관적으로 계산하는 결정론적 바닥 `deterministic_floor(ledger)`(`auto/grading.py:401-425`):
  - `0.05 × 열린 필수 섹션 수` (gap pressure)
  - `+ 0.10 × 활성 CONFLICTING 엔트리 수` (contradiction pressure)
  - `+ 0.05 × (assumption_only 섹션 / 전체 필수 섹션)` (evidence dilution)
  - `[0,1]`로 clamp.
- 파이프라인은 `max(llm_reported_score, deterministic_floor(ledger))`를 채택한다(`auto/pipeline.py:642-651`). **LLM은 코드가 측정 가능한 수준 아래로 모호성을 과소보고할 수 없다.**

> DITTO 시사점: 이것은 메인 §0 제1원칙("백킹 없는 생성을 행동으로 전환되기 전에 무력하게")의 구체적 구현이다. 모델의 readiness 자기평가를 그대로 믿지 않고, 구조적으로 측정 가능한 모호성 바닥을 코드로 강제한다.

### 2. 이중 합의 종료 게이트 (semantic ∧ structural)

인터뷰는 **두 판정자가 같은 턴에 동의할 때만** 닫힌다(`auto/interview_driver.py:204-227`).

- backend(의미적 ambiguity 모델)가 `seed_ready/completed`이고 **동시에**
- 드라이버측 ledger(구조적 완전성)가 `is_seed_ready()`일 때만 → `seed_ready` 반환.

어느 한쪽만 done이면 종료하지 않고 **다음 답변으로 재구성**한다:

- backend는 done인데 ledger gap이 남음 → 첫 gap을 답해 backend가 실질 내용으로 재채점하게 한다. **일방적 종료를 절대 받지 않는다.** 단 `goal` 누락 또는 CONFLICTING/BLOCKED gap이면 즉시 blocker(`auto/interview_driver.py:232-270`).
- backend는 계속 묻는데 ledger는 꽉 참 → 정상 답변 지속.

`max_rounds`(기본 12, `auto/interview_driver.py:104`)가 유일한 예산이다. 캡 소진 시:

- backend∧ledger 동의 → `seed_ready`.
- ledger만 done(backend가 stylistic ambiguity로 거부) → `ledger_only` closure(구조적 완전성이 우선, 비차단 advisory, `auto/interview_driver.py:496-515`).
- 안전 기본값으로 닫을 수 있는 gap만 남음 → `safe_default` closure + synthesis를 transcript에 push, 실패 시 **롤백**(`auto/interview_driver.py:398-485`).
- 안전하지 않은 gap이 남음 → **blocked**, 부분 기본값 롤백(`auto/interview_driver.py:516-555`).
- closure mode는 `mutual_agreement | ledger_only | safe_default` 세 값으로 기록(`auto/state.py:378-379`).

> DITTO 시사점: 메인 §6.8 CompletionGate × §6.9 ConvergenceGate의 **쌍대 게이트가 코드로 이미 존재**한다. `cap_reached ≠ converged`도 그대로다. "두 게이트 동시 만족이 곧 done"이라는 §6.9 정의가 ouroboros의 `backend_done AND ledger_done`과 정확히 동형이다.

### 3. Seed Draft Ledger — provenance가 타입이다 (source × status)

모호성 측정의 기반은 출처·신뢰도가 타입으로 박힌 ledger다(`auto/ledger.py`).

- **필수 섹션 10개**(`auto/ledger.py:57-68`): `goal, actors, inputs, outputs, constraints, non_goals, acceptance_criteria, verification_plan, failure_modes, runtime_context`. — 이것이 ouroboros의 "모호성 차원" 고정 집합이다. `failure_modes`(=pre-mortem)와 `verification_plan`이 필수에 포함된다.
- **source enum**(`auto/ledger.py:11-21`, 우선순위 `:40-47`): `user_goal, repo_fact, existing_convention, user_preference, non_goal, conservative_default, inference, assumption, blocker`. 동일 키 충돌은 source 우선순위 → confidence → 동률이면 CONFLICTING으로 남겨 드라이버가 차단(merge를 발명하지 않음).
- **status enum**(`auto/ledger.py:25-34`): `missing, weak, confirmed, conflicting, blocked, defaulted, inferred`.
- **evidence-backed vs assumption-only**(`auto/ledger.py:71-103`): 사용자 발화·repo·관례·선호·명시적 non-goal에 anchor된 것만 evidence-backed. INFERENCE/ASSUMPTION은 `assumption_only_sections`로 분리해 "시스템이 대신 가정한 것"과 "사용자/repo가 확인한 것"을 구분한다.
- `open_gaps()` = `{missing, weak, conflicting, blocked}` 섹션, `is_seed_ready()` = open_gaps 없음(`auto/ledger.py:404-416`).

> DITTO 시사점: 메인 §6.9 정직 라벨(*정체*/*확신*/*상태*, finding vs hypothesis)이 ouroboros에서는 source×status 타입으로 구현된다. INFERENCE/ASSUMPTION = `hypothesis`, evidence-backed = `finding`. DITTO의 `interview-state.json` dimension `state`(unknown/partial/resolved)에 source/status 차원을 더하면 정직 라벨이 스키마로 강제된다.

### 4. GradeGate A/B/C — 실행 전 결정론적 차단 + 검증가능성 기계 판정

`GradeGate`(`auto/grading.py:109-296`)는 B/C 등급 Seed의 실행을 막는다.

- ledger 채점(`grade_ledger`)과 seed 채점(`grade_seed`) 모두 `coverage, ambiguity, testability, execution_feasibility, risk` 5점수를 낸다.
- **A등급(may_run) 조건**(`auto/grading.py:277-296`): blocker 0 AND `coverage≥0.90 AND ambiguity≤0.20 AND testability≥0.85 AND execution_feasibility≥0.80 AND risk≤0.25 AND findings 없음`.
- Seed의 `ambiguity_score > 0.20`이면 high blocker(`auto/grading.py:164-173`). 동일 임계가 `core/seed.py:151`(`SeedMetadata.ambiguity_score` 기본 0.15, `ge=0, le=1`)과 결합.
- **검증가능성 기계 판정**: acceptance criterion이 `VAGUE_TERMS`(easy/intuitive/robust/scalable/better/...) 포함이면 vague finding(`auto/grading.py:23-33, 195-204, 352-354`), `_OBSERVABLE_HINTS` + 정규식 패턴(명령·exit code·stdout·HTTP 2xx·테스트 통과 등)에 안 걸리면 untestable finding(`auto/grading.py:34-57, 205-214, 357-376`).
- **high-risk assumption 차단**(`auto/grading.py:428-438`): credential/api key/production/payment/legal/medical 용어를 가진 활성 ASSUMPTION은 blocker로 승격.
- `goal`은 자동 기본값으로 채울 수 없다 — 즉시 blocker, 반드시 사용자에게서 온다(`auto/interview_driver.py:597-604`).

> DITTO 시사점: §6.1 acceptance_criteria의 "관찰 가능" 강제, §6.8 final_verdict gate, §5.5 draft→in_progress 전이 게이트를 **정규식·상수 기반 결정론 검사**로 구현할 수 있다. `VAGUE_TERMS`/`_OBSERVABLE_HINTS`는 거의 그대로 차용 가능하다. high-risk 용어 차단은 §5.4 plan approval gate의 자동 트리거가 된다.

### 5. 무편향 breadth control + Socratic 질문 생성 (프롬프트 계약)

`socratic-interviewer.md`는 한 번에 한 질문을 내되 앵커링을 막는 명시 규칙을 둔다.

- **단일 질문 생성기 역할 경계**: 인터뷰어는 질문만 한다, 구현/약속 금지(`agents/socratic-interviewer.md:5-15`). intent와 execution을 분리.
- **breadth control**(`:39-44`): 시작 시 "주요 ambiguity 트랙"을 추론해 active로 유지, 여러 deliverable은 별도 트랙으로(한 favorite 서브토픽으로 collapse 금지), 몇 라운드마다 breadth check, 한 파일/추상화/버그가 연속 지배하면 zoom-out.
- **self-answer 우선(brownfield)**(`:23-31`): 답변은 `[from-code]`/`[from-user]`/`[from-research]`로 prefix. 코드가 이미 말한 것은 묻지 말고 "왜?/무엇이 바뀌어야?"를 물어라(GOOD/BAD 예시 포함).
- **ontological 질문 사용**(`:33-37`): "What IS this?", "Root cause or symptom?", "What are we assuming?".
- **stop conditions**(`:46-49`): scope/non-goals/outputs/verification이 모두 충분히 명시되면 종료 선호; 문구만 다듬는 단계면 종료 여부를 물어라; 사용자가 "충분"이라 하면 final closure 질문.

> DITTO 시사점: deep-interview-contract.md §3(무편향 5단계 질문 생성)·§4.1(고정 차원)·§2(비진입)의 프롬프트 계약 원문이 여기 있다. breadth control은 §3 "차원 커버리지" 규칙, self-answer 우선은 §6.2 QuestionGate와 동형.

### 6. 온톨로지 프레임워크 — 횡단 관심사 weaver + 4대 본질 질문

ouroboros는 온톨로지 분석을 **단일 단계가 아니라 횡단(cross-cutting) 관심사**로 둔다(`core/ontology_aspect.py:1-25`).

- **두 고대 방법의 명시적 분리**(`core/ontology_questions.py:6-13`): (1) Socratic Questioning(Why?/What if?/필요한가? → 숨은 가정·모순 노출), (2) Ontological Analysis(What IS this?/root vs symptom → 근본 문제, 본질/우연 분리). socratic-interviewer는 둘을 함께 쓴다.
- **4(+1) 본질 질문 타입**(`OntologicalQuestionType`, `core/ontology_questions.py:39-49` + `ONTOLOGICAL_QUESTIONS` 사전 `:70-`): `ESSENCE`("What IS this, really?"), `ROOT_CAUSE`("Root cause or symptom?"), `PREREQUISITES`("What must exist first?"), `HIDDEN_ASSUMPTIONS`("What are we assuming?"), `EXISTING_CONTEXT`. 각 타입은 `question/purpose/follow_up` 구조를 가진 타입드 데이터.
- **AOP weaver "Around Advice"**(`core/ontology_aspect.py:217-373`): 핵심 연산 전에 온톨로지 분석을 실행하고, 위반이면 halt(`halt_on_violation=True`), LLM 실패 시 fail-closed(`strict_mode=True`), TTL 캐시로 LLM 호출 절감, pass/violation 이벤트 emit. `skip_analysis`로 hot path 우회.
- **3개 join point**(`OntologicalJoinPoint`, `:50-65`): `INTERVIEW`(Phase 0, 사용자가 근본 문제를 묻는지), `RESILIENCE`(Phase 3, 정체 시 CONTRARIAN이 가정 도전), `CONSENSUS`(Phase 4, Devil's Advocate가 root vs symptom 검사). 같은 온톨로지 로직을 join point별 Strategy로 주입(`OntologyStrategy` Protocol `:165-206`).
- **구조화 출력**: ontology-analyst는 `{essence, is_root_problem, prerequisites[], hidden_assumptions[], confidence, reasoning}` JSON만(`agents/ontology-analyst.md`). semantic-evaluator는 `{score, ac_compliance, goal_alignment, drift_score, uncertainty, reasoning, questions_used[], evidence[]}`로 drift·불확실성·anti-reward-hacking 투명성(`questions_used`)을 강제(`agents/semantic-evaluator.md`).

> DITTO 시사점(지식베이스 §6.11): 아래 별도 절 참조.

## DITTO 계약별 구현 참조 매핑

| ouroboros 메커니즘 | 근거 | DITTO 계약 | 차용/주의 |
|---|---|---|---|
| `deterministic_floor` (코드가 LLM ambiguity 자기보고를 누름) | `auto/grading.py:401-425`, `auto/pipeline.py:642-651` | §6.3 Deep Interview, §6.9 Convergence, §0 제1원칙 | readiness 자기평가를 코드 바닥과 `max()`로 결합. **바로 차용 가치 큼.** |
| 이중 합의 종료 (backend ∧ ledger) | `auto/interview_driver.py:204-227` | §6.3 종료 게이트, §6.8×§6.9 쌍대 | "두 게이트 동시 만족 = done"의 레퍼런스 구현. closure_mode 3값도 차용. |
| Seed Draft Ledger source×status provenance | `auto/ledger.py:11-103` | §6.9 정직 라벨, §6.7 Evidence, §6.1 Intent | INFERENCE/ASSUMPTION=hypothesis, evidence-backed=finding을 타입으로. `interview-state.json` dimension에 source 추가. |
| 필수 섹션 10개 (failure_modes/verification_plan 포함) | `auto/ledger.py:57-68` | §6.3 §4.1 차원, §6.7 | DITTO 7차원과 대조 — pre-mortem(failure_modes)·검증계획을 차원으로 승격 검토. |
| GradeGate A/B/C + may_run | `auto/grading.py:109-296` | §5.5 draft→in_progress, §6.8 final_verdict | 실행 전 결정론 차단 게이트. ambiguity≤0.20 등 임계는 configurable로. |
| VAGUE_TERMS / _OBSERVABLE_HINTS 검증가능성 판정 | `auto/grading.py:23-57, 352-376` | §6.1 acceptance_criteria 관찰가능 강제 | 정규식·상수 거의 그대로 차용 가능. acceptance_testability 차원의 기계 판정. |
| high-risk assumption 차단 (credential/production/...) | `auto/grading.py:428-438` | §5.4 plan approval, §6.3 pre-mortem 승격 | irreversible/high-blast 자동 트리거. |
| goal은 자동 기본값 불가 → 즉시 blocker | `auto/interview_driver.py:597-604` | §6.3 critical 차원, §6.2 user_owned_decision | critical 차원 미해소 시 user-owned로 차단. |
| breadth control / 단일 질문 생성기 | `agents/socratic-interviewer.md:5-49` | §6.3 §3 무편향 5단계, §6.2 QuestionGate | 프롬프트 계약 원문. self-answer 우선·zoom-out 규칙. |
| safe-default 종료 + 롤백 invariant | `auto/interview_driver.py:339-555`, `:805-833` | §6.9 ratchet, §6.10 Handoff | cap 도달 시 안전 기본값만 닫고 unsafe는 blocked. transcript 비동기화 시 롤백(SSOT 보존). |
| 온톨로지 AOP weaver (3 join points) | `core/ontology_aspect.py` | §6.6 Dialectic, §6.9, §6.11 Knowledge | 적대 검증을 단계마다 중복 구현하지 말고 횡단 weaver로. fail-closed 기본. |
| 4대 본질 질문 타입 | `core/ontology_questions.py`, `agents/ontologist.md` | §6.3 질문 생성, §6.11 지식 스키마 | ESSENCE/ROOT_CAUSE/PREREQUISITES/HIDDEN_ASSUMPTIONS. |
| semantic-evaluator drift/uncertainty/questions_used | `agents/semantic-evaluator.md` | §6.8 Completion, §6.9, §6.6 | drift_score·uncertainty 임계 + anti-reward-hacking 투명성(질문·근거 노출). |

## 지식베이스(§6.11 KnowledgeContract)를 위한 온톨로지 구조 참조

사용자 요청대로, 향후 DITTO 지식베이스가 차용할 온톨로지 구조를 분리해 정리한다. 핵심은 **온톨로지를 "단계"가 아니라 "지식의 스키마이자 횡단 검증층"으로 본다**는 점이다.

1. **본질 기반 엔티티 스키마.** 지식 항목을 표면 사실(텍스트)이 아니라 4대 질문으로 정규화한다: `essence`(이것은 본질적으로 무엇인가), `is_root_problem`(근본/증상), `prerequisites[]`(선행 의존), `hidden_assumptions[]`(암묵 가정), `confidence`. 근거: `agents/ontology-analyst.md`, `core/ontology_questions.py:70-`. → 메인 §6.11의 `decisions/`, `patterns/`, `glossary`가 이 구조를 가지면 "왜·무엇에 의존·무엇을 가정" 그래프가 자동으로 생긴다([[graphify]]와 연결: essence=노드, prerequisites=엣지, hidden_assumptions=가정 provenance).

2. **횡단 weaver로서의 온톨로지.** 온톨로지 검증을 work-item마다 재구현하지 말고, INTERVIEW(의도 정렬)·CONSENSUS(결과 평가)·RESILIENCE(정체 복구) 같은 join point에 동일 Strategy를 주입한다. 근거: `core/ontology_aspect.py:50-65, 217-373`. → DITTO에서는 §6.3 deep-interview, §6.6 dialectic, §6.9 convergence가 같은 join point 집합이 된다. fail-closed(`strict_mode`)와 TTL 캐시는 비용/안전 기본값으로 차용.

3. **provenance가 곧 신뢰 등급.** 지식 항목도 ledger처럼 source(user/repo/convention/inference/assumption)×status(confirmed/weak/conflicting/...)를 타입으로 가진다. 근거: `auto/ledger.py:11-103`. → 지식베이스에서 "확인된 사실"과 "모델이 추론한 가정"을 절대 같은 볼륨으로 섞지 않는다(메인 §6.9 투명성 계층화, §6.11 "합의된 용어만 glossary 승격").

4. **drift 추적.** semantic-evaluator의 `drift_score`(intent로부터의 이탈)와 `uncertainty`는 지식 항목이 시간에 따라 stale/contradicted 되는지 추적하는 메트릭이 된다. 근거: `agents/semantic-evaluator.md`. → 메인 §6.7 evidence freshness(`fresh|stale`)와 결합.

주의: ouroboros 온톨로지는 LLM 호출 기반(`OntologyStrategy.analyze`가 async LLM)이므로 비용이 든다. DITTO 지식베이스는 (a) 본질 스키마는 항상 두되, (b) LLM 온톨로지 분석은 고가치 결정/패턴에만 적용하고 hot path는 `skip_analysis`로 우회하는 ouroboros 패턴(`core/ontology_aspect.py:296-298`)을 따라야 한다.

## 약한 점/리스크 (DITTO 차용 시)

- **LLM 비용.** ambiguity 자기보고, 온톨로지 분석, semantic 평가가 모두 LLM 호출이다. ouroboros는 `deterministic_floor`·TTL 캐시·`skip_analysis`로 완화하지만, DITTO는 결정론 검사(정규식·상수)를 1차로 두고 LLM을 2차 검증으로 제한해야 한다.
- **필수 섹션 10개 강제는 무거울 수 있다.** 작은 요청까지 10개 섹션을 채우게 하면 메인 §4.1(작은 요청 비대화 금지)과 충돌한다. DITTO는 critical 차원만 hard-gate하고 나머지는 safe-default 허용으로 둔다(ouroboros도 auto 모드에서 safe-default를 둠).
- **safe-default의 audited policy 의존.** `finalize_safe_defaultable_gaps`는 "local·reversible·audited" 정책에 의존한다(`auto/interview_driver.py:339-346`). DITTO가 차용하려면 그 정책 자체를 명시·테스트해야 하며, 그 전에는 fail-closed가 안전하다.

## 근거 목록

- `src/ouroboros/auto/interview_driver.py:44-48` — `ambiguity_score`는 진단 표면, 게이트 안 함.
- `src/ouroboros/auto/interview_driver.py:90-104` — bounded driver, max_rounds=12, timeout.
- `src/ouroboros/auto/interview_driver.py:204-227` — 이중 합의 종료 게이트.
- `src/ouroboros/auto/interview_driver.py:232-270` — backend done·ledger gap 시 gap-reopen / goal·CONFLICTING 차단.
- `src/ouroboros/auto/interview_driver.py:339-555` — max_rounds 후 safe-default/ledger_only/blocked 분기.
- `src/ouroboros/auto/interview_driver.py:582-654` — gap steering, goal 자동불가 blocker.
- `src/ouroboros/auto/interview_driver.py:805-833` — safe-default 롤백 invariant.
- `src/ouroboros/auto/grading.py:23-57` — VAGUE_TERMS, _OBSERVABLE_HINTS.
- `src/ouroboros/auto/grading.py:109-296` — GradeGate, 5점수, A/B/C, may_run 임계.
- `src/ouroboros/auto/grading.py:401-425` — deterministic_floor 공식.
- `src/ouroboros/auto/grading.py:428-438` — high-risk assumption 차단.
- `src/ouroboros/auto/ledger.py:11-103` — source/status enum, REQUIRED_SECTIONS, evidence-backed vs assumption.
- `src/ouroboros/auto/ledger.py:404-416` — open_gaps/is_seed_ready.
- `src/ouroboros/auto/pipeline.py:642-651` — max(llm, floor) 적용.
- `src/ouroboros/core/seed.py:137-252` — Seed/SeedMetadata, ambiguity_score 기본 0.15, IMMUTABLE direction.
- `src/ouroboros/core/ontology_aspect.py:50-65` — 3 join points.
- `src/ouroboros/core/ontology_aspect.py:165-206` — OntologyStrategy Protocol.
- `src/ouroboros/core/ontology_aspect.py:217-373` — Around Advice weaver, fail-closed, TTL 캐시, skip_analysis.
- `src/ouroboros/core/ontology_questions.py:6-13, 39-49, 70-` — 두 방법 분리, 질문 타입, 질문 사전.
- `src/ouroboros/agents/socratic-interviewer.md:5-49` — 역할 경계, breadth control, self-answer, stop conditions.
- `src/ouroboros/agents/ontologist.md` — 4대 본질 질문.
- `src/ouroboros/agents/ontology-analyst.md` — essence/is_root_problem/prerequisites/hidden_assumptions JSON.
- `src/ouroboros/agents/semantic-evaluator.md` — score/ac_compliance/goal_alignment/drift_score/uncertainty/questions_used/evidence.
