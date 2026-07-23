import { join } from 'node:path';

/**
 * Canonical `.ditto/` path helpers for the 3-tier isolation layout.
 *
 * Tier ② project-global (git-shared) lives directly under `.ditto/`:
 * knowledge, agents, committed work-item Records. Those are NOT routed
 * through `localDir` — use `dittoDir` (or `committedWorkItemDir`) for them.
 *
 * Tier ③ per-developer runtime (gitignored) lives under `.ditto/local/`:
 * runs, sessions, cache, logs, worktrees, handoff, config.json. Route every
 * per-developer runtime path through `localDir`.
 */

/** The `.ditto/` workspace root under `repoRoot` (project-global tier). */
export function dittoDir(repoRoot: string): string {
  return join(repoRoot, '.ditto');
}

/**
 * A per-developer runtime path under `.ditto/local/`. Pass the leaf name(s),
 * e.g. `localDir(root, 'runs', id)` → `<root>/.ditto/local/runs/<id>`.
 */
export function localDir(repoRoot: string, ...segments: string[]): string {
  return join(repoRoot, '.ditto', 'local', ...segments);
}

/**
 * The committed (git-shared) base for a work item's Record —
 * `<root>/.ditto/work-items/<id>/`. Holds `record.json` (the authored
 * WorkItem) and `events/<seq>.<actor>.<eid>.json` (the immutable per-event
 * log). Project-global tier, NOT routed through `localDir`; personal Run
 * artifacts (evidence, autopilot state, metrics) stay under `localDir`.
 */
export function committedWorkItemDir(repoRoot: string, id: string): string {
  return join(dittoDir(repoRoot), 'work-items', id);
}
