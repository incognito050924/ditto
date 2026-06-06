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

## Storage, auto-read, auto-cleanup (wi_260605wf3)
Handoffs live in a single work-item-independent location, **not** under each work item:
- `.ditto/handoff/<work-item-id>.md` — **active**, waiting to be picked up.
- `.ditto/handoff/archive/<id>__<ts>.md` — consumed, or a completed (pass) handoff that needs no pickup.

The format is a one-line JSON frontmatter (machine round-trip) + a human-readable body. The CLI writes through this store: `ditto work handoff <id>` writes an active handoff on a non-pass item, and a pass item goes straight to archive (no active noise). PreCompact writes an active handoff automatically before compaction.

**Auto-read**: the next session does NOT need to be told a filename. The UserPromptSubmit hook reads every active handoff in `.ditto/handoff/`, injects its body into context, then moves it to archive — so a handoff is picked up exactly once and `active` never accumulates. Do not paste handoff paths into prompts; just continue.

## Output contract
- `handoff` artifact conforming to the handoff schema (§6.10), written through `HandoffStore`.
- Resume target keeps the same `autopilot_id`; scope is never narrowed because "this turn ran out".
