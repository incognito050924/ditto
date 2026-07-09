# DITTO Project Context

본 문서는 DITTO 개발에서 사용자와 agent가 공유하는 ubiquitous language를 정의한다. 새 용어가 합의되면 본 문서와 `glossary.json`을 동시에 갱신한다. 정의되지 않은 약어는 사용자 응답에서 self-check가 reject한다.

## 핵심 용어

### request
사용자가 한 말의 원문 또는 그에 가까운 paraphrase. 한 요청에서 여러 work item이 파생될 수 있다.

### work item
DITTO가 추적하는 작업의 정규화 단위. goal, acceptance criteria, 실행 기록, 검증 evidence, handoff를 포함한다. 식별자: `wi_*`. `task`라는 이름은 사용하지 않는다 — subagent의 작은 작업, provider의 background task, GitHub task와 충돌한다.

**work item 처리 정본 프로세스**: 진입점은 둘이다 — ① `ditto:deep-interview`로 의도를 먼저 잠그고 시작, 또는 ② 대화·`handoff`로 할 일을 받아 autopilot을 바로 시작. 그러나 **내부 파이프라인은 항상 동일**하다: `deep-interview`로 **의도 잠금**(intent.json) → `pre-mortem`으로 **계획 잠금** → `autopilot`으로 **코드베이스 변경**. ②의 "autopilot 바로 시작"도 이 단계를 건너뛰는 게 아니라 autopilot 부트스트랩 안에서 수행한다(intent.json을 요구하고 plan 단계에 pre-mortem coverage 게이트가 있다). **의무**: 사용자 의도는 work item을 열고, (우회할 명분이 없는 한 — `autopilot` 항목의 "너무 간단" 예외) 이 프로세스를 따른다.

**무축소 의무**: 사용자 의도가 아무리 크더라도, 한 번 확정(잠금)된 의도와 계획을 에이전트가 **임의로 축소하지 않는다**(헌장 §4-6). 대표 위반 둘 — ① 구현 범위를 줄여 남은 부분을 다음 work item/세션으로 넘기려는 시도(=잠긴 *계획* 무시), ② 남은 위험을 처리하지 않고 닫음(=잠긴 *의도* 무시). **front-stop(축소 판단을 앞으로 당긴다)**: 범위 축소나 "현 세션에서 끝까지 처리 불가"의 이유·필요성은 *가능한 한 의도파악·계획 단계*(`deep-interview`/`pre-mortem`)에서 미리 파악해 계획에 잠근다 — 축소 판단을 구현 중으로 미루지 않는다. 그럼에도 구현 중 진짜 축소가 필요해지면(비용·외부 의존·비가역·새 모호함) 그건 에이전트의 절차 결정이 아니라 **사용자 의도 차원의 결정**이므로 사용자에게 확인한다 — "임의로" 줄이는 것만 금지다.

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

**유일 변경 표면 가드(비단순 코드베이스 변경은 autopilot으로만)**: ditto에서 코드베이스 변경(구현·수정·삭제)의 **유일한 표면은 autopilot**이다. 메인 에이전트가 직접 TDD로 구현하는 것은 axis-2 오케스트레이션을 끄겠다는 선언이며 §4-9 위반이다 — 구현 산출물을 자기 맥락에 적재해 context rot를 키우고, 자기 작업을 자기 맥락에서 검증해(fresh context 아님) 검증 유효성을 깬다. 경계 둘: ① **"너무 간단"의 기준 = work-item 가치**(산출물 생성/비가역 변경이면 work item → autopilot). work item 가치 없는 기계적 단일 변경(오타·rename·config 한 줄)만 메인 직접 허용. ② **우회의 시점은 *의도가 잠긴 뒤***다. 설계 대화로 사용자가 계속 steering하는 단계는 우회가 아니라 intent 단계(`deep-interview` → intent.json)이고, autopilot은 "without user intervention"이라 그 단계 대상이 아니다. 우회는 **잠긴 뒤 비단순 구현을 메인이 들고 있는 것**. 올바른 흐름: 설계=의도 잠금 → 잠긴 뒤 구현은 autopilot에 위임(implementer/verifier/reviewer가 fresh context). "아직 안 잠겼다"를 핑계로 영원히 메인에서 짜지 않는다.

