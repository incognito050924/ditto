# autopilot — 하나의 work item 노드 그래프를 사람 개입 없이 완료까지 구동하는 오케스트레이션 엔진

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋 `c2d2e16`, 작성일 2026-07-19.

---

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`autopilot`은 DITTO 4축 중 **오케스트레이션 축**(ADR-0010)의 본체다. deep-interview가 의도를 잠그고(intent.json), 이 엔진이 그 의도를 **검증된 완료**까지 자율 구동한다.

푸는 문제와 채택한 개념:

- **문제**: LLM 에이전트에게 "이 work item 끝내"를 통째로 맡기면 (a) 범위를 조용히 줄이고, (b) 증거 없이 "됐다"고 선언하며, (c) 컨텍스트가 쌓일수록 판단이 자기 서사로 편향된다.
- **해법의 뼈대**: work item을 **typed node 그래프**로 분해하고(design→implement→verify 등), 오케스트레이터(main agent)는 **선택·위임·분류·평가만** 하고 **콘텐츠는 절대 생성하지 않는다**(`skills/autopilot/SKILL.md:14`). 각 노드의 실제 작업은 격리된 컨텍스트의 **owner 서브에이전트**가 수행한다.
- **핵심 불변식**: `root_goal`은 절대 쪼개지 않고 노드만 쪼갠다(`autopilot.ts:226` 스키마 `.describe`). 완료는 그래프가 terminal이 됐다는 사실이 아니라 **AC별 oracle 충족 + 증거**로만 판정한다(§6.8; graph done ≠ acceptance closed).

**에이전트-인-더-루프 모델**: headless `autopilot run`은 존재하지 않는다. CLI는 한 턴에 한 번 `next-node`(다음에 무엇을 할지 결정)와 `record-result`(그 결과 수집)를 호출하는 **순수한 단일-스텝 함수**를 노출하고, 그 사이에서 LLM owner가 위임 packet을 실행한다. 이 분업은 의도적이다 — 스폰(Task)은 main agent의 행동이라 코드가 관측할 수 없으므로, 엔진은 결정론적 게이트만 소유하고 판단은 owner/driver에 맡긴다.

---

## 2. 코드 위치와 진입점

핵심 파일(경로 + 한 줄 역할):

| 파일 | 역할 |
|---|---|
| `src/cli/commands/autopilot.ts` | CLI 진입. 16개 서브커맨드를 core 함수에 배선 (2084행) |
| `src/core/autopilot-loop.ts` | 루프의 심장. `nextNode`(1048)·`recordResult`(2698)·`executeTestBarrier`(910) (4251행) |
| `src/core/autopilot-graph.ts` | 그래프 순수함수: 노드 선택·전이표·file-overlap 게이트·프로모션 |
| `src/core/autopilot-driver.ts` | mutationGate(승인 소비)·rollbackOnRejection·allNodesTerminal |
| `src/core/autopilot-dispatch.ts` | 위임 packet 빌드·OWNER_TOOLS·child-result 가드 6종·decideOnFailure |
| `src/core/autopilot-store.ts` | 그래프 유일 mutator + append-only 결정 로그(`autopilot-decisions.jsonl`) |
| `src/core/autopilot-bootstrap.ts` | intent.json → 초기 그래프 생성(승인 게이트·seed 노드) |
| `src/core/autopilot-approval.ts` | approve/reject 순수 전이 + 승인 아티팩트 렌더 |
| `src/core/autopilot-complete.ts` | done→completion 브리지: AC별 verdict 도출·배리어 fold·frozen 무결성 |
| `src/core/autopilot-converge.ts` | 전진 재확장 planner(수정+재검토 라운드)·결함 분류기 |
| `src/core/autopilot-tidy.ts` | green implement 뒤 tidy 서브체인 결정(순수) |
| `src/core/autopilot-cleanup.ts` | driver-owned cleanup 노드(worktree 철거, irreversible 게이트) |
| `src/core/chain-drive.ts` | `ditto work chain drive` — follows-줄기 멤버 순차 구동 |
| `src/core/gates.ts` | 결정론적 게이트 전부(승인·완료·증거·종료완전성·intent-drift) |
| `src/core/convergence-store.ts` · `completion-store.ts` | convergence.json · completion.json 사이드카 |
| `src/schemas/autopilot.ts` | 그래프 스키마(SoT, ADR-0002) |
| `src/schemas/completion-contract.ts` · `convergence.ts` · `owner-return-envelope.ts` · `reviewer-output.ts` | 계약 스키마 |

