import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadKnowledgeSources, renderKnowledgeSummary } from './projection';

async function makeRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ditto-knowledge-projection-'));
}

async function writeKnowledge(
  repoRoot: string,
  opts: { glossary?: unknown; adrs?: Record<string, string> } = {},
): Promise<void> {
  const dir = join(repoRoot, '.ditto', 'knowledge');
  await mkdir(join(dir, 'adr'), { recursive: true });
  if (opts.glossary !== undefined) {
    await writeFile(join(dir, 'glossary.json'), JSON.stringify(opts.glossary), 'utf8');
  }
  for (const [name, body] of Object.entries(opts.adrs ?? {})) {
    await writeFile(join(dir, 'adr', name), body, 'utf8');
  }
}

describe('loadKnowledgeSources — headline summarization of .ditto/knowledge', () => {
  test('collects sorted term headlines, marking non-agreed statuses', async () => {
    const repoRoot = await makeRepo();
    await writeKnowledge(repoRoot, {
      glossary: {
        entries: [
          { term: 'oracle', status: 'agreed' },
          { term: 'autopilot' },
          { term: 'stem', status: 'proposed' },
        ],
      },
    });
    const sources = await loadKnowledgeSources(repoRoot);
    expect(sources.termHeadlines).toEqual(['autopilot', 'oracle', 'stem (proposed)']);
  });

  test('collects sorted ADR headlines as `id · status-first-token · title-without-id-prefix`', async () => {
    const repoRoot = await makeRepo();
    await writeKnowledge(repoRoot, {
      adrs: {
        'ADR-0013-memory.md':
          '# ADR-0013: 메모리 서브시스템 설계\n\n- 상태: accepted (합의됨)\n',
        'ADR-20260624-adr-identifier-policy.md':
          '# ADR-20260624-adr-identifier-policy: ADR 식별자 정책\n\n- 상태: accepted\n',
      },
    });
    const sources = await loadKnowledgeSources(repoRoot);
    expect(sources.adrHeadlines).toEqual([
      'ADR-0013 · accepted · 메모리 서브시스템 설계',
      'ADR-20260624-adr-identifier-policy · accepted · ADR 식별자 정책',
    ]);
  });

  test('missing knowledge dir / glossary / malformed glossary JSON degrade to empty headlines', async () => {
    const bare = await makeRepo();
    const sources = await loadKnowledgeSources(bare);
    expect(sources.termHeadlines).toEqual([]);
    expect(sources.adrHeadlines).toEqual([]);

    const malformed = await makeRepo();
    await writeKnowledge(malformed, { adrs: {} });
    await writeFile(join(malformed, '.ditto', 'knowledge', 'glossary.json'), '{not json', 'utf8');
    expect((await loadKnowledgeSources(malformed)).termHeadlines).toEqual([]);
  });

  test('source paths are repo-relative references to the knowledge bodies', async () => {
    const repoRoot = await makeRepo();
    const sources = await loadKnowledgeSources(repoRoot);
    expect(sources.contextPath).toBe(join('.ditto', 'knowledge', 'CONTEXT.md'));
    expect(sources.glossaryPath).toBe(join('.ditto', 'knowledge', 'glossary.json'));
    expect(sources.adrDir).toBe(join('.ditto', 'knowledge', 'adr'));
  });
});

describe('renderKnowledgeSummary — the projected block body', () => {
  test('renders header, body-path references, and both sections in order', async () => {
    const repoRoot = await makeRepo();
    await writeKnowledge(repoRoot, {
      glossary: { entries: [{ term: 'oracle' }] },
      adrs: { 'ADR-0001-stack.md': '# ADR-0001: 스택\n\n- 상태: accepted\n' },
    });
    const summary = renderKnowledgeSummary(await loadKnowledgeSources(repoRoot));
    const lines = summary.split('\n');
    expect(lines[0]).toBe('# DITTO Knowledge (projected — do not edit by hand)');
    expect(summary).toContain(
      'Durable project knowledge. Bodies live under `.ditto/knowledge/`; this is a summary.',
    );
    expect(summary).toContain(`- context: \`${join('.ditto', 'knowledge', 'CONTEXT.md')}\``);
    expect(summary).toContain(`- glossary: \`${join('.ditto', 'knowledge', 'glossary.json')}\``);
    expect(summary).toContain(`- decisions: \`${join('.ditto', 'knowledge', 'adr')}/\``);
    expect(summary).toContain('## Glossary terms\n- oracle');
    expect(summary).toContain('## Architecture decisions\n- ADR-0001 · accepted · 스택');
  });

  test('renders `- (none)` for empty sections', async () => {
    const repoRoot = await makeRepo();
    const summary = renderKnowledgeSummary(await loadKnowledgeSources(repoRoot));
    expect(summary).toContain('## Glossary terms\n- (none)');
    expect(summary).toContain('## Architecture decisions\n- (none)');
  });
});
