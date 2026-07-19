# DITTO 기능 해부 (재설계용 코드 설명 인덱스)

> **문서 성격**: 각 CLI 커맨드의 설계 의도·데이터 흐름·코드 인과·잠재 위험을 재설계 관점에서 분해한 코드 설명 문서 묶음이다.
> **권위는 코드에 있다(헌장 §4-11)**: 이 문서들은 코드 변경에 자동 동기화되지 않는다. 기준 커밋은 대체로 `c2d2e16`(2026-07-19)이며, 시간이 지나면 실제 코드와 어긋날 수 있다. 사실을 확인할 때는 문서가 가리키는 `파일:라인`을 직접 열어라.
> **범위**: `ditto` CLI 39개 top-level 커맨드 = 39개 문서. 각 문서는 동일한 7절 규격(의도→위치→데이터흐름→개념/ADR→코드분해→정합→위험)을 따른다.

---

## 읽는 법

DITTO는 코딩 에이전트의 작업을 오케스트레이션하는 계층이다. 기능은 **4개 기능축**(ADR-0010: 의도·오케스트레이션·E2E·지식)과, 그 위·아래를 받치는 **거버넌스(ACG)·배포·운영** 표면으로 나뉜다. 아래 지도 순서대로 읽으면 시스템 전체가 한 흐름으로 이어진다.

큰 그림 한 줄: **요청(모호) →〔의도축〕으로 잠그고 →〔오케스트레이션축〕으로 증거와 함께 구현하고 →〔E2E축〕으로 사용자 여정을 검증하고 →〔지식축〕으로 결정을 남기고 → 〔거버넌스〕게이트를 통과해야 push한다.** 그 전 과정을 〔배포·운영·훅〕이 받친다.

---

## ① 의도축 — 요청을 검증 가능한 목표로 잠근다

모호한 요청을 편향 없이 구조화해 acceptance criterion으로 굳히는 단계. "무엇을 만들지"를 사용자와 합의한다.

| 문서 | 한 줄 |
|---|---|
| [deep-interview](./deep-interview.md) | 소크라테스식 질문 fan-out → 게이트 점수화 → 답-따라 가지치기 → dissent → pre-mortem. 이중 게이트(readiness ∧ user_confirmation)로 의도를 잠근다 |
| [prism](./prism.md) | 모호한 요청 → 인터뷰 → 평문 설계문서 → 승인된 work item 분할 → intent 컴파일. tech-spec을 진화·대체(alias) |
| [coverage](./coverage.md) | pre-mortem far-field 카테고리 택소노미(23개). 이진 관련성 게이트로 관련 카테고리만 sweep, discover로 갭 카테고리 탐색 |
| [decision-conflict](./decision-conflict.md) | ADR 충돌을 kind×level×mode로 결정론 라우팅(align/justify/ask_user/block). method는 에이전트가 따르고 intent는 사용자에게 |
| [context](./context.md) | work item을 서브에이전트 위임용 마크다운 packet으로 투영(§4-9 위임 계약 산출물) |

## ② 오케스트레이션축 — 증거로만 완료를 말한다

잠근 의도를 노드 그래프로 펼쳐 owner 서브에이전트에 위임하고, 실패를 분류하며, acceptance criterion마다 증거로 닫을 때까지 자율 구동한다.

| 문서 | 한 줄 |
|---|---|
| [autopilot](./autopilot.md) | **엔진 본체.** 노드 그래프 → ready 선택 → owner 위임 → 증거 수집 → 실패 분류 → 완료 게이트 루프. no-auto-pick·materialize≠drive·결함 carve-out·per-AC oracle∧barrier·종료 완전성 불변식 |
| [work](./work.md) | work item 생명주기. Record(공유·커밋)/Run(개인·폐기) 2-tier, 경량/무거운 2경로, 18개 서브커맨드 |
| [verify](./verify.md) | `--` 뒤 명령을 실제 실행해 exit code로 AC verdict 기록 → completion contract로 닫음(경량 경로 증거 사슬) |
| [run](./run.md) | provider(외부 코딩 에이전트) 실행을 감사 가능한 run manifest로 남김(record=사후 / with=직접 spawn 자동 포착) |
| [refactor](./refactor.md) | ACG unit-scoped standing-code tidy 측정 표면(Tidy First). 현재는 provider 부재로 diff-only 판정 전용 |
| [review](./review.md) | 아키텍처 unit 단위 리뷰의 결정적 seam. 범위해석·집계·원장기록만 하고 실제 리뷰는 reviewer 노드가 수행 |
| [handoff](./handoff.md) | pull 방식 세션/work item 인계(auto-inject 금지, list→consume). 의도 축자 보존 |
| [worktree](./worktree.md) | work item별 격리 worktree로 병렬 개발. session-rooting·per-feature ephemeral·origin-land |
| [workspace](./workspace.md) | recipe의 repos[]를 클론하고 push-gate 훅을 심음. 4대 안전 게이트 + session-rooting invariant |

