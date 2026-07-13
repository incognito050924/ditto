import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locate the ditto *plugin root* — the directory that ships the plugin's own
 * artifacts (`bin/ditto`, `hooks/hooks.json`, `skills/`, `agents/`,
 * `.claude-plugin/plugin.json`). This is distinct from the session's target repo
 * root (ADR-0011 D2 session-rooting): under a consumer install the plugin lives
 * in the plugin cache while the session is rooted at the user's project.
 *
 * `ditto doctor` (distribution/capability) must check the plugin's surface at
 * THIS root, not at the target repo — otherwise a healthy consumer install false-
 * alarms as DRIFT because the target repo ships no plugin surface. The plugin's
 * hook child processes get `CLAUDE_PLUGIN_ROOT`, but a manual `ditto doctor` in a
 * shell does not, so we discover the root through three ordered vectors and fall
 * back to null (→ the caller reports `unverified`, not a confirmed drift).
 */

export type PluginRootSource = 'env' | 'self-locate' | 'registry';

export interface PluginRootResolution {
  root: string;
  source: PluginRootSource;
}

export interface PluginRootDeps {
  getEnv: (key: string) => string | undefined;
  /** Where self-location begins — dirname of the running module. */
  startDir: string;
  exists: (path: string) => boolean;
  /** Parsed `~/.claude/plugins/installed_plugins.json`, or null when absent. */
  readInstalledPlugins: () => unknown;
}

/** A directory is a plugin root iff it carries the canonical plugin manifest. */
const PLUGIN_MANIFEST = ['.claude-plugin', 'plugin.json'];

function isPluginRoot(dir: string, exists: (p: string) => boolean): boolean {
  return exists(join(dir, ...PLUGIN_MANIFEST));
}

/** Walk up from `start` to the first ancestor that carries the plugin manifest. */
function selfLocate(start: string, exists: (p: string) => boolean): string | null {
  let dir = start;
  for (;;) {
    if (isPluginRoot(dir, exists)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The Claude Code plugin manager records every installed plugin (keyed
 * `<name>@<marketplace>`) with its on-disk `installPath` in
 * `~/.claude/plugins/installed_plugins.json`. This is the only vector that finds
 * the surface from a DETACHED on-PATH binary — the `npx-bootstrap` install copies
 * a bare `bin/ditto` with no co-located surface, so self-location cannot reach it.
 * We read the registry as a last resort and verify the recorded path actually
 * carries a plugin manifest (a stale entry is ignored, not trusted).
 */
function fromRegistry(raw: unknown, exists: (p: string) => boolean): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const plugins = (raw as { plugins?: unknown }).plugins;
  if (!plugins || typeof plugins !== 'object') return null;
  for (const [key, entries] of Object.entries(plugins as Record<string, unknown>)) {
    if (!key.startsWith('ditto@')) continue;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const installPath = (entry as { installPath?: unknown })?.installPath;
      if (typeof installPath === 'string' && isPluginRoot(installPath, exists)) {
        return installPath;
      }
    }
  }
  return null;
}

/**
 * Resolve the plugin root via, in order: `CLAUDE_PLUGIN_ROOT` (set for plugin/hook
 * child processes) → self-location from the running module (binary co-located with
 * its surface: cache-invoked, dev checkout, dist/plugin) → the plugin-manager
 * registry (detached on-PATH binary). Returns null when none locate a plugin root,
 * so the caller degrades to `unverified` rather than false-alarming DRIFT.
 */
export function resolvePluginRoot(deps: PluginRootDeps): PluginRootResolution | null {
  const env = deps.getEnv('CLAUDE_PLUGIN_ROOT');
  if (env && env.length > 0) return { root: env, source: 'env' };

  const located = selfLocate(deps.startDir, deps.exists);
  if (located) return { root: located, source: 'self-locate' };

  const registered = fromRegistry(deps.readInstalledPlugins(), deps.exists);
  if (registered) return { root: registered, source: 'registry' };

  return null;
}

export type LocatedStatus = 'ok' | 'drift' | 'unverified';

/**
 * Map a plugin-root-dependent finding count to a doctor status. A "missing
 * surface" finding is only a confirmed DRIFT when the plugin root was located; if
 * it was not, the check ran against a fallback root it cannot trust, so the honest
 * verdict is `unverified` (exit 0) — a healthy-but-unlocatable install must not
 * false-alarm. Zero findings is always `ok`.
 */
export function locatedStatus(findingCount: number, located: boolean): LocatedStatus {
  if (findingCount === 0) return 'ok';
  return located ? 'drift' : 'unverified';
}

export function defaultPluginRootDeps(): PluginRootDeps {
  return {
    getEnv: (key) => process.env[key],
    startDir: dirname(fileURLToPath(import.meta.url)),
    exists: (p) => existsSync(p),
    readInstalledPlugins: () => {
      try {
        const path = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
        const text = readFileSync(path, 'utf8').trim();
        return text ? JSON.parse(text) : null;
      } catch {
        return null;
      }
    },
  };
}
