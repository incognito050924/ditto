# DITTO 기능 매핑 — 백서 ↔ 현재 구현

> **이 문서의 위치**: [DITTO-whitepaper.md](./DITTO-whitepaper.md)가 정의한 *철학·4축·개념·불변식*을 현재 하네스의 실제 기능(39개 CLI 커맨드)과 [../features/](../features/) 상세 문서에 연결한다. 재설계 시 "이 철학은 지금 무엇이 실현하고 있으며, 그것을 어떻게 다시 지을 것인가"를 한눈에 보기 위한 다리다.
> **표기**: 각 매핑에 재설계 방침을 붙였다 — **[보존]** 역할을 반드시 유지, **[재배선]** 역할은 유지하되 구현을 갈아끼움, **[통합/정리]** 여러 표면으로 흩어진 것을 합칠 후보.
> **권위**: 기능의 실제 동작은 각 `../features/*.md`가 가리키는 `파일:라인`이 원본이다. 이 표는 요약이며 drift할 수 있다(기준 커밋 c2d2e16).

---

## 1. 기능 4축 → 커맨드 (ADR-0010 순차 파이프라인)

| 축 | 목적 | 주 커맨드(스킬) | 상세 문서 | 재설계 방침 |
|---|---|---|---|---|
| **① 의도 파악·동기화** | 착수 전 의도 잠금 | `deep-interview`, `prism`, `coverage` | [deep-interview](../features/deep-interview.md) · [prism](../features/prism.md) · [coverage](../features/coverage.md) | [보존] 이중 게이트(readiness ∧ 사용자 확인)·반편향·pre-mortem front-load |
| **② 자율 실행 오케스트레이션** | 의도→코드, 끝까지 | `autopilot`, `work`, `verify`, `run` | [autopilot](../features/autopilot.md) · [work](../features/work.md) · [verify](../features/verify.md) · [run](../features/run.md) | [보존] no-auto-pick·materialize≠drive·완료 게이트 / [재배선] 노드 그래프·저장 |
| **③ E2E 테스트** | 의도대로 됐는지 실브라우저 확인 | `e2e`, `journey-author` | [e2e](../features/e2e.md) · [journey-author](../features/journey-author.md) | [보존] 사람 선언+에이전트 변환+게이트 검증 / [재배선] 변환기·강등 경로 |
| **④ 지식 베이스** | 매 변경을 프로젝트 메모리로 | `knowledge`, `memory`, `bridge` | [knowledge](../features/knowledge.md) · [memory](../features/memory.md) · [bridge](../features/bridge.md) | [보존] provenance·freshness 2축·propose→approve→project |

> **두 층위 주의**: 위 표의 커맨드는 축(목적 기둥)의 *현재 realization*이다. 재설계에서 축은 보존, 커맨드 구성은 교체 대상. (ADR-0010 D3)

---

## 2. 철학 원칙 → 그것을 집행하는 기능·게이트

백서 §4의 12원칙이 현재 어디서 *코드로 집행*되는지. 재설계에서 "이 원칙을 무엇이 강제하는가"의 청사진.

| 원칙 (§4) | 집행 표면 | 상세 문서 | 비고 |
|---|---|---|---|
| ①의도 먼저 / ②모호함 드러냄 | deep-interview 이중 게이트, prism 설계문서 | [deep-interview](../features/deep-interview.md) · [prism](../features/prism.md) | 착수 전 질문 소진 |
| ③최소 검증 구현 / ④외과적 변경 | change-contract forbidden_scope, PreToolUse 훅, minimal-increment self-check | [change-contract](../features/change-contract.md) · [hook](../features/hook.md) | 변경 범위 집행 |
| ⑤증거로만 완료 | completion contract, verify, autopilot 완료 게이트 | [verify](../features/verify.md) · [autopilot](../features/autopilot.md) | final_verdict=pass 조건 |
| ⑥무축소 | 종료 완전성 게이트(ADR-20260710), work item 단위 | [work](../features/work.md) · [autopilot](../features/autopilot.md) | in-scope 잔여 축소 차단 |
| ⑦반론은 협업 | dialectic(Producer/Opponent/Synthesizer), interview dissent | [deep-interview](../features/deep-interview.md) | Opponent=다른 맥락 |
| ⑧결정 책임 분리 / commit·push | Stop 훅 완료·landed 검증, push-gate | [push-gate](../features/push-gate.md) · [hook](../features/hook.md) | push=user-gated |
| ⑨위임으로 컨텍스트 보호 | context packet, 서브에이전트 격리, fresh-context 리뷰 | [context](../features/context.md) · [review](../features/review.md) | 검증 유효성 조건 |
| ⑩ADR 충돌 드러냄 | decision-conflict 라우팅, Stop 훅 fail-closed | [decision-conflict](../features/decision-conflict.md) | method vs intent 분류 |
| ⑪권위는 코드에 | classify(문서 위생), bridge sha 마커, doctor drift 검출 | [classify](../features/classify.md) · [bridge](../features/bridge.md) · [doctor](../features/doctor.md) | drift 검출 |
| ⑫시드·핸드오프=의도 상태 | handoff(pull), 교정적 프레이밍 | [handoff](../features/handoff.md) | 축자 보존 |

