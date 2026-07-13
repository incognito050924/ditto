---
name: cleanup
description: Action a classify run folder — archive it (reversible zip, default), permanently delete it (gated), or restore a staged doc. Use this after `classify` has staged docs into a run folder. Archive keeps a zip so it stays reversible; delete is permanent and requires an explicit confirm (autopilot refuses). Optionally commit the removals per affected sub-repo so they are git-revertable.
argument-hint: "<archive|delete|restore> --run-id <id> [--commit] [--confirm] [--path <original_path>]"
---

# Cleanup (action a classify run)

Terminal step after `classify`: take a classify run folder (created by `classify create-run`, populated by `classify stage`) and action it. Mechanism is in code (`src/cli/commands/cleanup.ts`, `src/core/cleanup-archive.ts`, `src/core/cleanup-store.ts`) — the code and this SKILL are the source of truth.

All commands are `ditto cleanup <sub>`. Per ADR-0001 this CLI is pure deterministic mechanics (git/zip/fs) — the per-doc judgment already happened in `classify`, so there is no LLM here.

It acts ONLY on the named run folder: an absent run-id folder makes it refuse, and another run is never touched.

## Actions

### archive (default — reversible)
```
ditto cleanup archive --run-id <id> [--commit] --output json
```
Zips the run folder to `.ditto/local/cleanup/archive/<id>.zip` (index included), then removes the run folder. The zip IS the reversibility — keep it to restore later. The zip is bound to the run folder only (no parent escape; symlinks are stored, not followed). Done when the run folder is gone and `<id>.zip` exists.

### delete (permanent — gated, fail-closed)
```
ditto cleanup delete --run-id <id> --confirm [--commit] --output json
```
Permanently removes the staged files + run folder. Because it is irreversible it needs an explicit `--confirm`, and **without `--confirm` it refuses** — so on any autopilot / non-interactive path (which carries no confirm) delete is fail-closed and can never delete unattended. This mirrors the irreversible-git approval gate (`src/core/autopilot-cleanup.ts`): the small-reversible waiver does not cover permanent deletion, and the auto-cleanup chain can ONLY archive (`autoChainArchive` in `src/core/cleanup-archive.ts`). Done when the run folder and its staged files are gone.

### restore (undo one staged doc)
```
ditto cleanup restore --run-id <id> --path <original_path> --output json
```
Moves one staged doc back to where it lived (over `CleanupStore.restore`). Use before archiving if a doc was staged by mistake. Done when the doc is back at `<original_path>`.

## --commit (one commit per sub-repo, git-revertable)

`--commit` (on archive or delete) commits the cleanup result. The docs were moved out of their owning sub-repos during `classify stage`, so each shows as a deletion there. The index records `owning_repo` per entry, so the commit is made PER affected sub-repo — one commit each — which keeps every removal independently `git revert`-recoverable (ac-10).

**Dirty-tree abort:** before committing, each affected sub-repo's working tree is checked. A sub-repo with uncommitted changes BEYOND this cleanup's own removals aborts the whole `--commit` with a warning and makes **no commit at all** — no auto `git clean`, no stash, so unrelated changes are left intact. Resolve them first, then re-run.
</content>
