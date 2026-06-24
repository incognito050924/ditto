# HANDOFF — 이 브랜치에서 이어서 작업 (2026-06-24, ADR-0024 floor-raising 완결 + main 통합)

호스트 메모리·work-items(`.ditto/local/`, gitignored)는 git으로 전파되지 않는다. 코드·테스트·git이 권위(헌장 §4-11). 이 문서는 "어디서 이어받나 + 안 넘어가는 것 + 다음 후보".

> **다음 세션은 이 브랜치 `wi_260623uap-ac-oracle`에서 그대로 이어서 작업한다.** 새 작업은 §2 후보에서 고른다. 새로 시작하거나 main에서 따지 말 것 — 이 브랜치가 SoT.

## 0. 전파 상태 (먼저 읽기)

- **다음 세션 = 이 브랜치 `wi_260623uap-ac-oracle`에서 계속.** ADR-0024 floor-raising 전체(increment 1·6·3·K + retro 갭fix + 추세원장 + ADR 상태갱신) + **origin/main 통합 머지**(`d08df53`)가 이 브랜치에 누적.
- **로컬만 — 미푸시.** 그래서 **같은 머신 새 세션이면 상태 그대로** — 브랜치 커밋·`.ditto/local`(WI·원장) 다 있어 pull 불요. 첫 확인: `git branch --show-current`가 `wi_260623uap-ac-oracle`인지 + `bun run build:bin`(src 동기화). (다른 PC는 먼저 push 필요 — 아직 안 됨; origin의 이 브랜치는 `a254323`에 stale.)
- **랜딩(push to main)은 별개 결정 — 자동 푸시 금지.** origin/main이 브랜치 tip의 조상이라 `git push origin HEAD:main`으로 FF 랜딩=배포 가능하지만 **사용자 타이밍 판단 대기 중**. 이어가는 작업과 섞지 말 것.
- 빌드/호출: `bun run build:bin` → **`./bin/ditto`** 사용(PATH 설치본 stale 가능). 정상 CLI 호출은 `DITTO_SKIP_HOOKS=1` prefix. 임시파일은 repo 안에(repo 밖 쓰기 차단). 커밋 훅이 bin/ditto·dist/plugin 자동 재빌드.
- **안 넘어가는 것**(`.ditto/local`): 각 WI의 intent/autopilot/completion/coverage JSON·검증 스크립트·추세 원장(`retro-metrics.jsonl`). 같은 머신이면 그대로 있음. WI들 done이라 재현 불요(요지 §1).

## 1. 브랜치에 누적된 것 — ADR-0024 floor-raising 결정 1~7 전부 landed