**self-answer 가드(묻기 전에 스스로 답을 시도한다)**: 사용자에게 질문을 던지기 직전, 잠긴 의도(intent.json)·ADR·코드·문서로 그 답이 유도되는지 먼저 시도한다. 분류는 두 갈래다 — ① **근거로 답 가능**: 답하고 묻지 않는다. 단 답은 추측이 아니라 근거여야 하고(사실 게이트: 확신 있는 오답이 최악), 답과 그 출처를 출력에 드러내 사용자가 거부할 수 있게 한다(조용한 가정 금지). ② **사용자만 답 가능**(제품 가치·도메인 의미·비가역 판단): 스스로 답하지 않고 묻는다 — 여기서 self-answer는 §4-2·§10 위반(게으른 가정)이다. 무정지 가드가 "게으르게 묻기"를 막는다면 이 가드는 "근거 있는 질문"을 없앤다. 둘이 겹쳐 멈춤을 기약불가능한 핵심(사용자만 답할 수 있는 것)까지 줄인다. 분기 기준은 "의도가 잠겼으니 다 답한다"가 아니라 **근거 유무**다.

### deep-interview
축1(의도 파악)의 인터뷰 메커니즘. autopilot이 자율 주행할 수 있도록 **착수 전에** 모든 진짜 질문(제품 가치·도메인 의미·비가역 결정)을 변증론적·경계 질문으로 소진해 intent를 확정한다. 실행 중 멈춰 되묻지 않기 위한 선행 게이트 — 질문은 여기서 끝낸다. `autopilot`의 무정지 실행을 가능케 하는 짝.

### pre-mortem
계획 단계에서 "이 일이 실패한다면 왜인가"를 미리 돌려 비가역 위험·커버리지 공백을 드러내는 절차. `deep-interview`와 함께 축1에서 의도·위험을 front-load해, autopilot이 실행 도중 새 모호함·위험에 부딪혀 멈추는 일을 막는다.

### Journey DSL
사용자가 사용자 여정을 선언하는 Markdown 마크업. front-matter(`id`·`name`·`description`·`surfaces`·`uses_blocks`·`flaky_history`) + 한국어 동사 7개 단계 + assertion 5형 + 재사용 블록 + 데이터 케이스 테이블 + 선언적 조건 3형으로 구성된다. `e2e/journeys/*.journey.md`에 git-tracked되고, 에이전트(e2e-scripter)가 `e2e/generated/*.spec.ts`로 변환한다. 사용자가 도입한 말("DSL 혹은 전용 Markup")에서 합의된 어휘. 정의 원천: `skills/e2e-author/DSL-GUIDE.md`. 작성 모델(사람 선언 + 에이전트 변환 + 게이트 검증)의 결정 근거는 ADR-0014.

### e2e_gate (E2E CI-evidence gate)
`recipe`의 E2E CI-증거 push-gate 블록(`recipeE2eGate`). protected/release 브랜치로 push할 때, **pushed 커밋 sha의 CI E2E check-run이 통과했는지를 라이브로 확인**하고 아니면 fail-closed로 BLOCK한다. 형태: `{protected_branches, evidence{source(enum: github-checks)·repo?·check_name_template·token(envRef)}}`. `push_gate`(로컬 `test_command`를 직접 실행)와 구별된다 — `e2e_gate`는 CI 증거를 *읽는다*. 부재=비활성(degrade-PASS). 핵심 불변식: **allow-신호는 서버-권위 라이브 read여야 하고 커밋된 산출물이 아니다**(커밋 가능자 누구나 `{pass:true}`를 날조할 수 있으므로). 커밋되는 것은 policy(어떤 journey를 제외하는가)뿐이고, 완화가 git-visible diff라 안전하다. 결정 근거는 ADR-20260709-e2e-evidence-gate-anti-forgery.

