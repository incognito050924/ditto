import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileExists } from '~/core/hosts/shared';
import { ALLOW_RULE } from '~/core/settings-allowlist';
import { setup } from '~/core/setup';

const NOW = new Date('2026-06-08T00:00:00.000Z');

interface Dirs {
  resourcesDir: string;
  projectRoot: string;
  homeDir: string;
}

async function freshDirs(): Promise<Dirs> {
  const resourcesDir = await mkdtemp(join(tmpdir(), 'ditto-setup-res-'));
  const projectRoot = await mkdtemp(join(tmpdir(), 'ditto-setup-proj-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'ditto-setup-home-'));
  await writeFile(join(resourcesDir, 'CLAUDE.md'), 'CLAUDE charter body\n');
  await writeFile(join(resourcesDir, 'AGENTS.md'), 'AGENTS charter body\n');
  await writeFile(join(resourcesDir, 'GLOBAL_FOO.md'), 'global foo body\n');
  return { resourcesDir, projectRoot, homeDir };
}

async function cleanup(d: Dirs): Promise<void> {
  await rm(d.resourcesDir, { recursive: true, force: true });
  await rm(d.projectRoot, { recursive: true, force: true });
  await rm(d.homeDir, { recursive: true, force: true });
}

const MANAGED_START = /<!--\s*ditto:managed:start/;

describe('setup', () => {
  test('installs project + global resources, scaffolds .ditto, allowlists settings', async () => {
    const d = await freshDirs();
    try {
      const result = await setup({ ...d, now: NOW });

      // project resources land in projectRoot with a managed block
      const claude = await readFile(join(d.projectRoot, 'CLAUDE.md'), 'utf8');
      const agents = await readFile(join(d.projectRoot, 'AGENTS.md'), 'utf8');
      expect(claude).toMatch(MANAGED_START);
      expect(claude).toContain('CLAUDE charter body');
      expect(agents).toMatch(MANAGED_START);
      expect(agents).toContain('AGENTS charter body');

      // GLOBAL_ prefix strips to <homeDir>/.claude/FOO.md
      const globalFoo = await readFile(join(d.homeDir, '.claude', 'FOO.md'), 'utf8');
      expect(globalFoo).toMatch(MANAGED_START);
      expect(globalFoo).toContain('global foo body');
      expect(await fileExists(join(d.homeDir, '.claude', 'GLOBAL_FOO.md'))).toBe(false);

      // .ditto/ created
      expect(await fileExists(join(d.projectRoot, '.ditto', 'knowledge', 'glossary.json'))).toBe(
        true,
      );
      expect(result.scaffold.alreadyInitialized).toBe(false);

      // settings allow rule present
      const settings = JSON.parse(await readFile(result.allowlistPath, 'utf8'));
      expect(settings.permissions.allow).toContain(ALLOW_RULE);

      // every resource written cleanly
      expect(result.resources.every((r) => r.status === 'written')).toBe(true);
      expect(result.resources).toHaveLength(3);
    } finally {
      await cleanup(d);
    }
  });

  test('preserves pre-existing user text outside the managed block', async () => {
    const d = await freshDirs();
    try {
      await writeFile(join(d.projectRoot, 'CLAUDE.md'), 'USER PREAMBLE\n');
      await setup({ ...d, now: NOW });
      const claude = await readFile(join(d.projectRoot, 'CLAUDE.md'), 'utf8');
      expect(claude).toContain('USER PREAMBLE');
      expect(claude).toMatch(MANAGED_START);
    } finally {
      await cleanup(d);
    }
  });

  test('re-run is idempotent: .ditto_bak keeps the first original, no dup allow rule', async () => {
    const d = await freshDirs();
    try {
      await writeFile(join(d.projectRoot, 'CLAUDE.md'), 'FIRST ORIGINAL\n');
      await setup({ ...d, now: NOW });

      // mutate the file content, then re-run; backup must keep the FIRST original
      const afterFirst = await readFile(join(d.projectRoot, 'CLAUDE.md'), 'utf8');
      await writeFile(
        join(d.projectRoot, 'CLAUDE.md'),
        afterFirst.replace('FIRST ORIGINAL', 'EDITED'),
      );
      await setup({ ...d, now: NOW });

      const bak = await readFile(join(d.projectRoot, 'CLAUDE.md.ditto_bak'), 'utf8');
      expect(bak).toBe('FIRST ORIGINAL\n');

      const settings = JSON.parse(
        await readFile(join(d.projectRoot, '.claude', 'settings.json'), 'utf8'),
      );
      const occurrences = settings.permissions.allow.filter((r: string) => r === ALLOW_RULE).length;
      expect(occurrences).toBe(1);
    } finally {
      await cleanup(d);
    }
  });
});
