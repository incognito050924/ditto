import { describe, expect, test } from 'bun:test';
import {
  type IrFragment,
  assembleSemanticIr,
  chunkSources,
  conceptId,
  findDanglingEdges,
  irFragmentsSchema,
  mergeIrFragments,
  normalizeConceptLabel,
} from '~/core/memory-build';
import { memoryEdge, memoryGraphIr, memoryNode } from '~/schemas/memory-graph-ir';

/** A multi-fragment input exercising fold, dedup, conflict, normalization. */
function goldenFragments(): IrFragment[] {
  return [
    {
      nodes: [
        { node_type: 'Concept', name: 'Memory Graph', source_id: 'src_aaaaaaaaaaaa' },
        {
          node_type: 'Concept',
          name: 'Provenance',
          source_id: 'src_aaaaaaaaaaaa',
          properties: { note: 'where data came from' },
        },
      ],
      edges: [
        {
          from: 'concept:memory graph',
          to: 'concept:provenance',
          edge_type: 'RELATED_TO',
          confidence_kind: 'INFERRED',
          confidence_score: 0.6,
          source_id: 'src_aaaaaaaaaaaa',
        },
      ],
    },
    {
      // duplicate concept with different raw casing/punctuation -> same id
      nodes: [
        { node_type: 'Concept', name: 'memory-graph!', source_id: 'src_bbbbbbbbbbbb' },
        {
          node_type: 'Concept',
          name: 'Provenance',
          source_id: 'src_bbbbbbbbbbbb',
          properties: { extra: 'duplicate' },
        },
      ],
      edges: [
        // same (from,to,edge_type) -> dedup; AMBIGUOUS is more conservative -> wins
        {
          from: 'concept:memory graph',
          to: 'concept:provenance',
          edge_type: 'RELATED_TO',
          confidence_kind: 'AMBIGUOUS',
          confidence_score: 0.2,
          source_id: 'src_bbbbbbbbbbbb',
        },
      ],
    },
  ];
}

describe('normalizeConceptLabel / conceptId', () => {
  test('lowercases, collapses punctuation+whitespace, trims', () => {
    expect(normalizeConceptLabel('  Memory-Graph!! ')).toBe('memory graph');
    expect(normalizeConceptLabel('Foo___Bar')).toBe('foo bar');
    expect(conceptId('Memory  Graph')).toBe('concept:memory graph');
  });
});

