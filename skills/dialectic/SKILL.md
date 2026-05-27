---
name: dialectic
description: Run a three-role (Producer / Opponent / Synthesizer) adversarial deliberation over a plan, decision, or artifact, preferring Codex for the Opponent. Use to pressure-test a plan or design before committing, or to converge a contested decision.
argument-hint: "--mode <create|review|decision|proposal|document|final-answer>"
---

# Dialectic Deliberation

Separate three roles so a single model cannot mark its own homework. The `--mode` only changes what the three roles work on and produce; the role structure and output schema are constant.

How (role separation, model routing, Codex Opponent bridge, round policy, admissibility link, schema) is owned by `reports/design/contracts/dialectic-deliberation-contract.md`.

## Roles
- **Producer** — states the best argument for the draft + a concrete proposal, with evidence, assumptions, known limits.
- **Opponent** (Codex preferred, Claude fallback recorded) — objections, each linked to an oracle (acceptance criterion, file:line, doc, or user intent); plus missing alternatives, scope-creep risks, verification gaps.
- **Synthesizer** — verdict (`accept|revise|reject|blocked`) + agreed final position; rejections carry as much grounding as a raise.

## Output contract
- `reviews/dialectic-<n>.json` + `.md` conforming to the dialectic schema (§6.6).
- Objections gate *action* only when admissible (criterion-linked ∧ novel ∧ critical|major); inadmissible objections are still surfaced in the ledger.
- The Opponent run records provider/model/command/timestamp/fallback.
