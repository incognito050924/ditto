---
name: plan
description: Turn a ready intent into an ordered plan of nodes (research/design/implement/review/verify) with acceptance mapping and an approval decision. Internal to autopilot; not user-invoked directly.
user-invocable: false
---

# Plan

Produce the ordered plan for a work item whose intent is ready: derive the node graph (kind → owner, dependency DAG) from the goal and acceptance criteria, map each node to acceptance refs, and determine whether the plan needs approval before mutating work.

This skill is invoked internally (by autopilot / the orchestrator), not by the user. It does not generate implementation content — it produces the plan and the approval signal.

## Output contract
- Initial `autopilot.json` node graph (consumed by `autopilot`).
- Approval signal: `pending` when the plan carries high-risk (non-local ∨ irreversible ∨ unaudited) assumptions, else `not_required`/`approved`.
- Mutating nodes do not run while approval is `pending`.