describe('mergeIrFragments — golden determinism (ac-4)', () => {
  test('same input -> bit-identical canonical content', () => {
    const a = mergeIrFragments(goldenFragments());
    const b = mergeIrFragments(goldenFragments());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('order-independent: reversed fragment order -> identical canonical content', () => {
    const forward = mergeIrFragments(goldenFragments());
    const reversed = mergeIrFragments([...goldenFragments()].reverse());
    const strip = (r: ReturnType<typeof mergeIrFragments>) =>
      JSON.stringify({
        nodes: r.nodes.map(({ provenance, ...rest }) => rest),
        edges: r.edges.map(({ provenance, ...rest }) => rest),
      });
    expect(strip(reversed)).toBe(strip(forward));
  });

  test('matches the pinned golden snapshot (run meta excluded)', () => {
    const { nodes, edges } = mergeIrFragments(goldenFragments());
    expect(nodes.map((n) => ({ id: n.id, name: n.name, properties: n.properties }))).toEqual([
      {
        id: 'concept:memory graph',
        name: 'Memory Graph',
        properties: {},
      },
      {
        id: 'concept:provenance',
        name: 'Provenance',
        // both fragments' properties union, emitted in sorted-key order
        properties: { extra: 'duplicate', note: 'where data came from' },
      },
    ]);
    expect(
      edges.map((e) => ({
        id: e.id,
        from: e.from,
        to: e.to,
        edge_type: e.edge_type,
        confidence_kind: e.confidence_kind,
        confidence_score: e.confidence_score,
        requires_review: e.requires_review,
      })),
    ).toEqual([
      {
        id: 'edge:concept:memory graph|RELATED_TO|concept:provenance',
        from: 'concept:memory graph',
        to: 'concept:provenance',
        edge_type: 'RELATED_TO',
        // AMBIGUOUS won the conflict (more conservative)
        confidence_kind: 'AMBIGUOUS',
        confidence_score: 0.2,
        requires_review: true,
      },
    ]);
  });
});

describe('mergeIrFragments — fold / dedup / sort / schema', () => {
  test('duplicate concept ids fold to one node', () => {
    const { nodes } = mergeIrFragments(goldenFragments());
    expect(nodes.filter((n) => n.id === 'concept:provenance')).toHaveLength(1);
  });

  test('edge dedup by (from,to,edge_type)', () => {
    const { edges } = mergeIrFragments(goldenFragments());
    expect(edges).toHaveLength(1);
  });

  test('within same kind, max score wins', () => {
    const frags: IrFragment[] = [
      {
        nodes: [],
        edges: [
          {
            from: 'concept:a',
            to: 'concept:b',
            edge_type: 'SIMILAR_TO',
            confidence_kind: 'INFERRED',
            confidence_score: 0.5,
            source_id: 'src_cccccccccccc',
          },
          {
            from: 'concept:a',
            to: 'concept:b',
            edge_type: 'SIMILAR_TO',
            confidence_kind: 'INFERRED',
            confidence_score: 0.9,
            source_id: 'src_dddddddddddd',
          },
        ],
      },
    ];
    const { edges } = mergeIrFragments(frags);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.confidence_score).toBe(0.9);
  });

  test('output is sorted by id', () => {
    const { nodes, edges } = mergeIrFragments(goldenFragments());
    expect(nodes.map((n) => n.id)).toEqual([...nodes.map((n) => n.id)].sort());
    expect(edges.map((e) => e.id)).toEqual([...edges.map((e) => e.id)].sort());
  });

  test('merged nodes/edges validate against the frozen schema', () => {
    const { nodes, edges } = mergeIrFragments(goldenFragments());
    for (const n of nodes) expect(memoryNode.safeParse(n).success).toBe(true);
    for (const e of edges) expect(memoryEdge.safeParse(e).success).toBe(true);
  });

  test('non-concept node keeps its provided id; edges follow concept remap', () => {
    const frags: IrFragment[] = [
      {
        nodes: [
          {
            id: 'symbol:src/x#foo',
            node_type: 'Symbol',
            name: 'foo',
            source_id: 'src_eeeeeeeeeeee',
          },
          { node_type: 'Concept', name: 'Hashing', source_id: 'src_eeeeeeeeeeee' },
        ],
        edges: [
          {
            from: 'symbol:src/x#foo',
            to: 'concept:HASHING',
            edge_type: 'MENTIONS',
            confidence_kind: 'INFERRED',
            confidence_score: 0.7,
            source_id: 'src_eeeeeeeeeeee',
          },
        ],
      },
    ];
    const { nodes, edges } = mergeIrFragments(frags);
    expect(nodes.find((n) => n.id === 'symbol:src/x#foo')).toBeDefined();
    expect(nodes.find((n) => n.id === 'concept:hashing')).toBeDefined();
    // edge.to was 'concept:HASHING' but is remapped to the canonical concept id
    expect(edges[0]?.to).toBe('concept:hashing');
  });
});

describe('assembleSemanticIr', () => {
  test('produces a schema-valid MemoryGraphIr with run metadata layered on', () => {
    const merged = mergeIrFragments(goldenFragments());
    const ir = assembleSemanticIr(merged, {
      ir_version: 'ir_test01',
      generated_at: '2026-06-09T10:00:00.000Z',
      extraction_run_id: 'xrun_test01',
    });
    expect(memoryGraphIr.safeParse(ir).success).toBe(true);
    expect(ir.nodes).toHaveLength(2);
  });

  test('out-of-band confidence is rejected by the schema (no silent clamp)', () => {
    const merged = mergeIrFragments([
      {
        nodes: [],
        edges: [
          {
            from: 'concept:a',
            to: 'concept:b',
            edge_type: 'SIMILAR_TO',
            // INFERRED band is [0.4, 0.95]; 0.99 is out of band
            confidence_kind: 'INFERRED',
            confidence_score: 0.99,
            source_id: 'src_ffffffffffff',
          },
        ],
      },
    ]);
    const ir = assembleSemanticIr(merged, {
      ir_version: 'ir_test01',
      generated_at: '2026-06-09T10:00:00.000Z',
      extraction_run_id: 'xrun_test01',
    });
    expect(memoryGraphIr.safeParse(ir).success).toBe(false);
  });
});

describe('chunkSources', () => {
  test('splits into stable, sorted chunks of the given size', () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      source_id: `src_${String(i).padStart(12, '0')}`,
      path: `f${i}.ts`,
      content: 'x',
    }));
    const chunks = chunkSources(files, 2);
    expect(chunks.map((c) => c.chunk_id)).toEqual(['chunk_0000', 'chunk_0001', 'chunk_0002']);
    expect(chunks[0]?.files).toHaveLength(2);
    expect(chunks[2]?.files).toHaveLength(1);
    // membership independent of input order
    const reversed = chunkSources([...files].reverse(), 2);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(chunks));
  });

  test('excludes sensitivity=secret files from chunks (F6 ac-5)', () => {
    const files = [
      { source_id: 'src_000000000001', path: 'a.ts', content: 'x' },
      { source_id: 'src_000000000002', path: 'b.ts', content: 'y', sensitivity: 'secret' as const },
      { source_id: 'src_000000000003', path: 'c.ts', content: 'z', sensitivity: 'public' as const },
    ];
    const chunks = chunkSources(files, 22);
    const includedIds = chunks.flatMap((c) => c.files.map((f) => f.source_id));
    expect(includedIds).toEqual(['src_000000000001', 'src_000000000003']);
    expect(includedIds).not.toContain('src_000000000002');
  });
});