**서브커맨드**(`autopilot.ts:2066-2083`):

| 커맨드 | 하는 일 |
|---|---|
| `bootstrap` | intent.json에서 그래프 생성, WI를 in_progress로 승격 |
| `next-node` | 다음 루프 액션 계산(노드 선택·승인 소비·dispatch) |
| `record-result` | owner 결과 수집: 가드→분류→결정→영속화 |
| `complete` | 완성 그래프에서 completion contract 조립(증거 게이트) |
| `status` | 그래프/진행 상태 조회 |
| `approve` / `reject` | pending 승인 게이트 전이 |
| `exempt` | 게이트 예외 처리 |
| `revise` | direction-fork 지점에서 같은 WI 재구동(새 노드 id) |
| `reopen` | passed implement 노드를 사용자 피드백으로 재개 |
| `cleanup` | driver cleanup 노드 실행(gated worktree 철거) |
| `propose-e2e` | 웹 표면 변경 시 e2e 저작 제안 대화 기록 |
| `intent-drift` | AC id-set 보존 자기점검 |
| `coverage-next` / `coverage-round` / `coverage-report` | plan 단계 pre-mortem coverage sweep |

주요 CLI 인자: `--workItem`(필수, 모든 커맨드), `bootstrap`의 `--riskNonLocal/--riskIrreversible/--riskUnaudited`(승인 게이트 구동)·`--e2e`(entry-phase e2e-author 노드 시드)·`--approvedSource`, `record-result`의 `--json`(recordResultPayload 스키마), 모든 커맨드의 `--output human|json`.

---

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

상태 파일은 전부 개인 tier(gitignored) `.ditto/local/work-items/<wi>/` 아래에 산다(`ditto-paths.ts:24` `localDir`):

- `autopilot.json` — 그래프 상태. 유일 writer는 `AutopilotStore`(`autopilot-store.ts:190`).
- `autopilot-decisions.jsonl` — append-only 결정 로그(재시도·전환·escalate·loop 종료·방향포크 등).
- `convergence.json` — per-target 수렴 사이드카(argmax·open-admissible·converged 플래그).
- `completion.json` — 완성 계약.
- `active-leases.json` — 현재 dispatch된 노드의 리스(PreToolUse가 읽어 in-scope 편집만 허용).
- `approval/plan-approval.md` — authored red-test 승인 아티팩트.

전체 흐름:

```
intent.json (deep-interview 산출)
   │  bootstrap: acceptanceTestable 게이트 통과 → WI in_progress 승격 + AC 미러
   ▼
autopilot.json  (design → [e2e-author] → [test-author] → implement → verify + test-barrier)
   │
   │  ── 루프(main agent가 반복) ──────────────────────────
   │   next-node ──▶ 액션(spawn/spawn_wave/present_plan/cleanup/main_session/barrier/done/…)
   │       ▲                                    │
   │       │                          owner 서브에이전트 실행
   │       │                                    ▼
   │   record-result ◀── owner 결과(recordResultPayload) → 가드→분류→전이→append 결정
   │       └── planner 프로모션 / tidy 스플라이스 / 전진 재확장 / 결함 체인구동
   ▼
allNodesTerminal → action:'done'{all_passed, disposition}
   ▼
complete: assembleCompletionFromGraph → completion.json (final_verdict) → WI 미러 → done flip
```

`bootstrap`(`autopilot-bootstrap.ts:182`)은 **intent의 AC**(readied set)로 그래프를 짜고, 그 AC를 work-item.json에 미러한다(`:234`) — completion이 WI에서 AC를 읽으므로 미러가 없으면 더 적은 AC를 평가해 false-green이 난다(gate↔score 일관성). 시드 노드 체인은 `buildInitialNodes`(`autopilot-graph.ts:263`, design→implement→verify)에 선택적 e2e-author·test-author·test-barrier가 얹힌다(`autopilot-bootstrap.ts:252-265`).

---

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### 4-1. 완료 통화 = per-AC oracle ∧ test-barrier (ADR-0024, ADR-20260708)

