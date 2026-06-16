# ADR-0020: 결정-모순 가드레일 — ADR을 추론 시점에 일관 적용 (classify × route × disclose)

- 상태: accepted (2026-06-16 설계 합의 + 전체 배선·집행 구현 + 라이브 e2e 검증 완료. 검출 지침(planner/researcher/reviewer/deep-interview/AGENTS §4-10)·라우팅 게이트(`decisionConflictGate`)·carrier(`decision-conflict-carrier`)·record-result producer(`decision_conflicts`→carrier 영속화)·approval front-load(`producePlanGate`)·Stop hook 집행(`decisionConflictForcesContinuation`)이 통합됨. 라이브 검증: 등록 planner 자율 검출 → 오케스트레이터 pass-through → record-result가 carrier 생성 → approval pending(예방) + Stop exit2(캐치)까지 실제 코드로 작동, 실제 코드 변경 0건. 커밋 `1f38011`. 철회·재검토 조건은 §철회/재검토 조건 참조)
- 결정 일자: 2026-06-16
- 결정자: hskim, claude
- 관련: ADR-0006(CodeQL 단일 — `scripts/adr-guard.ts`가 grep으로 집행하는 결정의 예), ADR-0001(provider 간접화 — 충돌 판단은 host LLM이 하고 ditto는 직접 분석 안 함), ADR-0013(memory subsystem — 검색 경로 + supersede 메커니즘), `scripts/adr-guard.ts`(상보적 grep 가드), `src/core/memory-bootstrap.ts`(`adrGist` 색인), `src/core/gates.ts`(`decisionConflictGate`), wi_260616pyj

## 컨텍스트

ADR은 영속 기록물일 뿐 추론 시점 가드레일로 작동하지 않는다. ADR 내용이 에이전트에게 닿는 경로는 셋인데 전부 약하다: CLAUDE.md 투영은 헤드라인(`id · status · title`)만 실어 본문의 금지가 안 보이고, `ditto memory query`는 자발적이며, warm-start는 오토파일럿 + researcher/planner owner + 플래그로 한정된다. `scripts/adr-guard.ts`는 grep으로 판정 가능한 위반만 잡고 의미적·문맥적 결정(예: ADR-0002)은 의도적으로 범위 밖으로 둔다.

결과: "A는 ~이유로 하지 않는다" 같은 결정이 있어도, 에이전트가 A를 제안·계획·구현할 때 일관되게 확인되지 않는다. 특히 평범한 인터랙티브 흐름(메인 에이전트의 의도분석·계획)에는 능동 검출이 전무하다.

## 결정 — 개발 시 지켜야 할 구조

### D1 — 충돌을 classify하고 route한다

충돌은 `kind`(forbid|require|prefer) × `level`(intent|method)로 분류한다. `intent`는 work item의 목적(goal/AC) 자체가 ADR 금지를 요구하는 경우(사용자만 해결 가능), `method`는 후보 구현 경로가 어기는 경우(에이전트가 ADR대로 재경로 가능). 라우팅: method → `align`(ADR 자동 준수), intent → interactive=`ask_user`/autopilot=`block`, prefer → `justify`(차단 안 함). 순수 함수 `decisionConflictGate(conflicts, mode)`(`src/core/gates.ts`)가 이 정책을 결정론으로 인코딩한다.

### D2 — 투명성 불변식: 충돌은 항상 출력에 근거와 함께 드러낸다

충돌을 감지하면 사용자가 확인을 안 받는 경우(method 자동 정렬)에도 **출력(사용자 응답·Stop 보고)에 근거(basis)를 노출**한다. "ADR-X를 고려해 이렇게 독자 판단했다"가 보여야 하며, 조용한 자동 준수는 위반이다. `DecisionConflict.basis`가 disposition까지 운반되어 렌더링된다.

### D3 — autopilot은 fail-closed (live 대기 금지 ∧ 약한 무시 금지)

오토파일럿 중 intent 충돌은 멈춰 서서 사용자 응답을 실시간 대기하지 않는다(ditto 자율성 가치). 대신 노드를 멈추고 `final_verdict=blocked`로 표시해 Stop 경계에서 보고한다. intent 충돌은 planner→승인 이음새에서 앞당겨 검출해 오토파일럿이 충돌을 안고 출발하는 일을 드물게 만든다.

### D4 — 판단은 host LLM, ditto는 검색·라우팅·투명성만 소유 (ADR-0001/0006 비충돌)

"충돌이 존재하는가, 그 kind/level은 무엇인가"는 의미 판단이라 결정론으로 못 푼다(Rice). 그 판단은 host LLM에 위임하고(ADR-0001: provider 직접 호출 금지, ADR-0006: AST 금지 유지), ditto는 ① memory graph 검색(`adrGist`), ② 순수 라우팅, ③ 투명성 정책만 가진다. 게이트가 충돌을 *만들지* 않는다.

### D5 — 검색은 2단, 효과-형태 회귀는 작성 품질에 의존

전역 invariant(`scope=global`, 심볼 앵커 없음)는 상시 주입하고, 지역 결정은 관련성 검색한다 — 전역 불변식은 관련성 검색으로는 새 위반일수록 놓치기 때문. anti-regression("B>C 회귀 금지")은 트리거가 이름이 아니라 폐기 상태의 *형태*라, constraint statement를 알아볼 수 있는 형태로 적어야만 작동한다.

## 철회/재검토 조건

- intent 충돌 false positive가 빈발해 마찰이 과하면 → method 자동정렬 범위 확대 또는 intent 검출 임계 상향.
- 전역 invariant 상시주입이 context rot로 실측되면 → node-level granularity 도입.
- host LLM의 분류 신뢰도가 낮아 타입드 constraint 필드(kind/scope/enforced_by)가 필요해지면 → knowledge-record 스키마에 가산적(기존 ADR 무변경) 추가.
- 사용자 프로젝트가 자체 ADR을 축적하고 ditto-product 결정을 배포해야 하면 → 현재 보류한 층 분리(D6 영역) 재개.

## 대안 (기각)

- **(a) grep 가드(adr-guard)만 확장** — 의미적·문맥적 결정을 강제할 수 없다. 상보로 유지하되 단독으로는 불충분. 기각.
- **(b) ditto가 직접 의미 분석(AST/provider 호출)** — ADR-0006(AST 금지)·ADR-0001(provider 간접화) 위반. 기각.
- **(c) autopilot이 충돌 시 live 사용자 대기** — 무인 진행이라는 ditto 자율성 가치 위반. 기각(→ D3 fail-closed).
- **(d) 충돌이면 종류 불문 하드 차단(prefer 포함)** — 마찰 과대 → 우회 학습 → 가드레일 사망. 기각.
- **(e) 자동 정렬을 조용히(로그만) 처리** — 투명성 위반. 기각(→ D2).
- **(f) ADR 층 분리를 지금 도입** — ditto 자기 ADR은 배포물 0건이라 사용자 프로젝트와 무관. per-repo `.ditto/knowledge/adr/`가 이미 올바른 층. 현재 불필요. 기각(철회조건에 부활 조건 명시).
