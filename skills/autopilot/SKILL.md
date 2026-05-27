---
name: autopilot
description: Drive a work item's node graph to completion without user intervention — select ready nodes, delegate to owner subagents, collect evidence, classify failures, and continue until the stop conditions. Internal orchestrator loop; not user-invoked directly.
user-invocable: false
---

# Autopilot

The orchestrator (main agent) drives the work item's node graph to completion. The driver runs on the main agent — it is never a subagent, because a subagent cannot spawn the stage subagents this loop needs (D3).

How (graph structure, driver loop, failure classification, approval gate, schema) is owned by `reports/design/contracts/autopilot-contract.md`.

## Identity (invariants)
- Orchestrator, not implementer: select / spawn / classify / evaluate — never generate content.
- `root_goal` is never split; only nodes are. Re-read `autopilot.json` each round (do not accumulate the graph in context).
- Graph mutation only through `AutopilotStore`.
- Owner spawn uses Context Isolation (no driver hypotheses / other-node results injected).
- Internal checkpoint completion ≠ final answer; the whole work item is the bar.
- Loop persistence is enforced by the Stop hook (M1.4), not by this skill.

## ReAct loop
Run this loop until a stop condition holds. Each step maps to a deterministic helper (the glue); the *judgment* (which node, fixable vs wrong approach, when to escalate) is yours.

1. **Re-read** the graph from `autopilot.json` (`AutopilotStore.get`) — never accumulate the graph in context across rounds.
2. **Select** the next ready node — `pending` with every `depends_on` `passed` (`selectReadyNode`). None ready → go to step 7.
3. **Approval check (before a mutating node).** Consume `approval_gate.status` (`mutationGate`): `approved`/`not_required` → proceed; `pending` → present the plan to the user and STOP (do not mutate); `rejected` → stop. You do not compute risk here — M2.1b/M2.2 bootstrap already set the status.
4. **Build the packet.** Map kind→owner (`kindToOwner`) and assemble the 6-section delegation packet (`buildDelegationPacket`): TASK · EXPECTED OUTCOME · REQUIRED TOOLS · MUST DO · MUST NOT DO · CONTEXT. Context Isolation: never inject your hypotheses or other nodes' internal state.
5. **Spawn** the owner stage subagent with the packet (Task, one level deep). You select and spawn; you never generate the content yourself.
6. **Collect & update.** Take the subagent's single result, gather evidence, and update the node through `AutopilotStore.updateNode` (the only mutation path). On failure: classify `{fixable|wrong_approach|blocked_external|user_decision_needed}`, then apply `decideOnFailure` — `retry`/`switch_approach` automatically within caps (increment `attempts`), `escalate` to the user otherwise. A cap hit is **non-pass** (≠ converged): raise a continuation signal (`buildContinuationSignal`) and stop. Record the decision in `autopilot-decisions.jsonl` (`appendDecision`).
7. **Continue or finish.** A passed node auto-advances to the next ready node without asking (M2.5). An internal checkpoint passing is never a final answer. When all nodes are terminal, completion/convergence is judged at the work-item level (M3).
8. **Persistence.** The Stop hook (M1.4) blocks premature stops while a runnable node remains; it yields (lets you stop) on approval-pending, a user-owned decision, an external blocker, or a safety boundary.

On context pressure, raise a continuation signal that keeps the SAME `autopilot_id`; never narrow scope because the turn ran out.
