import { describe, expect, test } from 'bun:test';
import { buildInitialNodes, fileOverlapGate, selectReadyNodes } from '~/core/autopilot-graph';

describe('selectReadyNodes (the candidate concurrent wave)', () => {
  test('returns every pending node whose deps have passed', () => {
    const nodes = buildInitialNodes(['ac-1']);
    // only N1 (design) is ready at the start; N2/N3 depend on it.
    expect(selectReadyNodes(nodes).map((n) => n.id)).toEqual(['N1']);
  });

  test('two independent ready nodes are both in the wave', () => {
    const nodes = buildInitialNodes(['ac-1']);
    const first = nodes[0];
    if (!first) throw new Error('expected initial nodes');
    const extra = { ...first, id: 'N1b' };
    expect(selectReadyNodes([...nodes, extra]).map((n) => n.id)).toEqual(['N1', 'N1b']);
  });
});

describe('fileOverlapGate (G5: serialize same-wave nodes that touch the same files)', () => {
  test('overlapping file_scope serializes all but the first claimant', () => {
    const { dispatch, serialized } = fileOverlapGate([
      { id: 'a', file_scope: ['src/x.ts'] },
      { id: 'b', file_scope: ['src/x.ts', 'src/y.ts'] },
    ]);
    expect(dispatch.map((n) => n.id)).toEqual(['a']);
    expect(serialized.map((n) => n.id)).toEqual(['b']);
  });

  test('disjoint file_scope runs concurrently', () => {
    const { dispatch, serialized } = fileOverlapGate([
      { id: 'a', file_scope: ['src/x.ts'] },
      { id: 'b', file_scope: ['src/y.ts'] },
    ]);
    expect(dispatch.map((n) => n.id)).toEqual(['a', 'b']);
    expect(serialized).toEqual([]);
  });

  test('empty file_scope (read-only node) never blocks and is never blocked', () => {
    const { dispatch, serialized } = fileOverlapGate([
      { id: 'a', file_scope: ['src/x.ts'] },
      { id: 'reviewer', file_scope: [] },
      { id: 'b', file_scope: ['src/x.ts'] },
    ]);
    expect(dispatch.map((n) => n.id)).toEqual(['a', 'reviewer']);
    expect(serialized.map((n) => n.id)).toEqual(['b']);
  });
});
