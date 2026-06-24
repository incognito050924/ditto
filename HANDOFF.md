# HANDOFF — 다른 세션/PC 이어받기 (2026-06-24, ADR-0024 결정 4·5·7 + K카운터 per-AC 세션)

호스트 메모리·work-items(`.ditto/local/`, gitignored)는 git으로 전파되지 않는다. 코드·테스트·git이 권위(헌장 §4-11). 이 문서는 "어디서 이어받나 + 안 넘어가는 것 + 다음 후보".

## 0. 전파 상태 (먼저 읽기)

- 브랜치 **`wi_260623uap-ac-oracle`** 에 커밋됨. 다른 PC: `git fetch && git checkout wi_260623uap-ac-oracle`(또는 pull). **이 브랜치는 origin/main 미머지** — ADR-0024 increment 6(직전)·4·5·7(이번)·K카운터가 누적된 dev 브랜치.
- 빌드: `git pull` 후 `bun run build:bin` → **`./bin/ditto`** 사용(PATH 설치본은 stale 가능). 정상 CLI 호출은 `DITTO_SKIP_HOOKS=1` prefix. 임시파일은 repo 안에(repo 밖 쓰기 차단).
- **안 넘어가는 것**(`.ditto/local`, gitignored): 두 WI의 intent/autopilot/completion/coverage/interview JSON·드라이버 스크립트. WI는 done이라 재현 불요(요지 §1).

## 1. 이번 세션 — 2개 WI DONE

### wi_260624bad — ADR-0024 결정 4·5·7 (increment 3) DONE (final_verdict=pass, 7 AC)
design 노드 제자리 경화. 표준 풀사이클(deep-interview 6생성기→gate→4질문 → coverage 사전부검 → planner → 구현 5노드 → fresh verify → review→fix→재리뷰 수렴).
- **결정5**(ac-1): `ditto autopilot status`가 AC↔oracle(method·maps_to·direction)을 human+json에 표시 — read-only·멱등·**pending일 때만 enrich**(새 게이트 아님). `src/cli/commands/autopilot.ts`.
- **결정4**(ac-2~5): retro 노드 = **모든 WI**. 정적 시드 아니라 **design-close에서 supersede 이후 terminal verify에 추가**(`autopilot-loop.ts` design-close 블록). 시드-retro는 supersede `removeNodes` dangling throw를 유발해 폐기(redo). **non-blocking 가드**: retro kind를 `all_passed`(autopilot-loop.ts)·`allNodesTerminal`(autopilot-driver.ts)에서 제외. **분리 측정**(`src/core/retro-measure.ts` 신규: ①outcome_floor[completion-coverage·`countUnitOnlyClosures`·escape-recurrence]·②process_health[post_cost], anti-SLOP omit, 빈-retro `no_measurable_signal`). **투영-only 서술** cross-WI 메모리 흡수(`MemoryEventStore.append`, 멱등 stable key, process-health 필터). dispatch 배선=`collectRetroContext`(autopilot-loop.ts).
- **결정7**(ac-6): 루프 종료 disposition(converged|capped|blocked, 부분실패=blocked) = **decision-log 단일 SoT**(`AutopilotDecision.loop_terminated`+`disposition`, latest-wins). convergence.json `exit.reason`은 per-target SoT 유지(어휘만 재사용). `autopilot-store.ts`·`autopilot-loop.ts:recordLoopTermination`.
- **검증**: 전체 `bun test` **2867 pass / 9 skip / 2 fail**(2 fail=기존 glossary entries[17]>800자, 형제 WI c379043 유입·이번 비책임) / lint 0. 리뷰 3 findings(disposition drift·unit_only 미배선·oversized absorb silent) 수정·수렴.
- **핵심**: far-field sweep가 ac-3 "non-blocking"이 prose 주장일 뿐 엔진 메커니즘 없음을 검출 → kind-guard로 드러냄(sweep 실증 가치).

