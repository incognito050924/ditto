---
name: e2e
description: Run one real-browser user journey for a work item with the playwright-e2e agent, capture screenshot/trace/console/network under .ditto/runs/, and write a single e2eJourney artifact that can close an acceptance criterion as evidence. Use for high-impact web changes that affect a user journey.
argument-hint: "[work-item-id] [journey-url]"
---

# E2E

Run one browser user journey end-to-end and produce a single `e2eJourney` artifact whose `result` is grounded in observed evidence (screenshot/trace/console/network) — or `blocked` when no browser is available. This is the runtime for an autopilot `nodeKind=e2e` node (owner `playwright-e2e`, mapped in `autopilot-graph.ts` `KIND_TO_OWNER`).

How (contract structure, artifact policy, MCP exclusion, autopilot/evidence integration) is owned by `reports/design/contracts/e2e-journey-contract.md`.

## Procedure (driver)
Run as the main agent; spawn the journey as its own Task (1-level). One journey per invocation — never multi-journey, never MCP, never dev-server orchestration (direct URL only).

1. **Build the journey spec** from the e2e node: `journey` (name), `url` (existing dev-server entry or live URL), ordered `steps`, and the `assertions` the journey must satisfy.
2. **Spawn `playwright-e2e`** (1-level Task) with the spec only. The agent confirms the URL is reachable, drives the steps with Playwright/Chromium, captures screenshot/trace/console/network into `.ditto/runs/<run-id>/`, checks accessibility-critical interactions, and on failure records a `reproduction` plus the failing artifact paths.
3. **Browser detection (hard constraint).** The thin layer (`src/core/e2e/browser.ts`, `runJourney`) probes whether Playwright/Chromium is already present WITHOUT installing it. If absent, it returns a schema-legal `result='blocked'` journey with the reason — it never runs `playwright install` and never hard-fails. A `blocked` journey is an honest outcome, not a pass.
4. **Write exactly one `e2eJourney` artifact** (full `e2eJourney` schema, `src/schemas/e2e-journey.ts`) to the run directory `.ditto/runs/<run-id>/journey.json` (a `reviews/` copy is optional). The schema enforces the cross-field invariants: `result=fail` ⇒ `reproduction` present; `result=pass` ⇒ every assertion satisfied.

The driver constructs the spec and spawns; it does not fabricate the browser outcome. The journey's `result` must reflect what the run observed.

## e2eJourney → EvidenceRecord (completion)
The produced `e2eJourney` closes an acceptance criterion by being referenced as **one EvidenceRecord** (`src/schemas/evidence-record.ts`) in the work item's `CompletionContract` `acceptance[].evidence_records`:

- `ref.kind = 'artifact'`, `ref.path = .ditto/runs/<run-id>/journey.json` (+ `ref.sha256` of the journey when portable).
- `portability = 'local-artifact'` (raw browser captures live under `.ditto/runs/`, gitignored).
- `artifact_available = true` in the capturing session; other clones judge from the summary / sha256 / `key_lines`.
- `key_lines` carries the journey `result` and the satisfied/blocked assertion summary so completion is judgeable without reopening the raw capture.

The E2E run is one evidence kind, not the verdict — the `CompletionContract` aggregates the `final_verdict`.

## Output contract
- Exactly one `e2eJourney` artifact (`.ditto/runs/<run-id>/journey.json`) conforming to the `e2eJourney` schema (§10).
- `result ∈ {pass, fail, blocked}`; `fail` carries `reproduction`; `blocked` is the expected outcome when no browser is present.
- Artifacts referenced by repo-relative `path` (+ sha256 for screenshots); raw stays under `.ditto/runs/`.
