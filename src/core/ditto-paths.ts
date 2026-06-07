import { join } from 'node:path';

/**
 * Canonical `.ditto/` path helpers for the 3-tier isolation layout.
 *
 * Tier ② project-global (git-shared) lives directly under `.ditto/`:
 * `knowledge/`, `agents/`, `architecture-spec.json`. Those are NOT routed
 * through `localDir` — use `dittoDir` for them.
 *
 * Tier ③ per-developer runtime (gitignored) lives under `.ditto/local/`:
 * work-items, runs, sessions, cache, logs, worktrees, handoff, surfaces.json.
 * Route every per-developer runtime path through `localDir`.
 */

/** The `.ditto/` workspace root under `repoRoot` (project-global tier). */
export function dittoDir(repoRoot: string): string {
  return join(repoRoot, '.ditto');
}

/**
 * A per-developer runtime path under `.ditto/local/`. Pass the leaf name(s),
 * e.g. `localDir(root, 'work-items', id)` → `<root>/.ditto/local/work-items/<id>`.
 */
export function localDir(repoRoot: string, ...segments: string[]): string {
  return join(repoRoot, '.ditto', 'local', ...segments);
}
