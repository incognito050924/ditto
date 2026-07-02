# HANDOFF (원격·cross-PC) — wi_2607026qs · E2E DSL→Playwright 공식 test-agents 재구축

원격(다른 PC) 인수인계. commit → push → 다른 PC fetch. 같은 머신 새 세션은 이 문서가 아니라 `.ditto/local/`을 쓴다. **코드·테스트·git·커밋된 ADR이 권위(§4-11)** — 아래 "남은 일"은 새 PC에서 grep/test로 **fresh 재확인** 후 진행하라(본문은 비-authoritative).

## 0. 전파 상태 (먼저 읽어라)

- **Resume 지점**: 브랜치 **`wi_2607026qs-e2e-testagents`** 끝(이 HANDOFF 커밋 tip). 히스토리 재작성 없음:
  ```
  git fetch origin wi_2607026qs-e2e-testagents
  git checkout wi_2607026qs-e2e-testagents
  bun install && bun run build:bin
  ```
  base = `8ab0454`(main). **main 아님** — 이 작업은 미검증(ac-3/5)·미머지.
- **안 넘어감(gitignore `.ditto/local/**`)**: `.ditto/local/work-items/wi_2607026qs/{intent.json, autopilot.json, completion.json, reviewer-output.json, design-contracts.md}`, `.ditto/local/runs/wi_2607026qs/coverage.json`. 새 PC엔 없다 → "WI 레코드 닫기"는 무의미, 남은 일은 코드 기준.
- **넘어감**: 모든 `src/`·`tests/`·`skills/`·`agents/`·`resources/playwright-agents/`, `.ditto/knowledge/adr/ADR-20260702-e2e-official-test-agents.md`(결정 기록), 이 `HANDOFF.md`.

## 1. 이번에 랜딩 (이 브랜치)

- `1f0bc41` feat(e2e): 공식 Playwright test-agents 기반 DSL→Playwright 파이프라인 재구축 (behavioral, wi_2607026qs) — 51파일.
- `21d7a44` fix(e2e): plan-adapter 미설정 센티널(—) 조건필터·치환 결함 수정 (behavioral, wi_260702hsa) — 라이브 실증 배관 검증 중 발견. `isCellSet()` 헬퍼(—=U+2014=미설정, DSL-GUIDE §5/§7)로, `(변수 있음/없음)` 조건이 `—` 케이스에서 오작동하고 `substituteVars`가 `—`를 리터럴 치환하던 결함 수정. 3 AC verify pass.
- 검증: **`bun test` 3882 pass / 0 fail**, biome clean, pre-commit 게이트(biome·adr·isolation·npx) 통과 + `bin/ditto`·`dist/plugin` 재빌드 포함.
- **final_verdict = unverified** (wi_2607026qs AC 7/9 pass; ac-3/ac-5 미검증 — §3). wi_260702hsa(버그수정)는 done·pass.

## 2. 무엇을 만들었나 (코드 위치)

- DSL v2 스키마(clean break, SoT): `src/schemas/journey-dsl.ts` — implementation_intent(필수)·constraints·edge_cases{case,handling}·failure_states{trigger,expected}·secret_vars·auth{credentials=env:/secret: ref}·initial_state·seed.
- 파이프라인: `src/core/e2e/plan-adapter.ts`(DSL→`specs/*.plan.md`+`.plan.map.json` 사이드카+assertions 채널, redaction) → `generator.ts`(`probeGenerator` usable→공식 generator 드라이브 seam / 아니면 `generator-fallback.ts` @ditto-unverified) → `spec-postpass.ts`(injectDittoMarkers: @step 액션+확인 마커 + digest 헤더) → `conformance.ts`/`generated-verify.ts` 게이트.
- 보조: `assertion-mapping.ts`(DSL 권위 매핑표, unmapped=hard-fail), `healer-policy.ts`(filterHealPatch: 셀렉터/대기만, 기대값·skip 금지=ADR-0014 D4), `init-agents.ts`(비파괴 `.mcp.json` merge·codex≥1.61 게이트), `src/schemas/e2e-assertion-map.ts`.
- CLI: `src/cli/commands/e2e.ts` — 신규 `ditto e2e plan|generate|mapping|init-agents` (+기존 conformance/verify-generated/regression/lifecycle).
- 소비자 v2 마이그레이션: `src/core/journey-authoring/{dsl,session}.ts`, `src/core/e2e/{regression-select,lifecycle,failure-verdict,regression-gate}.ts` + 테스트.
- 문서/에이전트: `skills/e2e-author/{SKILL,DSL-GUIDE}.md`, `skills/journey-author/SKILL.md`, `agents/e2e-scripter.md`(무브라우저 fallback으로 재프레임).
- 결정 기록: `.ditto/knowledge/adr/ADR-20260702-e2e-official-test-agents.md` (ADR-0014 D1/D2 메커니즘 정련, D4 보존 — supersede 아님).

