import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { type PluginRootDeps, locatedStatus, resolvePluginRoot } from '~/core/plugin-root';

const MANIFEST = join('.claude-plugin', 'plugin.json');

// A fixture filesystem: `existing` is the set of paths that exist. A dir is a
// plugin root iff `<dir>/.claude-plugin/plugin.json` is in the set.
function deps(over: Partial<PluginRootDeps> & { existing?: string[] } = {}): PluginRootDeps {
  const existing = new Set(over.existing ?? []);
  return {
    getEnv: () => undefined,
    startDir: '/nowhere',
    exists: (p) => existing.has(p),
    readInstalledPlugins: () => null,
    ...over,
  };
}

describe('resolvePluginRoot (ordered discovery vectors)', () => {
  test('env CLAUDE_PLUGIN_ROOT wins, verbatim, without a filesystem probe', () => {
    const r = resolvePluginRoot(
      deps({ getEnv: (k) => (k === 'CLAUDE_PLUGIN_ROOT' ? '/plug' : undefined) }),
    );
    expect(r).toEqual({ root: '/plug', source: 'env' });
  });

  test('empty env is ignored (falls through)', () => {
    const r = resolvePluginRoot(deps({ getEnv: () => '' }));
    expect(r).toBeNull();
  });

  test('self-locate walks up to the first ancestor carrying the plugin manifest', () => {
    // Binary at /cache/ditto/0.9.1/bin/ditto → module dir is .../bin; the manifest
    // lives one level up at the plugin root.
    const root = '/cache/ditto/0.9.1';
    const r = resolvePluginRoot(
      deps({ startDir: join(root, 'bin'), existing: [join(root, MANIFEST)] }),
    );
    expect(r).toEqual({ root, source: 'self-locate' });
  });

  test('self-locate returns null when no ancestor carries the manifest (detached binary)', () => {
    // ~/.local/share/ditto/bin/ditto — a bare copied binary, no surface up-tree.
    const r = resolvePluginRoot(deps({ startDir: '/home/u/.local/share/ditto/bin' }));
    expect(r).toBeNull();
  });

  test('registry vector finds the installPath for a detached binary', () => {
    const installPath = '/home/u/.claude/plugins/cache/ditto-local/ditto/0.9.1';
    const r = resolvePluginRoot(
      deps({
        startDir: '/home/u/.local/share/ditto/bin', // self-locate fails
        existing: [join(installPath, MANIFEST)],
        readInstalledPlugins: () => ({
          plugins: {
            'other@x': [{ installPath: '/somewhere/else' }],
            'ditto@ditto-local': [{ scope: 'user', installPath, version: '0.9.1' }],
          },
        }),
      }),
    );
    expect(r).toEqual({ root: installPath, source: 'registry' });
  });

  test('registry entry with a stale/absent installPath is ignored, not trusted', () => {
    const r = resolvePluginRoot(
      deps({
        startDir: '/detached/bin',
        existing: [], // the recorded path does NOT carry a manifest
        readInstalledPlugins: () => ({
          plugins: { 'ditto@ditto-local': [{ installPath: '/gone/0.9.1' }] },
        }),
      }),
    );
    expect(r).toBeNull();
  });

  test('precedence: self-locate is preferred over the registry', () => {
    const local = '/dev/repo';
    const r = resolvePluginRoot(
      deps({
        startDir: join(local, 'bin'),
        existing: [join(local, MANIFEST), join('/cache/x', MANIFEST)],
        readInstalledPlugins: () => ({
          plugins: { 'ditto@ditto-local': [{ installPath: '/cache/x' }] },
        }),
      }),
    );
    expect(r).toEqual({ root: local, source: 'self-locate' });
  });

  test('all vectors dry → null (caller degrades to unverified)', () => {
    expect(resolvePluginRoot(deps())).toBeNull();
  });
});

describe('locatedStatus (finding count × located → doctor status)', () => {
  test('zero findings is always ok, located or not', () => {
    expect(locatedStatus(0, true)).toBe('ok');
    expect(locatedStatus(0, false)).toBe('ok');
  });

  test('findings with a located plugin root are confirmed drift', () => {
    expect(locatedStatus(3, true)).toBe('drift');
  });

  test('findings without a located plugin root are unverified, not drift', () => {
    expect(locatedStatus(3, false)).toBe('unverified');
  });
});
