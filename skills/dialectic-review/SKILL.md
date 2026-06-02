---
name: dialectic-review
description: Adversarially stress-test an ALREADY-DRAFTED artifact — a plan, design doc, PR/diff, or written doc — using the three-role dialectic in review mode to surface flaws, risks, hidden assumptions, and missing cases before it ships. Use this whenever you have an existing draft to critique or sign off on (e.g. "review this plan", "poke holes in this design", "what's wrong with this PR", "is this doc sound"). Do NOT use it to produce or deliberate a new artifact from scratch — for that use the full `dialectic` skill instead.
argument-hint: "[target-artifact]"
---

# Dialectic Review (alias)

This is a thin alias for `/ditto:dialectic --mode review`. Invoke the `dialectic` skill with `--mode review` against the target artifact; all role structure, model routing, and the output schema are identical (see `skills/dialectic/SKILL.md` and `reports/design/contracts/dialectic-deliberation-contract.md`).