---

## 3. 핵심 개념 → 구현 위치

백서 §6 개념이 현재 어느 커맨드·스키마에 산다.

| 개념 | 현재 구현 | 상세 문서 |
|---|---|---|
| work item / Record·Run 2-tier | `work` + work-item-store / run-store | [work](../features/work.md) · [run](../features/run.md) |
| intent lock | `deep-interview` → intent.json | [deep-interview](../features/deep-interview.md) |
| pre-mortem / coverage taxonomy | `coverage` (list/add/discover) | [coverage](../features/coverage.md) |
| autopilot / no-auto-pick / defect carve-out | `autopilot` (loop·graph·dispatch·gates) | [autopilot](../features/autopilot.md) |
| completion contract / verdict / unverified | `verify` + completion-store | [verify](../features/verify.md) |
| oracle / reviewer output | `review` + reviewer 노드 | [review](../features/review.md) |
| context packet / handoff | `context` / `handoff` | [context](../features/context.md) · [handoff](../features/handoff.md) |
| dialectic | dialectic 스킬(Producer/Opponent/Synthesizer) | (스킬 — 커맨드 없음) |
| ACG governance | `architecture`·`change-contract`·`impact`·`boundary`·`fitness`·`semantic`·`acg-review`·`change-map` | §4 참조 |
| decision-conflict | `decision-conflict` | [decision-conflict](../features/decision-conflict.md) |
| memory graph / freshness 2축 | `memory` (build·scan·query·project) | [memory](../features/memory.md) |
| glossary·ADR / knowledge | `knowledge` (glossary·adr-new·adr-check) | [knowledge](../features/knowledge.md) |
| Journey DSL | `journey-author` · `e2e` | [journey-author](../features/journey-author.md) · [e2e](../features/e2e.md) |
| 정적분석 단일 엔진 | `codeql` (impact·boundary·fitness·semantic 공유) | [codeql](../features/codeql.md) |

---

## 4. 거버넌스(ACG) 계층 → 커맨드

백서 §6의 ACG는 여러 커맨드로 실현된다. 재설계에서 "변경을 아키텍처 계약에 대어 막는다"는 역할은 [보존], CodeQL 단일 엔진 선택은 [재배선] 후보.

| ACG 요소 | 커맨드 | 상세 문서 | 역할 |
|---|---|---|---|
| 아키텍처 스펙(관측 vs 비준) | `architecture` (propose/ratify) | [architecture](../features/architecture.md) | 규칙 원본 |
| 변경 계약 | `change-contract` (ICL→계약) | [change-contract](../features/change-contract.md) | PreToolUse 집행 입력 |
| 영향 그래프 | `impact` (CodeQL 관계추출) | [impact](../features/impact.md) | 변경 영향집합 |
| 경계 위반 | `boundary` (CodeQL 엣지) | [boundary](../features/boundary.md) | 모듈 경계 |
| 적합성 함수 | `fitness` (provider별 verdict·drift) | [fitness](../features/fitness.md) | 아키텍처 적합성 |
| 시맨틱 호환성 | `semantic` (타입안전≠의미안전) | [semantic](../features/semantic.md) | API 호환성 |
| 리뷰 원장 | `acg-review` (severity→risk 사영) | [acg-review](../features/acg-review.md) | 증거 없는 고위험 차단 |
| 변경 맵 뷰 | `change-map` (텍스트=정본) | [change-map](../features/change-map.md) | read-only 렌더 |
| 정적분석 엔진 | `codeql` | [codeql](../features/codeql.md) | 위 6개가 공유 |

---

## 5. 아키텍처 불변식 → 현재 실현 위치

백서 §7의 12불변식이 현재 어디서 성립하는지. **재설계는 이 불변식을 먼저 스키마/게이트로 못박는 것부터 시작한다(백서 §8-4).**

