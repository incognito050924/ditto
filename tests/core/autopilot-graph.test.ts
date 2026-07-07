import { describe, expect, test } from 'bun:test';
import {
  buildInitialNodes,
  computeDownstream,
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

  // wi_260610p9h g5: e2e-author is owned by the main-session pseudo-owner — the
  // driver runs the authoring skill inline (user dialogue), never spawns.
  test('e2e-author maps to the main-session pseudo-owner', () => {
    expect(kindToOwner('e2e-author')).toBe('main-session');
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

  test('BUG1: a verify an in-flight implement depends on is exempt from the frontier hold (no deadlock)', () => {
    // N7 (design) passed. N9 (verify) is ready (its dep N7 passed). N10 (implement)
    // depends on N9 — so N9 is a PRECONDITION of N10, not a post-condition. The
    // implement-frontier guard would hold N9 (verify) while N10 (implement) is
    // non-terminal; but N10 waits on N9 → deadlock (nothing dispatchable). N9 must
    // stay selectable so it can pass and unblock N10.
    const nodes: AutopilotNode[] = [
      {
        id: 'N7',
        kind: 'design',
        owner: 'planner',
        purpose: 'design',
        status: 'passed',
        depends_on: [],
        acceptance_refs: ['ac-1'],
        evidence_refs: [],
        attempts: { fix: 0, switch: 0 },
      },
      {
        id: 'N9',
        kind: 'verify',
        owner: 'verifier',
        purpose: 'verify a precondition',
        status: 'pending',
        depends_on: ['N7'],
        acceptance_refs: ['ac-1'],
        evidence_refs: [],
        attempts: { fix: 0, switch: 0 },
      },
      {
        id: 'N10',
        kind: 'implement',
        owner: 'implementer',
        purpose: 'implement after the precondition holds',
        status: 'pending',
        depends_on: ['N9'],
        acceptance_refs: ['ac-1'],
        evidence_refs: [],
        attempts: { fix: 0, switch: 0 },
      },
    ];
    expect(selectReadyNodes(nodes).map((n) => n.id)).toEqual(['N9']);
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

  // wi_260624fe0 (ac-1/ac-2, narrowed): `file_scope` is dual-meaning — on a
  // read-only node it is a READ/focus signal (and drives variant routing), not a
  // write claim. `nodeProposal` carries no write-intent field, so no structured
  // signal at splice time distinguishes read-focus from write-intent. The earlier
  // guard that rejected any read-only owner + non-empty file_scope was over-broad
  // (it broke the legitimate read-focus / variant-routing pattern); the rule
  // "mutating work goes to a mutating owner" is now carried by planner guidance.
  // So a read-only owner WITH a file_scope must splice clean.
  const ownedNode = (
    id: string,
    kind: AutopilotNode['kind'],
    owner: AutopilotNode['owner'],
    file_scope?: string[],
  ): AutopilotNode => ({
    ...node(id, ['N3']),
    kind,
    owner,
    ...(file_scope !== undefined ? { file_scope } : {}),
  });

  test('accepts a read-only owner (verify) carrying a non-empty file_scope (read-focus / variant routing)', () => {
    const existing = buildInitialNodes(['ac-1']);
    expect(() =>
      validateNodeAddition(existing, [ownedNode('N4', 'verify', 'verifier', ['src/core/x.ts'])]),
    ).not.toThrow();
  });

  test('accepts a read-only owner (research) carrying a non-empty file_scope (read-focus)', () => {
    const existing = buildInitialNodes(['ac-1']);
    expect(() =>
      validateNodeAddition(existing, [
        ownedNode('N4', 'research', 'researcher', ['src/core/x.ts']),
      ]),
    ).not.toThrow();
  });

  test('accepts a mutating owner (implement) carrying a non-empty file_scope', () => {
    const existing = buildInitialNodes(['ac-1']);
    expect(() =>
      validateNodeAddition(existing, [
        ownedNode('N4', 'implement', 'implementer', ['tests/x.test.ts']),
      ]),
    ).not.toThrow();
  });

  test('accepts a read-only owner (verify) with no file_scope (normal verify node)', () => {
    const existing = buildInitialNodes(['ac-1']);
    expect(() =>
      validateNodeAddition(existing, [ownedNode('N4', 'verify', 'verifier')]),
    ).not.toThrow();
  });

  test('accepts a read-only owner (verify) with an empty file_scope', () => {
    const existing = buildInitialNodes(['ac-1']);
    expect(() =>
      validateNodeAddition(existing, [ownedNode('N4', 'verify', 'verifier', [])]),
    ).not.toThrow();
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

describe('computeDownstream (ac-5: transitive DEPENDENTS of a fork node — reverse reachability)', () => {
  const mk = (id: string, depends_on: string[]): AutopilotNode => ({
    id,
    kind: 'implement',
    owner: 'implementer',
    purpose: 'p',
    status: 'pending',
    depends_on,
    acceptance_refs: ['ac-1'],
    evidence_refs: [],
    attempts: { fix: 0, switch: 0 },
  });

  test('linear chain: every node after the fork is downstream (in input order)', () => {
    const nodes = buildInitialNodes(['ac-1']); // N1 -> N2 -> N3
    expect(computeDownstream(nodes, 'N1')).toEqual(['N2', 'N3']);
    expect(computeDownstream(nodes, 'N2')).toEqual(['N3']);
  });

  test('a leaf fork (no dependents) has an empty downstream set', () => {
    const nodes = buildInitialNodes(['ac-1']);
    expect(computeDownstream(nodes, 'N3')).toEqual([]);
  });

  test('the fork node itself is never in its own downstream set', () => {
    const nodes = buildInitialNodes(['ac-1']);
    expect(computeDownstream(nodes, 'N1')).not.toContain('N1');
  });

  test('a sibling branch that does NOT depend on the fork is excluded', () => {
    // N1 -> N2 -> N3 ; N4 depends only on N1 (sibling of N2). Fork=N2.
    const nodes = [mk('N1', []), mk('N2', ['N1']), mk('N3', ['N2']), mk('N4', ['N1'])];
    expect(computeDownstream(nodes, 'N2')).toEqual(['N3']); // N4 not downstream of N2
    expect(computeDownstream(nodes, 'N1')).toEqual(['N2', 'N3', 'N4']); // all depend on N1
  });

  test('diamond: a join node reachable via two paths is listed once', () => {
    // N1 -> {N2, N3} -> N4 (join). Fork=N1 → all three; Fork=N2 → only the join N4.
    const nodes = [mk('N1', []), mk('N2', ['N1']), mk('N3', ['N1']), mk('N4', ['N2', 'N3'])];
    expect(computeDownstream(nodes, 'N1')).toEqual(['N2', 'N3', 'N4']);
    expect(computeDownstream(nodes, 'N2')).toEqual(['N4']);
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
