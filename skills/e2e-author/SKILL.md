---
name: e2e-author
description: Co-author a user journey as rich-context v2 DSL (e2e/journeys/*.journey.md) step-by-step WITH the user, project it to an official Playwright plan (`ditto e2e plan`), let the OFFICIAL playwright-test-generator drive a live browser to write the spec (`ditto e2e init-agents` + `ditto e2e generate`; degrades to the e2e-scripter fallback when no browser), gate it with `ditto e2e conformance` + `ditto e2e mapping`, and verify it once with `ditto e2e verify-generated` before any commit. Use when a developer wants a repeatable E2E test for a journey, not a one-off browser run.
argument-hint: "[journey description or .journey.md path]"
---

# E2E Author

Turn a user journey into a **persistent** Playwright test the way a developer verifies their own ditto-built feature: a **rich-context v2 DSL** file (source of truth, human-authored) → an official Playwright plan (`specs/<slug>.plan.md`) → a generated spec (`e2e/generated/<slug>.spec.ts`) that runs with plain `npx playwright test`, traceable step-by-step back to the DSL. The DSL grammar lives in `skills/e2e-author/DSL-GUIDE.md`; the conversion is driven by the **official Playwright test-generator** (live browser), with the `e2e-scripter` agent as the no-browser degraded fallback; the gates are `ditto e2e conformance`, `ditto e2e mapping`, and `ditto e2e verify-generated`.

This is the authoring pipeline — distinct from `skills/e2e` (one-off journey run for an autopilot e2e node, no persistent artifact).

**Governing decision:** ADR-20260702-e2e-official-test-agents — the official `playwright-test-generator` (drives a live browser via the `playwright-test` MCP, observing real selectors) is the primary DSL→spec converter; `e2e-scripter` is preserved only as the no-live-browser degraded fallback. This refines the ADR-0014 mechanism (D1/D2) without superseding it: the user still authors intent as DSL, DITTO still synthesizes no selectors/assertions deterministically, and the three gates (one live run · `@step` marker set · digest/stale) remain.

## When to enter
- The user wants a journey protected by a repeatable test (new feature flow, regression-prone path).
- An existing `.journey.md` changed and its generated spec is stale (conformance gate reports a digest mismatch).
- NOT for a one-shot "does this page work right now" check — that is `skills/e2e`.

## Procedure (driver — main session)

### (a) Co-author the v2 DSL — GUIDED, STEP-BY-STEP, the user in control
This is the point of the pipeline: **you author the DSL WITH the user, explaining each section as you go**, not silently drafting a finished file. The user owns the WHAT/WHY and the rich context; you fill code facts.

1. **Listen for intent.** The journey's WHAT and WHY come from the user: which flow, what must hold, business context. Code facts (selectors, routes, existing test ids) are YOUR job — investigate the repo (delegate bulk exploration to `researcher`). Never ask the user for selectors; never invent intent for the user.
2. **Walk the front-matter section by section**, explaining what each buys and getting the user's input (grammar: DSL-GUIDE.md §2). Do NOT rush past these — the rich context is what makes the generated spec accurate:
   - the 6 always-needed fields (`id`, `name`, `description`, `surfaces`, and especially **`implementation_intent`** — the prose that becomes the plan's Application Overview);
   - `constraints`, `edge_cases` (`{case, handling}`), `failure_states` (`{trigger, expected}`) — the invariants, boundaries, and failure paths;
   - `secret_vars`, `auth` (credentials as `env:`/`secret:` refs — **never a literal password/token**), `initial_state`, `seed`.
3. **Then the body** (DSL-GUIDE.md §3–§7): steps `[sN]`, the 7 verbs, the 5 assertion forms (**keyword-first** — `확인: contains …` / `visible …` / `hidden …` / `present …` / `url contains …`), the `## 케이스` table for data variations, `블록:` calls (+ `uses_blocks`), and the 3 condition forms.
4. **Show the draft and get confirmation** before converting — the DSL file (`e2e/journeys/<slug>.journey.md`, + `blocks/<block-id>.block.md`) is the contract everything downstream re-serialises.

### (b) Project the DSL to an official Playwright plan
`ditto e2e plan --journey e2e/journeys/<slug>.journey.md` — the deterministic adapter re-serialises the journey into `specs/<slug>.plan.md` (Application Overview from `implementation_intent` + `constraints`; one scenario per case; one scenario per `edge_case`/`failure_state`; `**Seed:**`/`Precondition:` lines from `auth`/`initial_state`/`seed`) plus a `specs/<slug>.plan.map.json` sidecar (the plan-step→DSL-step join). Secrets are redacted to `<env:VAR>` and a fail-closed guard refuses to write any plaintext secret. The adapter resolves no selectors and synthesizes no assertions (ADR-0014 boundary) — it only projects the human DSL.

### (c) Generate the spec — official live-browser generator, with degraded fallback
1. **Install the dual-host test-agents once:** `ditto e2e init-agents --host claude|codex`. This writes the deterministic ditto pieces (create-if-absent scaffold: `playwright.config.ts`, `e2e/seed.spec.ts`, `specs/`; `.mcp.json` backup+merge on the claude loop; the `.ditto/local/e2e-agents.json` version-skew record) and version-gates Playwright (codex REQUIRES ≥1.61 → refuses below; claude warns; absent → degrades, never auto-installs — ADR-0018). It reports the **delegated live step** it cannot do itself: run `npx playwright init-agents --loop=<claude|codex>` to write the official planner/generator agent files, after which ditto overwrites the healer with the constrained def.
2. **Primary path (live browser):** the official `playwright-test-generator` agent drives a real browser via the `playwright-test` MCP, reads `specs/<slug>.plan.md`, observes live selectors, and writes a raw spec. Post-pass it into the traceable artifact: `ditto e2e generate --journey <j> --host claude|codex --from-raw <raw spec> [--work-item <wi>]` prepends the provenance header (`@ditto-generated` + `@ditto-source` + `@ditto-digest`), injects one `// @step <journey-id>/sN` marker per DSL step (action AND assertion steps, joined through the sidecar — never re-derived from comment text), writes `e2e/generated/<slug>.spec.ts`, and emits the assertion map doc. It refuses to write a spec that leaves any DSL step without a marker (fail loud).
3. **Degraded fallback (no live browser/generator):** when the generator is unusable (no browser, Playwright too old, agents not installed, MCP unavailable), `ditto e2e generate` DEGRADES — it routes the SAME `specs/<slug>.plan.md` to the `e2e-scripter` agent and produces a scaffold branded with the **durable** header marker `@ditto-unverified fallback:e2e-scripter (no live browser at generation)`. The browser-evidence ACs (ac-3, ac-5) stay UNVERIFIED, the command exits non-zero with a loud warning, and the marker is committed with the spec so no later reader mistakes a guessed fallback for a live-verified spec. Degrade never crashes, auto-installs, or fabricates a pass.

### (d) Gate: traceability + one real run
1. **Conformance:** `ditto e2e conformance --journey <j> --generated e2e/generated/<slug>.spec.ts`. Every DSL step (journey + `uses_blocks` blocks), **including assertion steps**, must have a `@step` marker, and the artifacts must be FRESH w.r.t. their DSL (digest). Non-zero exit = missing markers or a stale digest — regenerate (do not hand-patch the spec) and re-run.
2. **Verify once before commit:** `ditto e2e verify-generated --runId <id> --files e2e/generated/<slug>.spec.ts`. Runs the repo's standard `npx playwright test` once and records pass/fail at `.ditto/local/runs/<id>/generated-verify.json`; with no browser it records `blocked` without installing anything (an honest outcome — report it, don't claim a pass). Confirm the record exists and read its result.

### (e) Per-assertion mapping review — the human confirms no weakened/over-fit assertions
`ditto e2e mapping --journey <j> --generated e2e/generated/<slug>.spec.ts [--work-item <wi>]` builds the redacted, git-tracked review table `specs/<slug>.assertion-map.md`: every DSL `확인:` vs the emitted Playwright matcher, classified `exact` / `weaker` / `stronger` / `unmapped`, with a `## 검토 필요` list of flagged rows. **The DSL is the authority** — the human reads the table and confirms no assertion was weakened (e.g. `contains` collapsed to a mere `toBeVisible`) or over-fit (e.g. `contains` hardened to exact-text equality). Gate: any `unmapped` assertion (a dropped `확인`) is a HARD FAIL (non-zero exit); `weakened`/`stronger` rows pass the gate but are surfaced for review. Reading cannot be forced — the review is the honest residual, so surface flagged rows explicitly at completion. (Note: `ditto e2e generate` also writes this doc; `ditto e2e mapping` is the standalone reviewer command and can be re-run.)

### (f) Healer policy — selector/wait only, never expected values
If a generated test flakes on a stale selector, healing is bounded HARD: only selector and wait changes may auto-apply; **changing an expected value or auto-skipping a test is forbidden**.
- A mechanical filter (`filterHealPatch`) rejects any patch hunk touching `expect(`/`toHave`/`toContain`/`.fixme(`/`.skip(`/`.only(`/a URL literal/seed data and allows only `getBy*`/`locator(`/`waitFor`/`timeout` — the guarantee holds regardless of any agent's obedience.
- The default is **propose-only**: the healer writes a patch to `.ditto/local/runs/<id>/heal-proposals/*.patch` with a rationale and STOPS; nothing auto-applies, and only the filter's `allowed` hunks may be applied.
- After any applied selector change, the assertion map is rebuilt and every touched step is force-flagged (`selector healed — re-review`) — a heal can never silently re-green a reviewed assertion.
- The constrained healer definition (installed over the stock healer by `init-agents`, `resources/playwright-agents/healer.constrained.{md,toml}`) removes the stock "fix assertions/expected values" and `test.fixme()` auto-skip behavior.

### Report to the user
The DSL file(s), the plan + sidecar, the generated spec (primary or `@ditto-unverified` fallback), the conformance result, the assertion-map doc + any flagged rows, and the verify-generated result (pass/fail/blocked + record path). The user decides the commit.

## 실패 시 (failure flow)
A failing generated test NEVER leads straight to a code fix. The verdict belongs to the user; the agent only proposes.

1. **Report in DSL vocabulary**: `ditto e2e failure-report --runId <id>` — which journey, which step (`[sN]` + DSL 원문), expected vs got, plus the replay means (headed re-run command, `npx playwright show-trace <trace>`).
2. **Propose a classification with basis — never decide alone**: 기능 결함 / 스크립트 결함 / 환경·데이터 / flaky. One re-run to confirm a flake is allowed at most once per test.
3. **The user decides**; record the verdict: `ditto e2e failure-verdict --work-item <wi> --journey <id> --case <name> --classification <기능|스크립트|환경|flaky> --basis <근거>` (flaky additionally takes `--journey-file` so the flake lands in the journey's `flaky_history`). Run this only on the user's explicit verdict — running it on your own judgment is fabricating a user decision.
4. **Handle by classification**: 기능 → only now may feature code be fixed — **before touching feature code, run the lock query and keep its exit code as evidence**: `ditto e2e fix-allowed --work-item <wi> --journey <id> --case <name>` (non-zero exit = still locked; the gate opens solely on a recorded 기능 verdict and re-locks on any later re-verdict) / 스크립트 → regenerate through the pipeline (§c) and the conformance + mapping + verify-generated gates must pass again / 환경·데이터 → blocked, the AC stays 미검증 / flaky → this run only is excused, flaky_history updated (digest excludes flaky_history, so no regeneration is needed).

**Feature-code edits before a recorded 기능 verdict are forbidden** — there is no fix path that bypasses the user verdict, and `fix-allowed` is the executable check of that lock.

## 기존 테스트 수명주기 (existing-test lifecycle)
Code changes interact with EXISTING journey tests in two ways; both keep the user in the verdict seat.

- **회귀 게이트 (영향 부분집합만)**: `ditto e2e regression --work-item <wi> --changed-files <csv>` crosses the diff with each journey's `component:` surfaces and runs only the impacted subset — never the whole suite. Present the selection by **name·description** (the CLI prints it that way; ids are machine identity), let the user adjust, and re-run with `--journeys <id csv>` if adjusted. Inside the selected list there is no escape: a failure there is a verification failure handled through the 실패 시 flow — never closed as "이번 수정 범위 아님". Record: `.ditto/local/work-items/<wi>/regression-gate.json`. This is not optional bookkeeping — `ditto autopilot complete` refuses to assemble a completion while impacted journeys have no covering `pass` record.
- **삭제·갱신: 제안은 에이전트, 실행은 사용자 확인 후 CLI로**: when a change makes an existing test meaningless (flow removed, surface gone), PROPOSE the update/delete with its basis; only after the user explicitly confirms, run `ditto e2e lifecycle --action update|delete --journey-file e2e/journeys/<slug>.journey.md --confirmed-by-user [--reason <r>] [--work-item <wi>]`. Passing `--confirmed-by-user` on your own judgment is fabricating a user decision. The CLI refuses manual (non-`@ditto-generated`) files and refuses without the flag; `delete` preserves shared block helpers still referenced by other journeys; `update` only marks the spec for regeneration — the pipeline above does the actual regeneration.

## Output contract
- Source of truth: `e2e/journeys/<slug>.journey.md` (+ blocks). Derived: `specs/<slug>.plan.md` (+ sidecar, redacted), `e2e/generated/**` with `@ditto-generated` headers, `specs/<slug>.assertion-map.md`.
- Generated specs run standalone via `npx playwright test` — no DITTO dependency at run time.
- Evidence: `ditto e2e plan`/`generate` output, conformance exit code, the assertion-map doc, and `generated-verify.json` (pass/fail/blocked) for the pre-commit run.

## Hard rules
- **No agent-invented journeys.** A DSL file is only written from stated user intent; the agent fills code facts, the user owns the WHAT/WHY and the rich context.
- **Credentials are never literal.** Passwords/tokens are `env:`/`secret:` references only; secret case-table columns go in `secret_vars`; storageState files and `.env*` are never committed.
- **The official generator is primary; the fallback is honest.** A no-browser fallback spec MUST carry the durable `@ditto-unverified` marker and its browser-evidence ACs stay unverified — never reported as passing.
- **Generated files are never edited by hand** (by you or on user request — regenerate from the DSL; hand edits are caught as stale/missing-marker failures).
- **Manual tests are untouchable.** Files without the `@ditto-generated` marker are human-authored; this pipeline never modifies or deletes them.
- A failing conformance gate, an `unmapped` assertion, or a `fail` verify run is a blocker, not a footnote — regenerate or report honestly.
- **v1 is a clean break** — v1 `.journey.md` files no longer parse; re-author as v2 (no auto-migration).
- Never commit; the pipeline ends at the report. (These skills/agents are deployed artifacts — a release-time `bun run build` regenerates `dist/`; nothing needs committing here.)
