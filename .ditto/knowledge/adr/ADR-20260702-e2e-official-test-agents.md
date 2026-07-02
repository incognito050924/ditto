# ADR-20260702-e2e-official-test-agents: 공식 Playwright test-generator를 주 DSL→spec 변환기로 · e2e-scripter는 무브라우저 강등 fallback (ADR-0014 D1/D2 메커니즘 정련, D4 보존)

- 상태: accepted
- 결정 일자: 2026-07-02
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: wi_2607026qs (design-contracts Contract 0~9). **ADR-0014**(E2E DSL·에이전트 변환·게이트 — 이 ADR이 D1/D2 *메커니즘*을 정련하고 D4를 보존한다; **supersede 아님**), ADR-0018(선택적 외부도구 우아한 강등 — degrade 경로 지배), ADR-0016(dual-host claude|codex), ADR-0002(zod schema SoT). 코드(권위): `src/core/e2e/plan-adapter.ts`(DSL→plan.md 재직렬화), `src/core/e2e/generated-postpass.ts`(@step/digest 주입), `src/core/e2e/generator-availability.ts`·`src/core/e2e/generator.ts`(probe·오케스트레이션·degrade), `src/core/e2e/heal-filter.ts`(healer 기계 필터), `src/core/e2e/init-agents-install.ts` + CLI `ditto e2e init-agents`(설치·버전 게이트), `resources/playwright-agents/healer.constrained.{md,toml}`(제약 healer 정의).

## 컨텍스트

ADR-0014 D2("결정론적 DSL→Playwright 변환기 비개발")는 변환을 자체 `e2e-scripter` 에이전트에 맡겼다. e2e-scripter는 실브라우저 없이 DSL을 읽고 Playwright selector·assertion을 **추측(blind guess)**해 생성한다 — 살아있는 DOM을 못 봐 selector가 취약하고 생성 직후 게이트(1회 실브라우저 실행)에서 자주 red였다.

그 사이 Playwright가 공식 test-generator 에이전트(`playwright-test-generator`)를 배포했다. 이 에이전트는 MCP `playwright-test` 서버로 실브라우저를 구동하며 살아있는 페이지에서 selector를 **관측**해 spec을 쓴다. 관측형 공식 generator가 존재하는데 자체 추측형 변환기를 주 경로로 유지할 이유가 사라졌다.

## 결정

**공식 Playwright `playwright-test-generator`(실브라우저 구동 에이전트)를 주 DSL→spec 변환기로 승격하고, 자체 `e2e-scripter`를 무브라우저 강등 fallback으로 내린다.**

- **주 경로.** `probeGenerator(repoRoot, host)`가 usable — playwright ≥ 1.61 · agents 설치(`e2e-agents.json` + plan-format 일치) · mcp 가용 — 이면, 공식 generator를 `specs/<slug>.plan.md`에서 실브라우저(MCP)로 구동한 뒤 post-pass를 돌린다.
- **강등 fallback.** not-usable(브라우저·버전·agents·mcp 중 하나라도 false)이면 **동일 plan.md**를 자체 e2e-scripter가 소비한다(raw DSL 재해석이 아니라 어댑터 산출 plan.md 입력) → **동일 post-pass** → **동일 게이트**. fallback spec은 헤더에 `@ditto-unverified fallback:e2e-scripter (no live browser at generation)`를 달고, 브라우저 증거 AC(ac-3·ac-5)는 verdict에서 unverified로 남는다. 강등은 crash·auto-install·조작된 pass를 만들지 않는다(ADR-0018 우아한 강등, 정직한 미검증).
- **Playwright 버전 핀.** codex loop는 `npx playwright --version` ≥ **1.61.0**을 요구한다(미만이면 거부 + 안내). claude loop는 < 1.61에서 경고. playwright 부재 시 설치하지 않고 강등으로 라우팅. 스탬프는 `.ditto/local/e2e-agents.json {playwright_version, loop, plan_format_version:'v1', healer:'constrained'}`, 어댑터는 plan에 `@ditto-plan v1`을 찍고 mismatch면 loud warn + degrade.

### ADR-0014 대비 분류

