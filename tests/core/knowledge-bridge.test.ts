import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  knowledgeProjectionDrift,
  knowledgeSummarySha256,
  loadKnowledgeSources,
  renderKnowledgeSummary,
  syncKnowledgeProjection,
} from '~/core/knowledge-bridge';
import { knowledgeRecord } from '~/schemas/knowledge-record';

const REPO = join(import.meta.dir, '..', '..');

const MANAGED_BLOCK_COUNT_RE = /<!--\s*ditto:managed:start[\s\S]*?<!--\s*ditto:managed:end\s*-->/g;

// Stage a tmp repo with a real copy of .ditto/knowledge so projection writes
// never dirty the actual repo.
async function stageRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ditto-knowledge-'));
  await cp(join(REPO, '.ditto', 'knowledge'), join(dir, '.ditto', 'knowledge'), {
    recursive: true,
  });
  return dir;
}

describe('knowledge projection (M6)', () => {
  test('builds a summary from the real .ditto/knowledge with paths + headlines', async () => {
    const sources = await loadKnowledgeSources(REPO);
    const summary = renderKnowledgeSummary(sources);
    // paths referenced (bodies stay as path refs)
    expect(summary).toContain('.ditto/knowledge/CONTEXT.md');
    expect(summary).toContain('.ditto/knowledge/glossary.json');
    expect(summary).toContain('.ditto/knowledge/adr/');
    // real glossary term + real ADR headline present
    expect(summary).toContain('work item');
    expect(summary).toMatch(/ADR-0001/);
    expect(sources.adrHeadlines.length).toBeGreaterThanOrEqual(3);
    expect(sources.termHeadlines.length).toBeGreaterThan(0);
  });

  test('write then re-check → drift 0 (sha256 current)', async () => {
    const dir = await stageRepo();
    try {
      const created = await syncKnowledgeProjection(dir);
      expect(created.action).toBe('created');
      // recompute sha256 against the written block
      const claude = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
      const sources = await loadKnowledgeSources(dir);
      expect(claude).toContain(knowledgeSummarySha256(renderKnowledgeSummary(sources)));
      expect(await knowledgeProjectionDrift(dir)).toBe(0);
      // idempotent
      const again = await syncKnowledgeProjection(dir, { check: true });
      expect(again.action).toBe('would-be-unchanged');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('knowledge block appends below an existing ditto:managed block, leaving it single + unchanged', async () => {
    const dir = await stageRepo();
    try {
      // simulate the real CLAUDE.md: exactly one ditto:managed block
      const fakeSha = 'a'.repeat(64);
      const marker = `source=AGENTS.md sha256=${fakeSha}`;
      const managed = `<!-- ditto:managed:start ${marker} -->\nshared instruction\n<!-- ditto:managed:end -->\n`;
      await writeFile(join(dir, 'CLAUDE.md'), managed, 'utf8');
      const result = await syncKnowledgeProjection(dir);
      expect(result.action).toBe('updated');
      const next = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
      // regression: still exactly one ditto:managed block, unchanged body
      expect((next.match(MANAGED_BLOCK_COUNT_RE) ?? []).length).toBe(1);
      expect(next).toContain(marker);
      expect(next).toContain('shared instruction');
      // and a separate knowledge block was added
      expect(next).toContain('ditto:knowledge:start');
      expect(next).toContain('ditto:knowledge:end');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('REGRESSION: real repo CLAUDE.md still has exactly one ditto:managed block (AGENTS.md)', () => {
    const claude = readFileSync(join(REPO, 'CLAUDE.md'), 'utf8');
    const blocks = claude.match(MANAGED_BLOCK_COUNT_RE) ?? [];
    expect(blocks.length).toBe(1);
    expect(blocks[0]).toContain('source=AGENTS.md');
  });
});

describe('knowledgeRecord runtime invariants (ac-4, ac-5)', () => {
  // ac-5: a curator-shaped record produced by the knowledge flow parses with 0 errors.
  const curatorRecord = () => ({
    schema_version: '0.1.0',
    project_name: 'ditto',
    updated_at: '2026-06-01T00:00:00.000Z',
    decisions: [
      {
        id: 'ADR-0004',
        title: 'knowledge projection uses a separate marker family',
        status: 'accepted',
        rationale:
          'CLAUDE.md hard-refuses a second ditto:managed block; a separate ditto:knowledge block keeps the AGENTS.md projection single.',
        change_condition: 'instruction-bridge가 다중 managed block을 허용하도록 바뀌면 재검토',
        path: '.ditto/knowledge/adr/ADR-0004-knowledge-projection.md',
      },
    ],
    patterns: [
      { name: 'separate-marker-family', summary: '다른 marker로 isomorphic projection 분리' },
    ],
    learnings: [
      {
        summary: 'projection은 FORM+DRIFT만 코드로 강제, 용어 합의 판단은 curator가 한다',
        evidence: [{ kind: 'note', summary: 'N1 design U2' }],
        learned_at: '2026-06-01T00:00:00.000Z',
      },
    ],
    projected_to_claude_md: true,
  });

  test('curator-shaped record parses (0 errors) and projects', () => {
    const r = knowledgeRecord.parse(curatorRecord());
    expect(r.projected_to_claude_md).toBe(true);
    expect(r.decisions[0]?.id).toBe('ADR-0004');
  });

  test('ADR cross-field at runtime: status=superseded without superseded_by rejects', () => {
    const bad = curatorRecord();
    bad.decisions[0].status = 'superseded';
    expect(knowledgeRecord.safeParse(bad).success).toBe(false);
  });
});
