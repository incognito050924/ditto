# ditto skill conventions — checklist & sources

The skill-specific checklist behind `SKILL.md`, loaded on demand. The **shared
authoring craft** — predictability, the steps-vs-reference ladder, completion
criteria, leading words, pruning, failure modes, co-location — lives once in
`writing-great-artifacts.md` and is not restated here; on any conflict, that craft
takes precedence (see its Precedence section). This file holds only what is
skill-specific.

## Invocation — model-invoked by default

A skill's `description` is its trigger. All ditto skills are **model-invoked**
(`/ditto:<name>`): the agent can fire them and other skills can reach them, at the
cost of the description sitting in context every turn. Claude Code's user-invoked
mode (`disable-model-invocation: true`) strips that reach and cost, but ditto does
not use it — it is a Claude-Code-only lever, so confirm the Codex build honours it
(dual-host, ADR-0016) before reaching for it.

## Frontmatter validation (hard rules)

- `name`: ≤64 chars; lowercase letters, digits, hyphens only; no reserved words
  `anthropic`/`claude`. Prefer gerund/noun-phrase; avoid `helper`/`utils`/`tools`.
- `description`: non-empty, ≤1024 chars, third person, states what + when, includes
  trigger keywords.

The contract test `scripts/validate-skill.mjs` checks these (errors block; style
issues warn).

## Description — the triggering lever

Claude picks among 100+ skills from the description alone, so it is third person
(injected into the system prompt), states what it does *and* when to use it, and
carries the words a user would actually type. ditto skills tend to under-trigger —
lean slightly pushy on the "use when…" clause.

## Progressive disclosure (3 levels)

| Level | Loaded | Cost | Content |
|---|---|---|---|
| metadata | always | ~100 tokens/skill | name + description |
| body | on trigger | keep < ~500 lines | SKILL.md |
| resources | on demand | ~unlimited | bundled files; scripts run without loading source |

Keep references **one level deep** from SKILL.md (Claude may only partially read
nested files). Add a table of contents to any reference over ~100 lines.

## Bundled resources

- `scripts/` — repeated or determinism-critical code. Executed, not loaded. Say
  which: "Run `x.py` to …" (execute) vs "See `x.py` for the algorithm" (read).
- `references/` — docs consulted while working. Loaded as needed; for a large file,
  give grep patterns in SKILL.md.
- `assets/` — files used in the output (templates, logos). Not loaded into context.

## Body style (ditto specifics)

Imperative voice, rationale over ALL-CAPS MUSTs, forward-slash paths, no
time-sensitive content. Everything else about *what to keep and cut* — leading
words, pruning, prompt-the-positive — is the craft in `writing-great-artifacts.md`.

## The ditto build seam

`skills/<name>/` is the source of truth. `scripts/build-plugin.mjs` copies `skills/`
verbatim → `dist/plugin/skills/` (Claude Code); `scripts/build-codex-plugin.mjs`
assembles the Codex plugin. Dual-host (ADR-0016): always run both. Pure copy — no
transform, no registry.

## Triggering optimization — hand off

For description-triggering optimization and the eval/benchmark viewer, use the
installed official `skill-creator` skill (its `run_loop.py` splits train/held-out,
runs each query 3×, selects by test score). This skill stays thin and owns only the
ditto conventions + build seam.

## Sources

- https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
- https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- https://code.claude.com/docs/en/features-overview (skill vs subagent vs MCP vs hook vs CLAUDE.md)
- https://github.com/anthropics/claude-code (plugins/plugin-dev/skills/skill-development/SKILL.md)
- Repo: `scripts/build-plugin.mjs`, `scripts/build-codex-plugin.mjs`, ADR-0016 (dual-host).
