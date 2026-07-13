# Worktree — known limits and unverified edges

Honest edges of the current implementation. The core workflow is in `../SKILL.md`; consult this file only when you hit one of these edges.

## Known limits

- **Korean-only guidance strings.** Some user-facing hints (e.g. the `cd … 후 거기서 세션을 열면 자동으로 …` binding hint) are Korean only, not localized.
- **Lock deadline is a hard failure.** A worktree operation waits up to 30s for DITTO's lock; under heavy contention overlapping a long operation it throws past that deadline rather than queueing. No corruption results — the operation simply fails and can be retried.
- **`ditto worktree list` cost is unmeasured at scale.** Listing calls one git subprocess per work-item worktree (dirty + ahead/behind), so cost grows linearly with work items. With hundreds of work items the cost is untested.
- **`ditto worktree remove --force` is all-or-nothing per work item.** Force applies to *every* worktree the work item owns; in a multi-repo workspace it will force-delete the clean sub-repo worktrees alongside the dirty ones. There is no per-worktree force.
- **Sub-repo detection is shallow.** Multi-repo nesting detects only the direct child directories of the workspace root that contain a `.git`. Deeper nesting and git submodules are not detected.
- **Same-file concurrent edits are out of scope.** Worktree isolation hides a same-file conflict until merge, where it surfaces late (this is why `../SKILL.md` restricts worktrees to genuinely independent features).

## Unverified (no fresh evidence)

- Real Windows runtime — only the code paths and `path.win32` handling exist.
- Two *live* autopilots running concurrently at the OS level — only synthetic tests.
- The host's SessionStart cwd payload contract that drives auto-binding.
