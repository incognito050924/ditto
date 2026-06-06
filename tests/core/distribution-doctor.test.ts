import { describe, expect, test } from 'bun:test';
import {
  type DistributionChecks,
  type DistributionDeps,
  collectDistributionChecks,
  evaluateDistribution,
} from '~/core/distribution-doctor';

const ALL_OK: DistributionChecks = {
  binary_built: true,
  binary_on_path: true,
  plugin_enabled: true,
  hooks_registered: true,
  target_initialized: true,
  allowlisted: true,
};

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

  test('uninitialized target breaks Agents and State only', () => {
    const r = evaluateDistribution({ ...ALL_OK, target_initialized: false });
    expect(r.axes.filter((a) => !a.satisfied).map((a) => a.axis)).toEqual(['Agents', 'State']);
  });

  test('missing hooks.json breaks Hooks only', () => {
    const r = evaluateDistribution({ ...ALL_OK, hooks_registered: false });
    expect(r.axes.filter((a) => !a.satisfied).map((a) => a.axis)).toEqual(['Hooks']);
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
    readGlobalSettings: () => ({ enabledPlugins: { 'ditto@ditto-local': true } }),
    readProjectSettings: () => ({ permissions: { allow: ['Bash(ditto:*)'] } }),
    exists: () => true,
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

  test('plugin not enabled in global settings → plugin_enabled false', () => {
    const c = collectDistributionChecks(deps({ readGlobalSettings: () => ({}) }));
    expect(c.plugin_enabled).toBe(false);
  });

  test('glossary seed absent → target_initialized false', () => {
    const c = collectDistributionChecks(deps({ exists: (p) => !p.endsWith('glossary.json') }));
    expect(c.target_initialized).toBe(false);
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
