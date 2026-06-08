import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RoutingContext, discoverResources, routeResource } from '~/core/resource-routing';

const ctx: RoutingContext = {
  projectRoot: '/tmp/proj',
  homeDir: '/tmp/home',
};

describe('routeResource', () => {
  test('CLAUDE.md → project, <projectRoot>/CLAUDE.md', () => {
    expect(routeResource('CLAUDE.md', ctx)).toEqual({
      scope: 'project',
      destName: 'CLAUDE.md',
      destPath: join('/tmp/proj', 'CLAUDE.md'),
    });
  });

  test('AGENTS.md → project', () => {
    const out = routeResource('AGENTS.md', ctx);
    expect(out.scope).toBe('project');
    expect(out.destPath).toBe(join('/tmp/proj', 'AGENTS.md'));
  });

  test('GLOBAL_CLAUDE.md → global, <homeDir>/.claude/CLAUDE.md (prefix stripped)', () => {
    expect(routeResource('GLOBAL_CLAUDE.md', ctx)).toEqual({
      scope: 'global',
      destName: 'CLAUDE.md',
      destPath: join('/tmp/home', '.claude', 'CLAUDE.md'),
    });
  });

  test('GLOBAL_FOO.md → global, prefix stripped (generic future routing)', () => {
    expect(routeResource('GLOBAL_FOO.md', ctx)).toEqual({
      scope: 'global',
      destName: 'FOO.md',
      destPath: join('/tmp/home', '.claude', 'FOO.md'),
    });
  });
});

describe('discoverResources', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resrouting-'));
  writeFileSync(join(dir, 'CLAUDE.md'), 'x');
  writeFileSync(join(dir, 'AGENTS.md'), 'y');

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('returns filenames in the directory', () => {
    expect(discoverResources(dir).sort()).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });

  test('missing dir → []', () => {
    expect(discoverResources(join(dir, 'does-not-exist'))).toEqual([]);
  });
});
