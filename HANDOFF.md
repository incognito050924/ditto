# HANDOFF — 다른 PC 이어받기 (2026-06-24, ADR-0024 결정6 루프 규율 구현 세션)

호스트 메모리·work-items(`.ditto/local/`, gitignored)는 git으로 전파되지 않는다. 코드·테스트·git이 권위(헌장 §4-11). 이 문서는 "어디서 이어받나 + 안 넘어가는 것".

## 0. 전파 상태 (먼저 읽기)

- 브랜치 **`wi_260623uap-ac-oracle`** 에 push됨. 다른 PC: `git fetch && git checkout wi_260623uap-ac-oracle` (또는 pull).
  - `47284f6` feat(autopilot): ADR-0024 결정6 루프 규율 (구현 본체)
  - `0aa73f5` fix(handoff): deriveAcVerdicts에 oracle 전달 (N10 보완)
  - + 이 `HANDOFF.md`
- 빌드: `git pull` 후 `bun run build:bin` → **`./bin/ditto`** 사용 (PATH 설치본은 stale 가능).
- **안 넘어가는 것**(`.ditto/local`, gitignored): wi_260623u0d의 intent/autopilot/completion/coverage/interview JSON — 이 PC 로컬. WI는 done이라 재현 불요(요지 §1).

## 1. 이번 세션 — wi_260623u0d **DONE** (ADR-0024 결정6 구현)

ditto 표준 절차 풀 사이클: deep-interview 의도잠금 → coverage pre-mortem(9-sweep) → planner → 계획잠금 승인 → implement → fresh verify → done.

**의도 잠금 2결정** (사용자 확인):
- oracle = **in-loop authoritative** — 에이전트 pass라도 oracle 불만족이면 노드 미닫힘·재open.
- wrong-fixpoint = **조용한 재open + 결정로그 기록**(인터럽트 없음), 동일 oracle K회 실패 시 blocked.

**5 메커니즘 (코드=권위, 전부 기존 seam 확장·재발명 0):**
- **converged vs capped**: `autopilot-loop.ts` done action의 `disposition`이 append-only decision-log에서 도출(loop-cap 마커→capped, else converged). exit.reason{converged|cap_reached|blocked} 어휘 재사용.
- **loop-level cap**: `schemas/autopilot.ts caps.loop_rounds`(default 12) + `autopilot-converge.ts totalForwardRounds`(graph-derived, stored counter 없음) → 도달 시 escalate/cap_exceeded.
- **in-loop oracle authoritative**: `gates.ts oracleSatisfaction` 재사용, recordResult pass경로에서 oracle 불만족 시 pass→open. **완료시점 닫힘판정은 그대로 유지**(ADR-0024:28 — completion이 closing judge).
- **wrong-fixpoint reopen**: `autopilot-graph.ts:64` reopen transition(passed→pending) + `appendDecision`(append-only). **passed-only status 가드**(forward-loop이 같은 노드를 blocked/spliced 했으면 no-op, throw 회피).
- **K→blocked**: `caps.oracle_failures_to_block`(default 3), K 카운터는 decision-log 마커에서 도출하며 **`node.attempts.fix`와 분리**(autopilot-converge.ts:17 layer-mix 금지). 재open이 K 카운터 공유.

**N10 보완(`0aa73f5`)**: `work-item-handoff.ts`가 `deriveAcVerdicts`를 oracle 없이 호출해 oracle-gated AC에서 `autopilot complete`와 verdict가 갈리던 gate↔score 갭 수정 — oracle Map을 빌드해 전달, 재현 테스트 추가.

**검증**: 신규 13 테스트(`tests/core/autopilot-loop-discipline.test.ts`) + handoff oracle 테스트, fresh verifier 6 AC pass. 전체 `bun test` **2811 pass / 2 fail**(2 fail=기존 `glossary.json` >800자, c379043부터, file_scope 밖). zero regression.

## 2. 다음 착수 후보 (결정6 done, 후속 — 전부 미착수)

- **ADR-0024 결정 4·5·7**: ④회고 측정(산출물 floor + 과정 건강도 분리, 서술=기존 기록 투영) ⑤plan 미리보기 뷰 ⑦의사결정 투명성 전면화(7은 oracle-unmet reason으로 부분 내재).
- **청사진 cleanup**: `reports/design/floor-raising-blueprint.md`는 결정 4/5/7이 아직 참조 → 그 구현 흡수 후 폐기(지금은 이르름, ADR-0024 명시).
- **K 카운터 per-node→per-AC 정교화**: 이번 구현은 per-node(단일 criterion 노드엔 정확, multi-AC 노드는 conflate). 마커 reason에 AC id 있어 localized follow-up. AC 무훼손이라 선택적.
- **ADR-0024 상태 갱신**: increment 2(결정6) landed 반영 (이번에 knowledge-update 미수행).
- **상류 의존(별도 WI)**: 과정측정=wi_260608acp, far-field 비용=wi_26062227h, fitness=wi_260615lj6.

## 3. GOTCHA

- dogfood CLI는 `./bin/ditto`(working-tree). src 변경 후 `bun run build:bin`. 정상 CLI 호출은 `DITTO_SKIP_HOOKS=1` prefix. 임시파일은 repo 안에(repo 밖 쓰기 차단).
- **coverage.json 경로**: `.ditto/local/runs/<wi>/coverage.json` (work-items/ 아님 — 혼동 주의). `coverage-next`는 read-only schedule(상태 전진 안 시킴); 노드 닫힘은 `coverage-round`. neutrality axis는 resolved close에 `axis_signals.neutrality={opponent_ran,verdict}`(verdict≠blocked) 필수.
- **flaky 테스트**: `ditto memory project + status > status is absent, then fresh after project`는 전체 `bun test` 실행 시에만 fail, 격리 실행 시 pass — 순서의존. 결정6과 무관, 별개 이슈.
- 기존 `glossary.json` 2 fail(definition >800자)은 c379043부터, file_scope 밖.
- **intent-drift**: change_surface(plan 예측) vs 실제 changed_files 불일치를 grow/shrink로 표시하나, **AC id-set 보존 시 advisory**라 completion은 통과. plan_brief change_surface를 과다 예측해도 외과적 구현이면 advisory만.

## 4. 다른 PC 세션 시작 — 재빌드 & setup

```
git pull 후: bun install (no-op 가능) → bun run build:bin && build:plugin && build:codex-plugin → ditto setup
검증: ditto doctor 전 축 drift 0. surface drift 뜨면 surfaces:gen 재생성.
```
