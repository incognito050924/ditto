---
name: e2e
description: Run one real-browser user journey for a work item with the playwright-e2e agent, capture screenshot/trace/console/network under .ditto/local/runs/, and write a single e2eJourney artifact that can close an acceptance criterion as evidence. Use for high-impact web changes that affect a user journey.
argument-hint: "[work-item-id] [journey-url]"
---

# E2E

Run one browser user journey end-to-end and produce a single `e2eJourney` artifact whose `result` is grounded in observed evidence (screenshot/trace/console/network) — or `blocked` when no browser is available. This is the runtime for an autopilot `nodeKind=e2e` node (owner `playwright-e2e`, mapped in `autopilot-graph.ts` `KIND_TO_OWNER`).

## Procedure (driver)
Run as the main agent; spawn the journey as its own Task (1-level). One journey per invocation, direct URL only (no multi-journey, no MCP, no dev-server orchestration).

0. **Gate on axis-3 applicability.** Run `ditto e2e applicable --output json`. Axis-3 is real-browser E2E: a library / CLI / domain-model target has no web UI, so `applicable=false` means axis-3 is **N/A** — a signal read from the target, not judged per run. *Done when:* on `applicable=false` you record the N/A decision + the `covered_by` axes (axis-2 reviewer / axis-1 intent alignment carry the AC) as the node outcome and stop, with no browser run and no fabricated `blocked`. Only `applicable=true` proceeds to step 1.
1. **Build the journey spec** from the e2e node: `journey` (name), `url` (dev-server entry or live URL), ordered `steps`, and `assertions`. Write each assertion as a **mechanically-checkable predicate** the runner can evaluate against the live page — `<selector> contains <text>`, `<selector> visible`, `<selector> hidden`, or a bare CSS selector (present-check). *Done when:* every assertion is one of those predicate forms. Free-text NL ("the page shows a welcome banner") is not a selector — the runner marks it `checkable=false` and the journey can only land `result=unverified` (an honest "could not evaluate", never a fabricated `fail`).
2. **Spawn `playwright-e2e`** (1-level Task) with the spec only. It confirms the URL is reachable, drives the steps with Playwright/Chromium, captures screenshot/trace/console/network into `.ditto/local/runs/<run-id>/`, checks accessibility-critical interactions, and on failure records a `reproduction` plus the failing artifact paths. *Done when:* the agent returns a journey summary grounded in the captures — the driver never fabricates the browser outcome.
3. **Browser detection is probe-only.** The thin layer (`src/core/e2e/browser.ts`, `runJourney`) probes whether Playwright/Chromium is already present and, if absent, returns a schema-legal `result='blocked'` journey with the reason. *Done when:* an absent browser yields `result='blocked'` (routed per Blocked routing) rather than a `playwright install` attempt — the layer never installs and never hard-fails, and a `blocked` journey is an honest outcome, not a pass.
4. **Write exactly one `e2eJourney` artifact** (full `e2eJourney` schema, `src/schemas/e2e-journey.ts`, §10) to `.ditto/local/runs/<run-id>/journey.json` (a `reviews/` copy is optional). *Done when:* the artifact satisfies the schema cross-field invariants — `result=fail` ⇒ `reproduction` present; `result=pass` ⇒ every assertion `checkable` and satisfied; `result=unverified` ⇒ ≥1 unchecked (NL) assertion and no checkable assertion contradicted.

## Blocked routing (autopilot)
When an autopilot e2e node returns `result='blocked'` (browser / optional tool absent), the driver records `failure_class: blocked_external` — routes to `escalate` (`src/core/autopilot-dispatch.ts:225-227`), NOT `fixable` (no retry loop burned) and NOT a fabricated `fail`. The work item then routes around e2e: the other axes (axis-2 reviewer / static + verify) carry the AC, and completion lands when the remaining evidence closes the ACs. When the DoD specifically requires e2e, the AC stays honest `unverified`, never a fabricated pass.

## e2eJourney → EvidenceRecord (completion)
The `e2eJourney` closes an acceptance criterion as **one EvidenceRecord** (`src/schemas/evidence-record.ts`) in the work item's `CompletionContract` `acceptance[].evidence_records`:

- `ref.kind = 'artifact'`, `ref.path = .ditto/local/runs/<run-id>/journey.json` (+ `ref.sha256` of the journey when portable).
- `portability = 'local-artifact'` (raw captures live under gitignored `.ditto/local/runs/`).
- `artifact_available = true` in the capturing session; other clones judge from the summary / sha256 / `key_lines`.
- `key_lines` carries the journey `result` + the satisfied/blocked assertion summary, so completion is judgeable without reopening the raw capture.

The E2E run is one evidence kind, not the verdict — the `CompletionContract` aggregates the `final_verdict`.

## Output contract
- Terminal shape is either the axis-3 **N/A** record (step 0) or exactly one `e2eJourney` artifact at `.ditto/local/runs/<run-id>/journey.json` conforming to the schema.
- `result ∈ {pass, fail, unverified, blocked}` with the per-step meanings above; `blocked` is the expected outcome when no browser is present.
- Artifacts are referenced by repo-relative `path` (+ sha256 for screenshots); raw captures stay under `.ditto/local/runs/`.
