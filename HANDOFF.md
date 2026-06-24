# HANDOFF — 다른 세션/PC 이어받기 (2026-06-24, ADR-0024 floor-raising 완결 + main 통합)

호스트 메모리·work-items(`.ditto/local/`, gitignored)는 git으로 전파되지 않는다. 코드·테스트·git이 권위(헌장 §4-11). 이 문서는 "어디서 이어받나 + 안 넘어가는 것 + 다음 후보".

## 0. 전파 상태 (먼저 읽기)

- 브랜치 **`wi_260623uap-ac-oracle`** (HEAD=`d08df53`). ADR-0024 floor-raising 전체(increment 1·6·3·K + retro 갭fix + 추세원장 + ADR 상태갱신) + **origin/main 통합 머지**가 누적.
- **로컬만 — 미푸시.** origin의 이 브랜치는 `a254323`에 stale, origin/main은 통합 전. **origin/main이 HEAD의 조상 → `git push origin HEAD:main`으로 FF 랜딩=배포 가능**(사용자가 타이밍 보류 중). push 전엔 다른 PC·마켓플레이스에 반영 안 됨.
- 빌드: `git pull`(또는 fetch+checkout) 후 `bun run build:bin` → **`./bin/ditto`** 사용(PATH 설치본 stale 가능). 정상 CLI 호출은 `DITTO_SKIP_HOOKS=1` prefix. 임시파일은 repo 안에(repo 밖 쓰기 차단). 커밋 훅이 bin/ditto·dist/plugin 자동 재빌드.
- **안 넘어가는 것**(`.ditto/local`): 각 WI의 intent/autopilot/completion/coverage JSON·검증 스크립트. WI들 done이라 재현 불요(요지 §1).

## 1. 브랜치에 누적된 것 — ADR-0024 floor-raising 결정 1~7 전부 landed

ADR-0024 = 기획~구현 품질 floor를 design 노드 *제자리 경화*로 올린다(raise+measure, 보장 아님).
- **increment 1** (wi_260623uap, `c379043`): AC↔oracle 코어 + 적대 변환기 + forward-AC frozen oracle.
- **increment 6** (wi_260623u0d, `47284f6`): 루프 규율 — cap≠converged·wrong-fixpoint reopen·동일 oracle K회 blocked.
- **increment 3** (wi_260624bad, `79b2e33`): 결정 4(회고 측정 ①outcome_floor·②process_health 분리·retro 노드 non-blocking)·5(`ditto autopilot status`의 plan oracle 뷰)·7(루프 종료 disposition=decision-log SoT). K카운터 per-AC(wi_260624kcv, criterion_ids).
- **ADR 상태 갱신** (wi_260624k67, `9993a74`, 비코드): ADR-0024를 "결정 1~7 landed"로 + 코드 닻을 배선 seam(retro-measure.ts 등)으로 승격 + glossary `oracle` 1234→783자(≤800 cap, 직전 2 fail 해소). knowledge.json decisions[]에 ADR-0024 등록.
- **retro↔completion 순서 갭 fix** (wi_260624qde, `321a016`, behavioral): retro 노드가 `autopilot complete`(completion.json 생산)보다 **먼저** 실행돼 outcome_floor의 coverage·unit_only가 retro시점 omit되던 갭. → `collectRetroContext`(autopilot-loop.ts)가 persisted completion 없을 때 complete와 **동일한** `assembleCompletionFromGraph(graph,workItem)`로 in-place grounded. **그래프에 AC-닫기 작업(non-retro 노드 acceptance_refs) 있을 때만** grounded, 없으면 anti-SLOP omit 유지. 순수(completion.json 안 씀→race 없음), 메트릭만 취함(서술은 persisted-only). 라이브 스모크로 실제 바이너리 grounded 확인.
- **측정값 추세 원장** (wi_260624mtq, `e4e02d6`, behavioral): `src/schemas/retro-metric-snapshot.ts` + `src/core/retro-metric-ledger.ts`(cross-WI append-only `.ditto/local/retro-metrics.jsonl`, WI당 1행 first-wins 멱등). record-result retro pass가 `ctx.metrics` 적재(흡수와 같은 fail-open try). **persist까지만** — 사용자向 report는 후속(원장 readAll로 회수 가능).
- **origin/main 통합** (`d08df53`): main 3커밋(npx 설치 완결·ADR-0025 codex dogfood host 분리) 흡수. 충돌 2건 해소 — knowledge.json decisions[] union(0013·14·15·20·24·25), CLAUDE.md는 `ditto bridge knowledge` 재생성(ADR-0024 accepted·ADR-0025 accepted, drift 0).
- **검증**: 전체 `bun test` **2885 pass / 9 skip / 0 fail**, biome 0, adr-guard 통과, 투영 drift 0.

