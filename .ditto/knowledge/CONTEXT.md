# DITTO Project Context

본 문서는 DITTO 개발에서 사용자와 agent가 공유하는 ubiquitous language를 정의한다. 새 용어가 합의되면 본 문서와 `glossary.json`을 동시에 갱신한다. 정의되지 않은 약어는 사용자 응답에서 self-check가 reject한다.

## 핵심 용어

### request
사용자가 한 말의 원문 또는 그에 가까운 paraphrase. 한 요청에서 여러 work item이 파생될 수 있다.

### work item
DITTO가 추적하는 작업의 정규화 단위. goal, acceptance criteria, 실행 기록, 검증 evidence, handoff를 포함한다. 식별자: `wi_*`. `task`라는 이름은 사용하지 않는다 — subagent의 작은 작업, provider의 background task, GitHub task와 충돌한다.

### run
한 번의 provider 호출. 한 work item은 여러 run을 가질 수 있다. 식별자: `run_*`.

### run manifest
run의 권위 있는 기록 파일. provider, profile, git state, prompt, stdout/stderr, diff, verifications, unverified 항목을 포함한다.

### evidence
주장(완료, 검증, 결정)을 뒷받침하는 참조. command 실행 결과, 파일, artifact path, URL, note 형태. context에 직접 넣지 않고 path/hash/preview로 참조한다.

### handoff
work item을 다른 세션, 다른 PC, 다른 agent로 이어주기 위해 정리한 사람이 읽는 문서. 무엇이 끝났나, 무엇이 남았나, 어디서 이어받나, 어떤 fresh evidence가 필요한가, 무엇을 건드리지 않아야 하는가를 담는다.

### completion contract
work item 완료 주장에 필수인 필드 집합. acceptance verdict, 변경 파일, 검증 명령, unverified 항목, remaining risk, next_handoff_path를 포함한다. `final_verdict=pass`는 모든 acceptance가 pass여야만 허용된다.

### verdict
acceptance 또는 review의 판정. 값: `pass | partial | fail | unverified`.

### profile
실행 권한과 정책의 묶음. 값: `read-only | workspace-write | networked | reviewer | isolated`.

### provider
실제로 model/tool loop를 실행하는 host. 값: `codex | claude-code | opencode | openagent | other`.

### reviewer output
generator와 분리된 evaluator의 결과. verdict, evidence, findings, unverified, recommended next action을 담는다. `cross-provider-reviewer`는 generator와 다른 provider/model family를 우선 사용한다.

### self-check
사용자에게 응답이 나가기 전에 적용하는 결정적 lint. 미합의 용어, 약어 남용, 추측 단정, 미검증 완료 선언, 근거 없는 답변을 reject한다.

### language ledger
work item 진행 중 합의되거나 수정된 용어 변경 기록. 합의 후 글로벌 glossary로 흡수된다.

### glossary / CONTEXT.md
프로젝트 ubiquitous language의 권위 원본. `CONTEXT.md`는 사람용, `glossary.json`은 기계용 view.

### ADR (Architecture Decision Record)
되돌리기 어려운 결정의 영속 기록. `adr/ADR-NNNN-<slug>.md`. 결정만 보존하고, 토론은 `decisions.md`에 둔다.

### doctor
host별 instruction, permission, MCP, skill 표면의 drift를 점검하는 명령. 실행이 아니라 진단.

### context packet
run에 넘기는 prompt. goal, acceptance, git state, relevant files, last failure, what-not-to-touch, evidence pointer, expected output contract로 구성된다.

### unverified
"검증하지 못함"의 명시적 표기. 모름은 모름으로 표기해야 하며 완료 주장과 섞지 않는다.

### cross_repo
단일모듈 CodeQL DB 분석에서 형제모듈(로컬 JAR) 의존이 정적으로 해소되지 않아 `ImpactGraph.unresolved`에 남는 kind. `internal_packages`의 glob에 매칭돼야 기록되며, 써드파티(Spring/JDK)와 구분된다. 결정 근거는 ADR-0007.

### internal_packages
`ArchitectureSpec`의 형제모듈 디스크립터 배열. `{type:'glob'}`=cross_repo 분류 대상 패키지 글로브, `{type:'path'}`=로컬 sibling JAR 위치 글로브(JVM 가드 입력). `public_surfaces`·`forbidden_dependencies`와 혼동하지 않는다.

### DITTO 기능 4축
DITTO가 사용자를 위해 무엇을 하는가를 정의하는 canonical 목적 기둥. 완전 순차 파이프라인 1→2→3→4로 동작한다.

