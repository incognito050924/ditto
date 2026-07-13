---
name: memory-graph
description: Query and curate the cross-entity memory graph — the provenance-carrying, freshness-stamped graph of how code, decisions, and documents relate. Use to consult what a symbol/decision is entangled with before grep/explore, to scan/build/project the graph, or to propose a memory event for approval. Read answers carry source + freshness; writes go through propose → approve → re-projection (agents never write the graph directly).
---

# Memory Graph

The memory subsystem keeps a provenance-grounded graph of how entities (code, decisions, documents, concepts) relate, served read-only with a freshness envelope. It complements `.ditto/knowledge` (curated, agreed) by holding the *derived, advisory* relations — INFERRED/AMBIGUOUS edges stay labeled and isolated until approved.

All commands are `ditto memory <sub>`. Design source: `reports/design/memory-graph-plugin-design.md` (§4 functions, §7 layout, §10 contracts).

## Two modes — pull vs push (§5)
- **pull (active query)** — `query`/`path`/`explain` are CLIs any bash-capable role calls when it needs cross-entity context ("what is this entangled with", "why was this decided"). Not bound to a node. Answers always carry source + freshness, so you rely on one only while its freshness holds.
- **push (auto-inject)** — the autopilot loop warm-starts researcher/planner packets from the graph automatically (`memory-warmstart.ts`); that runs inside the loop, not from this skill.

## Read — provenance + freshness on every answer (§4-4)
Reads never mutate. Each answer carries `projection_id`/`generated_at`/`freshness`/`dirty_sources`.
- `memory query <node> [--depth N] [--output json]` — undirected BFS neighbors from a node (default depth 2). Use this to answer "what is X entangled with".
- `memory path <from> <to> [--output json]` — shortest path between two nodes.
- `memory explain <node> [--output json]` — one node's label + adjacent edges.
- `memory status [--output json]` — projection freshness (fresh/stale/absent) + dirty sources.

Treat only a `fresh` answer as settled; on a `stale`/`absent` answer, re-`scan`/`build`/`project` first or fall back to normal exploration. When `freshness` is `code_drift`/`code_dirty`, the answer also carries `drifted_repos`/`drifted_sources` (the code diverged from what the memory was built on): verify **only** the sources listed in `drifted_sources` directly from code and trust the rest of the answer. The freshness label is advisory, not a refusal — the answer is still returned.

## Build the graph (derivation pipeline)
- `memory scan [--source-root <dir>] [--output json]` — hash sources into the manifest; reports added/changed/unchanged (the change gate for re-extraction).
- `memory build [--semantic] [--fragments <out.json>] [--source-root <dir>]` — structure-only by default (cheap, §4-6). `--semantic` emits chunk request packets for the `memory-extractor` agent; the host fans out, then `memory build --semantic --fragments <out.json>` merges host-returned IR fragments deterministically (§10-5).
- `memory project [--output json]` — regenerate the serving graph + wiki + manifest one-way from the IR + approved events (§4-3). Projections are regenerated, never hand-edited.
- `memory bootstrap [--output json]` — ingest curated ADR/glossary + archived handoffs so day-1 is not a cold start (idempotent).

## Write model (propose → approve → re-projection, §4-5)
Agents cannot write the graph directly.
- `memory propose --type <t> --text <…> [--source <id,…>] [--confidence INFERRED|AMBIGUOUS] [--sensitivity …]` — create a *pending* event.
- `memory approve <event-id> --by <approver> [--reject]` — append an immutable decision event (`supersedes` the original, never mutated) and re-project.
- `memory events append|list` — the append-only event SoT (per-entity immutable JSON).

## Audit (manual, append-only history, §4-6)
- `memory audit [--output json]` — count orphan/stale/duplicate/contradiction over the serving graph and append the result to the git-tracked audit history. Manual only — no auto-trigger.

## Degrade
Every read is fail-soft: an absent/empty/stale projection or an unknown node yields an empty/usage answer rather than crashing. When the graph gives you little, fall back to normal grep/explore — the subsystem is additive, used when it helps.

## Disable & remove (reversibility)
Set `DITTO_MEMORY=off` (or `0`) — one flag turns off the whole subsystem's automatic paths (it subsumes `DITTO_MEMORY_WARMSTART=0`). Explicit `ditto memory …` CLI calls are a user's own pull and still run. The full reversibility contract — the disable switch, deleting the data, and excising the subsystem down to each splice point (design §10-9 four invariants, ac-13) — is in `references/disable-and-remove.md`.
