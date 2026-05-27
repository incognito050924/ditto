---
name: handoff
description: Write the minimal context for another session or agent to pick up the same work item without losing intent or scope. Use at context pressure, session end, agent switch, or a long-task checkpoint.
argument-hint: "[work-item-id]"
---

# Handoff

Produce the minimal, sufficient context for the next session/agent to continue the SAME work item (same `autopilot_id`) without re-deriving intent. A handoff is not completion — it is orthogonal to the completion contract.

## Procedure
1. Capture: original user intent, current state, decisions already made, changed files.
2. Render verification evidence inline (summary / hash / command / exit code) — never assume raw artifacts travel. If raw artifacts are absent from this clone, set `artifact_available: false`.
3. List failed/unverified items, open threads, and the single first thing the next agent should check.
4. State the scope creep to forbid.

## Output contract
- `handoff` artifact conforming to the handoff schema (§6.10).
- Resume target keeps the same `autopilot_id`; scope is never narrowed because "this turn ran out".