- **D1 — 보존(preserved).** 의도(여정)는 여전히 사람이 Journey DSL로 선언하고, Playwright 구현은 *변환 에이전트*가 쓴다. 주 변환기가 자체 e2e-scripter에서 공식 generator로 바뀌었을 뿐, "ditto가 selector/assertion을 결정론적으로 합성하지 않는다"는 D1 불변식은 그대로다.
- **D2 — 정신 보존(preserved in spirit).** 새로 도입한 결정론 조각 두 개 — DSL→plan.md 어댑터(`plan-adapter.ts`)와 @step/digest post-pass(`generated-postpass.ts`) — 는 **사람 DSL을 재직렬화하고 추적성(traceability)만 주입**한다: 어댑터는 front-matter/body를 공식 plan 포맷으로 투영하고 secret var를 redact하며, post-pass는 sidecar map(`plan.map.json`)으로 plan-N→DSL-sN을 이어 `@step` 마커를 삽입하고 digest를 임베드할 뿐이다. **selector 해석도, 의미(semantics) 합성도 하지 않는다.** ADR-0014의 게이트 3종 — (1) 생성 직후 1회 실브라우저 실행 · (2) DSL step ↔ `@step` 마커 집합 검사 · (3) DSL digest 임베드·stale 감지 — 은 그대로 유지된다.
- **D4 — 보존(preserved).** featureFixAllowed 잠금(사용자 판정 전 기능 코드 수정 금지)은 healer의 selector/wait 전용 정책으로 지켜진다. `filterHealPatch`가 `expect(`/`toHave`/`toContain`/`.fixme(`/`.skip(`/`.only(`/URL 리터럴/seed 데이터를 건드리는 hunk를 하드 거부하고 `getBy*`/`locator(`/`waitFor`/`timeout`만 허용한다 — **기댓값 재작성도, auto-skip도 없다.** 적용된 selector 변경 후 touched region은 assertion map에서 강제 재플래그되어(`selector healed — re-review`) heal이 리뷰된 assertion을 조용히 재green할 수 없다.

## 근거 (rationale)

- **관측 selector가 추측 selector를 이긴다.** 공식 generator는 살아있는 DOM에서 selector를 관측해 생성 직후 실행 안정성이 높다. e2e-scripter의 blind guess는 selector 취약·초기 red가 잦았다.
- **D1/D2/D4 불변식을 안 깬다.** 변환기 교체는 "누가 Playwright를 쓰는가"만 바꾼다 — "사람이 의도를 선언한다 · ditto가 결정론 합성을 안 한다 · 게이트로 검증한다 · 실패 시 기능 잠금"은 전부 그대로. 그래서 supersede가 아니라 메커니즘 정련이다.
- **ADR-0018 정합.** 공식 도구(브라우저·agents·mcp) 부재가 의도 실현을 막지 못하도록 e2e-scripter를 강등 fallback으로 보존한다. 도구 없으면 정직한 unverified로 강등하지 crash·auto-install·조작된 pass로 가지 않는다.
- **ADR-0016 정합.** claude·codex 두 loop 모두 지원한다. init-agents가 host별로 배선한다(claude=`.mcp.json` 백업+병합·`.claude/agents/playwright-test-*.md`, codex=inline `[mcp_servers.playwright-test]` toml·`.codex/agents/playwright_test_*.toml`).

## 기각된 대안

- **e2e-scripter를 주 변환기로 유지(selector 계속 추측).** 살아있는 DOM 없이 selector를 추측하면 취약·초기 red가 잦고, 관측형 공식 generator가 이미 있는데 자체 추측기를 주 경로로 둘 이유가 없다. → 기각. 단, 브라우저·버전·agents 부재 시의 강등 fallback으로만 보존한다(ADR-0018 우아한 강등).

## 변경 조건 (change_condition)

- **Playwright test-agents API가 drift**하면(에이전트 정의 형태·MCP `playwright-test` 서버 계약 변경) → init-agents 설치 계약·`probeGenerator` 체크·plan 포맷 스탬프를 재정렬한다.
- **plan-format 계약이 깨지면**(`@ditto-plan v1` · `plan.map.json` join을 공식 generator가 더는 그대로 소비하지 않으면) → 어댑터/post-pass 계약을 재설계한다(공식 generator가 plan.md를 다르게 소비하는 경우 포함).
- **Playwright 최소 버전 요구가 바뀌면**(codex ≥ 1.61 하한 상향, 또는 공식 generator가 다른 최소 버전 요구) → init-agents 버전 게이트·`e2e-agents.json` 스탬프·plan_format_version을 갱신한다.
