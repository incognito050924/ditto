import { describe, expect, test } from 'bun:test';
import { type AbsorbAcgInput, UnsupportedAcgKindError, absorbAcgIntoIr } from '~/core/memory-ir';
import { type AcgImpactGraph, acgImpactGraph } from '~/schemas/acg-impact-graph';
import {
  type AcgSemanticScanObservation,
  acgSemanticScanObservation,
} from '~/schemas/acg-semantic-scan-observation';
import { memoryEdge, memoryNode } from '~/schemas/memory-graph-ir';

const XRUN = 'xrun_test01';

function sampleImpact(): AcgImpactGraph {
  return acgImpactGraph.parse({
    schema_version: '0.1.0',
    kind: 'acg.impact-graph.v1',
    work_item_id: 'wi_test0001',
    produced_by: 'agent',
    produced_at: '2026-06-09T10:00:00+00:00',
    change_target: 'src/core/foo.ts#bar',
    change_type: 'signature',
    affected_nodes: [
      { kind: 'direct_caller', path: 'src/core/baz.ts', symbol: 'callBar', reason: 'calls bar' },
      { kind: 'type_contract', path: 'src/schemas/x.ts', symbol: 'XType' },
      { kind: 'user_journey', journey_id: 'jrn_checkout', reason: 'touches checkout' },
    ],
    unresolved: [
      { kind: 'cross_repo', path: 'pkg/other', reason: 'lives in another repo' },
      { kind: 'journey_unknown', path: 'src/ui/page.tsx', reason: 'flow not mapped' },
    ],
  });
}

function sampleSemantic(): AcgSemanticScanObservation {
  return acgSemanticScanObservation.parse({
    schema_version: '0.1.0',
    kind: 'acg.semantic-scan-observation.v1',
    work_item_id: 'wi_test0001',
    produced_by: 'agent',
    produced_at: '2026-06-09T10:00:00+00:00',
    base_used: 'abc123',
    language: 'typescript',
    source_root: 'src',
    fingerprint: 'fp_deadbeef',
    change_count: 1,
    changes: [{ file: 'src/core/foo.ts', symbol: 'bar', before: '(a)=>x', after: '(a,b)=>x' }],
  });
}

