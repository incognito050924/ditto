---
name: coverage-taxonomy
description: Manage and discover the project's far-field pre-mortem category taxonomy — the probing-question lenses the coverage sweep answers. Use when the user wants to list/add/disable/reroute far-field or pre-mortem coverage categories, discover gap categories from the codebase, or propose new coverage categories for confirmation. Drives `ditto coverage list|add|disable|reroute|discover`.
---

# Coverage Taxonomy

The far-field taxonomy is the set of pre-mortem **categories** the coverage sweep probes — each a `{id, lens, disposition}` where the `lens` is the probing question and the `disposition` routes where the category is answered (`code-verify` / `user-intent` / `runtime-post-impl`). A code **floor** ships the baseline categories; a project layers a tier-② override on top (`.ditto/coverage-taxonomy.json`). This skill puts a human surface over the three things you do with that taxonomy: **discover** gap categories, **manage** the effective set, and **propose→confirm** new ones.

Every command here is `ditto coverage <sub>`. All are read-only except `add`/`disable`/`reroute` and `discover --confirm`, which write only the tier-② override (never the code floor).

## When to use
- "What far-field / pre-mortem categories does this project sweep?" → **manage · list**.
- "This project needs a category the floor doesn't have" / "turn off a floor category that never applies here" / "route this category somewhere else" → **manage · add / disable / reroute**.
- "Scan the codebase and tell me which coverage categories we're missing" → **discover**.
- "Discover, then actually add the good ones" → **propose→confirm**.

## ① Discover — scan the codebase for gap categories
Discovery finds far-field categories the current taxonomy is **missing**, grounded in real code. Per ADR-0001 ditto never calls an LLM itself, so the codebase-scan reasoning is host-delegated to the `coverage-discovery` agent (`agents/coverage-discovery.md`); ditto only gates what the agent returns.

1. Run the `coverage-discovery` agent (Task tool). It scans read-only and PROPOSES candidates, each `{ id, lens, evidence }` where `evidence` is a verifiable code citation (`file:line`, `symbol`, or a dependency reference like `package.json:express` / `@scope/name`).
2. Feed its JSON to the deterministic gate:
   ```bash
   ditto coverage discover --file candidates.json      # or: <candidates.json | ditto coverage discover
   ```
   The gate (`admitDiscoveredCategories`) enforces two rules with no agent discretion: **evidence-bound** — a candidate with no verifiable citation is dropped `no_evidence`; and **gap-only** — a candidate whose domain the effective taxonomy (or a routed-out gate) already covers is dropped `reconfirms_covered`. Every drop is reported with its machine reason, so nothing vanishes silently.
3. `discover` is **propose-only by default — it mutates nothing.** It prints the admitted gaps and the dropped ones for audit; you decide what to do next.

## ② Manage — list, add, disable, reroute
```bash
ditto coverage list                                          # effective taxonomy, each marked floor / added / rerouted / disabled
ditto coverage add --id <kebab-id> --lens "<probing question>" [--disposition code-verify|user-intent|runtime-post-impl]
ditto coverage disable --id <category-id> --reason "<why>"    # --reason is REQUIRED
ditto coverage reroute --id <category-id> --disposition code-verify|user-intent|runtime-post-impl
```
- `add` rejects an id that already names a known category (floor or project-added) — pick a new id, or use `reroute`/`disable`. `--disposition` defaults to `code-verify`.
- `disable` requires `--reason`: a removal is recorded in `disabled_reasons`, never silent. The target must be a known category (a typo'd id is rejected, not a silent no-op).
- `reroute` changes only the disposition route; the target must be a known category.

## ③ Propose → confirm — discover then add the admits
When you want discovery to actually augment the taxonomy, re-run with `--confirm`:
```bash
ditto coverage discover --file candidates.json --confirm     # adds each admitted gap via the same `add` path
```
`--confirm` routes every admitted candidate through the ordinary `coverage add` mutation (tier-② override only). Without `--confirm`, discovery stays a proposal — so the safe default is to run once bare, read the admits, then re-run with `--confirm` on the set you trust.

## Invariants worth remembering
- **Propose never mutates.** `discover` (no `--confirm`) and the agent both only propose; the deterministic gate plus your `--confirm` decide.
- **Disable is never silent.** `--reason` is mandatory and recorded.
- **Discovery is gap-only and evidence-bound.** No floor re-confirmation noise, and no candidate without a real code citation.
- Only the tier-② override is written; the code floor is immutable from the CLI.

## The ditto build seam
`skills/coverage-taxonomy/` and `agents/coverage-discovery.md` at the repo root are the source of truth. `scripts/build-plugin.mjs` (ALWAYS_DIRS) copies `skills/` + `agents/` into the Claude Code plugin and `scripts/build-codex-plugin.mjs` assembles the Codex plugin, so this surface ships to **both** hosts (ADR-0016). After editing either file, run `bun run surfaces:gen` to refresh the surface inventory.