완료는 "테스트 green"이 아니라 "**모든 AC가 재평가 가능한 oracle로 닫힘**"이다. oracle은 3종(`oracleSatisfaction`, `gates.ts:573`): `dynamic_test`(실행 증거), `static_scan`(재스캔 증거), `soft_judgment`(리뷰 판단). test-barrier는 완료의 **한 요소**일 뿐 통화 자체가 아니다 — barrier green이어도 static/soft oracle이 안 닫히면 AC는 안 닫힌다(ADR-20260708 D2). "실행 테스트=유일 수렴 화폐"는 ADR-0024가 **명시 기각**한 대안이다(정적·soft oracle 부류 누락).

barrier tier 경계(ADR-20260708 D1/D3): barrier는 **side-effect-free 유닛/목 서브셋 전용**. 실 DB·네트워크·공유 fixture를 건드리는 통합/E2E는 barrier 범위 밖 — 각각 push-gate·CI·`ditto e2e` 소관(중복 구축=drift, §4-11). barrier 실행불가 시 "passed"로 날조하지 않고 degrade-to-unverified하고 진행한다(D4, ADR-0018).

### 4-2. no-auto-pick / materialize≠drive 불변식 (ADR-20260627)

autopilot이 한 WI를 done flip한 뒤, 그 run이 만든 out-of-scope 후속은 **물질화만 하고 자동 구동하지 않는다**. per-WI 승인 + deep-interview 의도잠금이 자율성의 통제 경계다. dialectic(Producer=Claude/Opponent=Codex)이 "same-session 자동 체인 구동" 초안을 코드로 반증해 revise 판정했다 — run-materialized 후속은 placeholder AC로 생성되고 intent.json이 없어 자동 구동 대상이 사실상 공집합이며(`work.ts:1099-1106`), 자동 구동하려면 의도잠금 게이트를 우회해야 한다. 기각 대안: `no-auto-pick` 완화(틀린 레버 — 목표는 못 이루고 통제 경계만 무너뜨림).

### 4-3. 종료 완전성 게이트 (ADR-20260710)

pass-close는 **in-scope agent-owned 잔여를 조용히 떨어뜨릴 수 없다**. terminal flip은 Stop 훅의 잔여 게이트를 우회하므로(flip이 NON_TERMINAL 가드를 건드림), `work done`과 `autopilot complete` 두 close 경로에 `passCloseResidualBlockers`(`gates.ts:357`)를 직접 배선했다. 이건 **재사용**이다 — 새 분류기를 안 만들고 Stop이 이미 쓰는 `resolvabilityBlockers`(`unverified[]`) + `riskRecordBlockers`(`remaining_risk_records[]`)를 합친다(단일 라벨공간 R11). capture≠drive는 통과 조건: 잡아둔 out-of-scope 후속은 두 잔여 표면 어디에도 안 살아 게이트가 안 건드린다. priority(D2)는 표면화 순서만 정하고 아무것도 구동하지 않는다(advisory-only).

### 4-4. 결함 클래스 carve-out — 재현 실동작 버그만 same-run 구동 (ADR-20260714)

ADR-20260627/20260710의 유일 예외. autopilot이 구동 중 발견한 버그 중 **보수적 분류기(`classifyDiscoveredDefect`, `autopilot-converge.ts:73`)가 "재현되는 실동작 버그"로 판정한 것만** 자기 work item으로 물질화한 뒤 같은 run에서 done까지 체인 구동한다(각자 자기 커밋). 자격은 자유-텍스트 라벨이 아니라 **분류기 판정에 키드**된다(relabel 저항, D1): 잠복버그(현재 무피해)·기술부채·무관한 기존 실패는 자격 없고, **불확실하면 구동 안 하고 백로그로 물질화만**(fail-safe). 비-결함 후속의 materialize≠drive는 불변(D2). 두 fail-stop 조건은 예외 중에도 불변(D4): ① 정초 방향이 뒤집히거나 진행이 막힘, ② 보안·시스템·프로젝트·기능설계 의도를 위협하는 결정 — 이때는 멈추고 fail-closed handoff(우연히 발견한 보안 취약점의 자동 수정도 조건②로 인계).

### 4-5. 결정 로그 원자성 (ADR-20260628)

`appendDecision`(`autopilot-store.ts:301`)은 `appendFile(path, json+'\n', 'a')` 단일 O_APPEND 쓰기다. 파일 락 불필요 — 레코드는 작은 단일 write(수 KB), 같은 WI append는 single-writer(R7)로 직렬화되고, 교차 프로세스 동시 구동은 `active-leases.json` 리스가 차단한다. read-then-rewrite lost-update만 실제 버그였고 그건 O_APPEND가 제거했다. 기각: flock/큐(발생 안 하는 시나리오용 방어 복잡도, §4-3).

