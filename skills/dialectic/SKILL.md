---
name: dialectic
description: Run a three-role (Producer / Opponent / Synthesizer) adversarial deliberation over a plan, decision, or artifact, preferring Codex for the Opponent. Use to pressure-test a plan or design before committing, or to converge a contested decision.
argument-hint: "--mode <create|review|decision|proposal|document|final-answer>"
---

# Dialectic Deliberation

Separate three roles so a single model cannot mark its own homework. The `--mode` only changes what the three roles work on and produce; the role structure and output schema are constant.

How (role separation, model routing, Codex-plugin-cc delegation, round policy, admissibility link, schema) is owned by `reports/design/contracts/dialectic-deliberation-contract.md`.

## Roles
- **Producer** — states the best argument for the draft + a concrete proposal, with evidence, assumptions, known limits.
- **Opponent** (Codex preferred, Claude fallback recorded) — objections, each linked to an oracle (acceptance criterion, file:line, doc, or user intent); plus missing alternatives, scope-creep risks, verification gaps.
- **Synthesizer** — verdict (`accept|revise|reject|blocked`) + agreed final position; rejections carry as much grounding as a raise.

## Procedure (driver)
Run as the main agent; spawn each role as its own Task (1-level). The roles are **separate spawns even within one turn** — never simulate three voices in one prompt (dialectic-contract §2).

1. **Build `input`** (dialectic schema §5.2) from the node/decision: `mode`, `target_artifact`, `question`, `intent_refs`, `acceptance_refs`, `evidence_refs`, `constraints`, `model_policy`.
2. **Producer** — spawn `dialectic-producer` with the input only. Capture its `position`/`proposal`/`evidence`/`assumptions`/`known_limits`.
3. **Opponent** — decide the provider with `OpponentModelRouter` (`src/core/opponent-router.ts`): `resolveOpponentCandidates(model_policy)` → `selectOpponent(candidates, isAvailable)`, where `isAvailable` for the `codex` candidate is simply **whether the Codex plugin for Claude Code (codex-plugin-cc) is present in this session** (you know this — it surfaces the `codex:rescue` agent / adversarial-review). When Codex wins, **run the Opponent through the plugin, not through ditto**: delegate via the `codex:rescue` agent for a task-style opponent, or run the plugin's adversarial-review for review-mode. ditto never spawns Codex itself (no `codex exec`, no companion script). When Codex is unavailable, spawn the `dialectic-opponent` agent on the Claude fallback (claude-opus → claude-sonnet). Either way record the selection into `opponent.run` (`provider`/`model`/`command`/`timestamp`/`fallback_from`/`fallback_reason`).
4. **Synthesizer** — spawn `dialectic-synthesizer` with input + Producer + Opponent outputs. Capture the `verdict` + agreed position.
5. **Write** `reviews/dialectic-<n>.json` (full `dialectic` schema, with `round` = the round number) + a `.md` view. `<n>` increments per deliberation on the work item.

The driver constructs packets and spawns; it does not produce any role's content (autopilot-contract §3.4). Invoke this at **high-impact `review`/`design` nodes** (autopilot-contract §2.2 — review owner = reviewer, high-impact 산출물 = dialectic 3역), not on every node.

## Rounds (under ConvergenceGate)
`constraints.max_rounds` bounds re-deliberation; each artifact records its own `round` (1-based). **Re-deliberation loop**: when the Synthesizer returns `verdict=revise` with open `required_edits` AND `round < max_rounds`, that is NOT a close — apply the `required_edits` to the draft, then run a fresh Producer→Opponent→Synthesizer at `round+1` (a new `reviews/dialectic-<n>.json` with `round` incremented). The Stop hook enforces this: a `revise` with rounds remaining and required_edits still open forces continuation (`dialecticForcesContinuation`, stop.ts), so the deliberation actually converges across rounds instead of closing on the first `revise`. Rounds run *under* the ConvergenceContract admissibility/ratchet/decision-ledger discipline (§6) — `cap_reached ≠ converged`: hitting `max_rounds` without resolving admissible objections closes non-pass (the CompletionContract decides the verdict), it is not a silent `accept`. With the default `max_rounds=1` there is exactly one deliberation — round 1 = max, so a `revise` closes immediately ("one small deliberation, no infinite debate").

## Output contract
- `reviews/dialectic-<n>.json` + `.md` conforming to the dialectic schema (§6.6).
- Objections gate *action* only when **admissible = `maps_to` non-empty ∧ novel ∧ severity `critical|high`**; inadmissible (taste / no-oracle / `medium`-below) objections are still surfaced in the ledger but do not block.
- The Opponent run records provider/model/command/timestamp/fallback (never fabricated).
- The Stop hook reads these ledgers: a `reject`/`blocked` verdict or an unresolved admissible objection forces continuation (see `stop.ts`).
