# HANDOFF (원격·cross-PC) — 다른 PC에서 git으로 이어받기 (2026-06-26)

이 문서는 **원격/cross-PC** 핸드오프다(commit → push → 다른 PC pull). 같은 머신의 로컬 새 세션은 이 문서가 아니라 `.ditto/local/`(work-items·memory·handoff)를 쓴다. 호스트 auto-memory(`~/.claude`)·work-items(`.ditto/local/`, gitignored)는 **이 문서를 읽는 다른 PC엔 없다** — 본문이 가리키는 로컬 참조는 fresh clone에서 코드·테스트·커밋된 ADR·**roadmap SoT**로 재유도해야 한다. 코드·테스트·git·커밋된 ADR이 권위(§4-11).

**다음 작업 = ditto AX/자율성 로드맵 T2(또는 T3) — SoT부터 읽어라.**

## 0. 전파 상태 (먼저 읽기)

- origin/main = **`5104c7e`** (release **v0.4.0**, 태그 `v0.4.0`). 이전 동기 clone은 단순 `git pull`로 이어받음(이번 push는 FF, force 아님).
- 이 push로 전파: **T1 autopilot 무-전가**(`728c009` 구현) + roadmap landed(`0c63dd6`) + release(`5104c7e`). 직전 base는 `049a2f6`(v0.3.1, 병렬 doublewrap·install-docs 세션분).
- 빌드/호출: `bun run build:bin` → **`./bin/ditto`**. 깨끗 clone에서 첫 `bun test` 전 `bun run surfaces:gen`(없으면 surface 인벤토리 테스트가 `.ditto/local/surfaces*.json` 부재로 ENOENT — 환경 fail, 회귀 아님). 커밋 훅=`core.hooksPath=.githooks`(pre-commit: bin 재빌드+스테이징·biome lint·adr-guard·adr-check·test-isolation; post-commit/merge: dist/plugin 재조립). **ditto는 tsc 비게이트 — bun test가 진실**(HEAD에 pre-existing caps-literal tsc 다수).

## 1. 이번 세션 landed (T1 autopilot 무-전가 — main 병합·배포)

T1(P3·P4) **DONE·배포**. autopilot이 미검증 AC·agent-resolvable 위험·후속을 사용자에게 전가하지 않고, **오케스트레이션 흐름이 작업 완결 또는 사용자 명시 종료 외에는 끊기지 않는다**(north star, deep-interview 잠금 — 불가피한 사용자 결정조차 autopilot 살린 채 in-flow). 6 AC `final_verdict=pass`, runtime-artifact 검증(라이브 `hook stop` exit code·`complete` ledger·`--batch` 실 WI).

- **ac-1** Stop `nonPassTerminationGate`가 `acceptance[].verdict` 열거 → 비-pass 완료가 미검증 in-scope AC를 사유·근거 없이 park하면 차단(exit≠0), 정직한 partial/blocked는 종료(ADR-20260626 D2 보존). `stop.ts riskRecordForcesContinuation`도 배선.
- **ac-2** 증거 gatherable 미검증 AC 자동 reverify; tool-absence=`blocked_external`(ADR-0018, 무한루프 회피).
- **ac-3** `planForwardReexpansion` **1개 확장**(3 fork 아님·`.rev.r` cap 상속)으로 위험 자동fix; **4사유**(결정/ADR충돌·복수해결·범위밖·정말위험)만 in-flow 표면화; 구조화 ledger(auto_fix/surface/batch_escalate + reason-category).
- **ac-4** in-scope 후속=현재 그래프 노드 / out-of-scope=1회 batch materialize(draft·미구동·idempotent, **materialize≠drive**, ADR-0011 D2 same-rooted).
- **ac-5** in-scope 잔여 0까지 무중단 구동 + `no_progress_rounds` in-flow escalate(capped≠converged).
- **ac-6** AC별 증언 + 자동처리 원장 출력(status flip 없음).
- **변경 파일**: `src/core/{gates,autopilot-converge,autopilot-loop,autopilot-complete,autopilot-store}.ts` · `src/hooks/stop.ts` · `src/schemas/{completion-contract,autopilot,intent}.ts` · `src/cli/commands/{work,autopilot}.ts` + 테스트. ADR 충돌(method, 우회 준수): ADR-0011 D2, ADR-0018.

## 2. 다음 작업 — roadmap SoT부터

**권위 SoT = `reports/design/ditto-ax-autonomy-roadmap.md`**(커밋됨, T1 ✅ landed). 7개 문제·3개 테마·진척 추적이 거기 있다.

- **T2. 개발 절차 1급화**(P1·P2·P7) — TDD 1급 표면 + 경량 경로 기본값화 + **autopilot pass 시 자동 status close**(T1이 의도적으로 안 한 P1 — 현재 `work done` 수동) + backlog 위생. **추천 다음.**
- **T3. 다중 WI·worktree 자율 구동**(P5·P6) — ⏸ 보류. ADR-0011 D2(session-rooting) 비가역 충돌, 결정 선행.
- 착수: roadmap 읽고 → `ditto work start` → deep-interview로 의도 잠금 → autopilot 구동. (T1처럼 worktree 격리 권장.)

## 3. 미해결 결정 (사용자만)

- **D2** — T3 ADR-0011 충돌(비가역): session-rooting 불변식을 풀지(ADR 수정) vs 유지하며 우회.
- **D3** — TDD 표면 형태: 새 `ditto tdd` 표면 vs 기존 `implementer` 노드 red-first 교정.
- (D1 테마순서=T1우선 / D4 후속 즉시착수=in-scope 노드·out-of-scope batch 는 T1에서 확정됨.)

## 4. GOTCHA·권위

- **worktree 격리** 시 harness가 **메인-트리-stale tsc 진단**(export-not-found·필드-missing·Cannot-find-module) 표시 → worktree `bunx tsc`로 재판정. ditto는 tsc 비게이트.
- **autopilot이 status flip 안 함**(P1=T2) → 완료 후 `work done` 수동(completion final_verdict=pass 요구; placeholder AC면 거부).
- **release**=`node scripts/release.mjs minor`(4 touchpoint 버전+build:bin+commit+tag, **push 수동**). 버전 필드가 `/plugin update` 구동(push만+버전동결=no-op).
- **커밋 훅 `.githooks`**: pre-commit이 bin 재빌드+스테이징 + biome lint(실패 시 `bun run lint:fix`[+`biome check --fix --unsafe`로 template-literal]). 무관 src 있으면 분리 커밋 `git add <내것>` 후 `--no-verify`. push 후 amend 금지(force 게이트).
- **`schemas:export`는 전체 json 재생성** — 내 것만 남기고 나머지 `git checkout HEAD --` 외과 복원.
- 권위=코드·테스트·커밋 ADR·roadmap SoT(§4-11). cross-PC라 work-items·auto-memory 없음 — 위 file:line은 fresh clone에서 코드로 재확인.
