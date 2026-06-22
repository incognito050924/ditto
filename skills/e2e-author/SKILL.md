---
name: e2e-author
description: Author a user journey as DSL (e2e/journeys/*.journey.md) in dialogue with the user, convert it via the e2e-scripter agent into persistent Playwright specs under e2e/generated/, gate the result with `ditto e2e conformance`, and verify it once with `ditto e2e verify-generated` before any commit. Use when the user wants a repeatable E2E test for a journey, not a one-off browser run.
argument-hint: "[journey description or .journey.md path]"
---

# E2E Author

Turn a user journey into a **persistent** Playwright test: DSL file (source of truth, human-readable) → generated spec (`e2e/generated/<slug>.spec.ts`) that runs with plain `npx playwright test`, traceable step-by-step back to the DSL. The DSL grammar lives in `skills/e2e-author/DSL-GUIDE.md`; the converter is the `e2e-scripter` agent; the gates are `ditto e2e conformance` and `ditto e2e verify-generated`.

This is the authoring pipeline — distinct from `skills/e2e` (one-off journey run for an autopilot e2e node, no persistent artifact).

## When to enter
- The user wants a journey protected by a repeatable test (new feature flow, regression-prone path).
- An existing `.journey.md` changed and its generated spec is stale (conformance gate reports a digest mismatch).
- NOT for a one-shot "does this page work right now" check — that is `skills/e2e`.

## Procedure (driver — main session)
1. **Listen for intent.** The journey's WHAT and WHY come from the user: which flow, what must hold, what business context. Code facts (selectors, routes, existing test ids) are YOUR job — investigate the repo (delegate to `researcher` for bulk exploration). Never ask the user for selectors; never invent intent for the user.
2. **Write the DSL together.** Draft `e2e/journeys/<slug>.journey.md` (and `blocks/<block-id>.block.md` for procedures shared across journeys) strictly in DSL-GUIDE.md grammar: front-matter 7 fields, 7 verbs, 5 assertion forms, `## 케이스` table for data variations, 3 condition forms. Show the draft to the user and get confirmation before converting — the DSL file is the contract.
3. **Delegate conversion to `e2e-scripter`** (1-level Task) with the journey/block file paths and repo root. The scripter writes `e2e/generated/<slug>.spec.ts` (+ `support/<block-id>.block.ts` helpers), each with the provenance header and one `// @step` marker per DSL step, case tables as parameterized tests, blocks as shared helper imports.
4. **Run the conformance gate**: `ditto e2e conformance --journey e2e/journeys/<slug>.journey.md --generated e2e/generated/<slug>.spec.ts`. Non-zero exit means missing step markers or a stale digest — send the findings back to the scripter for rework and re-run the gate. Do not hand-patch the spec yourself.
5. **Verify once before commit**: `ditto e2e verify-generated --runId <id> --files e2e/generated/<slug>.spec.ts`. This runs the repo's standard `npx playwright test` once and records pass/fail at `.ditto/local/runs/<id>/generated-verify.json`; with no browser available it records `blocked` without installing anything (an honest outcome — report it, don't claim a pass). Confirm the record exists and read its result.
6. **Report to the user**: the DSL file(s), the generated file(s), the conformance result, and the verify-generated result (pass/fail/blocked + record path). The user decides the commit.

## 실패 시 (failure flow — spec §8)
A failing generated test NEVER leads straight to a code fix. The verdict belongs to the user; the agent only proposes.

1. **Report in DSL vocabulary**: `ditto e2e failure-report --runId <id>` — which journey, which step (`[sN]` + DSL 원문), expected vs got, plus the replay means (headed re-run command, `npx playwright show-trace <trace>`).
2. **Propose a classification with basis — never decide alone**: 기능 결함 / 스크립트 결함 / 환경·데이터 / flaky. One re-run to confirm a flake is allowed at most once per test.
3. **The user decides**; record the verdict: `ditto e2e failure-verdict --work-item <wi> --journey <id> --case <name> --classification <기능|스크립트|환경|flaky> --basis <근거>` (flaky additionally takes `--journey-file` so the flake lands in the journey's `flaky_history`). Run this only on the user's explicit verdict — running it on your own judgment is fabricating a user decision.
4. **Handle by classification**: 기능 → only now may feature code be fixed (implement 회귀) — **before touching feature code, run the lock query and keep its exit code as evidence**: `ditto e2e fix-allowed --work-item <wi> --journey <id> --case <name>` (non-zero exit = still locked; the gate opens solely on a recorded 기능 verdict and re-locks on any later re-verdict) / 스크립트 → scripter regenerates and the conformance + verify-generated gates must pass again / 환경·데이터 → blocked, the AC stays 미검증 / flaky → this run only is excused, flaky_history updated (digest excludes flaky_history, so no regeneration is needed).

**Feature-code edits before a recorded 기능 verdict are forbidden** — there is no fix path that bypasses the user verdict (ac-12), and `fix-allowed` is the executable check of that lock.

## 기존 테스트 수명주기 (existing-test lifecycle)
Code changes interact with EXISTING journey tests in two ways; both keep the user in the verdict seat.

- **회귀 게이트 (영향 부분집합만)**: `ditto e2e regression --work-item <wi> --changed-files <csv>` crosses the diff with each journey's `component:` surfaces and runs only the impacted subset — never the whole suite. Present the selection to the user by **name·description** (the CLI prints it that way; ids are machine identity), let the user adjust, and re-run with `--journeys <id csv>` if adjusted. Inside the selected list there is no escape: a failure there is a verification failure handled through the 실패 시 flow above — never closed as "이번 수정 범위 아님". Record: `.ditto/local/work-items/<wi>/regression-gate.json`. This record is not optional bookkeeping — `ditto autopilot complete` refuses to assemble a completion while impacted journeys have no covering `pass` record (the deterministic backstop; running the gate here is what satisfies it).
- **삭제·갱신: 제안은 에이전트, 실행은 사용자 확인 후 CLI로**: when a change makes an existing test meaningless (flow removed, surface gone), PROPOSE the update/delete with its basis; only after the user explicitly confirms, run `ditto e2e lifecycle --action update|delete --journey-file e2e/journeys/<slug>.journey.md --confirmed-by-user [--reason <r>] [--work-item <wi>]`. Passing `--confirmed-by-user` on your own judgment is fabricating a user decision. The CLI refuses manual (non-`@ditto-generated`) files and refuses without the flag; `delete` preserves shared block helpers still referenced by other journeys; `update` only marks the spec for regeneration — the scripter pipeline above does the actual regeneration.

## Output contract
- Source of truth: `e2e/journeys/<slug>.journey.md` (+ blocks). Derived: `e2e/generated/**` with `@ditto-generated` headers.
- Generated specs run standalone via `npx playwright test` — no DITTO dependency at run time.
- Evidence: conformance exit code + `generated-verify.json` (pass/fail/blocked) for the pre-commit run.

## Hard rules
- **No agent-invented journeys.** A DSL file is only written from stated user intent; agent fills code facts, user owns the WHAT/WHY.
- **Generated files are never edited by hand** (by you or on user request — regenerate from the DSL instead; the DSL is the source of truth, and hand edits are detected as stale/missing-marker failures).
- **Manual tests are untouchable.** Files without the `@ditto-generated` marker are human-authored; this pipeline never modifies or deletes them.
- A failing conformance gate or a `fail` verify run is a blocker, not a footnote — fix via scripter rework or report honestly.
- Never commit; the pipeline ends at the report.
