import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRepoRoot } from '~/core/fs';
import { fileExists } from '~/core/hosts/shared';
import { initScaffold } from '~/core/init-scaffold';
import { glossary } from '~/schemas/glossary';

const NOW = new Date('2026-06-06T00:00:00.000Z');

async function freshTarget(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ditto-init-'));
}

describe('initScaffold', () => {
  test('creates the .ditto skeleton on a clean target', async () => {
    const repo = await freshTarget();
    try {
      const result = await initScaffold(repo, NOW);

      expect(result.alreadyInitialized).toBe(false);
      // .ditto + 9 subdirs all freshly created.
      expect(result.createdDirs).toContain('.ditto');
      expect(result.createdDirs).toContain(join('.ditto', 'work-items'));
      expect(result.createdDirs).toContain(join('.ditto', 'knowledge', 'adr'));

      for (const sub of ['work-items', 'runs', 'handoff', 'sessions', 'logs', 'cache', 'agents']) {
        expect(await fileExists(join(repo, '.ditto', sub))).toBe(true);
      }
      // After init, findRepoRoot resolves deterministically to the target.
      expect(await findRepoRoot(repo)).toBe(repo);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('seeds a schema-valid empty glossary, context, and .gitignore', async () => {
    const repo = await freshTarget();
    try {
      await initScaffold(repo, NOW);

      const glossaryRaw = await readFile(
        join(repo, '.ditto', 'knowledge', 'glossary.json'),
        'utf8',
      );
      const parsed = glossary.parse(JSON.parse(glossaryRaw));
      expect(parsed.entries).toEqual([]);
      expect(parsed.updated_at).toBe(NOW.toISOString());
      // project_name derives from the target dir basename.
      expect(parsed.project_name).toBe(join(repo).split('/').pop());

      expect(await fileExists(join(repo, '.ditto', 'knowledge', 'CONTEXT.md'))).toBe(true);
      const gitignore = await readFile(join(repo, '.ditto', '.gitignore'), 'utf8');
      expect(gitignore).toContain('runs/');
      expect(gitignore).toContain('work-items/*/evidence/');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('does NOT seed surfaces.json (self-host-only artifact)', async () => {
    const repo = await freshTarget();
    try {
      await initScaffold(repo, NOW);
      expect(await fileExists(join(repo, '.ditto', 'surfaces.json'))).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('is idempotent and never clobbers existing seed files', async () => {
    const repo = await freshTarget();
    try {
      await initScaffold(repo, NOW);

      // Mutate the seeded glossary to prove a re-run keeps user edits.
      const glossaryPath = join(repo, '.ditto', 'knowledge', 'glossary.json');
      const edited = JSON.parse(await readFile(glossaryPath, 'utf8'));
      edited.project_name = 'user-renamed';
      await Bun.write(glossaryPath, JSON.stringify(edited));

      const second = await initScaffold(repo, new Date('2027-01-01T00:00:00.000Z'));
      expect(second.alreadyInitialized).toBe(true);
      expect(second.createdDirs).toEqual([]);
      expect(second.createdFiles).toEqual([]);
      expect(second.skippedFiles).toContain(join('.ditto', 'knowledge', 'glossary.json'));

      const after = JSON.parse(await readFile(glossaryPath, 'utf8'));
      expect(after.project_name).toBe('user-renamed');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
