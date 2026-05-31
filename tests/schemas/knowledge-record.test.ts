import { describe, expect, test } from 'bun:test';
import { knowledgeRecord } from '~/schemas/knowledge-record';

// A record modeled on the real .ditto/knowledge/ contents (CONTEXT.md, glossary.json,
// adr/ADR-0001..0003). The glossary body is referenced by path, not embedded.
const realistic = () => ({
  schema_version: '0.1.0',
  project_name: 'ditto',
  updated_at: '2026-06-01T00:00:00.000Z',
  decisions: [
    {
      id: 'ADR-0001',
      title: '런타임 및 구현 스택',
      status: 'accepted',
      rationale: 'single binary 배포 + 빠른 startup + schema DX → TypeScript + Bun',
      change_condition: 'Bun 생태계 단절 또는 startup 회귀 시 재검토',
      path: '.ditto/knowledge/adr/ADR-0001-runtime-stack.md',
    },
  ],
});

describe('knowledgeRecord schema', () => {
  test('realistic record (glossary referenced by path) parses; paths default', () => {
    const r = knowledgeRecord.parse(realistic());
    expect(r.context_path).toBe('.ditto/knowledge/CONTEXT.md');
    expect(r.glossary_path).toBe('.ditto/knowledge/glossary.json');
    expect(r.project_map_path).toBe(null);
    expect(r.projected_to_claude_md).toBe(false);
    expect(r.decisions[0]?.superseded_by).toBe(null);
  });

  test('ADR id must be ADR-NNNN', () => {
    const bad = realistic();
    bad.decisions[0].id = 'adr-1';
    expect(knowledgeRecord.safeParse(bad).success).toBe(false);
  });

  test('cross-field: status=superseded requires superseded_by', () => {
    const bad = realistic();
    bad.decisions[0].status = 'superseded';
    expect(knowledgeRecord.safeParse(bad).success).toBe(false);

    const ok = realistic();
    ok.decisions[0].status = 'superseded';
    // @ts-expect-error augmenting the fixture for the passing case
    ok.decisions[0].superseded_by = 'ADR-0009';
    expect(knowledgeRecord.safeParse(ok).success).toBe(true);
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
