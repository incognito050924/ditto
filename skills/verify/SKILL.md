---
name: verify
description: Independently verify that a work item's acceptance criteria are actually met with evidence, and emit a completion contract. Use when a change claims to be done, to confirm a fix, or before declaring final_verdict=pass.
argument-hint: "[work-item-id]"
---

# Verify

Check, with evidence, that each acceptance criterion of the work item is actually met — then produce a `completion.json` whose `final_verdict=pass` only when every criterion is `pass` and there are no in-scope unverified items.

## Procedure
1. Load the work item and its acceptance criteria.
2. For each criterion, gather the required evidence (run the command, read the diff, exercise the behavior) — not aspirational claims.
3. Record per-criterion verdicts with evidence references.
4. Explicitly list anything not verified (`unverified` with reasons); mark intentionally out-of-scope items `out_of_scope=true`.
5. Aggregate `final_verdict`. The completion contract schema rejects `pass` with any non-pass criterion or in-scope unverified item.

## Output contract
- `completion.json` conforming to the completion contract (§6.8).
- Non-pass verdicts require a `next_handoff_path`.
- The Stop gate cross-checks this against the work item's acceptance set (no missing/extra/duplicate criteria).
