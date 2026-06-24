# HANDOFF — 다른 PC에서 이어서 작업 (2026-06-25)

호스트 메모리·work-items(`.ditto/local/`, gitignored)는 git으로 전파되지 않는다. 코드·테스트·git이 권위(헌장 §4-11). 이 문서는 "어디서 이어받나 + 안 넘어가는 것 + 다음 후보".

## 0. 전파 상태 (먼저 읽기)

- **⚠ main이 force-push로 rewrite됐다.** codex 두 커밋(`9b7b0ee` self-host dogfood plugin, `91ba1a2` surface risk report)을 main에서 제거하고 `codex/dogfood-surface` 브랜치(origin에 push됨)로 분리했다. 기존 clone이 있으면 `git fetch && git reset --hard origin/main` (단순 `pull`은 diverge). 안전망 로컬 브랜치 `backup/pre-codex-split`(=옛 56d4c80)은 그 PC에만 있다.
- **`.ditto/local`(gitignored)은 안 넘어감** — WI 레코드(intent/autopilot/completion/coverage JSON·`retro-metrics.jsonl`·`surfaces*.json`·실험 JSON·work-items)가 새 PC엔 없다. 그래서 아래 done WI들의 "레코드 종결"은 새 PC에서 무의미 — 남은 일은 **코드 기준**(§2)으로 잡는다.
- 빌드/호출: `bun run build:bin` → **`./bin/ditto`**. 정상 CLI 호출은 `DITTO_SKIP_HOOKS=1` prefix. 커밋 훅은 **`core.hooksPath=.githooks`**(pre-commit이 bin/ditto 재빌드+자동 스테이징·biome lint·adr-guard·check-test-isolation; post-commit이 dist/plugin 재조립). 커밋 전 `bun run lint:fix` 권장(format 위반이 커밋 게이트를 막는다).
- 깨끗 clone 첫 `bun test` 전: `bun run surfaces:gen` (그 외 `.ditto/local` 상태 의존 테스트). surface-inventory 테스트는 이제 surfaces.json 부재 시 false-fail 대신 skip한다(아래 §1).

## 1. 이번 세션 landed (origin/main에 push됨)

- **`1929e1a` surface-inventory 테스트 격리 (wi_26062400f, 동작적)**: `tests/core/surface-inventory.plugin.test.ts`의 두 M1.6 테스트를 `test.skipIf(catalogAbsent)`로 가드 — gitignored `surfaces.json` 부재 시 visible named skip(fail 아님), 존재 시 단언 불변. ditto autopilot 자율 구동(design→impl→verify→retro→complete)으로 final_verdict=pass.
- **`a1d6f98` README npx 진입점 (비코드)**: README 최상단에 `npx github:incognito050924/ditto install` 노출(wi_260623rl4 산출물; npx-bootstrap.mjs는 이미 완비였음).
- **`3b11152` biome 포맷 정리 (구조적, 기존 부채)** · **`3afc6b8` batch-orchestration.md (비코드)** — 병렬 세션 산출물. **⚠ `reports/design/batch-orchestration.md`는 작업 서사 설계 메모로 헌장 §4-11·no-work-narrative와 충돌한다. 정리(classify/cleanup) 후보** — 같은 정보는 `.ditto/local/experiments/bulk-dogfood-260625.json`(측정)에 구조화돼 있다(안 넘어감).
- **codex 분리** (§0): main에서 codex 두 커밋 제거 → `codex/dogfood-surface`(origin).

## 1b. 이번 세션 확인 — "이미 됨"(핸드오프 stale 다수)

이전 핸드오프/HANDOFF §2가 가리킨 후보 다수가 다른 세션에서 이미 해결됐고 핸드오프만 stale이었다. fresh로 확인된 것:

- **deep-interview gate soundness 버그 = 이미 수정** (`3ead4f4`, wi_2606219rp): assumption-kind agent-guess가 critical을 닫지 못하게 — `delegated` flag + `interview-driver.ts:180` invariant. 테스트 103 pass.
- **fitness(`ditto fitness run|drift`) · 과정측정(`retro-metric-ledger` + `doctor retro-trend`) = 이미 구현.**
- **coverage intensity 영속·report.complete 파생노드(wi_260622z7d) · variant 라우팅·warm-start cap(wi_260621i0w) = 이미 구현** (bulk 실험에서 verify-only로 닫음).
- 교훈: §2 후보는 착수 전 반드시 fresh 확인(grep/test). 핸드오프 본문은 권위 아님.

## 2. 다음 착수 후보 (코드 기준 — fresh 확인 후 `ditto work start`)

- **`knowledge.json`/`decisions[]` orphan 폐기 vs 존치 (아키텍처 결정, 미등록)**: `decisions[]` 소비처가 혼재(`knowledge.ts` adr-check 인덱스 검사 + `gates.ts:483` ADR-worthy 카운트). 폐기 vs 실소비자 부여 결정 필요. **유일하게 미해결로 확인된 코드/결정 작업.** dialectic(폐기 vs 존치) 한 번 거칠 값어치.
- **far-field pre-mortem 재설계 (`wi_26062227h`, .ditto/local draft — 안 넘어감, 코드 기준 재등록)**: ③약함 카테고리 deep-interview 이관 + ①강함 oracle 결정적 검증. bulk 실험에서 far-field 19-lens sweep이 zero-code WI 3건 모두에서 전량 실행돼(순수 overhead) 동기 3회 재확인 — driver가 batched-Opponent 1개로 우회 중(미봉책).
- **부차 follow-up** (wi_26062400f가 남김): surface-inventory `length===40` 하드코딩 동적화; `check-test-isolation.ts`에 read-의존 정적 검출 추가(현재 write-only).
- **codex (별도 흐름)**: `DITTO_SKIP_HOOKS=1 bun test` 5 fail(surface/capability/hook drift) + `wi_260624a6d`·`wi_260623rbb`. `codex/dogfood-surface` 브랜치에서 이어감.

## 3. GOTCHA

- **main rewrite (§0)**: 기존 clone은 `git reset --hard origin/main`. 단순 pull 금지.
- **force-push to default branch는 DITTO PreToolUse 훅이 차단**: 사용자가 직접 셸에서 실행하거나, 훅 패턴(같은 세그먼트 force flag + `main`)을 피해야 한다.
- **커밋 훅 = `.githooks`**(core.hooksPath): pre-commit이 bin/ditto 재빌드+스테이징 + biome lint 게이트. format 위반 시 `bun run lint:fix` 후 재커밋. 무관한 src 변경이 있으면 bin 번들로 새어듦 → 분리 커밋은 `git add <내것>` 후 신중.
- **autopilot coverage close**: coverage-round payload에 `axis_signals`(neutrality{opponent_ran,verdict} + balance + priority{userPriority,achievedDepth}) 필수. design close에 `plan_brief`(change_surface + tier_inputs) 필수(없으면 G7 강등).
- **G7 judging-evidence guard**: verify/reviewer가 AC를 pass로 닫으려면 `evidence_refs`(evidenceRef object: kind/command/summary) 필수 — bare claim은 fixable 강등.
- **close-path**: completion final_verdict=pass ≠ done — `ditto work done <wi>` 명시 호출 필요.
- **parallel WI clobber**: 파일 쓰는 WI를 tree-cleanup WI와 병렬 금지. 격리 git worktree 또는 순차.