describe('mergeIrFragments — bare-name endpoint resolution', () => {
  test('resolves a bare display-name endpoint to the node canonical id', () => {
    const frags: IrFragment[] = [
      {
        nodes: [
          { node_type: 'Concept', name: 'Logging Service', source_id: 'src_111111111111' },
          { node_type: 'Concept', name: 'Async Buffer', source_id: 'src_111111111111' },
        ],
        edges: [
          {
            // extractor referenced endpoints by display name, not canonical id
            from: 'Logging Service',
            to: 'Async Buffer',
            edge_type: 'DEPENDS_ON',
            confidence_kind: 'INFERRED',
            confidence_score: 0.8,
            source_id: 'src_111111111111',
          },
        ],
      },
    ];
    const { edges } = mergeIrFragments(frags);
    expect(edges[0]?.from).toBe('concept:logging service');
    expect(edges[0]?.to).toBe('concept:async buffer');
  });

  test('does NOT resolve an ambiguous name shared by two distinct nodes', () => {
    const frags: IrFragment[] = [
      {
        nodes: [
          { id: 'symbol:a#X', node_type: 'Symbol', name: 'X', source_id: 'src_222222222222' },
          { id: 'symbol:b#X', node_type: 'Symbol', name: 'X', source_id: 'src_222222222222' },
        ],
        edges: [
          {
            from: 'X',
            to: 'symbol:a#X',
            edge_type: 'RELATED_TO',
            confidence_kind: 'INFERRED',
            confidence_score: 0.5,
            source_id: 'src_222222222222',
          },
        ],
      },
    ];
    const { edges } = mergeIrFragments(frags);
    // ambiguous 'X' is left unresolved (deterministic), not silently bound to one node
    expect(edges[0]?.from).toBe('X');
  });
});

describe('findDanglingEdges', () => {
  test('reports an edge whose endpoint resolves to no node', () => {
    const frags: IrFragment[] = [
      {
        nodes: [{ node_type: 'Concept', name: 'Real', source_id: 'src_333333333333' }],
        edges: [
          {
            from: 'concept:real',
            to: 'Ghost Node',
            edge_type: 'RELATED_TO',
            confidence_kind: 'INFERRED',
            confidence_score: 0.5,
            source_id: 'src_333333333333',
          },
        ],
      },
    ];
    const { nodes, edges } = mergeIrFragments(frags);
    expect(findDanglingEdges(nodes, edges)).toHaveLength(1);
  });

  test('a clean merged fragment has no dangling edges', () => {
    const { nodes, edges } = mergeIrFragments(goldenFragments());
    expect(findDanglingEdges(nodes, edges)).toEqual([]);
  });
});

describe('irFragmentsSchema', () => {
  test('rejects an EXTRACTED confidence kind from the extractor', () => {
    const bad = [
      {
        nodes: [],
        edges: [
          {
            from: 'a',
            to: 'b',
            edge_type: 'RELATED_TO',
            confidence_kind: 'EXTRACTED',
            confidence_score: 1,
            source_id: 'src_aaaaaaaaaaaa',
          },
        ],
      },
    ];
    expect(irFragmentsSchema.safeParse(bad).success).toBe(false);
  });

  test('accepts a well-formed fragment', () => {
    const ok = [
      {
        nodes: [{ node_type: 'Concept', name: 'X', source_id: 'src_aaaaaaaaaaaa' }],
        edges: [],
      },
    ];
    expect(irFragmentsSchema.safeParse(ok).success).toBe(true);
  });
});
