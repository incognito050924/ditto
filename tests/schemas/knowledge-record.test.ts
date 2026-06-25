import { describe, expect, test } from 'bun:test';
import { knowledgeRecord } from '~/schemas/knowledge-record';

// A record modeled on the real .ditto/knowledge/ contents (CONTEXT.md, glossary.json).
// Architecture decisions live as adr/*.md files (the SoT), not in this record — the
// hand-maintained decisions[] index was retired as drift-prone duplication
// (ADR-20260624 amend, wi_2606247cx). The glossary body is referenced by path, not
// embedded. ADR-id grammar coverage moved to tests/schemas/adr-id.test.ts.
const realistic = () => ({
  schema_version: '0.1.0',
  project_name: 'ditto',
  updated_at: '2026-06-01T00:00:00.000Z',
});

describe('knowledgeRecord schema', () => {
  test('realistic record (glossary referenced by path) parses; paths default', () => {
    const r = knowledgeRecord.parse(realistic());
    expect(r.context_path).toBe('.ditto/knowledge/CONTEXT.md');
    expect(r.glossary_path).toBe('.ditto/knowledge/glossary.json');
    expect(r.project_map_path).toBe(null);
    expect(r.projected_to_claude_md).toBe(false);
  });

  test('learnings carry evidence + learned_at; patterns are optional path', () => {
    const r = knowledgeRecord.parse({
      ...realistic(),
      patterns: [{ name: 'tidy-first', summary: '구조적/동작적 커밋 분리' }],
      learnings: [
        {
          summary: 'conformance test = 문서 적합성',
          evidence: [{ kind: 'note', summary: 'feedback memory' }],
          learned_at: '2026-06-01T00:00:00.000Z',
        },
      ],
    });
    expect(r.patterns[0]?.name).toBe('tidy-first');
    expect(r.learnings[0]?.evidence.length).toBe(1);
  });
});
