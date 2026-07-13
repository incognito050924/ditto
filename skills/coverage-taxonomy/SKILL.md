---
name: coverage-taxonomy
description: Manage and discover the project's far-field pre-mortem category taxonomy — the probing-question lenses the coverage sweep answers. Use when the user wants to list/add/disable/reroute far-field or pre-mortem coverage categories, discover gap categories from the codebase, or propose new coverage categories for confirmation. Drives `ditto coverage list|add|disable|reroute|discover`.
---

# Coverage Taxonomy

The far-field taxonomy is the set of pre-mortem **categories** the coverage sweep probes — each a `{id, lens, disposition}` where the `lens` is the probing question and the `disposition` routes where the category is answered (`code-verify` / `user-intent` / `runtime-post-impl`). A code **floor** ships the baseline categories; a project layers a tier-② override on top (`.ditto/coverage-taxonomy.json`). This skill is the human surface over the three things you do with that taxonomy: **discover** gap categories, **manage** the effective set, and **propose→confirm** new ones.

Every command is `ditto coverage <sub>`. All are read-only except `add`/`disable`/`reroute` and `discover --confirm`, which write only the tier-② override — the code floor is immutable from the CLI.

## When to use
- "What far-field / pre-mortem categories does this project sweep?" → **manage · list**.
- "This project needs a category the floor lacks" / "turn off a floor category that never applies here" / "route this category somewhere else" → **manage · add / disable / reroute**.
- "Scan the codebase for coverage categories we're missing" → **discover**.
- "Discover, then actually add the good ones" → **propose→confirm**.

## ① Discover — scan the codebase for gap categories
Discovery finds far-field categories the current taxonomy is **missing**, grounded in real code. Per ADR-0001 ditto never calls an LLM itself, so the scan is host-delegated to the `coverage-discovery` agent (`agents/coverage-discovery.md`); ditto only gates what the agent returns.

1. Run the `coverage-discovery` agent (Task tool). It scans read-only and PROPOSES candidates, each `{ id, lens, evidence }` where `evidence` is a verifiable code citation (`file:line`, `symbol`, or a dependency reference like `package.json:express` / `@scope/name`). *Done when:* the agent returns candidates each carrying evidence.
2. Feed its JSON to the deterministic gate:
   ```bash
   ditto coverage discover --file candidates.json      # or: <candidates.json | ditto coverage discover
   ```
   The gate (`admitDiscoveredCategories`) applies two rules with no agent discretion: **evidence-bound** — a candidate with no verifiable citation is dropped `no_evidence`; **gap-only** — a candidate whose domain the effective taxonomy (or a routed-out gate) already covers is dropped `reconfirms_covered`. *Done when:* the gate prints the admitted gaps and every drop with its machine reason (nothing vanishes silently).
3. `discover` without `--confirm` **mutates nothing** — it prints the admits + drops for audit; you decide what to do next.

## ② Manage — list, add, disable, reroute
```bash
ditto coverage list                                          # effective taxonomy, each marked floor / added / rerouted / disabled
ditto coverage add --id <kebab-id> --lens "<probing question>" [--disposition code-verify|user-intent|runtime-post-impl]
ditto coverage disable --id <category-id> --reason "<why>"    # --reason is REQUIRED
ditto coverage reroute --id <category-id> --disposition code-verify|user-intent|runtime-post-impl
```
- `add` rejects an id that already names a known category (floor or project-added) — pick a new id, or use `reroute`/`disable`. `--disposition` defaults to `code-verify`.
- `disable` requires `--reason`: the removal is recorded in `disabled_reasons`, never silent. The target must be a known category (a typo'd id is rejected, not a silent no-op).
- `reroute` changes only the disposition route; the target must be a known category.

## ③ Propose → confirm — discover then add the admits
```bash
ditto coverage discover --file candidates.json --confirm     # adds each admitted gap via the same `add` path
```
`--confirm` routes every admitted candidate through the ordinary `coverage add` mutation (tier-② override only). The safe default is to run bare once, read the admits, then re-run with `--confirm` on the set you trust.

## The ditto build seam
`skills/coverage-taxonomy/` + `agents/coverage-discovery.md` are the source of truth; the plugin builds ship this surface to **both** hosts (ADR-0016). After editing either file, run `bun run surfaces:gen` to refresh the surface inventory.
