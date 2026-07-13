/**
 * Unit scope resolver — maps an architecture UNIT to a
 * STANDING-code file set (baseline = HEAD), NOT a merge-base diff. This is the
 * SHARED resolver: WU-4 (`ditto refactor`) and WU-5 (`ditto review`) both resolve
 * `all | component:<name> | layer:<name> | api | <glob>` through this module so the
 * two sibling surfaces agree on what a unit IS.
 *
 * Reuses the existing path conventions rather than reinventing them:
 *   - layer:<name>     → `pathToLayer` (a layers-key appearing as a path segment),
 *                        which needs the ArchitectureSpec; absent spec → resolves
 *                        nothing (conservative — a false unit is worse than empty).
 *   - component:<name> → `layerOf` (top-level `src/<name>/…` dir). A component is a
 *                        top-level src directory, independent of the declared layers.
 *   - api              → controllers/routes layer (the REST API surface, §9).
 *   - <glob>           → `globToRegExp` over repo-relative paths.
 *   - all              → the whole standing file set.
 */
import { layerOf } from '~/acg/architecture/propose';
import { globToRegExp, pathToLayer } from '~/acg/boundary/boundary';
import type { AcgArchitectureSpec } from '~/schemas/acg-architecture-spec';

/** A structured architecture unit parsed from the `--scope` argument. */
export type UnitScope =
  | { kind: 'all' }
  | { kind: 'api' }
  | { kind: 'layer'; name: string }
  | { kind: 'component'; name: string }
  | { kind: 'glob'; glob: string };

/** The path segments that constitute the REST API surface (controllers/routes, §9). */
const API_LAYERS = ['controller', 'controllers', 'route', 'routes'];

/** Parse a `--scope <unit>` argument into a structured {@link UnitScope}. */
export function parseUnitScope(raw: string): UnitScope {
  const unit = raw.trim();
  if (unit === 'all') return { kind: 'all' };
  if (unit === 'api') return { kind: 'api' };
  if (unit.startsWith('layer:')) {
    const name = unit.slice('layer:'.length).trim();
    if (name.length === 0) throw new Error('layer:<name> requires a non-empty layer name');
    return { kind: 'layer', name };
  }
  if (unit.startsWith('component:')) {
    const name = unit.slice('component:'.length).trim();
    if (name.length === 0) throw new Error('component:<name> requires a non-empty component name');
    return { kind: 'component', name };
  }
  return { kind: 'glob', glob: unit };
}

/** Whether a repo-relative path belongs to the given unit. */
function fileInUnit(unit: UnitScope, path: string, archSpec?: AcgArchitectureSpec): boolean {
  switch (unit.kind) {
    case 'all':
      return true;
    case 'api':
      return API_LAYERS.some((seg) => path.split('/').includes(seg));
    case 'layer':
      // layer needs the spec (a layers-key as a path segment); absent → no match.
      return archSpec !== undefined && pathToLayer(path, archSpec.layers) === unit.name;
    case 'component':
      return layerOf(path) === unit.name;
    case 'glob':
      return globToRegExp(unit.glob).test(path);
  }
}

/**
 * Resolve a parsed unit against the repo's standing file set. Pure; the caller
 * supplies the full file list (enumerated from HEAD) and the ArchitectureSpec.
 */
export function resolveUnitScope(
  unit: UnitScope,
  files: readonly string[],
  archSpec?: AcgArchitectureSpec,
): string[] {
  return files.filter((f) => fileInUnit(unit, f, archSpec));
}
