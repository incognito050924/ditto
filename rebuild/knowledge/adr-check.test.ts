import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkAdrConsistency } from './adr-check';

async function makeRepoWithAdrs(files: Record<string, string>): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'ditto-adr-check-'));
  const adrDir = join(repoRoot, '.ditto', 'knowledge', 'adr');
  await mkdir(adrDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(adrDir, name), body, 'utf8');
  }
  return repoRoot;
}

describe('checkAdrConsistency — adr-check, the verification half of the identifier policy', () => {
  test('clean dir with legacy and new filenames passes (grandfather, both forms)', async () => {
    const repoRoot = await makeRepoWithAdrs({
      'ADR-0013-memory-subsystem-design.md': '# ADR-0013: x',
      'ADR-20260624-adr-identifier-policy.md': '# ADR-20260624-adr-identifier-policy: y',
    });
    const result = await checkAdrConsistency(repoRoot);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test('flags malformed filenames (bare id, wrong charset) but never number-sequence gaps', async () => {
    const repoRoot = await makeRepoWithAdrs({
      'ADR-0001-first.md': '# ADR-0001: a',
      // 0002..0009 missing — gaps must NOT be flagged.
      'ADR-0010-tenth.md': '# ADR-0010: b',
      'ADR-0042.md': 'bare id — malformed',
      'ADR-Bad_Name.md': 'wrong charset — malformed',
    });
    const result = await checkAdrConsistency(repoRoot);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0]).toContain('malformed ADR filename: ADR-0042.md');
    expect(result.violations[1]).toContain('malformed ADR filename: ADR-Bad_Name.md');
  });

  test('flags duplicate identifiers across different slugs (the legacy-number collision)', async () => {
    const repoRoot = await makeRepoWithAdrs({
      'ADR-0026-branch-a.md': '# ADR-0026: a',
      'ADR-0026-branch-b.md': '# ADR-0026: b',
    });
    const result = await checkAdrConsistency(repoRoot);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      'duplicate ADR identifier ADR-0026: ADR-0026-branch-a.md, ADR-0026-branch-b.md',
    ]);
  });

  test('non-md files are ignored; a missing adr dir is clean', async () => {
    const withNonMd = await makeRepoWithAdrs({ 'notes.txt': 'not an ADR' });
    expect((await checkAdrConsistency(withNonMd)).ok).toBe(true);

    const empty = await mkdtemp(join(tmpdir(), 'ditto-adr-check-empty-'));
    expect((await checkAdrConsistency(empty)).ok).toBe(true);
  });
});
