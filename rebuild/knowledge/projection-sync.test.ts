import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { knowledgeProjectionDrift, syncKnowledgeProjection } from './projection-sync';

async function makeRepo(opts: { adrs?: Record<string, string> } = {}): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'ditto-knowledge-sync-'));
  await mkdir(join(repoRoot, '.ditto', 'knowledge', 'adr'), { recursive: true });
  for (const [name, body] of Object.entries(opts.adrs ?? {})) {
    await writeFile(join(repoRoot, '.ditto', 'knowledge', 'adr', name), body, 'utf8');
  }
  return repoRoot;
}

const START_RE = /<!-- ditto:knowledge:start sha256=[a-f0-9]{64} -->/;

describe('syncKnowledgeProjection — idempotent CLAUDE.md block sync', () => {
  test('creates CLAUDE.md with the marker block when the file is missing', async () => {
    const repoRoot = await makeRepo();
    const result = await syncKnowledgeProjection(repoRoot);
    expect(result.action).toBe('created');
    expect(result.oldSha256).toBeNull();
    const content = await readFile(join(repoRoot, 'CLAUDE.md'), 'utf8');
    expect(content).toMatch(START_RE);
    expect(content).toContain('<!-- ditto:knowledge:end -->');
    expect(content).toContain('# DITTO Knowledge (projected — do not edit by hand)');
  });

  test('appends the block below existing content without touching it', async () => {
    const repoRoot = await makeRepo();
    await writeFile(join(repoRoot, 'CLAUDE.md'), '# My project\n\nhand-written notes\n', 'utf8');
    const result = await syncKnowledgeProjection(repoRoot);
    expect(result.action).toBe('updated');
    const content = await readFile(join(repoRoot, 'CLAUDE.md'), 'utf8');
    expect(content.startsWith('# My project\n\nhand-written notes\n')).toBe(true);
    expect(content).toMatch(START_RE);
  });

  test('re-running with unchanged sources is a no-op; changed sources replace the block in place', async () => {
    const repoRoot = await makeRepo({
      adrs: { 'ADR-0001-stack.md': '# ADR-0001: 스택\n\n- 상태: accepted\n' },
    });
    const first = await syncKnowledgeProjection(repoRoot);
    expect(first.action).toBe('created');

    const second = await syncKnowledgeProjection(repoRoot);
    expect(second.action).toBe('unchanged');
    expect(second.oldSha256).toBe(first.newSha256);

    // Source change → block replaced in place, surrounding content preserved.
    await writeFile(
      join(repoRoot, 'CLAUDE.md'),
      `above\n\n${await readFile(join(repoRoot, 'CLAUDE.md'), 'utf8')}below\n`,
      'utf8',
    );
    await writeFile(
      join(repoRoot, '.ditto', 'knowledge', 'adr', 'ADR-0002-second.md'),
      '# ADR-0002: 둘째\n\n- 상태: accepted\n',
      'utf8',
    );
    const third = await syncKnowledgeProjection(repoRoot);
    expect(third.action).toBe('updated');
    expect(third.newSha256).not.toBe(first.newSha256);
    const content = await readFile(join(repoRoot, 'CLAUDE.md'), 'utf8');
    expect(content.startsWith('above\n')).toBe(true);
    expect(content.endsWith('below\n')).toBe(true);
    expect(content).toContain('ADR-0002 · accepted · 둘째');
    expect(content.match(/ditto:knowledge:start/g)).toHaveLength(1);
  });

  test('refuses to touch a file carrying more than one knowledge block', async () => {
    const repoRoot = await makeRepo();
    await syncKnowledgeProjection(repoRoot);
    const once = await readFile(join(repoRoot, 'CLAUDE.md'), 'utf8');
    await writeFile(join(repoRoot, 'CLAUDE.md'), `${once}\n${once}`, 'utf8');
    const result = await syncKnowledgeProjection(repoRoot);
    expect(result.action).toBe('refused-multiple-markers');
    expect(await readFile(join(repoRoot, 'CLAUDE.md'), 'utf8')).toBe(`${once}\n${once}`);
  });

  test('check mode is a dry-run: reports would-* actions and never writes', async () => {
    const repoRoot = await makeRepo();
    const wouldCreate = await syncKnowledgeProjection(repoRoot, { check: true });
    expect(wouldCreate.action).toBe('would-create');
    await expect(readFile(join(repoRoot, 'CLAUDE.md'), 'utf8')).rejects.toThrow();

    await syncKnowledgeProjection(repoRoot);
    expect((await syncKnowledgeProjection(repoRoot, { check: true })).action).toBe(
      'would-be-unchanged',
    );
  });

  test('knowledgeProjectionDrift is 0 only when the projection is current', async () => {
    const repoRoot = await makeRepo();
    expect(await knowledgeProjectionDrift(repoRoot)).toBe(1);
    await syncKnowledgeProjection(repoRoot);
    expect(await knowledgeProjectionDrift(repoRoot)).toBe(0);
    await writeFile(
      join(repoRoot, '.ditto', 'knowledge', 'adr', 'ADR-0003-new.md'),
      '# ADR-0003: 신규\n\n- 상태: accepted\n',
      'utf8',
    );
    expect(await knowledgeProjectionDrift(repoRoot)).toBe(1);
  });
});