1. **사용자 의도 파악 및 동기화** — 변증론적·경계 질문을 반복해 사용자가 놓친 부분까지 드러내고, 사용자 이해와 완전히 일치할 때까지 인터뷰해 산출물을 작성한다.
2. **자율 실행 오케스트레이션** — 사용자 의도를 스스로 구체화해 실제 코드베이스를 만들어 나간다(의도 왜곡 없이, 대규모·장시간이라도 끝까지). 자율은 단어 그대로다: 승인된 실행 단위 안에서 절차 결정을 사용자에게 되묻지 않고 정지 조건까지 끝까지 몬다(→ `autopilot`).
3. **E2E 테스트** — 사용자 의도대로, 최초 계획대로 구현됐는지 확인한다.
4. **지식 베이스** — 매 변경마다 추가·변경된 코드베이스·컨텍스트를 문서화해 프로젝트 메모리를 획득한다.

경계: (a) 축3=진짜 브라우저 E2E only, 웹 없는 프로젝트는 N/A; (b) 축4=가치 있는 durable 변경만(에이전트 판단), 자동강제 아님; (c) 축1 종료=readiness 게이트(1차)+사용자 확인(2차) 둘 다; (d) 4축=완전 순차 파이프라인.

기능 4축은 목적 기둥이고, 기층 4축(Hooks/Skills/Agents/State)은 그것을 타겟에서 살아있게 배달하는 구현 substrate다(둘을 혼동하지 않는다). 정식 정의·근거는 ADR-0010.

### autopilot
축2(자율 실행 오케스트레이션)를 구동하는 오케스트레이터. 단어 그대로 **자율 주행**이다 — 승인된 실행 단위(요청·증분·work item) 안에서 노드 그래프를 스스로 선택·위임·검증하며 정지 조건까지 **끝까지 몬다**. 중간 멈춤은 사용자만 답할 수 있는 가치·의도 결정, 비가역 위험, 안전 경계에서만 한다(헌장 §3). **배제되는 안티패턴**: 절차 결정(구현 A/B 선택, "이대로 진행할까요?", 다음 증분 확인, 커밋 여부)을 사용자에게 떠넘기며 증분마다 멈춰 묻는 것 — 자율의 실패다. 그런 질문은 착수 *전* `deep-interview`/`pre-mortem`에서 소진한다. 결정 근거는 ADR-0020, 헌장 §3·§4-8.

**유일 변경 표면 가드(비단순 코드베이스 변경은 autopilot으로만)**: ditto에서 코드베이스 변경(구현·수정·삭제)의 **유일한 표면은 autopilot**이다. 메인 에이전트가 직접 TDD로 구현하는 것은 axis-2 오케스트레이션을 끄겠다는 선언이며 §4-9 위반이다 — 구현 산출물을 자기 맥락에 적재해 context rot를 키우고, 자기 작업을 자기 맥락에서 검증해(fresh context 아님) 검증 유효성을 깬다. 경계 둘: ① **"너무 간단"의 기준 = work-item 가치**(산출물 생성/비가역 변경이면 work item → autopilot). work item 가치 없는 기계적 단일 변경(오타·rename·config 한 줄)만 메인 직접 허용. ② **우회의 시점은 *의도가 잠긴 뒤***다. 설계 대화로 사용자가 계속 steering하는 단계는 우회가 아니라 intent 단계(`deep-interview`/`tech-spec` → intent.json)이고, autopilot은 "without user intervention"이라 그 단계 대상이 아니다. 우회는 **잠긴 뒤 비단순 구현을 메인이 들고 있는 것**. 올바른 흐름: 설계=의도 잠금 → 잠긴 뒤 구현은 autopilot에 위임(implementer/verifier/reviewer가 fresh context). "아직 안 잠겼다"를 핑계로 영원히 메인에서 짜지 않는다.

**self-answer 가드(묻기 전에 스스로 답을 시도한다)**: 사용자에게 질문을 던지기 직전, 잠긴 의도(intent.json)·ADR·코드·문서로 그 답이 유도되는지 먼저 시도한다. 분류는 두 갈래다 — ① **근거로 답 가능**: 답하고 묻지 않는다. 단 답은 추측이 아니라 근거여야 하고(사실 게이트: 확신 있는 오답이 최악), 답과 그 출처를 출력에 드러내 사용자가 거부할 수 있게 한다(조용한 가정 금지). ② **사용자만 답 가능**(제품 가치·도메인 의미·비가역 판단): 스스로 답하지 않고 묻는다 — 여기서 self-answer는 §4-2·§10 위반(게으른 가정)이다. 무정지 가드가 "게으르게 묻기"를 막는다면 이 가드는 "근거 있는 질문"을 없앤다. 둘이 겹쳐 멈춤을 기약불가능한 핵심(사용자만 답할 수 있는 것)까지 줄인다. 분기 기준은 "의도가 잠겼으니 다 답한다"가 아니라 **근거 유무**다.

