# ditto skill conventions — checklist & sources

The full authoring checklist behind `SKILL.md`, with citations. The body keeps the
essentials; this is the reference loaded on demand (progressive disclosure).

## Frontmatter validation (hard rules)

- `name`: ≤64 chars; lowercase letters, digits, hyphens only; no reserved words
  `anthropic`/`claude`. Prefer gerund/noun-phrase; avoid `helper`/`utils`/`tools`.
- `description`: non-empty, ≤1024 chars, third person, states what + when, includes
  trigger keywords.

The contract test `scripts/validate-skill.mjs` checks these (errors block; style
issues warn).

## Description — the triggering lever

Claude picks among 100+ skills from the description alone. Make it third person
(it's injected into the system prompt), state both what it does and when to use it,
and include the words a user would actually type. ditto skills tend to under-trigger,
so be slightly pushy on the "use when…" clause. Avoid vague ("Helps with documents")
and first/second person ("I can…", "You can…").

## Progressive disclosure (3 levels)

| Level | Loaded | Cost | Content |
|---|---|---|---|
| metadata | always | ~100 tokens/skill | name + description |
| body | on trigger | keep < ~500 lines | SKILL.md |
| resources | on demand | ~unlimited | bundled files; scripts run without loading source |

Keep references **one level deep** from SKILL.md (Claude may only partially read
nested files). Add a table of contents to any reference over ~100 lines.

## Bundled resources

- `scripts/` — repeated or determinism-critical code. Executed, not loaded. Make
  intent explicit: "Run `x.py` to …" (execute) vs "See `x.py` for the algorithm" (read).
- `references/` — docs consulted while working. Loaded as needed; for a large file,
  give grep patterns in SKILL.md.
- `assets/` — files used in the output (templates, logos). Not loaded into context.

## Body style

Imperative voice; explain *why* over heavy ALL-CAPS MUSTs. One default + escape
hatch, not a menu. Forward slashes. No time-sensitive content (use a collapsed "old
patterns" section). One term per concept. Don't duplicate info between SKILL.md and a
reference — each fact lives in one place.

## The ditto build seam

`skills/<name>/` is the source of truth. `scripts/build-plugin.mjs` copies `skills/`
verbatim → `dist/plugin/skills/` (Claude Code). `scripts/build-codex-plugin.mjs`
assembles the Codex plugin. Dual-host (ADR-0016): always run `bun run build:plugin &&
bun run build:codex-plugin`. Pure copy — no transform, no registry.

## Hand off trigger optimization (don't reinvent)

For description-triggering optimization and the eval/benchmark viewer, use the
installed official `skill-creator` skill (its `run_loop.py` splits train/held-out,
runs each query 3×, proposes improvements, selects by test score). This skill stays
thin and owns only the ditto conventions + build seam.

## Sources

- https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
- https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- https://code.claude.com/docs/en/features-overview (skill vs subagent vs MCP vs hook vs CLAUDE.md)
- https://github.com/anthropics/claude-code (plugins/plugin-dev/skills/skill-development/SKILL.md)
- Repo: `scripts/build-plugin.mjs`, `scripts/build-codex-plugin.mjs`, ADR-0016 (dual-host).
