# HANDOFF — 다른 PC에서 이어서 작업 (2026-06-24, v0.2.0 배포 후)

호스트 메모리·work-items(`.ditto/local/`, gitignored)는 git으로 전파되지 않는다. 코드·테스트·git이 권위(헌장 §4-11). 이 문서는 "어디서 이어받나 + 안 넘어가는 것 + 다음 후보".

> **다음 작업은 다른 PC에서 한다. main(`c5c3a1e`, release v0.2.0)이 SoT.** 작업 브랜치 `wi_260623uap-ac-oracle`는 main에 FF 통합 후 **삭제됨**(로컬+origin). origin/main에서 깨끗하게 clone/pull 해서 이어간다. 새 작업은 §2 후보에서 고른다.

## 0. 전파 상태 (먼저 읽기)

- **origin/main = `c5c3a1e` (release v0.2.0, 태그 `v0.2.0`)가 SoT.** 이번 세션 작업 + 동시 세션 ADR-id 작업이 전부 main에 통합·푸시·배포됨. 작업 브랜치는 삭제됨 — main에서 이어간다.
- **다른 PC는 fetch/clone로 코드 전부 받는다. 단 `.ditto/local`(gitignored)은 안 넘어감** — WI 레코드(intent/autopilot/completion/coverage JSON·검증 스크립트·`retro-metrics.jsonl`·`surfaces*.json`·work-items)가 새 PC엔 없다. 그래서 §1 WI들의 "레코드 종결(work done)"은 새 PC에서 무의미(레코드 부재) — 남은 일은 **코드 기준**(§2)으로 잡는다.
- **⚠ 깨끗 clone에서 테스트 8건 환경 실패 위험**: `surface-inventory.plugin.test.ts`·`doctor/surface.test.ts`(실 `.ditto/local/surfaces*.json` 읽기)·`ac-oracle.test.ts`(실 `.ditto/local/work-items` populated 읽기)가 로컬 상태에 의존한다. 첫 `bun test` 전 §4의 provisioning(`surfaces:gen` 등) 필요. **이게 §2의 read-위반 후속이 고쳐야 할 실제 증상.**
- 빌드/호출: `bun run build:bin` → **`./bin/ditto`** 사용(PATH 설치본 stale 가능). 정상 CLI 호출은 `DITTO_SKIP_HOOKS=1` prefix. 커밋 훅은 `.git/hooks`가 아니라 **`core.hooksPath=.githooks`**(pre-commit이 bin/ditto 재빌드+자동 스테이징·adr-guard·adr-check·check-test-isolation; post-commit이 dist/plugin 재조립).

## 1. v0.2.0에 landed된 것

ADR-0024 floor-raising 측정·자기설명 축 + 테스트 격리 가드 + ADR-id 정책. 전체 origin/main 배포(v0.2.0).

- **coverage 정의 통일 + retro 추세 report** (`faf8ad7`·`4d38e23`): retro `outcome_floor.coverage`를 doctor `completion-coverage`와 동일한 `isClosed`(verdict=pass AND 증거)로 통일(grounded는 그래프 경로 불변, persisted completion의 evidence-없는 pass만 제외). `ditto doctor retro-trend` + `summarizeRetroTrend`(원장 readAll → 메트릭별 n/first/last/mean/min/max) — ADR-0024 철회조건 평가용 소비자.
- **coverage residual_risk 구조화 필드** (`600cb42`): non-resolved close에 close_reason(skip 이유)과 별개로 `residual_risk`(잔여 위험) 요구·serialize·retro 소비. surviving-risk 자기설명 갭 해소.
- **테스트 격리 가드 + reviewer/verifier 렌즈** (`1cf158b`, wi_260624nde): `scripts/check-test-isolation.ts`(실 `.ditto/{local,runs,knowledge}`에 **쓰는** 신규 테스트 정적 감지, allowlist 9건) + pre-commit 배선 + agents/reviewer·verifier 렌즈. **write-only** — 읽기 위반은 §2 후속.
- **ADR 식별자 정책** (동시 세션, `131d962`·`267396d`·`2a95b32`): ADR id = 불변 파일명 `ADR-YYYYMMDD-<slug>.md`, 정규식 단일 SoT(`src/schemas/adr-id.ts`), adr-new/adr-check CLI. 인덱스 백필은 revert(`eea6244`).
- **release v0.2.0** (`c5c3a1e`, 태그 `v0.2.0`): 0.1.0→0.2.0, 4 manifest + bin/ditto. 마켓플레이스는 repo tree 직접 서빙, `version`이 `/plugin update` 구동.
- **검증**: v0.2.0 시점 전체 `bun test` **2914 pass / 9 skip / 0 fail**(로컬 .ditto 상태 있는 환경), biome 0, adr-guard·adr-check·check-test-isolation 통과.

