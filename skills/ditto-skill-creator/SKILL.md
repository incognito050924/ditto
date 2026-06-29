---
name: ditto-skill-creator
description: Author a new ditto skill (skills/<name>/SKILL.md) that follows the Anthropic Agent Skills best practices AND the ditto build/distribution conventions. Use when the user wants to add, scaffold, or improve a ditto skill, create a new /ditto:<name> capability, or asks how skills are structured/built in this repo. Validates the draft with a contract test and rebuilds both host plugins.
---

# ditto skill creator

Create a new skill for **this repo** the ditto way: author `skills/<name>/SKILL.md`, validate it against the Anthropic frontmatter rules with the bundled contract test, then rebuild both host plugins so it ships to Claude Code *and* Codex.

This skill is deliberately thin. It does **not** re-implement the official `skill-creator` eval/benchmark harness — for triggering-accuracy optimization (the `run_loop.py` description optimizer, the eval viewer) hand off to the installed `skill-creator` skill. This skill owns one thing the generic creator can't: the **ditto build seam and conventions**.

## When to reach for this vs other tools

- New reusable **knowledge/workflow** loaded on demand → a skill (this).
- New isolated **worker** that returns only a summary → an autopilot owner subagent → use `ditto-agent-creator` instead.
- "Always do X every session" → CLAUDE.md / AGENTS.md, not a skill.
- Connect to an **external service** → MCP, not a skill.

## Procedure

1. **Capture intent.** What should the skill let Claude do? What user phrases should trigger it? What's the output? If the conversation already contains the workflow to capture, extract it first and confirm with the user.
2. **Draft `skills/<name>/SKILL.md`** following the conventions below.
3. **Validate** with the contract test:
   ```bash
   node skills/ditto-skill-creator/scripts/validate-skill.mjs skills/<name>/SKILL.md
   ```
   Fix every ERROR; weigh each warning. (Or add the file to `tests/skills/validate-skill.test.ts`'s authored-skills list and run `bun test tests/skills/validate-skill.test.ts`.)
4. **Rebuild both hosts** (the build seam — see below):
   ```bash
   bun run build:plugin && bun run build:codex-plugin
   ```
5. **(Optional) Optimize triggering** — hand off to the official `skill-creator` skill for the description-optimization loop and eval viewer. Don't reinvent it here.

## The ditto build seam (why both builds)

`skills/<name>/` at the repo root is the **source of truth**. `scripts/build-plugin.mjs` copies `skills/` verbatim into `dist/plugin/skills/` (Claude Code), and `scripts/build-codex-plugin.mjs` assembles `dist/codex-plugin/` (Codex). ditto is dual-host (ADR-0016), so a skill that only appears in one build is a half-shipped skill — always run **both**. The build is a pure copy: no transform, no registry to edit. Just author under `skills/` and rebuild.

## SKILL.md conventions (the parts that matter)

**Frontmatter** — only `name` and `description` are required.
- `name`: lowercase-letters/digits/hyphens, ≤64 chars, gerund or noun-phrase (`processing-pdfs`, not `helper`/`utils`). Cannot contain the reserved words `anthropic`/`claude`.
- `description`: the single biggest lever on whether the skill triggers. Write it **in third person**, state **what it does AND when to use it**, and include the **keywords a user would actually type**. ditto skills tend to *under*-trigger, so lean slightly pushy on the "use when…" clause.
  - Good: `Extract text and tables from PDF files. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.`
  - Bad: `Helps with documents` / `I can help you with PDFs`.

**Progressive disclosure** — three load levels: metadata (always, ~100 tokens), SKILL.md body (on trigger, keep under ~500 lines), bundled files (on demand, effectively unlimited; scripts execute without their source entering context). Keep the body lean; push detail into `references/` linked **one level deep** from SKILL.md (Claude may only partially read nested files). For any reference over ~100 lines, add a table of contents.

**Bundled resources**
- `scripts/` — code that's rewritten repeatedly or needs deterministic reliability. Executed, not loaded.
- `references/` — docs Claude consults while working (schemas, policies). Loaded as needed.
- `assets/` — files used in the *output* (templates). Not loaded into context.

**Body style** — imperative voice; explain *why* a step matters rather than piling on ALL-CAPS MUSTs (today's models reason well with good rationale). One default with an escape hatch, not a menu of options. Forward-slash paths only. No time-sensitive content. One term per concept.

See `references/ditto-skill-conventions.md` for the full checklist and the source citations.

## Anti-patterns to avoid

Verbose explanations of things Claude already knows · vague/overlapping descriptions (cause mis-triggering) · first/second-person description · deeply nested references · offering many interchangeable options · duplicating the same info in SKILL.md and a reference · shipping to only one host build.
