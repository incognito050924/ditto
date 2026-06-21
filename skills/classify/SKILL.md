---
name: classify
description: Classify workspace docs for cleanup — find lost-authority docs (orphaned, stale, contradicting code) and stage each into a reversible action bucket. Use to triage design/report/scratch docs that have drifted from code (charter §4-11). Discovery + signals are deterministic; the per-doc disposition decision is made by one fresh subagent per doc (no cross-doc bias). Nothing is deleted — docs are MOVED into a run folder, fully reversible.
argument-hint: "[--scope <glob|commits>] [--tracked tracked-only|include-untracked|untracked-only] [--aggressiveness 1-5] [--concurrency N] [--auto-cleanup]"
---

# Classify (doc cleanup)

Triage workspace documents that may have lost authority — orphaned (nothing references them), stale (older than the code they describe), or contradicting current code (charter §4-11: code is the source of truth; drift-prone docs are not). Each candidate is staged into a reversible action bucket; **nothing is deleted** — docs are MOVED under a run folder and can be restored.

All commands are `"${CLAUDE_PLUGIN_ROOT}/bin/ditto" classify <sub>`. Mechanism is in code (`src/cli/commands/classify.ts`, `src/core/cleanup-scan.ts`, `src/core/cleanup-store.ts`) — the code and this SKILL are the source of truth.

## Why a thin CLI + per-doc agents (ADR-0001 + charter §4-9)

ditto (TypeScript) never calls an LLM. So the split is:

- **CLI = deterministic mechanics only.** `scan` discovers candidates + the DETERMINISTIC signals (orphan, stale), excludes the protected set, resolves each doc's owning sub-repo. `create-run` makes the run folder. `stage` moves ONE already-decided doc into its bucket with its basis. The CLI never judges a doc.
- **You (the driver) = per-doc fan-out.** For each candidate you spawn **one fresh subagent per doc**, at concurrency N. Each agent sees ONLY its own doc + the criteria + the protected set + the fixed facts — **never other docs**. That per-doc isolation (charter §4-9) is the anti-bias mechanism: a doc must be judged on its own merits, not dragged by the narrative built up reading the previous nine docs. The agent decides the bucket + basis (it may add the judgment-only `contradiction` signal by comparing the doc to current code); then you call `classify stage` with that decision.

## Action buckets

- `quarantine` — set aside; uncertain but suspicious. (archive)
- `absorb-then-discard` — content worth keeping should be folded into code/living guidance first, then the doc goes. (archive)
- `delete-candidate` — proposed for deletion. **Never staged on the auto path** (see below). Requires a human to action it via the `cleanup` command.
- `unclassified` — the agent could not decide; needs a human.

## Procedure

1. **Scan.**
   ```
   "${CLAUDE_PLUGIN_ROOT}/bin/ditto" classify scan \
     [--scope <glob|commit,commit>] [--tracked tracked-only|include-untracked|untracked-only] \
     [--categories design,report,...] [--aggressiveness 1-5] [--concurrency N] [--auto-cleanup] \
     --output json
   ```
   Returns `{params, candidates[], excluded_protected[]}`. Each candidate carries `{path, owning_repo, tracked, signals[]}`. The protected set (CLAUDE.md/AGENTS.md/README, `.ditto/knowledge`, `reports/design`, `reports/contracts`) is already excluded — never re-add it.

2. **Create the run** with the params snapshot scan returned:
   ```
   "${CLAUDE_PLUGIN_ROOT}/bin/ditto" classify create-run --params '<params json>' --output json
   ```
   → `{run_id, run_dir}`. All per-doc results merge into this one run folder + index (append-only, 1:1 per staged doc).

3. **Fan out one fresh subagent PER candidate, at concurrency N** (`params.concurrency`). Each agent's packet contains ONLY:
   - the one doc's path + content,
   - the criteria + bucket meanings (above) + the `aggressiveness` level guidance (below),
   - the protected set + the fixed facts (owning_repo, deterministic signals scan found for THIS doc).
   It must NOT contain other candidates' paths, contents, or decisions (ac-8). The agent returns `{action, summary, basis:[{kind, detail}, …]}` with **at least one** basis signal — it may confirm the deterministic orphan/stale signals and/or add a `contradiction` signal it judged by reading current code.

   > Mechanical constraint: ditto subagents cannot spawn sub-subagents (single-level delegation). **You** are the driver that fans out the per-doc agents and collects their decisions.

4. **Stage each decided doc** (one call per doc — the index grows 1:1, crash-safe):
   ```
   "${CLAUDE_PLUGIN_ROOT}/bin/ditto" classify stage --run-id <id> --path <doc> \
     --action <bucket> --basis '[{"kind":"stale","detail":"…"}]' \
     --summary '…' --aggressiveness <n> [--agent <handle>] [--auto] --output json
   ```
   `stage` refuses protected paths (ac-4) and empty basis (ac-5) at the store layer — those refusals are not bypassable.

5. **Review:** `classify status --run-id <id> --output json` lists the run's entries.

## Aggressiveness L1–L5 (guidance to the per-doc agents)

A lever on how readily a doc is bucketed for removal vs. left alone. Same signals, different threshold:

- **L1 (most conservative).** Only bucket a doc when ALL of: orphan AND stale AND a clear contradiction with code. Default to `unclassified` when in doubt. Never propose `delete-candidate`.
- **L2.** Two strong signals required. Prefer `quarantine` over anything stronger.
- **L3 (default).** One strong signal (clear orphan, clear stale, or clear contradiction) is enough to `quarantine`; two to propose `absorb-then-discard`.
- **L4.** A single signal can justify `absorb-then-discard`; `delete-candidate` for orphan + stale together.
- **L5 (most aggressive).** Any single lost-authority signal can justify `delete-candidate` (still staged as a move, still reversible, still human-actioned).

## Auto-cleanup is archive-only (fail-closed, ac-6)

`--auto-cleanup` (and any autopilot path) is **structurally incapable of deletion.** When you stage on the auto path, pass `--auto`: the CLI then refuses any action except `quarantine`/`absorb-then-discard` — `delete-candidate` and `unclassified` are rejected before the filesystem is touched (`autoChainArchiveAction` in `src/cli/commands/classify.ts`). Deletion only ever happens when a human runs the `cleanup` command against `delete-candidate` entries. The auto chain routes into that command's archive-only path via `runAutoCleanupChain` (`src/cli/commands/classify.ts`); the fail-closed guard is real and tested.

## Reversibility

Every staged doc is a `git mv`-style move into the run folder, recorded 1:1 in `index.json`. Nothing is destroyed during classification. Restore a doc with the store's `restore` primitive (exposed by `cleanup restore`).
