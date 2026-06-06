import { describe, expect, test } from 'bun:test';
import {
  buildInitialNodes,
  fileOverlapGate,
  kindToOwner,
  nodeTransition,
  proposalsToNodes,
  selectReadyNodes,
  validateNodeAddition,
} from '~/core/autopilot-graph';
import type { AutopilotNode } from '~/schemas/autopilot';

describe('kindToOwner ([VERIFY] lifecycle owners wired: security · refactor · retro)', () => {
  test('the newly-wired [VERIFY] kinds map to their dedicated owners', () => {
    expect(kindToOwner('security')).toBe('security-reviewer');
    expect(kindToOwner('refactor')).toBe('refactorer');
    expect(kindToOwner('retro')).toBe('retrospective');
  });

  test('the pre-existing kind→owner mappings are unchanged', () => {
    expect(kindToOwner('design')).toBe('planner');
    expect(kindToOwner('implement')).toBe('implementer');
    expect(kindToOwner('review')).toBe('reviewer');
  });
});

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

  test('B3: seed verify is held while an appended implement node is still pending', () => {
    const seed = buildInitialNodes(['ac-1']);
    const passed = seed.map((n) =>
      n.id === 'N1' || n.id === 'N2' ? ({ ...n, status: 'passed' } as AutopilotNode) : n,
    );
    // Append-only planner splices a further implement node; its depends_on cannot
    // reference the already-frozen seed verify, so without the guard both N3 and
    // G1 would go ready in the same wave.
    const g1: AutopilotNode = {
      id: 'G1',
      kind: 'implement',
      owner: 'implementer',
      purpose: 'planner-appended implement',
      status: 'pending',
      depends_on: ['N1'],
      acceptance_refs: ['ac-1'],
      evidence_refs: [],
      attempts: { fix: 0, switch: 0 },
    };
    const nodes = [...passed, g1];

    // N3 (seed verify) is held while G1 implement is non-terminal.
    expect(selectReadyNodes(nodes).map((n) => n.id)).toEqual(['G1']);

    // Once G1 passes the implement frontier clears and N3 becomes ready.
    const after = nodes.map((n) =>
      n.id === 'G1' ? ({ ...n, status: 'passed' } as AutopilotNode) : n,
    );
    expect(selectReadyNodes(after).map((n) => n.id)).toEqual(['N3']);
  });

  test('B3 no-op: pure seed makes N3 ready once N2 passes (single implement, terminal)', () => {
    const seed = buildInitialNodes(['ac-1']);
    const nodes = seed.map((n) =>
      n.id === 'N1' || n.id === 'N2' ? ({ ...n, status: 'passed' } as AutopilotNode) : n,
    );
    expect(selectReadyNodes(nodes).map((n) => n.id)).toEqual(['N3']);
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

describe('validateNodeAddition (A-1: integrity gate for node-add)', () => {
  const node = (id: string, depends_on: string[] = []): AutopilotNode => ({
    id,
    kind: 'implement',
    owner: 'implementer',
    purpose: 'p',
    status: 'pending',
    depends_on,
    acceptance_refs: [],
    evidence_refs: [],
    attempts: { fix: 0, switch: 0 },
  });

  test('accepts a valid forward-only addition', () => {
    const existing = buildInitialNodes(['ac-1']);
    expect(() => validateNodeAddition(existing, [node('N4', ['N3'])])).not.toThrow();
  });

  test('rejects a duplicate id against the existing graph', () => {
    const existing = buildInitialNodes(['ac-1']);
    expect(() => validateNodeAddition(existing, [node('N1')])).toThrow(/duplicate node id/);
  });

  test('rejects a duplicate id within the batch', () => {
    const existing = buildInitialNodes(['ac-1']);
    expect(() => validateNodeAddition(existing, [node('N4'), node('N4')])).toThrow(
      /duplicate node id/,
    );
  });

  test('rejects a dangling depends_on', () => {
    const existing = buildInitialNodes(['ac-1']);
    expect(() => validateNodeAddition(existing, [node('N4', ['Nx'])])).toThrow(
      /dangling depends_on/,
    );
  });

  test('rejects a cycle-introducing addition', () => {
    const existing = buildInitialNodes(['ac-1']);
    // N4 depends on N5, N5 depends on N4 → cycle within the batch.
    expect(() => validateNodeAddition(existing, [node('N4', ['N5']), node('N5', ['N4'])])).toThrow(
      /cycle/,
    );
  });

  // dialectic P2: scope-grow caught at node-introduction time, not only at Stop.
  const refNode = (id: string, refs: string[]): AutopilotNode => ({
    ...node(id, ['N3']),
    acceptance_refs: refs,
  });

  test('with an allowed AC id set: a node referencing only known criteria passes', () => {
    const existing = buildInitialNodes(['ac-1', 'ac-2']);
    const allowed = new Set(['ac-1', 'ac-2']);
    expect(() => validateNodeAddition(existing, [refNode('N4', ['ac-1'])], allowed)).not.toThrow();
  });

  test('with an allowed AC id set: a node inventing an AC ref is rejected at introduction', () => {
    const existing = buildInitialNodes(['ac-1', 'ac-2']);
    const allowed = new Set(['ac-1', 'ac-2']);
    expect(() => validateNodeAddition(existing, [refNode('N4', ['ac-9'])], allowed)).toThrow(
      /acceptance_ref not in intent/,
    );
  });

  test('without an allowed AC id set: invented refs are NOT checked (legacy/no-intent path)', () => {
    const existing = buildInitialNodes(['ac-1']);
    expect(() => validateNodeAddition(existing, [refNode('N4', ['ac-9'])])).not.toThrow();
  });
});

describe('proposalsToNodes (A-3: intent-level proposal → full node)', () => {
  test('fills owner (kindToOwner), status, attempts and evidence from a proposal', () => {
    const nodes = proposalsToNodes([
      {
        id: 'G1',
        kind: 'review',
        purpose: 're-review',
        depends_on: ['N1'],
        acceptance_refs: ['ac-1'],
      },
    ]);
    expect(nodes).toHaveLength(1);
    const n = nodes[0];
    expect(n?.owner).toBe('reviewer'); // derived, not supplied
    expect(n?.status).toBe('pending');
    expect(n?.attempts).toEqual({ fix: 0, switch: 0 });
    expect(n?.evidence_refs).toEqual([]);
    expect(n?.depends_on).toEqual(['N1']);
    expect(n?.acceptance_refs).toEqual(['ac-1']);
    expect(n?.agent_hint).toBeUndefined(); // absent on the proposal → absent on the node
  });

  test('carries an optional agent_hint from the proposal onto the promoted node', () => {
    const nodes = proposalsToNodes([
      {
        id: 'G2',
        kind: 'implement',
        purpose: 'specialized impl',
        depends_on: [],
        acceptance_refs: ['ac-2'],
        agent_hint: 'sql-implementer',
      },
    ]);
    expect(nodes[0]?.agent_hint).toBe('sql-implementer');
  });

  test('carries an optional file_scope from the proposal onto the promoted node (B2 ac-2)', () => {
    const nodes = proposalsToNodes([
      {
        id: 'G3',
        kind: 'implement',
        purpose: 'scoped impl',
        depends_on: [],
        acceptance_refs: ['ac-2'],
        file_scope: ['src/a.ts'],
      },
    ]);
    expect(nodes[0]?.file_scope).toEqual(['src/a.ts']);
    // absent on the proposal → absent on the node
    const bare = proposalsToNodes([
      { id: 'G4', kind: 'review', purpose: 'r', depends_on: [], acceptance_refs: ['ac-1'] },
    ]);
    expect(bare[0]?.file_scope).toBeUndefined();
  });
});

describe('nodeTransition (G3: explicit transition table, not implicit rules)', () => {
  test('legal lifecycle transitions follow the table', () => {
    expect(nodeTransition('pending', 'dispatch')).toBe('running');
    expect(nodeTransition('running', 'pass')).toBe('passed');
    expect(nodeTransition('running', 'fail')).toBe('failed');
    expect(nodeTransition('running', 'block')).toBe('blocked');
    expect(nodeTransition('failed', 'dispatch')).toBe('running'); // retry re-dispatches
    expect(nodeTransition('blocked', 'dispatch')).toBe('running'); // unblocked
  });

  test('rollback returns an in-flight node to pending (undo speculative dispatch)', () => {
    expect(nodeTransition('running', 'rollback')).toBe('pending');
    expect(nodeTransition('failed', 'rollback')).toBe('pending');
  });

  test('retry re-arms a running node to pending (retryable failure, not terminal)', () => {
    // A retryable/switch failure re-arms the node so selectReadyNodes (pending-only)
    // re-picks it on the next round. Terminal failure (cap exceeded) uses `fail`.
    expect(nodeTransition('running', 'retry')).toBe('pending');
  });

  test('illegal transitions throw (fail loud, not a silent no-op)', () => {
    expect(() => nodeTransition('passed', 'fail')).toThrow();
    expect(() => nodeTransition('pending', 'pass')).toThrow();
    expect(() => nodeTransition('passed', 'rollback')).toThrow();
  });
});