---

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### 5-1. 노드 그래프 (autopilot-graph.ts)

- **전이표**(`NODE_TRANSITIONS`, `:79`): 노드 lifecycle이 흩어진 규칙이 아니라 명시 `(status × event) → status` 표다. 엔트리 없는 전이는 loud fail(`nodeTransition`, `:103`). `retry`(running→pending, 재선택용)와 terminal `fail`(cap 소진)의 구분, `reopen`(passed→pending, tidy가 진짜 결함 발견 시 유일한 passed 탈출구)이 여기 산다.
- **ready 선택**(`selectReadyNodes`, `:123`): pending이고 모든 dep이 passed인 노드. 두 홀드 가드가 얹힌다 — (a) implement-frontier 가드: implement 노드가 하나라도 비-terminal이면 verify를 홀드(단 그 verify에 의존하는 implement가 있으면 precondition이라 면제, deadlock 방지 `:139`), (b) settled-tree 홀드: mutating(implementer-owned) 노드가 하나라도 비-terminal이면 `test` barrier를 홀드(`:161`) — barrier는 전체 스위트를 도니 fix 서브에이전트가 편집 중이면 false RED/stale GREEN이 난다.
- **file-overlap 게이트**(`fileOverlapGate`, `:237`): 같은 파일을 쓰는 두 owner는 동시 실행 금지. `file_scope`가 disjoint한 노드만 greedy admit, 나머지는 다음 wave로 직렬화. 빈 scope(read-only)는 아무것도 claim 안 하니 절대 지연 안 됨.
- **프로모션**(`proposalsToNodes` `:297` + `supersededByPromotion` `:340`): planner가 *무엇*(kind/purpose/edges/AC)만 내면 owner·기본값은 여기서 파생. 프로모션 시 seed의 N2/N3처럼 promoted subgraph가 완전 커버하는 pending 후속은 제거 대상 — 단 survivor가 의존하거나 자기 dep이 살아남으면 보존(고아 방지, 보수적 중복이 구멍보다 낫다).
- **무결성 게이트**(`validateNodeAddition`, `:413`): splice 전 순수 검사 — 중복 id·dangling dep·cycle을 loud fail. `allowedAcceptanceIds`가 주어지면 intent에 없는 AC ref를 splice 시점에 즉시 거부(scope-grow fail-fast, `:425`).

### 5-2. next-node — 다음 액션 결정 (autopilot-loop.ts:1048)

순수 단일-스텝. 게이트 순서(각 파일:라인은 loop.ts):
1. **거부-플랜 롤백**(`1056`): `approval_gate.status==='rejected'`면 running 노드를 pending으로 되돌리고(`rollbackOnRejection`, `driver.ts:90`) 투기적으로 author된 red test 삭제 → `action:'rollback'`.
2. **spec-digest staleness**(`1087`): intent가 스펙 문서에서 컴파일됐는데 그 문서가 바뀌었으면 `action:'blocked'`(재-finalize 요구).
3. **candidate 선택**(`selectReadyNodes`, `1092`).
4. **빈 ready 처리**(`1093-1210`): `pendingDoomedByFailure`가 failed dep에 막힌 pending을 blocked로 착지(무한 waiting 방지, `graph.ts:216`); `allNodesTerminal`(retro 면제, `driver.ts:111`)이면 결정 로그에서 converged/capped disposition 계산해 `action:'done'`; 아니면 `blocked`/`waiting`.
5. **file-overlap wave 게이트**(`1211`): running mutating 노드를 synthetic claim으로 시드해 새 wave와 충돌 방지.
6. **mutationGate 승인**(`1242`, `driver.ts:18`): brief 하드게이트 포함. wave-eligible 판정(`isWaveEligible`)이 driver/main-session/test kind를 제외하고 mutating 노드를 `gate.allowed`에 건다 — 단 `test-author`는 pre-approval carve-out(승인 전에 red test를 authoring해야 하니). unknown-scope mutating은 최대 1개.
7. **액션 방출**: ≥2 eligible→`spawn_wave`, `test` kind→in-process `executeTestBarrier`, `driver`→`cleanup`, `main-session`→`main_session`, mutating+게이트 닫힘→(authored test_spec면 아티팩트 렌더 후)`present_plan`, 그 외→dispatch(pending→running, lease set)+`spawn`.