## ③ E2E축 — 사용자 여정을 실제로 검증한다

사용자 가치를 여정으로 저작하고, 실브라우저로 확인 가능한 스펙으로 컴파일한다.

| 문서 | 한 줄 |
|---|---|
| [e2e](./e2e.md) | 일회성 실브라우저 `run` + 저작 파이프라인(DSL→plan→generate→conformance/mapping 게이트→verify). 공식 Playwright generator, 무브라우저면 강등 |
| [journey-author](./journey-author.md) | 스토리·여정을 대화로 저작 → per-entity 카탈로그 + v2 journey DSL 컴파일. DSL→Playwright는 e2e로 인계 |

## ④ 지식축 — 결정을 drift 없이 남긴다

용어·결정·관계를 코드 곁 살아있는 지식으로 큐레이션하고, 코드↔SoT 신선도를 추적한다.

| 문서 | 한 줄 |
|---|---|
| [memory](./memory.md) | cross-entity 메모리 그래프. provenance·freshness 캐리, propose→approve→re-projection, 호스트-위임 LLM 추출, 신선도 2축 |
| [knowledge](./knowledge.md) | glossary 승격 + ADR(불변 파일명) + knowledge-record + CLAUDE.md projection. adr-check 게이트 |
| [bridge](./bridge.md) | AGENTS.md→CLAUDE.md 단방향 투영 + 지식 요약 투영. 정규화 sha256 마커로 drift 검출 |

## ⑤ 거버넌스 (ACG) — 변경을 아키텍처 계약에 대어 막는다

ACG(Architecture/Change Governance)는 모든 코드베이스용 변경 거버넌스로, 스펙/바인딩 2계층이며 DITTO가 첫 바인딩이다. 정적 사실은 CodeQL 단일 엔진(ADR-0006)에서 나온다.

| 문서 | 한 줄 |
|---|---|
| [architecture](./architecture.md) | ArchitectureSpec 제안(propose)·비준(ratify). 관측(agent candidate) vs 규칙(사람 비준) 분리 |
| [change-contract](./change-contract.md) | ICL(.icl)→ChangeContract 컴파일. PreToolUse 훅의 forbidden_scope 집행 입력 생성 |
| [impact](./impact.md) | 한 심볼의 영향집합을 CodeQL 관계추출로 ImpactGraph 산출. default-deny journey 불변식 |
| [boundary](./boundary.md) | 모듈/패키지 경계 위반을 CodeQL 엣지로 검출. internal_packages 선언 + JVM 가드 |
| [fitness](./fitness.md) | 적합성 함수를 provider별(codeql/command/executed/injected) 실행해 verdict·drift 산출 |
| [semantic](./semantic.md) | 시맨틱 호환성 스캔("타입 안전 ≠ 의미 안전"). blocking 판정 vs non-gated 관측 분리 |
| [change-map](./change-map.md) | ChangeContract·ImpactGraph·ReviewGraph를 텍스트(정본)·mermaid·json으로 렌더링하는 read-only 뷰어 |
| [acg-review](./acg-review.md) | reviewer-output을 severity→risk 어댑터로 위험 원장에 사영. "증거 없는 고위험"이 완료 차단 |
| [codeql](./codeql.md) | 유일 정적분석 엔진. 보안/dataflow 원장 경로 + impact/boundary/semantic 공유 관계추출 경로 |

## ⑥ 배포·운영·훅 — 전 과정을 받친다

