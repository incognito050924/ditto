import { describe, expect, test } from 'bun:test';
import { renderMermaid } from '~/acg/change-map';
import { acgChangeContract } from '~/schemas/acg-change-contract';
import { acgImpactGraph } from '~/schemas/acg-impact-graph';
import { acgReviewGraph } from '~/schemas/acg-review-graph';

const contract = (overrides: Record<string, unknown> = {}) =>
  acgChangeContract.parse({
    schema_version: '0.1.0',
    kind: 'acg.change-contract.v1',
    work_item_id: 'wi_retry0001',
    produced_by: 'agent',
    produced_at: '2026-06-05T00:00:00Z',
    purpose: 'retry policy',
    allowed_scope: [{ kind: 'glob', ref: 'src/runtime/**' }],
    forbidden_scope: [
      { kind: 'glob', ref: 'kafka-adapter/**' },
      { kind: 'public_surface', ref: 'api/external' },
    ],
    invariants: [],
    acceptance: [{ criterion: 'retries bounded', evidence_kind: 'test' }],
    risk_default: 'medium',
    decision_ref: 'adr/ADR-0007',
    ...overrides,
  });

const impact = (overrides: Record<string, unknown> = {}) =>
  acgImpactGraph.parse({
    schema_version: '0.1.0',
    kind: 'acg.impact-graph.v1',
    work_item_id: 'wi_retry0001',
    produced_by: 'agent',
    produced_at: '2026-06-05T00:00:00Z',
    change_target: 'src/runtime/retry.ts: retry (behavior)',
    change_type: 'behavior',
    affected_nodes: [{ kind: 'direct_caller', path: 'src/runtime/handler.ts', handled: false }],
    unresolved: [{ kind: 'cross_repo', path: 'libs/x.jar', reason: 'sibling module' }],
    ...overrides,
  });

describe('renderMermaid — 50-change-map §3 파생 다이어그램', () => {
  test('mermaid 코드펜스 + graph LR + 위험색 중심노드', () => {
    const out = renderMermaid(contract());
    expect(out.startsWith('```mermaid\n')).toBe(true);
    expect(out.trimEnd().endsWith('```')).toBe(true);
    expect(out).toContain('graph LR');
    expect(out).toContain('C["◆ wi_retry0001<br/>medium"]:::medium');
    expect(out).toContain('classDef medium');
  });

  test('forbidden_scope → 점선 ✕ forbid 엣지 + forbid 스타일', () => {
    const out = renderMermaid(contract());
    expect(out).toContain('C -.->|✕ forbid| F0["kafka-adapter/**"]:::forbid');
    expect(out).toContain('F1["api/external"]:::forbid');
    expect(out).toContain('classDef forbid');
  });

  test('impact affected → 실선 + kind+증거뱃지, unresolved → 점선 ⚠', () => {
    const review = acgReviewGraph.parse({
      schema_version: '0.1.0',
      kind: 'acg.review-graph.v1',
      work_item_id: 'wi_retry0001',
      files: [
        {
          path: 'src/runtime/handler.ts',
          role: 'service_logic',
          risk: 'low',
          risk_reason: 'covered by test',
          evidence: { kind: 'test' },
        },
      ],
      human_review_set: [],
    });
    const out = renderMermaid(contract(), impact(), review);
    expect(out).toContain('C -->|direct_caller ☑| A0["src/runtime/handler.ts"]');
    expect(out).toContain('C -.->|⚠ unresolved| U0["cross_repo: libs/x.jar"]:::unresolved');
  });

  test('위험은 ReviewGraph 최고위험을 따른다(high)', () => {
    const review = acgReviewGraph.parse({
      schema_version: '0.1.0',
      kind: 'acg.review-graph.v1',
      work_item_id: 'wi_retry0001',
      files: [
        {
          path: 'src/x.ts',
          role: 'service_logic',
          risk: 'high',
          risk_reason: 'unresolved high risk',
          unresolved: true,
        },
      ],
      human_review_set: ['src/x.ts'],
    });
    const out = renderMermaid(contract(), undefined, review);
    expect(out).toContain('<br/>high"]:::high');
    expect(out).toContain('classDef high');
  });

  test('라벨 특수문자(따옴표/개행) 안전 처리', () => {
    const out = renderMermaid(
      contract({ work_item_id: 'wi_quote0001' }),
      impact({
        affected_nodes: [{ kind: 'doc', path: 'say "hi"\nthere', handled: false }],
        unresolved: [],
      }),
    );
    expect(out).toContain('A0["say \'hi\' there"]');
    expect(out).not.toContain('"hi"');
  });
});
