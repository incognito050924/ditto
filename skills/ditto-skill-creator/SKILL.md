---
name: ditto-skill-creator
description: Author a new ditto skill (skills/<name>/SKILL.md) that follows the Anthropic Agent Skills best practices AND the ditto build/distribution conventions. Use when the user wants to add, scaffold, or improve a ditto skill, create a new /ditto:<name> capability, or asks how skills are structured/built in this repo. Validates the draft with a contract test and rebuilds both host plugins.
---

# ditto skill creator

Author a skill for **this repo** the ditto way: write `skills/<name>/SKILL.md`, validate it with the bundled contract test, then rebuild both host plugins so it ships to Claude Code *and* Codex. This skill is deliberately thin — it does not re-implement the official `skill-creator` eval harness (hand triggering-optimization there); it owns the one thing the generic creator can't, the **ditto build seam and conventions**.

Author for **predictability** — the agent taking the same *process* every run. Read `references/writing-great-artifacts.md` first: it is the shared authoring craft (leading words, completion criteria, the steps-vs-reference ladder, pruning, prompt-the-positive) and governs subagents too. When a rule here and that craft pull against each other, the craft wins.

## When to reach for this vs other tools

- Reusable **knowledge/workflow** loaded on demand → a skill (this).
- Isolated **worker** that returns only a summary → an autopilot owner subagent → `ditto-agent-creator`.
- Behaviour wanted on **every session** → CLAUDE.md / AGENTS.md.
- An **external service** → MCP.

## Procedure

1. **Capture intent** — done when you can name, in one sentence, the trigger phrases that should fire the skill and the single output it produces. If the workflow is already in this conversation, extract and confirm it.
2. **Draft** `skills/<name>/SKILL.md` to the checklist in `references/ditto-skill-conventions.md`.
3. **Validate** — done when the contract test reports OK:
   ```bash
   node skills/ditto-skill-creator/scripts/validate-skill.mjs skills/<name>/SKILL.md
   ```
   Clear every ERROR and weigh each warning (the craft warnings included).
4. **Rebuild both hosts** — done when both builds exit 0:
   ```bash
   bun run build:plugin && bun run build:codex-plugin
   ```
   `skills/` is the source of truth; the build is a pure copy into `dist/plugin/` (Claude Code) and `dist/codex-plugin/` (Codex). ditto is dual-host (ADR-0016), so a one-host skill is half-shipped — run both.
5. **(Optional) Sharpen triggering** — the official `skill-creator` skill owns the description-optimization loop and eval viewer; hand it off there.

See `references/writing-great-artifacts.md` for the authoring craft and `references/ditto-skill-conventions.md` for the ditto checklist (frontmatter rules, progressive-disclosure levels, the model-invoked default) and sources.
