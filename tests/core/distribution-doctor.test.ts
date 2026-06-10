import { describe, expect, test } from 'bun:test';
import {
  type DistributionChecks,
  type DistributionDeps,
  collectDistributionChecks,
  evaluateDistribution,
} from '~/core/distribution-doctor';

const ALL_OK: DistributionChecks = {
  binary_built: true,
  binary_fresh: true,
  binary_on_path: true,
  plugin_surface_present: true,
  hooks_registered: true,
  target_initialized: true,
  allowlisted: true,
};

const STAMP = 'a'.repeat(64);

describe('evaluateDistribution (atomic checks → per-axis deployment contracts)', () => {
  test('every check met → all four axes satisfied, 0 findings', () => {
    const r = evaluateDistribution(ALL_OK);
    expect(r.finding_count).toBe(0);
    expect(r.axes.map((a) => a.axis)).toEqual(['Hooks', 'Skills', 'Agents', 'State']);
    expect(r.axes.every((a) => a.satisfied)).toBe(true);
  });

  test('missing binary on PATH breaks Skills and Agents (the axes that need it)', () => {
    const r = evaluateDistribution({ ...ALL_OK, binary_on_path: false });
    const bad = r.axes.filter((a) => !a.satisfied).map((a) => a.axis);
    expect(bad).toEqual(['Skills', 'Agents']);
    expect(r.axes.find((a) => a.axis === 'Skills')?.missing).toContain('binary_on_path');
  });

  test('missing plugin surface breaks Skills and Agents (the axes that ship from it)', () => {
    const r = evaluateDistribution({ ...ALL_OK, plugin_surface_present: false });
    const bad = r.axes.filter((a) => !a.satisfied).map((a) => a.axis);
    expect(bad).toEqual(['Skills', 'Agents']);
    expect(r.axes.find((a) => a.axis === 'Agents')?.missing).toContain('plugin_surface_present');
  });

  test('uninitialized target breaks Agents and State only', () => {
    const r = evaluateDistribution({ ...ALL_OK, target_initialized: false });
    expect(r.axes.filter((a) => !a.satisfied).map((a) => a.axis)).toEqual(['Agents', 'State']);
  });

  test('missing hooks.json breaks Hooks only', () => {
    const r = evaluateDistribution({ ...ALL_OK, hooks_registered: false });
    expect(r.axes.filter((a) => !a.satisfied).map((a) => a.axis)).toEqual(['Hooks']);
  });

  test('R5: a stale binary (src drift) breaks Hooks only', () => {
    const r = evaluateDistribution({ ...ALL_OK, binary_fresh: false });
    expect(r.axes.filter((a) => !a.satisfied).map((a) => a.axis)).toEqual(['Hooks']);
    expect(r.axes.find((a) => a.axis === 'Hooks')?.missing).toContain('binary_fresh');
  });

  test('allowlisted is reported but gates no axis (not in the §3.5 per-axis table)', () => {
    const r = evaluateDistribution({ ...ALL_OK, allowlisted: false });
    expect(r.finding_count).toBe(0);
    expect(r.checks.allowlisted).toBe(false);
  });
});

