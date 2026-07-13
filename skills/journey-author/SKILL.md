---
name: journey-author
description: Author user stories and journeys in dialogue with the user, then compile them into per-entity story/journey files + v2 journey DSL (e2e/journeys/*.journey.md). Two entry points — ① story→journey→E2E (user-value first) and ② journey→E2E (value already fixed). The user owns the WHAT/WHY; the agent fills code facts and proposes a decomposition the user reviews. DSL→Playwright conversion/run is out of scope — it hands off to the e2e-author pipeline (official Playwright test-generator; ADR-0014, ADR-20260702-e2e-official-test-agents).
argument-hint: "[--kind=story|journey] [story or journey description]"
---

# Journey Author

Turn user value into traceable E2E artifacts. The authoring buffer (`ditto journey-author start/record-*/decompose/finalize`) is the working source; `finalize` compiles it into **ADR-0005 per-entity** story/journey files + **v2** journey DSL (`e2e/journeys/*.journey.md`). The catalog is a **read-side projection** reduced from the per-entity files (`src/core/journey-authoring/store.ts`) — never written directly.

This is the value→DSL stage. Turning the DSL into runnable Playwright specs and verifying it is **e2e-author**'s job — continue there, do not script it here (ADR-0014, ADR-20260702-e2e-official-test-agents).

## When to enter
- The user wants to capture a user story and/or journey as a durable, traceable artifact that later compiles into an E2E test.
- For a one-off "does this page work now" check, use `skills/e2e` instead.

## Two entry points (ac-1)
One command, picked by `start --kind`:
- **`--kind story`** — surface ① **story→journey→E2E**: the user's value (actor/want/value) comes first; it decomposes into one or more journeys, which become E2E artifacts.
- **`--kind journey`** — surface ② **journey→E2E**: the value is already fixed; record the journey directly toward E2E. (Authoring DSL straight from a finished journey with no story context also starts here.)

```
ditto journey-author start --work-item <wi> --kind story|journey --output json
```

## Procedure (driver — main session)

1. **Listen for intent.** The WHAT and WHY of the story/journey come from the user. Code facts (selectors, routes, existing test ids, whether product code exists) are yours — investigate the repo, delegating bulk exploration to a `researcher` subagent. *Done when:* intent is captured from the user and code facts are repo-sourced, never asked of the user or invented.

2. **Surface ① — record the story.** Capture the user's value as a story draft:

   ```
   ditto journey-author record-story --work-item <wi> --json '{
     "slug": "<kebab>", "owner": "<owner>",
     "actor": "<who>", "want": "<what>", "value": "<why>",
     "reference_journey_ids": [ ... ]
   }' --output json
   ```
   *Done when:* the story draft is recorded in the buffer.

3. **Propose a decomposition — the user reviews and confirms (ac-5).** `decompose` suggests ordered journey steps from a one-line intent, writes nothing, and never auto-confirms.

   ```
   ditto journey-author decompose --intent "<one-line intent>" --output json
   ```
   *Done when:* the user has confirmed the steps to materialize — nothing is recorded until they do. The agent may propose structure, but the user owns the journey.

4. **Record each confirmed journey.** Upsert a journey draft by slug (same slug updates in place):

   ```
   ditto journey-author record-journey --work-item <wi> --json '{
     "slug": "<kebab>", "name": "<name>", "description": "<desc>",
     "owner": "<owner>", "intent": "<intent>", "surfaces": [ ... ],
     "steps": [ ... ], "implemented": <bool>
   }' --output json
   ```

   **`implemented` decides the status (ac-6).** `implemented: true` ⇒ `awaiting_validation` (product code exists to resolve selectors). `implemented: false` (the default) ⇒ **`spec_first`** — the journey is specified before the code exists and is excluded from the active selector mapping until code arrives (`store.ts`), so spec-first authoring never claims a binding the code cannot satisfy. *Done when:* every confirmed journey is recorded with its `implemented` flag set truthfully.

5. **Finalize — compile the buffer (fail-closed).**

   ```
   ditto journey-author finalize --work-item <wi> --output json
   ```

   Every conflict/reference gate runs **before any write**: an id conflict or a story referencing an absent journey rejects the whole compile with the defect location — fix the buffer, never bypass. On success it writes the **per-entity** story/journey files and the **v2** journey DSL (`e2e/journeys/*.journey.md`) — `implementation_intent` is derived from the journey's description + intent; the richer v2 context (constraints, edge/failure cases, auth/initial_state/seed) is added later during e2e-author's guided authoring, not here — and reports the ids + `dsl_paths` + any `superseded`. *Done when:* finalize returns the written ids + `dsl_paths` (or rejects with a defect location to fix).

6. **Hand off to E2E.** The v2 journey DSL is now the contract. Continue in **e2e-author**: enrich the v2 context (constraints, edge/failure cases, auth/initial_state/seed), then its plan→generate→gate pipeline turns the DSL into a verified Playwright spec. This skill ends at the v2 DSL + per-entity artifacts (ADR-20260702-e2e-official-test-agents).

## Hard rules (guardrails)
- **No agent-invented stories or journeys.** A story/journey is recorded only from stated user intent; the agent fills code facts and *proposes* a decomposition, the user confirms before anything is recorded (ac-5). `decompose` writes nothing and never auto-confirms; only `record-journey` (on the user's confirmed steps) materializes.
- **Unimplemented screens are `spec_first` (ac-6)** — set `implemented: false` when no product code exists yet; never claim a binding the code cannot satisfy.
- **The catalog and compiled files are re-generated, never hand-edited** — the catalog is a read-side projection reduced from the per-entity files; to change the compiled story/journey files, re-run `finalize` from the buffer.
- **Finalize is fail-closed** — id conflicts and missing journey references reject the whole compile before any write; fix the buffer, never bypass a gate.
- **DSL→Playwright conversion/run is out of scope** — hand off to the e2e-author pipeline for that stage (ADR-0014, ADR-20260702-e2e-official-test-agents); this skill ends at the v2 DSL + per-entity artifacts.
- Never commit; the pipeline ends at the report.
