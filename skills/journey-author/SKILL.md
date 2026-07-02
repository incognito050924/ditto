---
name: journey-author
description: Author user stories and journeys in dialogue with the user, then compile them into per-entity story/journey files + v2 journey DSL (e2e/journeys/*.journey.md). Two entry points — ① story→journey→E2E (user-value first) and ② journey→E2E (value already fixed). The user owns the WHAT/WHY; the agent fills code facts and proposes a decomposition the user reviews. DSL→Playwright conversion/run is out of scope — it hands off to the e2e-author pipeline (official Playwright test-generator; ADR-0014, ADR-20260702-e2e-official-test-agents).
argument-hint: "[--kind=story|journey] [story or journey description]"
---

# Journey Author

Turn user value into traceable E2E artifacts. The authoring buffer (`ditto journey-author start/record-*/decompose/finalize`) is the working source; `finalize` compiles it into **ADR-0005 per-entity** story/journey files + **v2** journey DSL (`e2e/journeys/*.journey.md`). The catalog is never written directly — it is a **read-side projection** reduced from the per-entity files (`src/core/journey-authoring/store.ts`).

This is the value→DSL stage. Turning the DSL into runnable Playwright specs and verifying them is the **e2e-author** skill's job (the official Playwright test-generator over a live browser, with the `e2e-scripter` agent as the no-browser fallback) — do not duplicate that pipeline here (ADR-0014, ADR-20260702-e2e-official-test-agents).

## When to enter

- The user wants to capture a user story and/or journey as a durable, traceable artifact that later compiles into an E2E test.
- Either a value-first story exists that should decompose into journeys (surface ①), or a concrete journey is already known and only needs to be recorded toward E2E (surface ②).

Do NOT enter for a one-off "does this page work now" check — that is `skills/e2e`. Authoring DSL straight from a finished journey with no story context can also start at surface ②.

## Two entry points (ac-1)

One command, picked by `start --kind`:

- **`--kind story`** — surface ① **story→journey→E2E**: the user's value (actor/want/value) comes first; it decomposes into one or more journeys, which become E2E artifacts.
- **`--kind journey`** — surface ② **journey→E2E**: the value is already fixed; record the journey directly toward E2E.

```
ditto journey-author start --work-item <wi> --kind story|journey --output json
```

## Procedure (driver — main session)

1. **Listen for intent.** The WHAT and WHY of the story/journey come from the user. Code facts (selectors, routes, existing test ids, whether product code exists) are YOUR job — investigate the repo, delegating bulk exploration to a `researcher` subagent. Never ask the user for selectors; never invent the user's intent.

2. **Surface ① — record the story.** Capture the user's value as a story draft:

   ```
   ditto journey-author record-story --work-item <wi> --json '{
     "slug": "<kebab>", "owner": "<owner>",
     "actor": "<who>", "want": "<what>", "value": "<why>",
     "reference_journey_ids": [ ... ]
   }' --output json
   ```

3. **Propose a decomposition — user reviews and confirms (ac-5).** `decompose` is **proposal only**: it suggests ordered journey steps from a one-line intent, writes nothing, and never auto-confirms. Present the proposal; the user owns the WHAT, so nothing is materialized until they confirm.

   ```
   ditto journey-author decompose --intent "<one-line intent>" --output json
   ```

   This mirrors e2e-author's **"No agent-invented journeys"** rule: the agent may propose structure, but the user owns the journey — never record steps the user has not confirmed.

4. **Record each confirmed journey.** Upsert a journey draft by slug (same slug updates in place):

   ```
   ditto journey-author record-journey --work-item <wi> --json '{
     "slug": "<kebab>", "name": "<name>", "description": "<desc>",
     "owner": "<owner>", "intent": "<intent>", "surfaces": [ ... ],
     "steps": [ ... ], "implemented": <bool>
   }' --output json
   ```

   **`implemented` decides the status (ac-6).** `implemented: true` ⇒ `awaiting_validation` (product code exists to resolve selectors). `implemented: false` (the default) ⇒ **`spec_first`** — the journey is specified before the code exists. A `spec_first` journey is intentionally excluded from the active selector mapping until code arrives (`store.ts`), so spec-first authoring never produces a journey that falsely claims to bind to running code.

5. **Finalize — compile the buffer (fail-closed).**

   ```
   ditto journey-author finalize --work-item <wi> --output json
   ```

   Every conflict/reference gate runs **before any write**: an id conflict or a story referencing an absent journey rejects the whole compile with the defect location — fix the buffer, never bypass. On success it writes the **per-entity** story/journey files and the **v2** journey DSL (`e2e/journeys/*.journey.md`) — `implementation_intent` is derived from the journey's description + intent; the richer v2 context (constraints, edge/failure cases, auth/initial_state/seed) is added later during e2e-author's guided authoring, not here — and reports the ids + `dsl_paths` + any `superseded`.

6. **Hand off to E2E.** The v2 journey DSL is now the contract. Turning it into a runnable Playwright spec and verifying it is **e2e-author**'s pipeline: enrich the v2 context (constraints, edge/failure cases, auth/initial_state/seed), `ditto e2e plan`, then the official Playwright test-generator writes the spec over a live browser (`ditto e2e init-agents` + `ditto e2e generate`; the `e2e-scripter` agent is the no-browser fallback), gated by `ditto e2e conformance`/`mapping`/`verify-generated`. Continue there — do not script it here (ADR-20260702-e2e-official-test-agents).

## Hard rules

- **No agent-invented stories or journeys.** A story/journey is only recorded from stated user intent; the agent fills code facts and *proposes* a decomposition, the user owns the WHAT/WHY and confirms before anything is recorded (ac-5).
- **`decompose` is proposal-only** — it writes nothing and never auto-confirms; only `record-journey` (on the user's confirmed steps) materializes.
- **Unimplemented screens are `spec_first` (ac-6)** — set `implemented: false` when no product code exists yet; never claim a binding the code cannot satisfy.
- **The catalog is a read-side projection**, reduced from the per-entity files — never hand-write or hand-edit a catalog file, and never hand-edit the compiled per-entity story/journey files (re-run `finalize` from the buffer instead).
- **Finalize is fail-closed** — id conflicts and missing journey references reject the whole compile before any write; fix the buffer, never bypass a gate.
- **DSL→Playwright conversion/run is out of scope** — hand off to the e2e-author pipeline for that stage (official Playwright test-generator, with e2e-scripter as the no-browser fallback; ADR-0014, ADR-20260702-e2e-official-test-agents); this skill ends at the v2 DSL + per-entity artifacts.
- Never commit; the pipeline ends at the report.
