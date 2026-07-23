import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAdrSkeleton } from './adr-authoring';

async function makeRepoRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ditto-adr-authoring-'));
}

describe('createAdrSkeleton — adr-new, the creation half of the identifier policy', () => {
  test('creates ADR-YYYYMMDD-<slug>.md whose filename stem is the immutable id', async () => {
    const repoRoot = await makeRepoRoot();
    const result = await createAdrSkeleton({
      repoRoot,
      slug: 'my-decision',
      now: new Date('2026-07-24T12:00:00Z'),
    });
    expect(result.id).toBe('ADR-20260724-my-decision');
    expect(result.path).toBe(
      join(repoRoot, '.ditto', 'knowledge', 'adr', 'ADR-20260724-my-decision.md'),
    );
    const body = await readFile(result.path, 'utf8');
    expect(body).toContain('# ADR-20260724-my-decision: <제목>');
    expect(body).toContain('- 상태: proposed');
    expect(body).toContain('- 결정 일자: 2026-07-24');
    expect(body).toContain('## 컨텍스트');
    expect(body).toContain('## 결정');
    expect(body).toContain('## 근거 (rationale)');
    expect(body).toContain('## 변경 조건 (change_condition)');
  });

  test('uses the UTC date for the id — no local-timezone drift', async () => {
    const repoRoot = await makeRepoRoot();
    // 23:30Z is already the next day in +09:00; the id must stay on the UTC day.
    const result = await createAdrSkeleton({
      repoRoot,
      slug: 'utc-day',
      now: new Date('2026-07-24T23:30:00Z'),
    });
    expect(result.id).toBe('ADR-20260724-utc-day');
  });

  test('rejects an invalid slug before writing anything (fail-closed)', async () => {
    const repoRoot = await makeRepoRoot();
    await expect(
      createAdrSkeleton({ repoRoot, slug: 'Bad_Slug', now: new Date('2026-07-24T12:00:00Z') }),
    ).rejects.toThrow('invalid');
    // Nothing was written — not even the adr directory.
    await expect(stat(join(repoRoot, '.ditto', 'knowledge', 'adr'))).rejects.toThrow();
  });

  test('refuses to overwrite an existing ADR — a same-day same-slug collision surfaces', async () => {
    const repoRoot = await makeRepoRoot();
    const now = new Date('2026-07-24T12:00:00Z');
    await createAdrSkeleton({ repoRoot, slug: 'collide', now });
    await expect(createAdrSkeleton({ repoRoot, slug: 'collide', now })).rejects.toThrow(
      'refusing to overwrite',
    );
  });
});
