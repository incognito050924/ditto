---
name: memory-graph
description: Query and curate the cross-entity memory graph — the provenance-carrying, freshness-stamped graph of how code, decisions, and documents relate. Use to consult what a symbol/decision is entangled with before grep/explore, to scan/build/project the graph, or to propose a memory event for approval. Read answers carry source + freshness; writes go through propose → approve → re-projection (agents never write the graph directly).
---

# Memory Graph

The memory subsystem keeps a provenance-grounded graph of how entities (code, decisions, documents, concepts) relate, served read-only with a freshness envelope. It complements `.ditto/knowledge` (curated, agreed) by holding the *derived, advisory* relations — INFERRED/AMBIGUOUS edges stay labeled and isolated until approved.

All commands are `ditto memory <sub>`. Design source: `reports/design/memory-graph-plugin-design.md` (§4 functions, §7 layout, §10 contracts).

## Two modes — pull vs push (§5)
- **pull (active query)** — `query`/`path`/`explain` are CLIs any bash-capable role calls when it needs cross-entity context ("what is this entangled with", "why was this decided"). Not bound to a node. Answers always carry source + freshness, so a stale answer is never used as settled.
- **push (auto-inject)** — the autopilot loop warm-starts researcher/planner packets from the graph automatically (`memory-warmstart.ts`); you do not invoke that here.

## Read (no mutation — provenance + freshness on every answer, §4-4)
- `memory query <node> [--depth N] [--output json]` — undirected BFS neighbors from a node (default depth 2). Use this to answer "what is X entangled with".
- `memory path <from> <to> [--output json]` — shortest path between two nodes.
- `memory explain <node> [--output json]` — one node's label + adjacent edges.
- `memory status [--output json]` — projection freshness (fresh/stale/absent) + dirty sources.

Every read answer carries `projection_id`/`generated_at`/`freshness`/`dirty_sources`. **Do not treat a `stale`/`absent` answer as settled** — re-`scan`/`build`/`project` first or fall back to normal exploration.

When `freshness` is `code_drift`/`code_dirty`, the answer also carries `drifted_repos`/`drifted_sources` (the code diverged from what the memory was built on). **Verify only the sources listed in `drifted_sources` directly from code; trust the rest of the answer.** The label is advisory, never a refusal — the answer is still returned.

## Build the graph (derivation pipeline)
- `memory scan [--source-root <dir>] [--output json]` — hash sources into the manifest; reports added/changed/unchanged (the change gate for re-extraction).
- `memory build [--semantic] [--fragments <out.json>] [--source-root <dir>]` — structure-only by default (cheap, §4-6). `--semantic` emits chunk request packets for the `memory-extractor` agent; the host fans out, then `memory build --semantic --fragments <out.json>` merges host-returned IR fragments deterministically (§10-5).
- `memory project [--output json]` — regenerate the serving graph + wiki + manifest one-way from the IR + approved events (§4-3). Projections are never hand-edited.
- `memory bootstrap [--output json]` — ingest curated ADR/glossary + archived handoffs so day-1 is not a cold start (idempotent).

## Write model (propose → approve → re-projection, §4-5)
Agents cannot write the graph directly.
- `memory propose --type <t> --text <…> [--source <id,…>] [--confidence INFERRED|AMBIGUOUS] [--sensitivity …]` — create a *pending* event.
- `memory approve <event-id> --by <approver> [--reject]` — append an immutable decision event (`supersedes` the original, never mutated) and re-project.
- `memory events append|list` — the append-only event SoT (per-entity immutable JSON).

## Audit (manual, append-only history, §4-6)
- `memory audit [--output json]` — count orphan/stale/duplicate/contradiction over the serving graph and append the result to the git-tracked audit history. Manual only — no auto-trigger.

## Degrade
Every read is fail-soft: an absent/empty/stale projection or an unknown node yields an empty/usage answer, never a crash. When the graph gives you little, fall back to normal grep/explore — the subsystem is additive, not a required step.

## Disable & remove (reversibility, design §10-9 four invariants, ac-13)

**Disable (single switch).** Set `DITTO_MEMORY=off` (or `0`) — one flag turns off the whole subsystem's automatic paths. It subsumes the granular `DITTO_MEMORY_WARMSTART=0`, so you need only the master switch. When off, the §5 warm-start push (`autopilot-loop → warmStartMemoryContext`) returns `undefined`, so the autopilot delegation packet is byte-for-byte what it was without memory (§5 fail-open, invariants ①②). Explicit `ditto memory …` CLI calls are a user's own pull and still run — disabling targets auto-injection/instrumentation, not manual consultation. The flag is read in `src/core/memory-flag.ts` (`isMemoryEnabled()`); invariance is proven by `tests/core/memory-warmstart.test.ts` (`DITTO_MEMORY=off ⇒ undefined`, packet unchanged).

**Delete the data (invariant ③).** Deleting the SoT (`.ditto/memory/`) and the derived projections (`.ditto/local/memory/`) leaves the ditto core unchanged — only `ditto memory` commands are affected; autopilot/work/knowledge keep working (warm-start sees an absent projection and degrades to `undefined`).

**Remove the subsystem (invariant ④).** To excise memory entirely, remove only these splice points; everything else in ditto stays intact:
- **command** — the `memory` registration in `src/cli/index.ts` (`import { memoryCommand }` + `memory:` in `subCommands`) and `src/cli/commands/memory.ts`.
- **skill** — `skills/memory-graph/`.
- **agent** — `agents/memory-extractor.md`.
- **owner pull habit** — the one conditional "`ditto memory query` before grep/explore" line in each owner prompt (`agents/{implementer,reviewer,verifier,security-reviewer,playwright-e2e,researcher}.md`).
- **§5-1 splice** — the optional `memoryContext` field in `buildDelegationPacket` (`src/core/autopilot-dispatch.ts`) and the two `warmStartMemoryContext(...)` lookups in `src/core/autopilot-loop.ts`.

After those removals the rest of ditto (autopilot, work items, knowledge, ACG) is unaffected.
