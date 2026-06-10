import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the bundled resources directory. Under the installed plugin layout the
 * plugin root is `${CLAUDE_PLUGIN_ROOT}`. Otherwise (manual/dev invocation) walk
 * up from this module (or `from`, when given) to the first ancestor that holds
 * `resources/managed`. This is depth-independent, so it resolves correctly
 * whether the entry point is the source file (src/cli), the repo-root bundle
 * (bin/ditto), the product bundle (dist/plugin/bin/ditto), or the installed
 * plugin cache (~/.claude/plugins/cache/.../<version>/bin/ditto) — a fixed
 * relative guess only matches some of these, silently mis-resolving the rest.
 */
export function resolveResourcesDir(from?: string): string {
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    return join(process.env.CLAUDE_PLUGIN_ROOT, 'resources', 'managed');
  }
  const start = from ?? dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (;;) {
    const candidate = join(dir, 'resources', 'managed');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last-resort: the original source-layout guess (src/cli → repo root).
  return join(resolve(start, '..', '..'), 'resources', 'managed');
}