## 3. 남은 일 (코드 기준, fresh 재확인 필수)

1. **ac-3 / ac-5 라이브 실증 (핵심 미완).** 실앱 green은 여전히 unverified. **구조 확정(이번 세션)**: `generate` usable 경로는 CLI 단독으로 완주 못 한다 — host agent(e2e-author skill)가 MCP `playwright-test`로 실브라우저를 관측해 raw spec을 만들고 `--from-raw`로 주입해야 하며, CLI는 probe/post-pass/게이트만 한다(ADR-20260702). MCP는 새 세션부터 로드된다. **배관 검증(이번 세션, fallback 경로)**: `.ditto/local/e2e-proof/target-app`에 checkout-coupon 여정을 v2로 재저작 + `init-agents`(.mcp.json/e2e-agents.json 배선) + `plan`(exit 0) → `generate`(fallback=정직한 `@ditto-unverified`) → `conformance`(fallback엔 @step 없어 정직한 FAIL)까지 돌려 배관 동작을 확인했다. **이 배선·여정은 `.ditto/local` gitignored → 새 PC엔 안 넘어감, 재배선 필요.** 새 PC 실증 순서: target-app에 **Playwright ≥1.61 설치**(주의: ditto 버전 게이트는 `bunx playwright`를 쓴다 — `npx`만 1.61이면 게이트가 못 본다) → `e2e init-agents --host claude` → delegated `npx playwright init-agents --loop=claude` → v2 여정 → `plan` → **e2e-author skill로 MCP 실브라우저 드라이브** → `generate --from-raw` → `conformance`(exit 0) → `verify-generated`(green). 먼저 `bun test` 전체 green 재확인.
2. **리뷰 후 main 병합/push** — 미검증 상태라 병합·main push는 사용자 판단.
3. **소소(비차단)**: `skills/e2e-author/DSL-GUIDE.md`(~179, 346-347행)가 target-first assertion을 "조용히 드롭"이라 서술 → 이제 detectForm 양쪽 순서 인식 + 미분류=unmapped hard-fail이라 문구 stale. 실동작: `bun test tests/core/e2e-assertion-mapping.test.ts`.

## 4. Gotchas

- 빌드/호출: 배포 `bin/ditto`는 stale 가능 → `bun run build:bin` 후 `./bin/ditto`(dogfood=워킹트리 빌드). 깨끗 clone 첫 `bun test` 전 `bun run surfaces:gen` 필요할 수 있음(surface 인벤토리 ENOENT는 환경 fail).
- 게이트: `.githooks` pre-commit이 **biome lint를 커밋 게이트로** 실행(+bin 재빌드·adr·isolation·npx 가드). 게이트 명령 직접 실행 시 `DITTO_SKIP_HOOKS=1` 접두.
- **tsc 비게이트**(bun test가 진실; `src/acg/**` pre-existing tsc 다수). biome `noNonNullAssertion`은 `!` 금지 → `?? ''`/narrowing.
- 자율 오케스트레이션: `record-result`의 `evidence_refs.kind` ∈ `command|file|artifact|url|note`; `plan_brief`=`change_surface`+`tier_inputs` 필수; `generated_nodes`는 아무 contentful pass에나 splice.
- 쉘: zsh는 unquoted `$var`를 루프에서 단어분할 안 함(python 드라이버 권장); bash 명령 문자열에 secret/credential 단어 있으면 PreToolUse 훅 차단 → 페이로드를 파일로.
