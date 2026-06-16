---
name: e2e
description: Run one real-browser user journey for a work item with the playwright-e2e agent, capture screenshot/trace/console/network under .ditto/local/runs/, and write a single e2eJourney artifact that can close an acceptance criterion as evidence. Use for high-impact web changes that affect a user journey.
argument-hint: "[work-item-id] [journey-url]"
---

# E2E

Run one browser user journey end-to-end and produce a single `e2eJourney` artifact whose `result` is grounded in observed evidence (screenshot/trace/console/network) — or `blocked` when no browser is available. This is the runtime for an autopilot `nodeKind=e2e` node (owner `playwright-e2e`, mapped in `autopilot-graph.ts` `KIND_TO_OWNER`).

How (contract structure, artifact policy, MCP exclusion, autopilot/evidence integration) is owned by `reports/design/contracts/e2e-journey-contract.md`.

## Procedure (driver)
Run as the main agent; spawn the journey as its own Task (1-level). One journey per invocation — never multi-journey, never MCP, never dev-server orchestration (direct URL only).

0. **Check axis-3 applicability first.** Run `"${CLAUDE_PLUGIN_ROOT}/bin/ditto" e2e applicable --output json`. Axis-3 is real-browser E2E only: a library / CLI / domain-model target has no web UI, so axis-3 is **N/A**. When `applicable=false`, do NOT spawn a browser run or fabricate a `blocked` journey — record the N/A decision and the `covered_by` axes (axis-2 reviewer / axis-1 intent alignment carry the verification) as the node's outcome, and stop. Only proceed to step 1 when `applicable=true`. (This is the automatic N/A branch — read from a web-UI signal, not judged per run.)

1. **Build the journey spec** from the e2e node: `journey` (name), `url` (existing dev-server entry or live URL), ordered `steps`, and the `assertions` the journey must satisfy. Write each assertion as a **mechanically-checkable predicate** so the runner can evaluate it against the live page: `<selector> contains <text>`, `<selector> visible`, `<selector> hidden`, or a bare CSS selector (present-check). Free-text NL ("the page shows a welcome banner") is NOT a selector — the runner cannot evaluate it, marks it `checkable=false`, and the journey lands on `result=unverified` (an honest "could not evaluate", never a fabricated `fail`). Prefer a checkable predicate over prose so the assertion actually closes the criterion.
2. **Spawn `playwright-e2e`** (1-level Task) with the spec only. The agent confirms the URL is reachable, drives the steps with Playwright/Chromium, captures screenshot/trace/console/network into `.ditto/local/runs/<run-id>/`, checks accessibility-critical interactions, and on failure records a `reproduction` plus the failing artifact paths.
3. **Browser detection (hard constraint).** The thin layer (`src/core/e2e/browser.ts`, `runJourney`) probes whether Playwright/Chromium is already present WITHOUT installing it. If absent, it returns a schema-legal `result='blocked'` journey with the reason — it never runs `playwright install` and never hard-fails. A `blocked` journey is an honest outcome, not a pass.
4. **Write exactly one `e2eJourney` artifact** (full `e2eJourney` schema, `src/schemas/e2e-journey.ts`) to the run directory `.ditto/local/runs/<run-id>/journey.json` (a `reviews/` copy is optional). The schema enforces the cross-field invariants: `result=fail` ⇒ `reproduction` present; `result=pass` ⇒ every assertion is `checkable` and satisfied; `result=unverified` ⇒ ≥1 unchecked (NL) assertion and no checkable assertion contradicted.

The driver constructs the spec and spawns; it does not fabricate the browser outcome. The journey's `result` must reflect what the run observed.

## e2eJourney → EvidenceRecord (completion)
The produced `e2eJourney` closes an acceptance criterion by being referenced as **one EvidenceRecord** (`src/schemas/evidence-record.ts`) in the work item's `CompletionContract` `acceptance[].evidence_records`:

- `ref.kind = 'artifact'`, `ref.path = .ditto/local/runs/<run-id>/journey.json` (+ `ref.sha256` of the journey when portable).
- `portability = 'local-artifact'` (raw browser captures live under `.ditto/local/runs/`, gitignored).
- `artifact_available = true` in the capturing session; other clones judge from the summary / sha256 / `key_lines`.
- `key_lines` carries the journey `result` and the satisfied/blocked assertion summary so completion is judgeable without reopening the raw capture.

The E2E run is one evidence kind, not the verdict — the `CompletionContract` aggregates the `final_verdict`.

## Output contract
- When axis-3 is **N/A** (`ditto e2e applicable` → `applicable=false`): no browser run; the node records the N/A decision + the `covered_by` axes. A library/CLI target legitimately produces no journey.
- Otherwise, exactly one `e2eJourney` artifact (`.ditto/local/runs/<run-id>/journey.json`) conforming to the `e2eJourney` schema (§10).
- `result ∈ {pass, fail, unverified, blocked}`; `fail` carries `reproduction`; `unverified` = ran but ≥1 assertion was not a checkable predicate (NL prose); `blocked` is the expected outcome when no browser is present.
- **Driver classification of `blocked`.** When an autopilot e2e node returns `result='blocked'` (browser / optional tool absent), the driver records `failure_class: blocked_external` (routes to `escalate`, `src/core/autopilot-dispatch.ts:225-227`) — NOT `fixable` (no retry loop burned) and NOT a fabricated `fail`. Consequence: the work item routes around e2e — the other axes (axis-2 reviewer / static + verify) carry the AC, and completion lands when the remaining evidence closes the ACs; when the DoD specifically requires e2e, the AC is left honest `unverified` (never a fabricated pass).
- Artifacts referenced by repo-relative `path` (+ sha256 for screenshots); raw stays under `.ditto/local/runs/`.