**dispatch 시 부작용**(`1444-1501`): 전이 영속화, **active-node lease 설정**(`1451` — PreToolUse가 읽는 flow 신호), variant 라우팅(`selectVariantCandidates` — owner-role의 프로젝트 특화 서브에이전트 후보를 late-bind로 packet에 실음), warm-start memory 주입(fail-open `1474`), review owner엔 change-surface 1회 사전계산(`1482`), retro 노드엔 retro context 조립(`1478`), 그리고 `buildDelegationPacket`으로 packet 조립.

### 5-3. 위임 packet (autopilot-dispatch.ts:242)

6-섹션 packet(task·expected_outcome·required_tools·must_do·must_not_do·context). **Context Isolation**: driver의 가설이나 다른 노드 내부 상태는 절대 안 실린다(`:355` must_not_do). `OWNER_TOOLS`(`:92`)가 owner별 도구를 정하고, `isMutatingOwner`(`:130`)는 Edit 보유 여부로 mutating을 파생 — 승인 게이트와 packet 도구가 절대 어긋나지 않도록 단일 테이블에서 도출. `tester`에 Edit이 없는 건 load-bearing: Edit이 새면 `isMutatingOwner(tester)=true`가 되어 0-file GREEN barrier를 mutation-without-changes로 거부→완료 deadlock. 조건부 directive: planner엔 `generated_nodes` 요구, dynamic_test AC 있는 implementer엔 RED_FIRST, mid-wave implementer엔 scope-local unit(전체 스위트는 barrier가 1회 증명), test-author엔 AUTHORING(red까지만, green 금지).

### 5-4. record-result — 결과 수집 (autopilot-loop.ts:2698 → recordResultCore 2753)

노드는 running이어야 하고(`2774`), 모든 exit에서 lease 해제(`2786`). **가드 스택**(각각 claimed pass를 `fixable` fail로 강등):
- `guardChildResult`(`dispatch.ts:410`): 빈/ack-only("done") 결과 floor. 완료 *신호*는 완료 *증거*가 아니다.
- owner-return envelope 3종(`2837`): shape(`guardOwnerEnvelope`)·owner_kind 일치(`guardEnvelopeOwnerMatch` — retrospective 면제를 자기-relabel로 훔치는 것 차단)·artifact 비어있지 않음. 절대 throw 안 함(orchestrator crash 방지) — safeParse.
- `guardMutatingEvidence`(`dispatch.ts:436`): mutating pass는 `changed_files`≥1 필요. refactorer는 no-tidy가 유효하니 면제, implementer는 명시 `no_op_justification` 있을 때만 면제(조건부 제거 노드가 0-file일 때 verify 노드 deadlock 방지, wi_2607194d0).
- design pass+plan_brief는 `coverage.json` 존재 요구(`2891`), `guardAcClosingEvidence`(`2915`)는 AC-closing pass에 증거 요구, phantom-red 하드게이트(test-author, `2943`), frozen-test 무결성(`3016`).

**in-loop oracle 권위**(`3053`): passed 판정이어도 `unmetOracles`가 남으면 `sameOracleFailureCount`로 이 (노드,AC)의 과거 실패 K를 세어 `K+1 >= caps.oracle_failures_to_block`이면 block, 아니면 retry(무한 wrong-fixpoint 방지).

**실패 분류 & 라우팅**: 4클래스(`fixable`/`wrong_approach`/`blocked_external`/`user_decision_needed`)를 `decideOnFailure(klass, attempts, caps)`(`dispatch.ts:607`, loop 호출 `4206`)에 매핑 — `fixable`는 `fix < fix_per_node`면 retry 아니면 escalate, `wrong_approach`는 switch, external/user는 즉시 escalate. 결정은 전이 + append-only 로그로 기록(`4224`). cap 히트는 **non-pass**(≠ converged).

**partial-but-progressing continuation**(`4142`): fixable fail인데 oracle-green 누적 집합이 **strict 성장** 중이면 fix cap을 안 태우고 재-dispatch(`caps.progress_continuation_cap`으로 상한). green→red 회귀는 집합을 non-monotone으로 만드니 종료 보장은 이 신호에 의존하지 않고 fix-cap fail-path가 백스톱(belt+suspenders).

