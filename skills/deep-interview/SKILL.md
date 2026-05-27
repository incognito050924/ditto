---
name: deep-interview
description: Resolve intent ambiguity with unbiased Socratic questions and a pre-mortem before planning. Use when acceptance criteria cannot be written, the request depends on product/domain meaning, there are two or more materially different implementations, or a pre-mortem surfaces hard-to-reverse risk.
argument-hint: "[work-item-id]"
---

# Deep Interview

Resolve the *intent-level* ambiguity of a request to the degree needed — no more — and surface hard-to-reverse risk early with a pre-mortem. Plan-level adversarial checking is NOT done here; that is `/ditto:dialectic` (§6.6).

How (mechanism, thresholds, schema) is owned by `reports/design/contracts/deep-interview-contract.md`. This skill body is the v0 procedure skeleton.

## Procedure
1. Build candidate questions across every ambiguity dimension (no anchoring). Ask one at a time.
2. Before asking, pass each question through the QuestionGate self-answer check (code → docs → repo-artifact → web → memory). Ask the user only what only the user can answer; include "what changes depending on the answer".
3. Track readiness in `interview-state.json` (dimensions, ambiguity, readiness score/threshold).
4. Run a pre-mortem; promote irreversible/high-blast risks to acceptance criteria, `out_of_scope`, or a user-owned decision.
5. Exit only when the gate is met: every critical dimension resolved AND readiness ≥ threshold. A question cap is not success — record remaining ambiguity as explicit `hypothesis`-labelled assumptions.

## Output contract
- `interview-state.json` (sidecar; conforms to the schema).
- Updates IntentContract (`intent.json` + work-item `acceptance_criteria`) and syncs a short summary to the user: narrowed goal, added/removed scope, remaining assumptions, blocked user-owned decisions.
- Always records an explicit `exit.reason`. No silent exit.
