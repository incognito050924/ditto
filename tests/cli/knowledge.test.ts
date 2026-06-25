import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAdrConsistency, createAdrSkeleton } from '~/cli/commands/knowledge';

// wi_260624gm9 (node gN4): `ditto knowledge adr-new --slug=<slug>` generates a new
// ADR skeleton named ADR-YYYYMMDD-<slug>.md. The whole filename stem is the ADR's
// immutable id (no separate number). Clock is injectable so the date is deterministic.

const FIXED = new Date('2026-06-24T09:00:00Z');

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ditto-adrnew-'));
  await mkdir(join(dir, '.ditto', 'knowledge', 'adr'), { recursive: true });
  return dir;
}

describe('createAdrSkeleton (ditto knowledge adr-new)', () => {
  test('valid slug + injected date 2026-06-24 → ADR-20260624-<slug>.md with skeleton', async () => {
    const repoRoot = await tempRepo();
    try {
      const result = await createAdrSkeleton({ repoRoot, slug: 'my-feature', now: FIXED });
      const expectedPath = join(
        repoRoot,
        '.ditto',
        'knowledge',
        'adr',
        'ADR-20260624-my-feature.md',
      );
      expect(result.path).toBe(expectedPath);
      const body = await readFile(expectedPath, 'utf8');
      expect(body).toContain('# ADR-20260624-my-feature');
      expect(body).toContain('상태: proposed');
      expect(body).toContain('결정 일자: 2026-06-24');
      // rationale + change_condition placeholders must be present for the curator to fill.
      expect(body.toLowerCase()).toContain('rationale');
      expect(body.toLowerCase()).toContain('change_condition');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('rejects an invalid slug (Bad_Slug) — throws, no file written', async () => {
    const repoRoot = await tempRepo();
    try {
      await expect(createAdrSkeleton({ repoRoot, slug: 'Bad_Slug', now: FIXED })).rejects.toThrow();
      const path = join(repoRoot, '.ditto', 'knowledge', 'adr', 'ADR-20260624-Bad_Slug.md');
      expect(await Bun.file(path).exists()).toBe(false);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('rejects an UPPER slug — throws', async () => {
    const repoRoot = await tempRepo();
    try {
      await expect(createAdrSkeleton({ repoRoot, slug: 'UPPER', now: FIXED })).rejects.toThrow();
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('refuses to overwrite when the target file already exists — throws, original kept', async () => {
    const repoRoot = await tempRepo();
    try {
      const path = join(repoRoot, '.ditto', 'knowledge', 'adr', 'ADR-20260624-dup.md');
      await writeFile(path, 'ORIGINAL CONTENT', 'utf8');
      await expect(createAdrSkeleton({ repoRoot, slug: 'dup', now: FIXED })).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe('ORIGINAL CONTENT');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

// wi_260624gm9 (node gN5): `ditto knowledge adr-check` is a fail-closed consistency
// checker over `.ditto/knowledge/adr/`. Exit 0 when clean; non-zero listing every
// violation otherwise. Two file-driven checks: (1) filename format, (2) identifier
// uniqueness. The hand-maintained knowledge.json decisions[] index — and its
// index→file consistency check — was retired (ADR-20260624 amend, wi_2606247cx);
// the adr/*.md files are the SoT. adr-check must never flag number-sequence gaps or
// suggest renaming legacy ADR-NNNN files.

const adrDirOf = (repoRoot: string) => join(repoRoot, '.ditto', 'knowledge', 'adr');

async function writeAdr(repoRoot: string, filename: string, body = '# stub\n'): Promise<void> {
  await writeFile(join(adrDirOf(repoRoot), filename), body, 'utf8');
}

describe('checkAdrConsistency (ditto knowledge adr-check)', () => {
  test('valid: legacy + new file, both well-formed and unique → no violations', async () => {
    const repoRoot = await tempRepo();
    try {
      await writeAdr(repoRoot, 'ADR-0001-foo.md');
      await writeAdr(repoRoot, 'ADR-20260624-bar.md');
      const result = await checkAdrConsistency(repoRoot);
      expect(result.violations).toEqual([]);
      expect(result.ok).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('malformed filename (ADR-xyz.md, bare ADR-20260624.md) → violations', async () => {
    const repoRoot = await tempRepo();
    try {
      await writeAdr(repoRoot, 'ADR-xyz.md');
      await writeAdr(repoRoot, 'ADR-20260624.md'); // 8-digit but no slug
      const result = await checkAdrConsistency(repoRoot);
      expect(result.ok).toBe(false);
      expect(result.violations.length).toBeGreaterThanOrEqual(2);
      expect(result.violations.join('\n')).toContain('ADR-xyz.md');
      expect(result.violations.join('\n')).toContain('ADR-20260624.md');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('duplicate identifier (two ADR-0026-*.md) → violation', async () => {
    const repoRoot = await tempRepo();
    try {
      await writeAdr(repoRoot, 'ADR-0026-a.md');
      await writeAdr(repoRoot, 'ADR-0026-b.md');
      const result = await checkAdrConsistency(repoRoot);
      expect(result.ok).toBe(false);
      expect(result.violations.join('\n')).toContain('ADR-0026');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('a number-sequence gap (ADR-0001 then ADR-0003) is NOT flagged', async () => {
    const repoRoot = await tempRepo();
    try {
      await writeAdr(repoRoot, 'ADR-0001-foo.md');
      await writeAdr(repoRoot, 'ADR-0003-baz.md');
      const result = await checkAdrConsistency(repoRoot);
      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
