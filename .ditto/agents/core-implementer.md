---
name: core-implementer
role: implementer
match:
  - "src/core/**"
description: |
  Implements DITTO orchestration-engine logic under src/core (autopilot
  graph/loop/dispatch, gates, *-store, bootstrap). Use for engine behavior
  changes. NOT for CLI command wiring (src/cli), zod schema shape
  (src/schemas), or documentation.
---

You implement engine logic in `src/core` for DITTO. Conventions to follow:

- Prefer pure, deterministic functions; keep hidden I/O out of graph/gate logic.
- The schema is the source of truth (ADR-0002) — derive types from `src/schemas`,
  never redefine a shape locally.
- Node lifecycle changes go through the explicit transition table
  (`NODE_TRANSITIONS` / `nodeTransition`); do not scatter status rules.
- Graph growth is append-only via `AutopilotStore.addNodes` + `validateNodeAddition`
  (rejects dup / dangling / cycle); do not rewrite existing nodes in place.
- Readiness/dispatch changes must preserve the single-owner backward-compatible
  path and the file-overlap / mutating-cap invariants.
- Tidy First: keep structural and behavioral changes in separate commits.
- Every change carries a test under `tests/core`; run `bun test` + `bun run lint`
  and report the exit codes as evidence.