describe('absorbAcgIntoIr', () => {
  test('output validates against the frozen memory-graph-ir schema', () => {
    const { nodes, edges } = absorbAcgIntoIr(
      {
        impact: sampleImpact(),
        boundaryEdges: [{ from: 'src/core/baz.ts', to: 'src/core/foo.ts' }],
        semantic: sampleSemantic(),
      },
      XRUN,
    );
    for (const n of nodes) expect(memoryNode.safeParse(n).success).toBe(true);
    for (const e of edges) expect(memoryEdge.safeParse(e).success).toBe(true);
  });

  test('determinism: same source -> same canonical content (run meta excluded)', () => {
    const input: AbsorbAcgInput = {
      impact: sampleImpact(),
      boundaryEdges: [
        { from: 'src/core/baz.ts', to: 'src/core/foo.ts' },
        { from: 'src/a.ts', to: 'src/b.ts' },
      ],
      semantic: sampleSemantic(),
    };
    const a = absorbAcgIntoIr(input, XRUN);
    const b = absorbAcgIntoIr(input, XRUN);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    // canonical content (ids + non-provenance fields) is independent of xrunId
    const strip = (r: ReturnType<typeof absorbAcgIntoIr>) =>
      JSON.stringify({
        nodes: r.nodes.map(({ provenance, ...rest }) => rest),
        edges: r.edges.map(({ provenance, ...rest }) => rest),
      });
    const withOtherRun = absorbAcgIntoIr(input, 'xrun_other99');
    expect(strip(a)).toBe(strip(withOtherRun));
  });

  test('output is sorted by id', () => {
    const { nodes, edges } = absorbAcgIntoIr({ impact: sampleImpact() }, XRUN);
    const nodeIds = nodes.map((n) => n.id);
    const edgeIds = edges.map((e) => e.id);
    expect(nodeIds).toEqual([...nodeIds].sort());
    expect(edgeIds).toEqual([...edgeIds].sort());
  });

  test('impact affected -> Symbol + RELATED_TO with EXTRACTED=1.0 provenance', () => {
    const { nodes, edges } = absorbAcgIntoIr({ impact: sampleImpact() }, XRUN);
    const sym = nodes.find((n) => n.id === 'symbol:src/core/baz#callBar');
    expect(sym?.node_type).toBe('Symbol');
    expect(sym?.properties.acg_kind).toBe('direct_caller');
    expect(sym?.properties.reason).toBe('calls bar');
    expect(sym?.provenance?.extraction_run_id).toBe(XRUN);
    expect(sym?.provenance?.extracted_by).toBe('impact');

    const edge = edges.find((e) => e.from === 'symbol:src/core/baz#callBar');
    expect(edge?.edge_type).toBe('RELATED_TO');
    expect(edge?.confidence_kind).toBe('EXTRACTED');
    expect(edge?.confidence_score).toBe(1);
  });

  test('journey affected node uses journey_id (no path)', () => {
    const { nodes } = absorbAcgIntoIr({ impact: sampleImpact() }, XRUN);
    const journey = nodes.find((n) => n.id === 'symbol:journey:jrn_checkout#jrn_checkout');
    expect(journey?.node_type).toBe('Symbol');
    expect(journey?.properties.acg_kind).toBe('user_journey');
  });

  test('unresolved -> Artifact + AMBIGUOUS=0.1 + requires_review with kind/reason preserved', () => {
    const { nodes, edges } = absorbAcgIntoIr({ impact: sampleImpact() }, XRUN);
    const art = nodes.find((n) => n.id === 'artifact:pkg/other');
    expect(art?.node_type).toBe('Artifact');
    expect(art?.properties.acg_unresolved_kind).toBe('cross_repo');
    expect(art?.properties.reason).toBe('lives in another repo');

    const edge = edges.find((e) => e.from === 'artifact:pkg/other');
    expect(edge?.confidence_kind).toBe('AMBIGUOUS');
    expect(edge?.confidence_score).toBe(0.1);
    expect(edge?.requires_review).toBe(true);
  });

  test('boundary DependencyEdge -> Artifact x2 + IMPORTS, codeql EXTRACTED=1.0', () => {
    const { nodes, edges } = absorbAcgIntoIr(
      { boundaryEdges: [{ from: 'src/a.ts', to: 'src/b.ts' }] },
      XRUN,
    );
    expect(nodes.map((n) => n.id).sort()).toEqual(['artifact:src/a', 'artifact:src/b']);
    const imp = edges.find((e) => e.edge_type === 'IMPORTS');
    expect(imp?.from).toBe('artifact:src/a');
    expect(imp?.to).toBe('artifact:src/b');
    expect(imp?.confidence_kind).toBe('EXTRACTED');
    expect(imp?.provenance.extracted_by).toBe('codeql');
  });

  test('semantic change -> Symbol before/after, source_revision=base_used', () => {
    const { nodes } = absorbAcgIntoIr({ semantic: sampleSemantic() }, XRUN);
    const sym = nodes.find((n) => n.id === 'symbol:src/core/foo#bar');
    expect(sym?.properties.before).toBe('(a)=>x');
    expect(sym?.properties.after).toBe('(a,b)=>x');
    expect(sym?.source_revision).toBe('abc123');
    expect(sym?.provenance?.extracted_by).toBe('codeql');
  });

  test('unsupported affected kind is a loud fail (no silent drop)', () => {
    const bad = {
      ...sampleImpact(),
      affected_nodes: [{ kind: 'mystery_kind', path: 'src/x.ts', handled: false }],
    } as unknown as AcgImpactGraph;
    expect(() => absorbAcgIntoIr({ impact: bad }, XRUN)).toThrow(UnsupportedAcgKindError);
  });
});