describe('collectDistributionChecks (injected IO; runtime vantage)', () => {
  const deps = (over: Partial<DistributionDeps>): DistributionDeps => ({
    pluginRoot: '/plugin',
    targetRoot: '/target',
    whichDitto: () => '/usr/local/bin/ditto',
    readProjectSettings: () => ({ permissions: { allow: ['Bash(ditto:*)'] } }),
    exists: () => true,
    readText: () => `#!/usr/bin/env bun\nbundle()\n//# ditto-src-stamp=${STAMP}\n`,
    sourceStamp: () => STAMP,
    ...over,
  });

  test('a fully-deployed environment maps every check true', () => {
    const c = collectDistributionChecks(deps({}));
    expect(c).toEqual(ALL_OK);
  });

  test('ditto absent from PATH → binary_on_path false', () => {
    const c = collectDistributionChecks(deps({ whichDitto: () => null }));
    expect(c.binary_on_path).toBe(false);
  });

  test('a healthy new-model install has plugin_surface_present (no enabledPlugins key)', () => {
    // The regression guard: the new model loads the plugin from "./" and never
    // writes enabledPlugins['ditto@ditto-local']. Surface presence at pluginRoot,
    // not a global settings flag, must satisfy the check.
    const c = collectDistributionChecks(deps({}));
    expect(c.plugin_surface_present).toBe(true);
  });

  test('plugin surface absent at pluginRoot → plugin_surface_present false', () => {
    const c = collectDistributionChecks(deps({ exists: (p) => !p.startsWith('/plugin/skills') }));
    expect(c.plugin_surface_present).toBe(false);
  });

  test('plugin surface is probed under pluginRoot, never targetRoot', () => {
    const checked: string[] = [];
    collectDistributionChecks(
      deps({
        exists: (p) => {
          checked.push(p);
          return true;
        },
      }),
    );
    expect(checked.some((p) => p.startsWith('/plugin/.claude-plugin/plugin.json'))).toBe(true);
    expect(checked.some((p) => p === '/plugin/skills')).toBe(true);
    expect(checked.some((p) => p === '/plugin/agents')).toBe(true);
    expect(checked.some((p) => p.startsWith('/target/skills'))).toBe(false);
  });

  test('glossary seed absent → target_initialized false', () => {
    const c = collectDistributionChecks(deps({ exists: (p) => !p.endsWith('glossary.json') }));
    expect(c.target_initialized).toBe(false);
  });

  // R5 binary_fresh scenarios — the drift the round-2 review caught live
  // (bin/ditto built 10:37 enforcing an old policy against 13:06 sources).
  test('R5: stamp matches current src → binary_fresh true', () => {
    expect(collectDistributionChecks(deps({})).binary_fresh).toBe(true);
  });

  test('R5: stamp differs from current src → binary_fresh false', () => {
    const c = collectDistributionChecks(deps({ sourceStamp: () => 'b'.repeat(64) }));
    expect(c.binary_fresh).toBe(false);
  });

  test('R5: pre-stamp build (no marker) → binary_fresh false (rebuild embeds it)', () => {
    const c = collectDistributionChecks(deps({ readText: () => 'bundle()\n' }));
    expect(c.binary_fresh).toBe(false);
  });

  test('R5: unreadable binary → binary_fresh false', () => {
    const c = collectDistributionChecks(deps({ readText: () => null }));
    expect(c.binary_fresh).toBe(false);
  });

  test('R5: no src/ at plugin root (installed context) → vacuously fresh', () => {
    const c = collectDistributionChecks(
      deps({ exists: (p) => p !== '/plugin/src', readText: () => null }),
    );
    expect(c.binary_fresh).toBe(true);
  });

  test('project allowlist missing the rule → allowlisted false', () => {
    const c = collectDistributionChecks(deps({ readProjectSettings: () => ({}) }));
    expect(c.allowlisted).toBe(false);
  });

  test('plugin-root artifacts are read from pluginRoot, not targetRoot', () => {
    // session-rooting layout: plugin and target are distinct dirs.
    const checked: string[] = [];
    const c = collectDistributionChecks(
      deps({
        exists: (p) => {
          checked.push(p);
          return true;
        },
      }),
    );
    expect(c.binary_built).toBe(true);
    expect(c.hooks_registered).toBe(true);
    // bin/ditto and hooks/hooks.json must be probed under /plugin, never /target.
    expect(checked.some((p) => p.startsWith('/plugin/bin/'))).toBe(true);
    expect(checked.some((p) => p.startsWith('/plugin/hooks/'))).toBe(true);
    expect(checked.some((p) => p.startsWith('/target/bin/'))).toBe(false);
    expect(checked.some((p) => p.startsWith('/target/hooks/'))).toBe(false);
  });

  test('target-root artifacts are read from targetRoot, not pluginRoot', () => {
    const checked: string[] = [];
    collectDistributionChecks(
      deps({
        exists: (p) => {
          checked.push(p);
          return true;
        },
      }),
    );
    // .ditto State is probed under /target, never /plugin.
    expect(checked.some((p) => p.startsWith('/target/.ditto/'))).toBe(true);
    expect(checked.some((p) => p.startsWith('/plugin/.ditto/'))).toBe(false);
  });

  test('session-rooting: a built plugin with an uninitialized target is not misjudged', () => {
    // The exact bug ADR-0011 D1 flagged: plugin artifacts present at pluginRoot,
    // target not yet scaffolded. binary/hooks must stay true; only State fails.
    const c = collectDistributionChecks(
      deps({
        exists: (p) => p.startsWith('/plugin/'),
      }),
    );
    expect(c.binary_built).toBe(true);
    expect(c.hooks_registered).toBe(true);
    expect(c.target_initialized).toBe(false);
  });
});