## 2. 다음 착수 후보 (코드 기준 — 새 PC에서 `ditto work start`로 새 WI 등록)

> 코드베이스 변경이면 사용자 허가 단위로 `ditto work start` 후 착수(헌장 §3).

- **테스트 격리 가드 read-위반 후속** (1cf158b의 알려진 공백): 가드가 write-only라 **읽기 의존 위반**을 안 잡는다. `surface-inventory.plugin.test.ts:15`(gitignored·untracked `.ditto/local/surfaces.json`을 REPO_ROOT에서 readFileSync)·`doctor/surface.test.ts:245`·`ac-oracle.test.ts`(실 `.ditto/local/work-items` 읽기)가 깨끗 clone/CI에서 false-fail — §0에서 관측됨. read 검출을 가드에 추가하거나 그 테스트들을 fixture 격리/조건부로(surfaces.json track 정책 결정 포함). **가장 인접·실증된 후보.**
- **`wi_2606247cx` — knowledge.json/decisions[] orphan 폐기 vs 존치 (아키텍처)**: decisions[]가 런타임 orphan(adr-check만 읽음)으로 판명. M6 Knowledge는 유지하도록 지었으나 c9f8604가 같은 이유로 삭제 시도 → **코드베이스 내부 모순**. 폐기(decisions[]·스키마·adr-check #3·curator 지침 제거) vs 존치(실 소비자 부여) 결정 필요. v0.2.0에 미결 상태로 배포됨 — design 한 번 거칠 값어치, cascade-삭제 성급 금지.
- **결정5 plan oracle 뷰** 저위험 WI 확대 (ADR-0024 잔여, 추세 데이터 누적 후 평가).
- **retro 실패경로·재드라이브 멱등** 라이브 실증 (단위/wiring만, 라이브 스모크는 happy/converged만 — 검증 작업).
- **상류 의존(별도 WI)**: 과정측정 `wi_260608acp`, far-field 비용 `wi_26062227h`, fitness `wi_260615lj6`.

## 3. GOTCHA

- **깨끗 환경 테스트 격리 위반**(§0·§2): 실 `.ditto/local` 읽는 테스트 8건 → provisioning 없으면 false-fail. write-only 가드는 안 잡음.
- **커밋 훅 = `.githooks`**(core.hooksPath, `.git/hooks` 아님): pre-commit이 bin/ditto 자동 재빌드+스테이징. 무관한 워킹트리 src 변경이 있으면 bin 번들로 새어듦 → 분리 커밋은 `git add <내것>` 후 `--no-verify`.
- **`schemas:export`는 stale json 전부 재생성**(다른 in-flight zod 변경 소산) — 내 스키마 json만 남기고 나머지 `git checkout HEAD --`로 되돌려라.
- **tsc 미게이트**: implicit-any/exactOptional fixture 오류 ~356건+ 프로젝트 전역 선재(typecheck 스크립트 없음, CI=lint+adr:guard+check:test-isolation). bun은 타입 무시 실행 → 비차단. LSP "Cannot find module" diagnostic은 worktree/재인덱싱 환각(bun test 0 fail이면 정상).
- **parallel WI clobber**: 파일 쓰는 WI를 `git checkout` tree-cleanup하는 WI와 병렬로 돌리면 후자가 전자를 churn으로 오인해 revert→유실. 진짜 격리(파일0겹침) 아니면 순차, 또는 격리 git worktree.

## 4. 세션 시작 (다른 PC) — clone & 검증

```
git clone <repo> ditto && cd ditto      # 또는 기존 clone: git fetch && git checkout main && git pull
bun install
bun run build:bin && bun run build:plugin && bun run build:codex-plugin
ditto setup                              # host 블록·.ditto scaffold·allowlist·도구
# 첫 bun test 전 (격리 read-위반 테스트 환경 — §0·§2):
bun run surfaces:gen                     # .ditto/local/surfaces*.json 생성 (surface-inventory·doctor/surface 테스트)
#   ac-oracle.test.ts는 .ditto/local/work-items populated 가정 — 새 PC엔 없음.
#   read-위반 후속(§2)이 미해결인 동안엔 이 8건이 환경 실패할 수 있다(코드 정상, 환경 부재).
```
검증: `ditto doctor` 전 축 drift 0. surface drift 뜨면 `surfaces:gen` 재생성.
베이스라인: 전체 `bun test` = **2914 pass / 9 skip / 0 fail** (로컬 .ditto 상태가 갖춰진 환경 기준; 새 PC는 위 provisioning 후).