### EvidenceSource
E2E CI-증거 게이트가 증거를 읽는 포터블 seam(`src/core/e2e/evidence-source.ts`). `github-checks`가 built-in 구현으로, 정확한 커밋 sha의 check-run을 한 번의 배치 read로 가져온다. host-agnostic(ADR-0016) — GitLab 등 non-GitHub CI는 이 built-in을 건드리지 않고 `EvidenceSource`를 구현하면 된다. gh-client의 fail-**OPEN** 극성과 반대로, 모든 실패(`{ok:false}`: auth·timeout·rate-limit·perm·absent·malformed·unparseable)를 게이트 **BLOCK**으로 매핑한다(fail-closed). `evidence`(주장을 뒷받침하는 참조)·`memory source`(memory ingest 출처)와 혼동하지 않는다. 결정 근거는 ADR-20260709.

### gate-exclude (journey)
journey를 E2E 게이트의 mandatory 집합에서 빼는 커밋된 per-journey opt-out. journey front-matter의 `gate{exclude, exclude_reason}`(`journeyGate`)로 저자가 직접 선언한다 — journey는 git-tracked repo 자산이라 저자 self-service이고, `exclude=true`는 비어있지 않은 `exclude_reason`을 **필수로** 요구한다(조용한 opt-out 금지). 멤버십은 blocklist다: journey는 exclude하지 않으면 mandatory. policy(어떤 journey 제외)를 커밋에 두는 것은 안전하다 — 완화가 git-visible diff이기 때문(allow-신호와 달리 위조 위험이 없다). 결정 근거는 ADR-20260709.

### 정합성 2축
memory freshness가 답해야 하는 두 독립 관계. 축1=SoT↔파생물(SoT 레코드는 바뀌었는데 파생물 재빌드 안 됨), 축2=코드베이스↔SoT(코드 수정·`git stash`·브랜치 이동으로 실제 코드가 SoT 스냅샷과 달라짐). 기존 `memoryStatus`는 축1만 검출했고 축2는 사각지대였다. 결정 근거는 ADR-0015.

### code_drift
owning-repo 현재 HEAD가 memory가 저장한 `git_commit`(`source_revisions[].git_commit`)과 달라, SoT가 다른 커밋의 코드에서 만들어진 상태. 축2의 진짜 신뢰 결함이라 warm-start 주입 억제 대상이다. 결정 근거는 ADR-0015.

### code_dirty
owning-repo 워킹트리가 더티(미커밋 편집·`git stash`)인 상태. 개발 중 정상이라 라벨만 달고 warm-start를 억제하지 않는다 — 더티마다 억제하면 memory가 inert가 되기 때문. `code_drift`와 혼동하지 않는다. 결정 근거는 ADR-0015.

### drifted_sources
축2 검출이 어긋났다고 판정한 source 목록(별도 필드, 축1의 `dirty_sources`와 분리). 소비자(memory-graph 스킬)는 이 목록에 든 source만 코드로 직접 검증하고 나머지는 신뢰한다. 결정 근거는 ADR-0015.

### 표준 work-lifecycle 2경로 (정식/약식)
코드를 바꾸는 모든 작업은 **딱 두 경로** 중 하나로만, 등록된 work item 아래에서 진행한다. **정식(heavy)** = `deep-interview`→`pre-mortem`→`autopilot`(모호·비가역·다중표면 작업). **약식(light)** = `work set-criteria`→`verify`→`work done`(작고 가역적인 작업). 둘 중 *어느* 경로냐는 에이전트 판단(advisory, weight 라우팅)이지만, **둘 다 우회한 ad-hoc 직접수정·콘솔 TDD는 금지된 세 번째 경로**다 — 추적·완료·회고·정리가 빠져 작업이 닫히지 않는 rot을 남기기 때문. TDD는 경로 *안의* 구현 기법이지 경로의 대체가 아니다. 이 강제는 런타임 PRIME_DIRECTIVE(`src/core/charter.ts`, 권위)가 매 턴 주입하고, 입문 가이드는 루트 `WORKFLOW.md`다. 결정 근거는 ADR-20260626-work-lifecycle-lightweight-path.

### lightweight path (경량 경로)
무거운 경로(`deep-interview`→`pre-mortem`→`autopilot`) 옆에 둔 세리머니 없는 작업 경로. `work start --criteria` 또는 `work set-criteria`로 관측 가능한 진짜 기준을 세우고 `verify`→`work done`으로 닫는다(`intent.json`·graph 불필요). 경량 vs 무거운 선택은 logged-override(차단 기본값 + 기록된 사유, ADR-0020 패턴 재사용)이고, 무거운 경로 트리거는 `declared_risk`다. `work promote`로 제자리 승격한다. 결정 근거는 ADR-20260626-work-lifecycle-lightweight-path.

