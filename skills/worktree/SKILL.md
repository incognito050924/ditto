---
name: worktree
description: Develop several features at once on one machine with git worktrees — 여러 feature 동시 개발 / 병렬 개발 / parallel development. Each work item gets its own isolated worktree (own branch, own files) so two efforts (and their autopilots) run side by side without stepping on each other. Use when starting a second feature before the first is merged, or asking how to run concurrent work / multiple worktrees.
---

# Concurrent development with worktrees

Run more than one feature at the same time on a single machine. Each work item gets its own git worktree — a separate checkout on its own branch (`ditto/<wi>`) under `.ditto/local/worktrees/<wi>` — so the changes never collide in the working tree. The commands and flags below are the authority's surface; exact output and edge behavior live in the CLI itself (`ditto worktree --help`, `ditto work start --help`).

## When to use

- Recommended **only for genuinely independent features**. Worktree isolation lets two efforts touch the repo at once, but if both edit the **same files**, the conflict stays hidden until merge and surfaces late. For overlapping work, prefer one sequential branch.

## Workflow

### 1. Start a work item with its worktree in one step

```
ditto work start "<goal>" --request "<verbatim user request>" --worktree
```

Creates the work item, then the branch `ditto/<wi>` and its worktree at `.ditto/local/worktrees/<wi>`, and prints a `cd` hint. Multi-repo workspaces nest one sub-repo worktree per repo inside the workspace worktree.

For a work item that already exists:

```
ditto worktree create <wi>
```

### 2. Open a session inside the worktree

`cd` to the printed path and start a Claude Code / Codex session **there**. The session auto-binds to that work item **when the cwd is a real work-item worktree path and that work item still exists in the main workspace** — then you do not mention the work item in the prompt. If the path does not match (e.g. the work item was removed, or the cwd is not actually inside `…/worktrees/<wi>`), SessionStart prints a one-line advisory and you bind manually (name the `wi_…` in your first prompt). There is no command that launches the session for you; `cd` then start it manually.

The worktree session shares the main workspace's `.ditto/local` state (work items, autopilot, sessions), so you can drive autopilot for that work item from inside its worktree.

### 3. See what is in flight

```
ditto worktree list
```

Lists every per-work-item worktree with its work item, branch, path, and git state — `clean`/`dirty` and `+ahead/-behind` against its base. `ditto work status <wi>` also shows the work item's linked worktree(s).

### 4. Work concurrently

Each worktree is isolated by its own branch and its own files, so two worktrees can be worked on — and run autopilot — at the same time. The shared `.git` is protected by locking (DITTO's lock plus git's own). When dogfooding, each worktree loads the `ditto` built from its own source.

### 5. Clean up

```
ditto worktree remove <wi>
```

Refuses (blocks) when the worktree is dirty or unmerged, protecting unsaved work. To remove anyway and discard that work, pass explicit approval:

```
ditto worktree remove <wi> --force
```

Merging and pushing are yours to do — DITTO does not auto-coordinate merges.

## Out of scope

- No central dashboard beyond `ditto worktree list`.
- No automatic merge coordination — you merge and push.
- No automatic session launch — `cd` and start the session yourself.
- No cross-workspace worktrees — worktrees belong to the one workspace.

## Known limits

Honest edges of the current implementation:

- **Korean-only guidance strings.** Some user-facing hints (e.g. the `cd … 후 거기서 세션을 열면 자동으로 …` binding hint) are Korean only, not localized.
- **Lock deadline is a hard failure.** A worktree operation waits up to 30s for DITTO's lock; under heavy contention overlapping a long operation it throws past that deadline rather than queueing. No corruption results — the operation simply fails and can be retried.
- **`ditto worktree list` cost is unmeasured at scale.** Listing calls one git subprocess per work-item worktree (dirty + ahead/behind), so cost grows linearly with work items. With hundreds of work items the cost is untested.
- **`ditto worktree remove --force` is all-or-nothing per work item.** Force applies to *every* worktree the work item owns; in a multi-repo workspace it will force-delete the clean sub-repo worktrees alongside the dirty ones. There is no per-worktree force.
- **Sub-repo detection is shallow.** Multi-repo nesting detects only the direct child directories of the workspace root that contain a `.git`. Deeper nesting and git submodules are not detected.
- **Concurrent edits to the same file are out of scope.** Worktree isolation hides a same-file conflict until merge; it surfaces late.

Unverified (no fresh evidence):

- Real Windows runtime — only the code paths and `path.win32` handling exist.
- Two *live* autopilots running concurrently at the OS level — only synthetic tests.
- The host's SessionStart cwd payload contract that drives auto-binding.
