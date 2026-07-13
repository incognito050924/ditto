---
name: verify
description: Independently verify that a work item's acceptance criteria are actually met with evidence, and emit a completion contract. Use when a change claims to be done, to confirm a fix, or before declaring final_verdict=pass.
argument-hint: "[work-item-id]"
---

# Verify

Check, with evidence, that each acceptance criterion of the work item is actually met — then produce a `completion.json` whose `final_verdict=pass` only when every criterion is `pass` and there are no in-scope unverified items.

## Procedure

1. **Load the work item and its acceptance criteria.** Done when you have the full criterion set the completion contract will be checked against.
2. **Gather fresh evidence for each criterion by exercising it** — run the command, read the diff, drive the behavior — so each verdict rests on observed behavior, not the author's claim. Done when every criterion has evidence you produced this run.
3. **Record per-criterion verdicts with evidence references.** Done when each criterion carries a verdict plus the reference that backs it.
4. **Account for the rest explicitly** — list anything not verified as `unverified` with a reason, and mark intentionally excluded items `out_of_scope=true`. Done when no criterion is left in an undeclared state.
5. **Aggregate `final_verdict`.** The completion contract schema rejects `pass` with any non-pass criterion or in-scope unverified item, so a `pass` here means every criterion passed. Done when `completion.json` validates against the contract.

## Semantic compatibility observation (O2/O8)

If the change touched exported signatures, run `ditto semantic observe --work-item <wi> --base <work-item start sha or main>` once during verify. This records changed exported signatures to the **non-gated** `semantic-scan-observation.json` (observation, not a verdict — it does NOT block completion). Review the observed changes: promote any meaning-breaking change to a blocking verdict with `ditto semantic detect` + `ditto semantic verdict`, or declare it intended. A re-run with an unchanged tree is skipped by fingerprint, so it is cheap to repeat. The Stop hook also surfaces a reminder when source changed without any semantic artifact.

## Output contract

- `completion.json` conforming to the completion contract (§6.8).
- Non-pass verdicts require a `next_handoff_path`.
- The Stop gate cross-checks this against the work item's acceptance set (no missing/extra/duplicate criteria).
</content>