### declared risk (declared_risk)
work item이 무거운 경로(`deep-interview`)를 요구하는지 판정하는 위험 신호 필드. `risk{non_local·irreversible·unaudited}` 축 + 미해결 unknown 수로 구성된다. placeholder-문자열 nudge를 *대체*해, 진짜 기준을 세팅해도 무거운-경로 검출이 조용히 사라지지 않게 한다. 결정 근거는 ADR-20260626-work-lifecycle-lightweight-path.

### stem (줄기, lineage chain)
관련 work item을 한 단위로 보는 묶음 모델. 저장된 epic 객체나 죽은 `child_ids` 트리가 아니라, work item의 `follows` 계보 엣지 위에서 `work stem`이 *파생*하는 뷰다. 일괄 종결은 줄기 전원이 terminal일 때만 가능(롤업 verdict, 부분-abandon 허용). 결정 근거는 ADR-20260626-work-lifecycle-lightweight-path.

### follow-up materialization (후속 물질화)
발굴된 작업을 추적 가능한 형태로 전환하는 절차. work item의 `work follow-up` 슬롯에 담기며, 발굴된 *버그*는 추적 WI로 물질화되어 `discovered_by`로 역링크되고, *아이디어*는 candidate로 남는다. 미해결 자기-유발 high/critical 회귀는 `work done`을 차단(`--resolve`로 해제). 발굴을 산문 목록으로 사용자에게 던지지 않기 위함. 결정 근거는 ADR-20260626-work-lifecycle-lightweight-path.

### push-readiness (push-ready)
한 작업 단위가 자기완결이라 푸시할 수 있다는 강한 신호. `work push-ready`가 *명시 요청 시에만* 계산해 노출한다 — 전 AC가 실 명령-증거로 pass + 미해결 회귀 없음 + 줄기 done. PULL-ONLY: 어디서도 능동적 push 제안을 하지 않는다(push는 사용자의 비가역 배포 결정, 헌장 §4-8). 결정 근거는 ADR-20260626-work-lifecycle-lightweight-path.

### Record (work-item tier) / Run (work-item tier)
work item 상태는 두 tier로 쪼개진다. **Record** = 커밋·공유·git-tracked tier(`.ditto/work-items/<id>/` = `record.json`(AC 멤버십·scope·`evidence_required`) + `events/`(전이당 불변 이벤트)). 프로젝트 메모리(status·AC verdict·github 멱등)가 여기 durable하게 남아 팀·다른 PC가 pull해 진행 상태를 본다. **Run** = 개인·폐기가능·gitignored tier(`.ditto/local/work-items/<id>/` = reduced view 미러 + intent.json·runs·graph). Run은 언제든 삭제 가능하고 삭제해도 Record는 무손실로 남는다. spec-freshness 스탬프 `source_digest`는 Run(intent.json)에 남고 Record엔 없다(droppable). `run`(한 번의 provider 호출, `run_*`)과 혼동하지 않는다. 결정 근거는 ADR-20260706-work-item-record-run-split(사용자 backlog §7 Q1 공유 백로그·Q2 스키마 수준 분할; ADR-0012 D1 부분 supersede).

### first-terminal-wins
work-item 이벤트 reducer(`reduceWorkItem`)의 status fold 규칙. terminal status(`done`/`abandoned`)는 배타적이라 최초 terminal이 이기고 경쟁하는 2번째 terminal은 거부된다(비-terminal reopen만 정당한 재진입). 비-terminal은 latest-wins. 이벤트는 `event_id`로 dedupe, `(seq,actor,event_id)`로 결정적 정렬(`ts`는 clock-skew-unsafe라 정렬 키 아님). 전이는 `appendEvent`가 `open(wx)`로 이벤트당 불변 파일을 append한다(파일 락 없이 원자성 — 논거는 ADR-20260628-append-decision-atomicity). 코드: `src/core/work-item-store.ts`.

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