### deep-interview
축1(의도 파악)의 인터뷰 메커니즘. autopilot이 자율 주행할 수 있도록 **착수 전에** 모든 진짜 질문(제품 가치·도메인 의미·비가역 결정)을 변증론적·경계 질문으로 소진해 intent를 확정한다. 실행 중 멈춰 되묻지 않기 위한 선행 게이트 — 질문은 여기서 끝낸다. `autopilot`의 무정지 실행을 가능케 하는 짝.

### pre-mortem
계획 단계에서 "이 일이 실패한다면 왜인가"를 미리 돌려 비가역 위험·커버리지 공백을 드러내는 절차. `deep-interview`와 함께 축1에서 의도·위험을 front-load해, autopilot이 실행 도중 새 모호함·위험에 부딪혀 멈추는 일을 막는다.

### Journey DSL
사용자가 사용자 여정을 선언하는 Markdown 마크업. front-matter(`id`·`name`·`description`·`surfaces`·`uses_blocks`·`flaky_history`) + 한국어 동사 7개 단계 + assertion 5형 + 재사용 블록 + 데이터 케이스 테이블 + 선언적 조건 3형으로 구성된다. `e2e/journeys/*.journey.md`에 git-tracked되고, 에이전트(e2e-scripter)가 `e2e/generated/*.spec.ts`로 변환한다. 사용자가 도입한 말("DSL 혹은 전용 Markup")에서 합의된 어휘. 정의 원천: `skills/e2e-author/DSL-GUIDE.md`. 작성 모델(사람 선언 + 에이전트 변환 + 게이트 검증)의 결정 근거는 ADR-0014.

### 정합성 2축
memory freshness가 답해야 하는 두 독립 관계. 축1=SoT↔파생물(SoT 레코드는 바뀌었는데 파생물 재빌드 안 됨), 축2=코드베이스↔SoT(코드 수정·`git stash`·브랜치 이동으로 실제 코드가 SoT 스냅샷과 달라짐). 기존 `memoryStatus`는 축1만 검출했고 축2는 사각지대였다. 결정 근거는 ADR-0015.

### code_drift
owning-repo 현재 HEAD가 memory가 저장한 `git_commit`(`source_revisions[].git_commit`)과 달라, SoT가 다른 커밋의 코드에서 만들어진 상태. 축2의 진짜 신뢰 결함이라 warm-start 주입 억제 대상이다. 결정 근거는 ADR-0015.

### code_dirty
owning-repo 워킹트리가 더티(미커밋 편집·`git stash`)인 상태. 개발 중 정상이라 라벨만 달고 warm-start를 억제하지 않는다 — 더티마다 억제하면 memory가 inert가 되기 때문. `code_drift`와 혼동하지 않는다. 결정 근거는 ADR-0015.

### drifted_sources
축2 검출이 어긋났다고 판정한 source 목록(별도 필드, 축1의 `dirty_sources`와 분리). 소비자(memory-graph 스킬)는 이 목록에 든 source만 코드로 직접 검증하고 나머지는 신뢰한다. 결정 근거는 ADR-0015.

## 금지 표현

다음 표현은 사용자 응답에서 self-check가 reject한다.

- `wi`, `rm`, `cfg` 같은 사전에 정의되지 않은 단독 약어
- "대략", "아마도", "거의 다 됐다" 같은 근거 없는 단정/모호 표현
- "위치/ID/제목만" 언급하고 판단 맥락을 빠뜨린 응답
- 검증 명령 없이 "완료/성공/통과"를 단정하는 문장

## 진화 규칙

- 새 용어 합의 전에 work item의 `language.md`와 `language-ledger.json`에 변경을 제안한다.
- 사용자 합의 후 본 문서와 `glossary.json`에 반영하고 `language-ledger.json`의 `agreed_with_user`를 `true`로 갱신한다.
- 사용 빈도가 낮아지면 `deprecated`로 표기하고 즉시 삭제하지 않는다.
