# Role: state-persistence  (NOT a workflow subagent — calling-session-owned)

The design originally named a `State-Writer` subagent that would `agent(...)` to write `queue.json`/`log.jsonl`. **That role is removed on review.** Two findings force it:

1. **A Workflow script has no filesystem access.** The shipping code-modernization workflows delegate ALL file IO + resume to the calling session (`portfolio-assess.js` meta: "workflow scripts have no filesystem access … the calling session writes/renders"; `uplift-migrate.js` returns re-passable unit lists for the next invocation's `args`). So the harness cannot own the restart invariant, and there is nothing for a State-Writer subagent to reliably do.
2. **Delegating deterministic JSON writes to a non-deterministic LLM is a defect.** The original draft embedded `JSON.stringify(queue).slice(0,4000)` — silently truncating state as the queue grew — and never checked the writer's return. Determinism cannot come from an LLM turn.

## Where state lives instead
- The workflow holds the queue as a JS value during a run and **returns `resume_state`** (full queue + backlog + `round` + `openHist` + `noProgress`) in its final structured output — no truncation.
- The **calling session** (which has a real shell/FS) persists that to `state/queue.json` + appends to `state/log.jsonl`, and on resume passes it back as `args.resumeState`. Resume is an EXTERNAL boundary, mirroring the shipping workflows.
- The escape-detection carry-state (`openHist`, `noProgress`, `round`) is part of `resume_state`, so bounded+escape survives restart (not just the queue) — closing the "escape state is volatile" gap.

## Single-source-of-truth clarification (F4)
"Single-source disk state" is a property of the **built rebuild/ foundation** (the thing under construction), realized and tested inside the island. It is NOT the harness's own runtime state. The harness's durable state is exactly the returned `resume_state` that the calling session persists — there is one writer (the calling session), so no dual-state.
