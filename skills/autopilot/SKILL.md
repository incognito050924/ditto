---
name: autopilot
description: Drive a work item's node graph to completion without user intervention — select ready nodes, delegate to owner subagents, collect evidence, classify failures, and continue until the stop conditions. Internal orchestrator loop; not user-invoked directly.
user-invocable: false
---

# Autopilot (skeleton)

The orchestrator (main agent) drives the work item's node graph to completion. This is a v0 **skeleton**: the frontmatter and role are fixed here; the ReAct loop body is filled in M2.2.

How (graph structure, driver loop, failure classification, approval gate, schema) is owned by `reports/design/contracts/autopilot-contract.md`.

## Identity (invariants)
- Orchestrator, not implementer: select / spawn / classify / evaluate — never generate content.
- `root_goal` is never split; only nodes are. Re-read `autopilot.json` each round (do not accumulate the graph in context).
- Graph mutation only through `AutopilotStore`.
- Owner spawn uses Context Isolation (no driver hypotheses / other-node results injected).
- Internal checkpoint completion ≠ final answer; the whole work item is the bar.
- Loop persistence is enforced by the Stop hook (M1.4), not by this skill.

## ReAct loop (filled in M2.2)
> Placeholder: re-read graph → select ready node (deps passed) → kind→owner 6-section packet → spawn owner subagent (1-level) → collect evidence + update node via AutopilotStore → classify failure (retry/switch/escalate) → evaluate stop conditions.
