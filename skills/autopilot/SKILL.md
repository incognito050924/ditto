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
Run this loop until a stop condition holds. The two CLI step commands own the deterministic mechanics (select, approval gate, packet build, the G7 content-free floor, failure-decision policy, transition table, persistence) so this skill never re-describes them; your job is the *judgment* (which result passed, fixable vs wrong approach, when to escalate). Re-read nothing into context across rounds — the commands read `autopilot.json` each call.

1. **Ask for the next step.** Run `ditto autopilot next-node --workItem <wi> --output json`. It re-reads the graph, consumes the approval gate (only a mutating/implementer node is gated; design/research may run before approval), selects the next ready node through the file-overlap gate, **dispatches it (pending → running, persisted)**, and returns one `action`:
   - `spawn` → `{node_id, owner, packet}`: go to step 2.
   - `present_plan` → approval pending before a mutating node: present the plan to the user and STOP (do not mutate).
   - `rollback` → plan rejected: in-flight nodes were rolled back to pending; STOP and re-plan.
   - `waiting` → nothing ready (deps unmet or a node still running): nothing to do this round.
   - `blocked` → `{blocked_node_ids, reason}`: a node is blocked on a user-owned decision (§4.3, e.g. a forward-re-expansion budget escalation) with nothing else runnable. STOP and surface the ids + reason to the user; do not poll it as `waiting`.
   - `cleanup` → `{node_id, reason}`: a `driver`-owned (cleanup) node — a deterministic engine step, **not an LLM owner**, so there is nothing to spawn. The node is already dispatched to running. Run `ditto autopilot cleanup --workItem <wi> --node <node_id>` to execute the gated teardown (per-run git worktrees, §2.2). Worktree removal is irreversible git, so it is gated by an **explicit** approval: add `--approve` to authorize. Without it (and with worktrees to remove) the node is blocked and the teardown plan is surfaced for a user-owned decision; the small-reversible auto-waiver does NOT authorize. An empty plan passes trivially. Then go back to step 1.
   - `done` → `{all_passed}`: all nodes terminal. This is the completion *disposition*, not a verdict — graph done ≠ acceptance criteria closed (§6.8). Assemble the completion with `ditto autopilot complete --workItem <wi> [--summary "…"]`: it maps each AC to the evidence the nodes collected and derives the verdict **evidence-gated** (a criterion passes only when an addressing node passed *and* carried evidence; otherwise `unverified`) — `final_verdict=pass` still demands every AC closed with real evidence, never auto-pass on graph-done.
2. **Spawn** the owner stage subagent with `packet` (Task, one level deep). You select and spawn; you never generate the content yourself. Context Isolation: the packet already carries TASK · EXPECTED OUTCOME · REQUIRED TOOLS · MUST DO · MUST NOT DO · CONTEXT — never inject your hypotheses or other nodes' internal state.
3. **Judge the result, then record it.** Take the subagent's single result and form a judgment: did it pass (with evidence), or fail — and if so, which class (`fixable` | `wrong_approach` | `blocked_external` | `user_decision_needed`)? Run `ditto autopilot record-result --workItem <wi> --json '{node_id, result_text, outcome, failure_class?, evidence_refs?, changed_files?, reason?}'`. A mutating node (implementer/refactorer) reports the files it changed as `changed_files` (repo-relative); on a contentful pass they are unioned into the work item so `autopilot complete` reads them without a manual pin. The command enforces the deterministic floor: a **completion signal is not completion proof** — an empty or ack-only `result_text` ("done") is overridden to a `fixable` failure even if you claimed pass; `decideOnFailure` applies `retry`/`switch_approach` within caps (re-arming the node) or escalates; a cap hit is **non-pass** (≠ converged); the decision is logged to `autopilot-decisions.jsonl`. Pass `result_text` verbatim — do not pre-trim it to pass the guard. When a `design`/planner node's result *generates a node subgraph* (the planner is a graph generator, contract §2.4), include it as `generated_nodes` (intent-level: `{id, kind, purpose, depends_on, acceptance_refs}`); on a contentful pass `record-result` promotes it through `addNodes` (cycle/dup/dangling rejected), so the next `next-node` sees the grown graph.
4. **Loop or stop.** On `spawn`/`waiting`/`cleanup`, go back to step 1 (a passed node auto-advances; an internal checkpoint passing is never a final answer). On `present_plan`/`rollback`/`blocked`/`done`, stop per that action. The Stop hook (M1.4) blocks premature stops while a runnable node remains; it yields on approval-pending, a user-owned decision (`blocked`), an external blocker, or a safety boundary.

On context pressure, keep the SAME `autopilot_id`; never narrow scope because the turn ran out.