| 불변식 (§7) | 현재 실현 | 상세 문서 |
|---|---|---|
| 1. 완료 = 모든 AC evidence pass | completion contract, autopilot 완료 게이트 | [verify](../features/verify.md) · [autopilot](../features/autopilot.md) |
| 2. 무축소를 코드로 | 종료 완전성 게이트 | [work](../features/work.md) |
| 3. fail-closed 게이트 | push-gate, decision-conflict, pre-mortem 승격 | [push-gate](../features/push-gate.md) · [decision-conflict](../features/decision-conflict.md) |
| 4. fresh context 검증 | 서브에이전트 위임, reviewer 노드 | [review](../features/review.md) · [autopilot](../features/autopilot.md) |
| 5. 증거는 참조로 | evidence path/hash/preview | [verify](../features/verify.md) |
| 6. 우아한 강등 | e2e no-browser fallback, codeql 부재 degrade | [e2e](../features/e2e.md) · [codeql](../features/codeql.md) |
| 7. 호스트/프로바이더 절연 | seam + 호스트 위임, dual-host | [autopilot](../features/autopilot.md) · [memory](../features/memory.md) |
| 8. tier 격리 / session-rooting | init 3계층, worktree, workspace | [init](../features/init.md) · [worktree](../features/worktree.md) · [workspace](../features/workspace.md) |
| 9. 스키마가 SoT | 전 커맨드가 src/schemas 소비 | (전역) |
| 10. push user-gated / commit agent-owned | push-gate, Stop 훅 | [push-gate](../features/push-gate.md) · [hook](../features/hook.md) |
| 11. 메타-도구 사용자 환경 적합 | (부채 — §7 매핑 참조) | (재설계 대상) |
| 12. 언어-중립 어휘 | self-check lint | (스킬·훅) |

---

## 6. 기층(substrate) → 배달·운영 커맨드

백서 §5-1 "기층 4축(Hooks/Skills/Agents/State)"과 배포·운영을 실현하는 커맨드. **재설계에서 이 층 전체가 교체 대상이다** — 기능 4축을 타겟에서 살아있게 배달하는 방식일 뿐.

| 기층 역할 | 커맨드 | 상세 문서 |
|---|---|---|
| 훅 디스패치(트리거) | `hook` (session-start·prompt·pre/post-tool·stop) | [hook](../features/hook.md) |
| 설치·구성 | `init`·`setup`·`uninstall` | [init](../features/init.md) · [setup](../features/setup.md) · [uninstall](../features/uninstall.md) |
| 진단·교정 | `doctor` (drift 검출 + --fix) | [doctor](../features/doctor.md) |
| 모드·배포 | `mode`·`release` | [mode](../features/mode.md) · [release](../features/release.md) |
| 배포 게이트 | `push-gate` | [push-gate](../features/push-gate.md) |
| 외부 연계(백로그 SoT) | `github` | [github](../features/github.md) |
| 문서 위생 | `classify`·`cleanup` | [classify](../features/classify.md) · [cleanup](../features/cleanup.md) |
| 코드 정리(Tidy) | `refactor` | [refactor](../features/refactor.md) |
| 병렬 개발 격리 | `worktree`·`workspace` | [worktree](../features/worktree.md) · [workspace](../features/workspace.md) |

---

## 7. 재설계에서 고칠 부채 → 영향받는 커맨드

백서 §8-3의 7개 구조 부채가 어느 기능에서 관측됐는지. 재설계는 이것들을 *설계로* 배제한다.

| 부채 (§8-3) | 관측된 커맨드(예) | 근거 문서 §6/§7 |
|---|---|---|
| 1. 의도↔구현 drift | context·refactor·change-contract·e2e·codeql | 각 문서 §6 |
| 2. CLI 표면 ≠ 소비 경로 | decision-conflict·review·refactor·prism | 각 문서 §6 |
| 3. 공유 원장 다중 producer 덮어쓰기 | acg-review·review·boundary·codeql | [acg-review](../features/acg-review.md) §7 |
| 4. 락 없는 store write 동시성 | deep-interview·work·architecture·journey-author | 각 문서 §7 |
| 5. 가치가 코드 아닌 절차에만 | deep-interview(반편향) | [deep-interview](../features/deep-interview.md) §6 |
| 6. enum·taxonomy lockstep 중복 | autopilot(resolvability)·coverage(카테고리 수) | [autopilot](../features/autopilot.md) §6 |
| 7. 비-JS/비-java 침묵 강등 | change-contract·boundary·impact | 각 문서 §7 |

---

## 8. 이 매핑을 읽는 순서 (재설계 팀용)

1. [DITTO-whitepaper.md](./DITTO-whitepaper.md) §2~§4 — 왜 존재하고 무엇을 지키는가.
2. 이 문서 §1~§3 — 그 철학이 지금 무엇으로 실현되는가.
3. [DITTO-whitepaper.md](./DITTO-whitepaper.md) §7 + 이 문서 §5 — 반드시 코드로 못박을 불변식.
4. [DITTO-whitepaper.md](./DITTO-whitepaper.md) §8-3 + 이 문서 §7 — 이번에 고칠 부채.
5. 필요할 때 [../features/](../features/)의 개별 문서로 내려가 `파일:라인` 근거를 확인.