ADR-0024 = 기획~구현 품질 floor를 design 노드 *제자리 경화*로 올린다(raise+measure, 보장 아님).
- **increment 1** (wi_260623uap, `c379043`): AC↔oracle 코어 + 적대 변환기 + forward-AC frozen oracle.
- **increment 6** (wi_260623u0d, `47284f6`): 루프 규율 — cap≠converged·wrong-fixpoint reopen·동일 oracle K회 blocked.
- **increment 3** (wi_260624bad, `79b2e33`): 결정 4(회고 측정 ①outcome_floor·②process_health 분리·retro 노드 non-blocking)·5(`ditto autopilot status`의 plan oracle 뷰)·7(루프 종료 disposition=decision-log SoT). K카운터 per-AC(wi_260624kcv, criterion_ids).
- **ADR 상태 갱신** (wi_260624k67, `9993a74`, 비코드): ADR-0024를 "결정 1~7 landed"로 + 코드 닻을 배선 seam(retro-measure.ts 등)으로 승격 + glossary `oracle` 1234→783자(≤800 cap, 직전 2 fail 해소). knowledge.json decisions[]에 ADR-0024 등록.
- **retro↔completion 순서 갭 fix** (wi_260624qde, `321a016`, behavioral): retro 노드가 `autopilot complete`(completion.json 생산)보다 **먼저** 실행돼 outcome_floor의 coverage·unit_only가 retro시점 omit되던 갭. → `collectRetroContext`(autopilot-loop.ts)가 persisted completion 없을 때 complete와 **동일한** `assembleCompletionFromGraph(graph,workItem)`로 in-place grounded. **그래프에 AC-닫기 작업(non-retro 노드 acceptance_refs) 있을 때만** grounded, 없으면 anti-SLOP omit 유지. 순수(completion.json 안 씀→race 없음), 메트릭만 취함(서술은 persisted-only). 라이브 스모크로 실제 바이너리 grounded 확인.
- **측정값 추세 원장** (wi_260624mtq, `e4e02d6`, behavioral): `src/schemas/retro-metric-snapshot.ts` + `src/core/retro-metric-ledger.ts`(cross-WI append-only `.ditto/local/retro-metrics.jsonl`, WI당 1행 first-wins 멱등). record-result retro pass가 `ctx.metrics` 적재(흡수와 같은 fail-open try). **persist까지만** — 사용자向 report는 후속(원장 readAll로 회수 가능).
- **origin/main 통합** (`d08df53`): main 3커밋(npx 설치 완결·ADR-0025 codex dogfood host 분리) 흡수. 충돌 2건 해소 — knowledge.json decisions[] union(0013·14·15·20·24·25), CLAUDE.md는 `ditto bridge knowledge` 재생성(ADR-0024 accepted·ADR-0025 accepted, drift 0).
- **ADR 식별자 정책** (2026-06-24 세션, wi_260624gm9 + 후속): ADR id = **불변 파일명** `ADR-YYYYMMDD-<slug>.md`(순차번호·uid 폐기). `131d962` feat(schema legacy∪new regex·knowledge-bridge 파서·`ditto knowledge adr-new`/`adr-check` CLI·정책 ADR `ADR-20260624-adr-identifier-policy.md`) · `267396d` ci(adr-check를 pre-commit 배선) · `2a95b32` refactor(ADR-id 정규식 단일 SoT `src/schemas/adr-id.ts`, 5곳 일원화). 기존 ADR-NNNN grandfather(rename 0), 진짜 충돌=동일 파일명→git add/add. **인덱스 백필은 revert**(`eea6244`, wi_260624op1 abandoned) — knowledge.json decisions[]가 **런타임 orphan**으로 판명(투영·메모리는 .md/glossary 직접, decisions[] 읽는 건 adr-check뿐; c9f8604가 같은 이유로 삭제했던 파일). 폐기 vs 존치는 `wi_2606247cx`(§2).
- **동시 세션 교차**: `600cb42`(coverage residual_risk, wi_260624wg4)가 같은 브랜치에 교차 커밋됨(내 ADR 커밋과 안 섞임 확인).
- **검증**: ADR 작업 시점 전체 `bun test` **2899 pass / 9 skip / 0 fail**, biome 0, adr-guard 통과. (ADR-0024 베이스라인은 2885였음; 이후 600cb42가 coverage 테스트 추가 → 다음 세션 재확인.)

## 2. 다음 착수 후보 (전부 미착수)

> 새 세션은 아래에서 하나 골라 이 브랜치 위에서 시작 — 코드베이스 변경이면 `ditto work start`로 새 WI 등록 후 착수(사용자 허가 단위, 헌장 §3). **랜딩은 작업이 아니라 배포 결정**이라 아래 묶음과 별개.

