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
2. **자율 실행 오케스트레이션** — 사용자 의도를 스스로 구체화해 실제 코드베이스를 만들어 나간다(의도 왜곡 없이, 대규모·장시간이라도 끝까지).
3. **E2E 테스트** — 사용자 의도대로, 최초 계획대로 구현됐는지 확인한다.
4. **지식 베이스** — 매 변경마다 추가·변경된 코드베이스·컨텍스트를 문서화해 프로젝트 메모리를 획득한다.

경계: (a) 축3=진짜 브라우저 E2E only, 웹 없는 프로젝트는 N/A; (b) 축4=가치 있는 durable 변경만(에이전트 판단), 자동강제 아님; (c) 축1 종료=readiness 게이트(1차)+사용자 확인(2차) 둘 다; (d) 4축=완전 순차 파이프라인.

기능 4축은 목적 기둥이고, 기층 4축(Hooks/Skills/Agents/State)은 그것을 타겟에서 살아있게 배달하는 구현 substrate다(둘을 혼동하지 않는다). 정식 정의·근거는 ADR-0010.

### Journey DSL
사용자가 사용자 여정을 선언하는 Markdown 마크업. front-matter(`id`·`name`·`description`·`surfaces`·`uses_blocks`·`flaky_history`) + 한국어 동사 7개 단계 + assertion 5형 + 재사용 블록 + 데이터 케이스 테이블 + 선언적 조건 3형으로 구성된다. `e2e/journeys/*.journey.md`에 git-tracked되고, 에이전트(e2e-scripter)가 `e2e/generated/*.spec.ts`로 변환한다. 사용자가 도입한 말("DSL 혹은 전용 Markup")에서 합의된 어휘. 정의 원천: `skills/e2e-author/DSL-GUIDE.md`. 작성 모델(사람 선언 + 에이전트 변환 + 게이트 검증)의 결정 근거는 ADR-0014.

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