### 5-5. 전진 재확장 (convergence) — autopilot-converge.ts + loop 배선

review/verify/security 노드가 findings>0면 **back-edge를 안 걸고**(DAG 유지) 새 `fix`+`review` 노드를 앞으로 splice한다(`planForwardReexpansion`, `:218`). 두 층 escape: findings=0 verdict만 loop close(예산이 절대 close 못 함, §4.3), 예산 소진 시 escalate(cap-reached≠converged, pass 아님). optional 도구 부재(CodeQL/playwright)는 `blocked_external`로 surface하지 절대 `agent_resolvable`로 안 함(grounding이 external은 풀지만 agent_resolvable은 안 풀어 무한 re-verify 방지, `:231`). forward 라운드 깊이는 노드 id 마커(`.rev.r`)에서 파생(`forwardRound`/`totalForwardRounds` — driver 카운터 불신, 그래프에서 재구성). loop.ts는 review(`3202`)·reverify·risk_fix·follow_up·defect_fix 다섯 트리거를 이 한 planner로 구동(`applyAutoResolveSplice`, `2553`).

### 5-6. tidy 서브체인 (autopilot-tidy.ts + loop 2070)

green implement pass 뒤 `classifyTidyEntry`가 diff-stat로 SKIP/ENTER 결정(순수, slop은 입력 아님). ENTER면 touched code 파일당 병렬 `refactor` 노드(각자 declared file_scope로 lease 강제) + `verify` DoD-replay 노드를 planner `generated_nodes`와 **같은 splice 경로**로 스플라이스. `deriveTidyScope`(`:56`)가 change_surface∪changed_files로 diff를 스코프해 다른 세션 커밋이 spurious refactor 노드를 낳는 걸 차단(wi_260709ft1). tidy 노드가 진짜 결함을 발견하면(`tidy_bug_found`) tidy 노드를 terminal fail 처리하고 implement dep을 `reopen`으로 되돌린다(수정은 tidy가 아니라 implement 책임, `4077`).

### 5-7. test-barrier (autopilot-loop.ts:910)

`test` kind는 LLM이 아니라 **결정론적 in-process 스텝**이다 — LLM tester는 red를 green으로 합리화할 수 있으니 verdict를 명령 exit code에서만 파생한다(`autopilot-graph.ts:35` 주석). WORST-WINS collapse: RED→bounded retry(`decideOnFailure('fixable')`)→`red_retry` 아니면 terminal `red_failed`; unrunnable/timeout/missing→degrade/timeout으로 진행(passed지만 명령 증거 없음→완료가 ≠pass로 floor); all-green→명령 증거와 함께 pass.

### 5-8. 완료 조립 (autopilot-complete.ts:635)

`assembleCompletionFromGraph`가 done→completion 브리지의 본체:
- **deriveAcVerdicts**(`:213`): AC별 addressing 노드 + closing 증거를 모아 `nodeVerdictFor`(`:105`)로 판정. **false-green 보호** — passed 노드도 (a) 증거 없으면 unverified("claim≠proof"), (b) per-AC `ac_verdicts`를 worst-fold해 per-criterion non-pass가 node-level pass를 CAP(node pass가 AC non-pass를 흡수 못 함). fix-backed re-verify와 structural-unverified 두 supersession carve-out은 ordering-gated(하류 verified pass가 커버할 때만 발동).
- **3개 in-scope floor**(`:666-675`)를 병합: `testBarrierUnverified`(barrier가 green이 아니면 in-scope unverified 방출; **test 노드 0개면 구조적 grandfather로 `[]`**, legacy 그래프 무회귀; `barrier_opt_out`은 degraded barrier만 억제, RED/non-terminal은 절대 못 억제), `phantomRedUnverified`(test-author degrade), `frozenBreachUnverified`(frozen manifest 재해시; `currentTestHash` 없으면 INERT라 CLI complete 경로만 강제). 이 셋은 per-AC fold와 **독립적으로** `buildCompletion`(`completion-store.ts:48`)의 `deriveFinalVerdict`로 final_verdict를 AND floor.
- **종료 완전성 producer**: `deriveNonPassStatus`(`:610`)가 non-pass인데 그래프가 terminal/stuck-blocked면 정직한 `non_pass_status`(blocked/partial) 방출 — `nonPassTerminationGate`(`gates.ts:785`)가 이 정직한 선언을 요구한다(무인 완료 보존: 게이트가 pass를 막아도 non-pass로 착지하지 사용자를 기다리며 멈추지 않음).