| 문서 | 한 줄 |
|---|---|
| [hook](./hook.md) | 호스트 훅 6종 디스패처(session-start/user-prompt-submit/pre·post-tool-use/pre-compact/stop). PreToolUse 가드 + Stop 완료 게이트. fail-open/fail-closed 2층 |
| [init](./init.md) | .ditto 디렉터리 scaffold + 3계층(제품/전역/개인) 경로 배치 |
| [setup](./setup.md) | @clack TUI + recipe.yaml 비대화 로더 + provisioner(LSP·playwright·codeql). 도구 부재 우아한 강등 |
| [uninstall](./uninstall.md) | setup 역과정. marker/charter sha로 "심은 것만" 추적 strip, 사용자 내용 절대 보존 |
| [doctor](./doctor.md) | drift 검출 9종 + 측정 판독 4종. `--fix`는 가역 3종만(검출↔교정 분리) |
| [mode](./mode.md) | 세션이 작업트리(dev) vs 설치본 중 무엇을 로드했는지 + STALE 여부 + 배포 액션 판정 |
| [push-gate](./push-gate.md) | push 전 완료·landed·개인tier 자기검증 게이트. fail-closed·override-only·ROOT-ONLY 신뢰·green 캐시 |
| [github](./github.md) | GitHub 연계. SoT 3층(보드=백로그 read, 완료=ditto write), claim=advisory lock, allow-list 리댁션 |
| [release](./release.md) | 도그푸딩 전용 릴리스 컷터. fail-closed 게이트 + build-stamp + 커밋된 bin/ditto = 배포 산출물 |

---

## 재설계 시 반복해서 나타난 교차 패턴

39개 문서를 각각 fresh context로 분해하면서 **여러 커맨드에 공통으로 나타난 구조적 위험**이 드러났다. 재설계할 때 개별 기능보다 먼저 다뤄야 할 시스템 수준 문제다.

1. **설계 의도 ↔ 구현의 drift가 흔하다.** 개념 정의가 코드보다 넓거나(context packet 8필드 vs 5섹션), 커맨드 description·주석이 실제 동작을 잘못 안내한다(refactor의 "auto-commit" 미구현, change-contract의 "fitness 미저장" 반대, codeql `--probe` vs `--build-verified`, ADR-20260702가 가리키는 e2e 경로 4개 전부 부재). → 재설계는 "문서·주석이 가리키는 코드 경로가 실재하는지"를 게이트로 삼을 만하다.

2. **CLI 표면과 실제 소비 경로의 분리.** 여러 커맨드(decision-conflict gate, review, refactor, prism 컴파일)는 CLI를 직접 부르는 소비자가 없고, 파이프라인은 내부 함수·다른 커맨드를 탄다. "CLI를 부르면 차단된다"는 오해를 부른다. → 결정적 seam(측정·기록)과 실제 게이트(훅·loop)를 재설계에서 명시적으로 층 분리할 것.

3. **공유 원장 파일을 여러 producer가 full-replace로 덮어쓴다.** `work-items/<wi>/acg-review.json`을 acg-review·review·codeql·boundary 4곳이 병합 없이 교체 → 마지막 writer가 이김. 실행 순서·소유권이 정적으로 불명확. → 원장은 append/merge 또는 producer별 네임스페이스로.

4. **락 없는 store write = 동시 세션 last-write-wins.** InterviewStore·work-item runs append·architecture-spec·journey 카탈로그 등 다수가 full-replace write에 락이 없다. 공유트리 동시 autopilot에서 턴/데이터 유실 가능(push-gate flake로 이미 관측됨). → 동시성 모델을 시스템 차원에서 결정할 것.

5. **핵심 가치가 코드가 아니라 SKILL 절차에만 사는 지점.** deep-interview의 반편향·anti-context-rot는 CLI가 강제하지 못하고 드라이버 절차에 의존한다(delegation-enforcement-boundary ADR과 정합이지만, 코드로 집행 불가라는 뜻이기도 하다). → 무엇을 코드로 강제하고 무엇을 규율로 둘지의 경계를 재설계에서 재확인.

6. **enum·taxonomy의 수동 lockstep 중복.** resolvability enum(2곳 inline), coverage 카테고리 수(코드 23 vs ADR/기록 19), LSP 감지↔registry↔resolve 3자 lockstep 등이 자동 동기화 장치 없이 주석 규율에만 의존. → 단일 SoT로 수렴.

7. **비-JS/TS·비-java 스택에서의 침묵 강등.** change-contract symbol 확장이 `javascript`/`src` 하드코딩, boundary kotlin buildless 거짓 깨끗함, impact analyzer가 dynamic_call/reflection 등 미충족. dogfood 스택 편의가 계약으로 굳으면 메타-도구 원칙([[feedback_metatool_user_project_fit]])과 충돌. → 언어-중립성을 재설계 불변식으로.

> 위 7개는 개별 문서 §6(정합)·§7(위험)에 각각 `파일:라인` 근거와 함께 적혀 있다. 재설계 착수 전 이 인덱스에서 해당 문서로 들어가 근거를 확인하라.