## 2. 다음 착수 후보 (전부 미착수)

- **랜딩(배포)**: 누적분을 origin/main으로 — `git push origin HEAD:main`(FF). 사용자 타이밍 판단. 이게 곧 배포(다른 PC·마켓플레이스 pull).
- **추세 report (추세원장의 후속)**: 원장은 persist만 — 추세를 읽는 소비자(CLI/doctor)가 없다. ADR-0024 철회·재검토 조건("회고 측정이 약한 기획자 분산 축소를 보이나") 평가는 이 report + WI 누적이 있어야 가능. **결정4 자기검증 루프 미완**.
- **coverage 정의 통일 (report보다 먼저)**: retro coverage 식=`pass 비율`(증거 불문) vs doctor `isClosed`=`pass AND 증거`. 이제 그 값이 추세 원장에 박히므로, report 전에 정해야 함(틀린 정의로 쌓고 고치면 과거 데이터 오염).
- **coverage.json `resolved` `close_reason` 자기설명 갭**(라이브 retro 발견 #1): surviving-risk 근거가 plan_brief에만 남고 sweep 산출물엔 안 남음.
- **결정5 plan oracle 뷰** 저위험 WI 확대(measure 후).
- **retro 실패경로·재드라이브 멱등** 라이브 미실증(단위검증만; 라이브 스모크는 happy/converged만).
- **상류 의존(별도 WI)**: 과정측정=wi_260608acp, far-field 비용=wi_26062227h, fitness=wi_260615lj6.

## 3. GOTCHA

- **tsc 미게이트**: `ac_verdicts`/`caps` fixture 누락 tsc 오류 ~356건 프로젝트 전역 선재(`47284f6` 스키마 유래, typecheck 스크립트 없음, CI=lint+adr:guard). 비차단(이번 변경 추가 0, stash 비교 356=356로 확인).
- **retro 측정 입력 출처**: coverage/unit_only=completion(work-items/<wi>/completion.json) 또는 없으면 그래프 assemble; escape_recurrence=CoverageFeedbackLedger; post_cost=그래프/decisions/handoffs. retro 흡수(`absorbRetroMemory`)는 narrative만, 추세 원장은 metrics만 — 책임 분리, 둘 다 retro pass의 fail-open try.
- **coverage.json 경로**: `.ditto/local/runs/<wi>/coverage.json`(work-items/ 아님 — 혼동 주의). retro 측정과 무관(retro는 completion을 봄).
- **intent-drift "FAIL"=advisory**: change_surface(plan 예측) vs 실제 변경 불일치. AC-id-set 보존 시 completion 통과.
- **dogfood CLI**: src 변경 후 `bun run build:bin`. 브랜치 전환·merge가 dist/plugin 자동 재조립.

## 4. 다른 PC 세션 시작 — 재빌드 & setup

```
git pull(또는 fetch+checkout wi_260623uap-ac-oracle) 후:
  bun install(no-op 가능) → bun run build:bin && build:plugin && build:codex-plugin → ditto setup
검증: ditto doctor 전 축 drift 0. surface drift 뜨면 surfaces:gen 재생성.
베이스라인: 전체 bun test = 2885 pass / 9 skip / 0 fail (이전의 glossary 2 fail은 해소됨).
```
