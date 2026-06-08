import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pure resource-discovery + routing for static resources (e.g. `CLAUDE.md`).
 * These functions decide WHERE each bundled resource installs. They perform no
 * fs writes and no CLI; install locations come only via `ctx` args so the
 * setup command (not this module) owns the actual paths.
 */

/** A static resource installs either into the project or the global `.claude`. */
export type RoutingScope = 'project' | 'global';

/** Install-location inputs. `homeDir` is the parent of `.claude`. */
export interface RoutingContext {
  projectRoot: string;
  homeDir: string;
}

export interface RoutingDecision {
  scope: RoutingScope;
  destPath: string;
  destName: string;
}

const GLOBAL_PREFIX = 'GLOBAL_';

/**
 * Route a bundled resource filename to its install location.
 *
 * Any `GLOBAL_*` filename routes to the global `<homeDir>/.claude/` with the
 * prefix stripped from the installed name; everything else installs into the
 * project root under its own filename.
 */
export function routeResource(filename: string, ctx: RoutingContext): RoutingDecision {
  if (filename.startsWith(GLOBAL_PREFIX)) {
    const destName = filename.slice(GLOBAL_PREFIX.length);
    return {
      scope: 'global',
      destName,
      destPath: join(ctx.homeDir, '.claude', destName),
    };
  }
  return {
    scope: 'project',
    destName: filename,
    destPath: join(ctx.projectRoot, filename),
  };
}

/**
 * List the static-resource filenames directly inside `resourcesDir`
 * (non-recursive). Returns `[]` if the directory is missing.
 */
export function discoverResources(resourcesDir: string): string[] {
  try {
    return readdirSync(resourcesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