`buildCompletion`(`completion-store.ts:48`)은 WI의 모든 criterion당 정확히 한 acceptance 엔트리를 만들고(completionGate가 missing/extra/dup에 안 걸림), final_verdict는 파생 — 모든 AC pass AND in-scope unverified 없음일 때만 pass. 스키마 `completion-contract.ts`가 이걸 superRefine으로 재강제(`:198`: pass인데 non-pass AC 있으면 거부, pass인데 in-scope unverified 있으면 거부).

### 5-9. gates.ts 핵심 게이트

- `acceptanceTestable`(`:175`): vague term + observable/measurable predicate 부재를 거부(단 evidence_required 있으면 통과). bootstrap의 intent-ready 게이트.
- `highRiskAssumption`(`:857`): `RiskAxes`(non_local∨irreversible∨unaudited) 셋 중 하나라도 true면 승인 필요. bootstrap 승인 게이트를 구동(`autopilot-bootstrap.ts:176`).
- `completionGate`(`:693`)·`completionEvidenceGate`(`:747`): 전자는 AC id-set 교차검증 + pass면 non-pass criterion 차단, 후자는 pass가 runnable verification에 근거하는지(ack 아님) 검사.
- `intentDriftGate`(`:1102`): AC id-set 보존 tripwire. blocking(id-set grow/shrink/invented node ref)과 non-blocking advisory(goal/root_goal 문자열 divergence — reworded re-finalize는 정당)를 분리. scope-drift 그래프는 close 못 함.
- `passCloseResidualBlockers`(`:357`): §4-3 종료 완전성. `resolvabilityBlockers`(default-DENY: agent_resolvable은 grounding으로도 절대 안 풀림)+`riskRecordBlockers` 재사용.
- `defectFixRequiresConditionB`(`:420`): §4-4 결함 구동의 fail-closed 게이트. 보안/시스템/프로젝트/기능설계 adverse 결정이 필요한 결함은 자동 구동 금지(조건② handoff).
- `convergenceGate`(`:803`): selected=max-score, converged==(completion pass ∧ open-admissible 0) 검증.

---

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위: `autopilot.ts`(CLI)·loop/graph/dispatch/store/bootstrap/converge/tidy/cleanup/approval/driver/complete/gates·convergence-store·completion-store 코어, 관련 스키마 5종, ADR 5종, `skills/autopilot/SKILL.md`. 두 최대 파일(loop 4251·gates 1346·complete 1005)은 서브에이전트 구조 매핑으로 라인 인용을 교차확인했다(직접 실행 검증은 안 함 — 미검증).

의도대로 동작하는 지점(코드로 확인):

- **graph done ≠ AC closed**: `action:'done'{all_passed}`는 disposition이지 verdict가 아니고(`autopilot-loop.ts:266` 주석), complete가 AC별 증거로 재판정한다. false-green 방어가 여러 층(guardMutatingEvidence·guardAcClosingEvidence·nodeVerdictFor worst-fold·3 floor)으로 중첩.
- **no-auto-pick / defect carve-out 일관**: loop은 out-of-scope 후속에 `batch_escalate` 신호만 방출(구동 안 함, `autopilot-loop.ts:3588`), 결함만 `classifyDiscoveredDefect` 판정+condition-b 게이트 뒤에서 `defect_chain_driven`. charter PRIME_DIRECTIVE(`charter.ts:70`)와 ADR-20260714가 동기화됨.
- **단일 라벨공간(R11)**: `resolvability` enum이 `completion-contract.ts:21`·`autopilot-store.ts:88` 두 곳에 inline 중복되나 주석이 "lockstep 유지"를 명시. 이건 drift 위험 지점이지만 현재는 일치(미확인: 자동 동기화 장치 없음, 수동 규율에 의존).

불일치/갭/미확인:

- **loop_rounds 예산 공유(결함 체인구동)**: 파생 결함의 drive 라운드가 `.rev.r` 마커로 originating run의 `loop_rounds`를 공유한다(중첩 결함 N개가 N×loop_rounds 도는 것 방지, `autopilot-converge.ts:34`). N개 결함이 순차로 예산을 소진하는 경계 동작은 코드로 확인했으나 실행 검증은 안 함 — **미검증**.
- **shed-effectiveness 갭**: WS3 context-pressure는 advisory이고 disk-derived proxy에 stored counter가 없어 "driver가 실제로 shed했는지 vs directive 무시했는지"를 구분하는 on-disk 신호가 없다. SKILL.md(`:51`)가 "accepted, not a defect"로 명시. **의도된 관측 갭**.
- **mutual-exclusivity throw**: record-result payload가 promotion 신호(generated_nodes/plan_brief)와 auto-resolve lane(residual_risks/follow_ups)을 동시에 실으면 `recordResultCore`(`3111`)가 soft downgrade가 아니라 **throw**한다(auto-resolve가 promotion 전에 early-return해 조용히 drop하는 걸 방지). orchestrator-safety를 중시하는 다른 가드들과 결이 다른 fail-loud 선택 — 의도적이나 owner가 잘못된 payload를 보내면 record-result가 exit non-zero로 죽는다(재설계 시 주의점).

---

## 7. 잠재 위험·부작용·재설계 시 고려점

**동시성·정합성**:
- `active-leases.json` 리스가 교차 프로세스 동시 구동을 막는 유일 방어다(ADR-20260628). worktree 병렬 개발에서 여러 세션이 **공유 트리**를 쓰면 land abort·pre-commit 외래 dirt·push-gate가 gitignored 개인 tier를 자기검증하는 flake가 반복 관찰됐다(메모리 다수 gotcha). 재설계 시 리스 모델을 강화하거나 worktree 격리를 계약화해야 한다.
- `changed_files` 오염이 반복 escape origin이었다 — 워킹트리 스캔이 외래 untracked를 과포함해 완료본을 오염시켰다. 근본수정(wi_260719ayc)이 워킹트리를 소스가 아니라 GUARD로 쓰고(extraTrackedDirt fail-closed) `--changed` 명시선언 + baseline 배제로 차단했다. **재설계 시 절대 워킹트리 스캔으로 changed_files를 도출하지 마라** — run-앵커 baseline이 불변식이다.

**drift 위험**:
- `resolvability` enum이 두 파일에 inline 중복(§6). 라벨 하나 추가 시 둘 다 고쳐야 하고 자동 동기화가 없다 — 통합하거나 공유 스키마로 승격을 고려.
- kind→owner, OWNER_TOOLS, nodeOwner/nodeKind enum이 total map으로 강제되어(`autopilot-graph.ts:8`) unknown이 loud fail한다 — 이 total성이 여러 게이트(barrier deadlock 방지 등)의 안전 기반이니 재설계 시 보존해야 한다.

**재설계 시 반드시 보존해야 할 불변식**:
1. **graph done ≠ AC closed** — 완료는 언제나 AC별 oracle+증거로 재판정. all_passed는 disposition일 뿐.
2. **완료 통화 = per-AC oracle ∧ barrier** — barrier를 "유일 수렴 화폐"로 승격 금지(ADR-0024 기각 대안).
3. **claim≠proof floor** — mutating pass의 changed_files, AC-closing pass의 evidence, ack-only 강등, worst-fold. 이 층들이 skipped-spawn false-green을 막는 유일 방어다(스폰은 코드가 관측 못 함).
4. **no-auto-pick / materialize≠drive** — 결함 클래스만 예외이고 분류기 판정에 키드(자유-텍스트 라벨 아님). 종료 완전성 게이트가 in-scope 잔여의 조용한 축소를 차단.
5. **단일-스텝 순수 함수 + 매 라운드 disk 재구성** — driver 카운터 불신(forward round·oracle failure·loop 종료를 전부 그래프/로그에서 재구성). 이게 컨텍스트 rot에 대한 방어다.
6. **AutopilotStore 유일 mutator + O_APPEND 결정 로그** — 스키마 검증·원자성이 여기 집중.

**재고할 수 있는 결정**:
- barrier가 유닛/목 tier 전용이라는 경계(ADR-20260708). 사용자 프로젝트가 통합 테스트를 완료 시점에 돌려야 하면 tier 경계 재협상이 필요할 수 있다(현재는 push-gate/CI/e2e로 밀어냄).
- record-result의 mutual-exclusivity throw(§6) — orchestrator를 죽이는 대신 soft downgrade + surfacing으로 바꿀지.
- context-pressure의 shed-effectiveness 관측 갭(§6) — stored counter 없이 disk-proxy만으로 shed 준수를 강제할 방법이 현재 없다.
