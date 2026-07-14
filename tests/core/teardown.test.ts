import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileExists } from '~/core/hosts/shared';
import { normalizedSha256 } from '~/core/instruction-bridge';
import { buildManagedBlock } from '~/core/managed-resource';
import { ALLOW_RULE } from '~/core/settings-allowlist';
import { setup } from '~/core/setup';
import { teardown } from '~/core/teardown';

const NOW = new Date('2026-06-08T00:00:00.000Z');
const MANAGED_MARKER = /<!--\s*ditto:managed:/;

interface Dirs {
  resourcesDir: string;
  projectRoot: string;
  homeDir: string;
}

async function freshDirs(): Promise<Dirs> {
  const resourcesDir = await mkdtemp(join(tmpdir(), 'ditto-teardown-res-'));
  const projectRoot = await mkdtemp(join(tmpdir(), 'ditto-teardown-proj-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'ditto-teardown-home-'));
  await writeFile(join(resourcesDir, 'CLAUDE.md'), 'CLAUDE charter body\n');
  return { resourcesDir, projectRoot, homeDir };
}

async function cleanup(d: Dirs): Promise<void> {
  await rm(d.resourcesDir, { recursive: true, force: true });
  await rm(d.projectRoot, { recursive: true, force: true });
  await rm(d.homeDir, { recursive: true, force: true });
}

describe('teardown', () => {
  test('round-trip: strips managed block, preserves user text before and after it', async () => {
    const d = await freshDirs();
    try {
      const claudePath = join(d.projectRoot, 'CLAUDE.md');
      // Pre-existing user content surrounding where the managed block lands.
      await writeFile(claudePath, 'USER TOP\n');
      await setup({ ...d, now: NOW });
      // Append user text AFTER the managed block (simulates trailing content).
      const afterSetup = await readFile(claudePath, 'utf8');
      await writeFile(claudePath, `${afterSetup}USER BOTTOM\n`);
      expect(afterSetup).toMatch(MANAGED_MARKER);

      const result = await teardown(d);

      const final = await readFile(claudePath, 'utf8');
      expect(final).not.toMatch(MANAGED_MARKER);
      expect(final).toContain('USER TOP');
      expect(final).toContain('USER BOTTOM');
      expect(result.files.find((f) => f.filename === 'CLAUDE.md')?.action).toBe('stripped');
    } finally {
      await cleanup(d);
    }
  });

  test('preserves an increment the user added outside the block after setup', async () => {
    const d = await freshDirs();
    try {
      const claudePath = join(d.projectRoot, 'CLAUDE.md');
      await setup({ ...d, now: NOW });
      const installed = await readFile(claudePath, 'utf8');
      // User edits the file post-setup, adding a section outside the block.
      await writeFile(claudePath, `${installed}\n## My increment\nkeep me\n`);

      await teardown(d);

      const final = await readFile(claudePath, 'utf8');
      expect(final).not.toMatch(MANAGED_MARKER);
      expect(final).toContain('## My increment');
      expect(final).toContain('keep me');
    } finally {
      await cleanup(d);
    }
  });

  test('corrupted markers with a .ditto_bak present: restores from backup, does not strip-destroy', async () => {
    const d = await freshDirs();
    try {
      const claudePath = join(d.projectRoot, 'CLAUDE.md');
      const block = buildManagedBlock('managed body', 'CLAUDE.md');
      // Two start markers (one block, plus a stray start) → corrupted/unstrippable.
      await writeFile(claudePath, `PRECIOUS USER DATA\n${block}\n${block}\n`);
      // Backup snapshot of the original user file.
      await writeFile(`${claudePath}.ditto_bak`, 'PRECIOUS USER DATA\n');

      const result = await teardown(d);

      const final = await readFile(claudePath, 'utf8');
      expect(final).toBe('PRECIOUS USER DATA\n');
      expect(final).not.toMatch(MANAGED_MARKER);
      expect(result.files.find((f) => f.filename === 'CLAUDE.md')?.action).toBe(
        'restored-from-backup',
      );
    } finally {
      await cleanup(d);
    }
  });

  test('corrupted markers with NO backup: leaves the file untouched (never destroys content)', async () => {
    const d = await freshDirs();
    try {
      const claudePath = join(d.projectRoot, 'CLAUDE.md');
      const block = buildManagedBlock('managed body', 'CLAUDE.md');
      const corrupted = `PRECIOUS\n${block}\n${block}\n`;
      await writeFile(claudePath, corrupted);

      const result = await teardown(d);

      expect(await readFile(claudePath, 'utf8')).toBe(corrupted);
      expect(result.files.find((f) => f.filename === 'CLAUDE.md')?.action).toBe('left-untouched');
    } finally {
      await cleanup(d);
    }
  });

  test('removes the allow rule while preserving other allow rules', async () => {
    const d = await freshDirs();
    try {
      await setup({ ...d, now: NOW });
      const settingsPath = join(d.projectRoot, '.claude', 'settings.json');
      // Add an unrelated allow rule that teardown must NOT touch.
      const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
      settings.permissions.allow.push('Bash(git:*)');
      await writeFile(settingsPath, JSON.stringify(settings, null, 2));

      await teardown(d);

      const final = JSON.parse(await readFile(settingsPath, 'utf8'));
      expect(final.permissions.allow).not.toContain(ALLOW_RULE);
      expect(final.permissions.allow).toContain('Bash(git:*)');
    } finally {
      await cleanup(d);
    }
  });

  // ---- raw AGENTS.md ditto-charter region teardown (marker-less, exact-match) ----
  // These write a bundled AGENTS.md charter + a charter-manifest.json into resourcesDir
  // so teardown can recognize the leading ditto region by normalized sha and remove it.
  async function bundleCharter(d: Dirs, charter: string, manifestShas: string[]): Promise<void> {
    await writeFile(join(d.resourcesDir, 'AGENTS.md'), charter);
    await writeFile(
      join(d.resourcesDir, 'charter-manifest.json'),
      `${JSON.stringify({ shas: manifestShas }, null, 2)}\n`,
    );
  }

  test('AGENTS.md: removes the exact-match charter region, keeps trailing user rules byte-identical', async () => {
    const d = await freshDirs();
    try {
      const charter = 'DITTO Agent Behavior Charter\nrule one\nrule two\n';
      // Manifest empty → recognition relies on the current bundled charter sha (union).
      await bundleCharter(d, charter, []);
      const agentsPath = join(d.projectRoot, 'AGENTS.md');
      const userRules = '\n# My Project Rules\nkeep me exactly\n';
      await writeFile(agentsPath, charter + userRules);

      const result = await teardown(d);

      expect(await readFile(agentsPath, 'utf8')).toBe(userRules);
      expect(result.files.find((f) => f.filename === 'AGENTS.md')?.action).toBe('stripped');
    } finally {
      await cleanup(d);
    }
  });

  test('AGENTS.md: recognizes a PRIOR charter version via the manifest and removes it', async () => {
    const d = await freshDirs();
    try {
      const priorCharter = 'DITTO Agent Behavior Charter v1\nold rule\n';
      const currentCharter = 'DITTO Agent Behavior Charter v2\nnew rule\nmore\n';
      // Bundle ships the CURRENT charter; the manifest carries the PRIOR sha.
      await bundleCharter(d, currentCharter, [normalizedSha256(priorCharter)]);
      const agentsPath = join(d.projectRoot, 'AGENTS.md');
      const userRules = '# User section\nretain\n';
      // On disk the project still has the PRIOR charter region + user rules.
      await writeFile(agentsPath, priorCharter + userRules);

      const result = await teardown(d);

      expect(await readFile(agentsPath, 'utf8')).toBe(userRules);
      expect(result.files.find((f) => f.filename === 'AGENTS.md')?.action).toBe('stripped');
    } finally {
      await cleanup(d);
    }
  });

  test('AGENTS.md: user-edited (unrecognized) region is preserved, not removed', async () => {
    const d = await freshDirs();
    try {
      const charter = 'DITTO Agent Behavior Charter\nrule one\nrule two\n';
      await bundleCharter(d, charter, []);
      const agentsPath = join(d.projectRoot, 'AGENTS.md');
      // The user edited the charter body: no leading prefix matches a known sha.
      const edited = 'DITTO Agent Behavior Charter\nrule one EDITED\nrule two\n# mine\nkeep\n';
      await writeFile(agentsPath, edited);

      const result = await teardown(d);

      expect(await readFile(agentsPath, 'utf8')).toBe(edited);
      expect(result.files.find((f) => f.filename === 'AGENTS.md')?.action).toBe('left-untouched');
    } finally {
      await cleanup(d);
    }
  });

  test('AGENTS.md: a file that is exactly a known charter (no user rules) is emptied', async () => {
    const d = await freshDirs();
    try {
      const charter = 'DITTO Agent Behavior Charter\nrule one\nrule two\n';
      await bundleCharter(d, charter, []);
      const agentsPath = join(d.projectRoot, 'AGENTS.md');
      await writeFile(agentsPath, charter);

      const result = await teardown(d);

      expect(await readFile(agentsPath, 'utf8')).toBe('');
      expect(result.files.find((f) => f.filename === 'AGENTS.md')?.action).toBe('stripped');
    } finally {
      await cleanup(d);
    }
  });

  test('AGENTS.md: charter-manifest.json is never treated as a project file to tear down', async () => {
    const d = await freshDirs();
    try {
      const charter = 'DITTO Agent Behavior Charter\nrule one\n';
      await bundleCharter(d, charter, []);

      const result = await teardown(d);

      expect(result.files.some((f) => f.filename === 'charter-manifest.json')).toBe(false);
    } finally {
      await cleanup(d);
    }
  });

  test('does not delete .ditto/', async () => {
    const d = await freshDirs();
    try {
      await setup({ ...d, now: NOW });
      const dittoDir = join(d.projectRoot, '.ditto');
      expect(await fileExists(dittoDir)).toBe(true);

      await teardown(d);

      expect(await fileExists(dittoDir)).toBe(true);
    } finally {
      await cleanup(d);
    }
  });
});