### wi_260624kcv — K카운터 per-node→per-AC DONE (final_verdict=pass, 3 AC, 라이브 스모크 겸)
오라클-실패 K 카운터(`oracle_failures_to_block`)를 per-node→per-AC. **구조화 `AutopilotDecision.criterion_ids?`**(파싱 회피) + **legacy(필드 없음) node-scoped fallback**(in-flight 보존) + 블록 reason에 criterion id + **첫 multi-AC fixture**. `autopilot-loop.ts:sameOracleFailureCount`(:988)·두 호출부(:1255 in-loop·:1319 reopen)·`autopilot-store.ts`. TDD RED(29/2)→GREEN, 2867 pass.
- **라이브 스모크 결과**: retro 단계 실런 전수작동 — design-close 추가(크래시 없음)·non-blocking(retro running인데 그래프 done)·retroContext 채워짐·N8 loop_terminated=converged·메모리 흡수(`.ditto/memory/events/memevt_retro_*.json`, cross-WI)·anti-SLOP omit·투영-only. **happy/converged 경로만 라이브검증**; retro 실패경로·재드라이브 멱등은 단위검증만(미실증).

## 2. 다음 착수 후보 (전부 미착수)

- **ADR-0024 상태 갱신(knowledge-update)**: ADR-0024를 "increment 3(결정 4·5·7) landed" 반영 + 이번 학습. `ditto:knowledge-update`. (이번 세션 미수행.)
- **라이브 retro가 발견한 2건**(실 후속거리): ①coverage.json `resolved` 카테고리 `close_reason` 비어 surviving-risk 근거가 plan_brief에만 — sweep 산출물 자기설명 갭. ②retro가 `autopilot complete` **전** 발화라 ①outcome floor가 retro시점 구조적 ungrounded — "complete 후 retro" 순서가 의도인지 점검.
- **결정 4·5·7 잔여**: 측정값 추세 보존(시점 스냅샷 ledger, ②지표 추세)·결정5 미리보기 저위험 WI 확대(measure 후).
- **glossary 2 fail 정리**: `glossary.json` entries[17](`oracle`, 1234자) >800 cap. 별도 정리(이 브랜치 c379043 유입).
- **상류 의존(별도 WI)**: 과정측정=wi_260608acp, far-field 비용=wi_26062227h, fitness=wi_260615lj6.

## 3. GOTCHA

- **이 WI 자체 그래프엔 retro 없음**: wi_260624bad는 feature 이전 부트스트랩(도그푸딩 닭-달걀). 신규 WI부터 retro 붙음(wi_260624kcv에서 실증).
- **tsc 미게이트**: `ac_verdicts`/`caps` fixture 누락 tsc 오류는 프로젝트 전역 선재(스키마 commit 47284f6 유래, typecheck 스크립트 없음, CI=lint+adr:guard). repo 위생 권고(fixture factory default-fill)지만 비차단.
- **intent-drift "FAIL"=advisory**: change_surface(plan 예측) vs 실제 변경 불일치. AC-id-set 보존 시 completion 통과(하드 게이트는 AC-id-set).
- **coverage.json 경로**: `.ditto/local/runs/<wi>/coverage.json`(work-items/ 아님). resolved close엔 axis_signals.neutrality{opponent_ran,verdict} 필수, out_of_scope close엔 close_reason 필수.
- **dogfood CLI**: src 변경 후 `bun run build:bin`. 브랜치 전환·merge가 dist/plugin 자동 재조립.
- **batched coverage sweep**: 무관 카테고리 out_of_scope+정당화, 적용만 단일 batched Opponent로 resolved([[coverage-sweep-batched-verification]] 패턴). tiny 변경에도 sweep가 실 갭 검출(wi_260624kcv: legacy recount·파싱·fixture 부재).

## 4. 다른 PC 세션 시작 — 재빌드 & setup

```
git pull 후: bun install(no-op 가능) → bun run build:bin && build:plugin && build:codex-plugin → ditto setup
검증: ditto doctor 전 축 drift 0. surface drift 뜨면 surfaces:gen 재생성. 전체 bun test = 2867 pass / 2 glossary fail(기존)이 베이스라인.
```