- **랜딩(배포 — 작업 아님)**: 누적분을 origin/main으로 — `git push origin HEAD:main`(FF). **사용자 타이밍 판단, 자동 푸시 금지.** 이게 곧 배포(다른 PC·마켓플레이스 pull).
- **추세 report (추세원장의 후속)**: 원장은 persist만 — 추세를 읽는 소비자(CLI/doctor)가 없다. ADR-0024 철회·재검토 조건("회고 측정이 약한 기획자 분산 축소를 보이나") 평가는 이 report + WI 누적이 있어야 가능. **결정4 자기검증 루프 미완**.
- **coverage 정의 통일 (report보다 먼저)**: retro coverage 식=`pass 비율`(증거 불문) vs doctor `isClosed`=`pass AND 증거`. 이제 그 값이 추세 원장에 박히므로, report 전에 정해야 함(틀린 정의로 쌓고 고치면 과거 데이터 오염).
- **coverage.json `resolved` `close_reason` 자기설명 갭**(라이브 retro 발견 #1): surviving-risk 근거가 plan_brief에만 남고 sweep 산출물엔 안 남음.
- **결정5 plan oracle 뷰** 저위험 WI 확대(measure 후).
- **retro 실패경로·재드라이브 멱등** 라이브 미실증(단위검증만; 라이브 스모크는 happy/converged만).
- **`wi_2606247cx` — knowledge.json/decisions[] orphan 해소 (아키텍처)**: M6 Knowledge는 이 파일 유지하도록 지었으나 c9f8604가 "런타임 미참조 orphan"으로 삭제, curator는 여전히 씀 = **코드베이스 내부 모순**. **폐기**(knowledge.json/decisions[]·스키마 decisions[]·adr-check #3·curator.md 지침 제거) vs **존치**(decisions[]에 실 소비자 부여 후 c9f8604 supersede) 결정 필요 — 방향 design 한 번 거칠 값어치, M6 기계를 건드리니 cascade-삭제 성급 금지. `curator.md:18` decisions[] 지침 처리(스톱갭 (a))도 이 WI에 **흡수**됨(단독 선행 금지).
- **`wi_260624nde` — 테스트 격리 가드 + reviewer 렌즈**: 테스트가 실 `.ditto/` 경로에 쓰는 격리 누수(false-pass로 진짜 버그 가림)를 막는 구조 가드 + reviewer/verifier 렌즈. (pre-mortem far-field 카테고리로는 약하다고 판단 — dev-time 테스트 품질이라 review/verify가 맞는 자리.)
- **상류 의존(별도 WI)**: 과정측정=wi_260608acp, far-field 비용=wi_26062227h, fitness=wi_260615lj6.

## 3. GOTCHA

- **tsc 미게이트**: `ac_verdicts`/`caps` fixture 누락 tsc 오류 ~356건 프로젝트 전역 선재(`47284f6` 스키마 유래, typecheck 스크립트 없음, CI=lint+adr:guard). 비차단(이번 변경 추가 0, stash 비교 356=356로 확인).
- **retro 측정 입력 출처**: coverage/unit_only=completion(work-items/<wi>/completion.json) 또는 없으면 그래프 assemble; escape_recurrence=CoverageFeedbackLedger; post_cost=그래프/decisions/handoffs. retro 흡수(`absorbRetroMemory`)는 narrative만, 추세 원장은 metrics만 — 책임 분리, 둘 다 retro pass의 fail-open try.
- **coverage.json 경로**: `.ditto/local/runs/<wi>/coverage.json`(work-items/ 아님 — 혼동 주의). retro 측정과 무관(retro는 completion을 봄).
- **intent-drift "FAIL"=advisory**: change_surface(plan 예측) vs 실제 변경 불일치. AC-id-set 보존 시 completion 통과.
- **dogfood CLI**: src 변경 후 `bun run build:bin`. 브랜치 전환·merge가 dist/plugin 자동 재조립.

## 4. 세션 시작 — 재빌드 & 검증

**같은 머신 새 세션 (기본 경로)**: pull 불요(로컬이 SoT). 아래만:
```
git branch --show-current   # = wi_260623uap-ac-oracle 확인 (아니면 git checkout)
bun run build:bin           # src 변경분을 ./bin/ditto 에 동기화
```
**다른 PC**: 먼저 push가 선행돼야 함(미완). 이후:
```
git fetch && git checkout wi_260623uap-ac-oracle
bun install → bun run build:bin && build:plugin && build:codex-plugin → ditto setup
```
검증: `ditto doctor` 전 축 drift 0. surface drift 뜨면 surfaces:gen 재생성.
베이스라인: 전체 `bun test` = **2885 pass / 9 skip / 0 fail** (이전 glossary 2 fail 해소됨).
