import { describe, expect, test } from 'bun:test';
import { assembleCompletionFromGraph, deriveAcVerdicts } from '~/core/autopilot-complete';
import { type Autopilot, type AutopilotNode, autopilot } from '~/schemas/autopilot';
import type { WorkItem } from '~/schemas/work-item';

const NOW = new Date('2026-06-02T00:00:00.000Z');

const node = (over: Partial<AutopilotNode> & Pick<AutopilotNode, 'id'>): AutopilotNode => ({
  kind: 'verify',
  owner: 'verifier',
  purpose: 'verify',
  status: 'passed',
  depends_on: [],
  acceptance_refs: [],
  evidence_refs: [],
  ac_verdicts: [],
  attempts: { fix: 0, switch: 0 },
  ...over,
});

const graphWith = (nodes: AutopilotNode[]): Autopilot =>
  autopilot.parse({
    schema_version: '0.1.0',
    autopilot_id: 'orch_completetest',
    work_item_id: 'wi_completetest',
    root_goal: 'goal',
    approval_gate: { status: 'not_required', source: 'small_reversible_policy' },
    nodes,
    caps: { fix_per_node: 2, switch_per_node: 1, converge_rounds: 3 },
    continue_policy: {},
    stop_conditions: [],
  });

const workItemWith = (acIds: string[]): WorkItem =>
  ({
    id: 'wi_completetest',
    changed_files: ['src/x.ts'],
    goal: 'the goal',
    acceptance_criteria: acIds.map((id) => ({
      id,
      statement: `${id} is met`,
      verdict: 'unverified',
      evidence: [],
    })),
  }) as unknown as WorkItem;

const ev = (path: string) => ({ kind: 'file' as const, path, summary: `evidence ${path}` });

describe('deriveAcVerdicts (evidence-gated: pass only with evidence; never auto-pass a claim)', () => {
  test('a passed addressing node WITH evidence → pass, carrying that evidence', () => {
    const graph = graphWith([
      node({ id: 'N3', acceptance_refs: ['ac-1'], status: 'passed', evidence_refs: [ev('t.log')] }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('pass');
    expect(v?.evidence).toEqual([ev('t.log')]);
  });

  test('a passed addressing node WITHOUT evidence → unverified (claim ≠ proof, not pass)', () => {
    const graph = graphWith([
      node({ id: 'N3', acceptance_refs: ['ac-1'], status: 'passed', evidence_refs: [] }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('unverified');
  });

  test('a failed addressing node → fail', () => {
    const graph = graphWith([
      node({ id: 'N3', acceptance_refs: ['ac-1'], status: 'failed', evidence_refs: [ev('t.log')] }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('fail');
  });

  test('no node addresses the criterion → unverified', () => {
    const graph = graphWith([
      node({ id: 'N3', acceptance_refs: ['ac-2'], evidence_refs: [ev('t')] }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('unverified');
  });

  test('evidence is the union across all addressing nodes', () => {
    const graph = graphWith([
      node({ id: 'N2', acceptance_refs: ['ac-1'], status: 'passed', evidence_refs: [ev('a')] }),
      node({ id: 'N3', acceptance_refs: ['ac-1'], status: 'passed', evidence_refs: [ev('b')] }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('pass');
    expect(v?.evidence).toEqual([ev('a'), ev('b')]);
  });

  // False-green repro (wi_260606e43 N3): the verifier judged ac-3 PARTIAL, but the
  // node passed *as a node* (its verification ran, evidence present) addressing all
  // three ACs. The node-level pass must NOT absorb the per-AC partial.
  test('a per-AC partial verdict overrides a node-level pass (no false-green; claim ≠ proof)', () => {
    const graph = graphWith([
      node({
        id: 'N3',
        acceptance_refs: ['ac-1', 'ac-2', 'ac-3'],
        status: 'passed',
        evidence_refs: [ev('verify.log')],
        ac_verdicts: [{ criterion_id: 'ac-3', verdict: 'partial' }],
      }),
    ]);
    const [a1, a2, a3] = deriveAcVerdicts(graph, ['ac-1', 'ac-2', 'ac-3']);
    expect(a1?.verdict).toBe('pass');
    expect(a2?.verdict).toBe('pass');
    expect(a3?.verdict).toBe('partial'); // not pass — the verifier judged it partial
  });

  test('a per-AC fail verdict overrides a node-level pass', () => {
    const graph = graphWith([
      node({
        id: 'N3',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        evidence_refs: [ev('verify.log')],
        ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'fail' }],
      }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('fail');
  });

  // The fold only ever LOWERS: an explicit pass cannot upgrade an evidence-less
  // structural unverified (the evidence gate still holds; claim ≠ proof).
  test('an explicit pass cannot raise a verdict above the evidence-gated structural floor', () => {
    const graph = graphWith([
      node({
        id: 'N3',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        evidence_refs: [],
        ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'pass' }],
      }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('unverified');
  });

  // find→fix→reverify convergence (ac-2): an earlier verify recorded ac-1 fail,
  // a fix node passed, and a LATER re-verify that depends on that fix recorded
  // ac-1 pass. The later fix-backed re-verify supersedes the earlier fail.
  test('a fix-backed re-verify supersedes an earlier fail for the same AC → pass', () => {
    const graph = graphWith([
      node({ id: 'N3', kind: 'verify', acceptance_refs: ['ac-1'], status: 'failed' }),
      node({ id: 'N4', kind: 'fix', owner: 'implementer', status: 'passed', depends_on: ['N3'] }),
      node({
        id: 'N5',
        kind: 'verify',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        depends_on: ['N4'],
        evidence_refs: [ev('reverify.log')],
      }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('pass');
  });

  // ac-2 via a per-AC verdict: the same AC failed on an early node (ac_verdict fail)
  // then re-passed on a later fix-backed re-verify.
  test('supersession also works when the earlier fail is a per-AC verdict', () => {
    const graph = graphWith([
      node({
        id: 'N3',
        kind: 'verify',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        evidence_refs: [ev('v1.log')],
        ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'fail' }],
      }),
      node({ id: 'N4', kind: 'fix', owner: 'implementer', status: 'passed', depends_on: ['N3'] }),
      node({
        id: 'N5',
        kind: 'verify',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        depends_on: ['N4'],
        evidence_refs: [ev('reverify.log')],
      }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('pass');
  });

  // find→fix→reverify convergence for a PARTIAL (symmetry with fail): an earlier
  // verify recorded ac-1 partial, a fix passed, and a LATER re-verify behind that
  // fix recorded ac-1 pass. The pre-fix partial snapshot is superseded like a fail.
  test('a fix-backed re-verify supersedes an earlier partial for the same AC → pass', () => {
    const graph = graphWith([
      node({
        id: 'N3',
        kind: 'verify',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        evidence_refs: [ev('v1.log')],
        ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'partial' }],
      }),
      node({ id: 'N4', kind: 'fix', owner: 'implementer', status: 'passed', depends_on: ['N3'] }),
      node({
        id: 'N5',
        kind: 'verify',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        depends_on: ['N4'],
        evidence_refs: [ev('reverify.log')],
      }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('pass');
  });

  // guard: an UNFIXED partial (no later passing re-verify behind a fix) must still
  // report partial — supersession must NOT mask an unresolved partial.
  test('an unfixed partial (no fix-backed re-verify) still reports partial (no false-green)', () => {
    const graph = graphWith([
      node({
        id: 'N3',
        kind: 'verify',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        evidence_refs: [ev('v1.log')],
        ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'partial' }],
      }),
      // A later re-verify PASSES but does NOT depend on any fix node → cannot supersede.
      node({
        id: 'N5',
        kind: 'verify',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        evidence_refs: [ev('reverify.log')],
      }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('partial');
  });

  // ac-3 guard: an UNFIXED fail (no later passing re-verify behind a fix) must
  // still report fail — supersession must NOT mask a real failure.
  test('an unfixed fail (no fix-backed re-verify) still reports fail (no false-green)', () => {
    const graph = graphWith([
      node({ id: 'N3', kind: 'verify', acceptance_refs: ['ac-1'], status: 'failed' }),
      // A later re-verify PASSES but does NOT depend on any fix node → cannot supersede.
      node({
        id: 'N5',
        kind: 'verify',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        evidence_refs: [ev('reverify.log')],
      }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('fail');
  });

  // ac-3 guard variant: a fix node exists but is NOT passed → its re-verify cannot
  // supersede (the fix did not land).
  test('a re-verify behind an unpassed fix cannot supersede a fail', () => {
    const graph = graphWith([
      node({ id: 'N3', kind: 'verify', acceptance_refs: ['ac-1'], status: 'failed' }),
      node({ id: 'N4', kind: 'fix', owner: 'implementer', status: 'failed', depends_on: ['N3'] }),
      node({
        id: 'N5',
        kind: 'verify',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        depends_on: ['N4'],
        evidence_refs: [ev('reverify.log')],
      }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('fail');
  });

  // gotcha #3 / wi_260610idf: an IMPLEMENTATION node's evidence-less pass is a
  // structural unverified — not a judgment. When a DOWNSTREAM addressing node
  // (one that transitively depends on it) passed the same AC with evidence, the
  // verification covered the implementation, so the structural unverified must
  // not drag the AC down. This is the defect that forced wi_2606104bd to empty
  // implement nodes' acceptance_refs by hand.
  describe('downstream verified pass supersedes upstream structural unverified (gotcha #3)', () => {
    const implNode = (id: string, over: Partial<AutopilotNode> = {}) =>
      node({
        id,
        kind: 'implement',
        owner: 'implementer',
        status: 'passed',
        acceptance_refs: ['ac-1'],
        evidence_refs: [],
        ...over,
      });
    const verifierNode = (id: string, deps: string[], over: Partial<AutopilotNode> = {}) =>
      node({
        id,
        kind: 'verify',
        owner: 'verifier',
        status: 'passed',
        acceptance_refs: ['ac-1'],
        depends_on: deps,
        evidence_refs: [ev('verify.log')],
        ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'pass' }],
        ...over,
      });

    test('REPRO: evidence-less implement + downstream verified pass → pass (was unverified)', () => {
      const graph = graphWith([implNode('N1'), verifierNode('N7', ['N1'])]);
      const [v] = deriveAcVerdicts(graph, ['ac-1']);
      expect(v?.verdict).toBe('pass');
    });

    test('transitive dependency counts (verifier behind a chain of implements)', () => {
      const graph = graphWith([
        implNode('N1'),
        implNode('N2', { depends_on: ['N1'] }),
        verifierNode('N7', ['N2']),
      ]);
      const [v] = deriveAcVerdicts(graph, ['ac-1']);
      expect(v?.verdict).toBe('pass');
    });

    test('a pass that is NOT downstream of the implement cannot supersede (ordering matters)', () => {
      // The verifier ran in parallel / before — its evidence does not cover N1's change.
      const graph = graphWith([implNode('N1'), verifierNode('N7', [])]);
      const [v] = deriveAcVerdicts(graph, ['ac-1']);
      expect(v?.verdict).toBe('unverified');
    });

    test('an explicit per-AC non-pass on the implement node is a judgment and sticks', () => {
      const graph = graphWith([
        implNode('N1', {
          evidence_refs: [ev('impl.log')],
          ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'partial' }],
        }),
        verifierNode('N7', ['N1']),
      ]);
      const [v] = deriveAcVerdicts(graph, ['ac-1']);
      expect(v?.verdict).toBe('partial');
    });

    test('a NON-TERMINAL implement node sticks at unverified (work unfinished)', () => {
      const graph = graphWith([implNode('N1', { status: 'running' }), verifierNode('N7', ['N1'])]);
      const [v] = deriveAcVerdicts(graph, ['ac-1']);
      expect(v?.verdict).toBe('unverified');
    });

    test('a FAILED implement node still fails the AC (only fix-backed re-verify supersedes a fail)', () => {
      const graph = graphWith([implNode('N1', { status: 'failed' }), verifierNode('N7', ['N1'])]);
      const [v] = deriveAcVerdicts(graph, ['ac-1']);
      expect(v?.verdict).toBe('fail');
    });

    test("a node's own per-AC pass still cannot upgrade its own evidence-less unverified", () => {
      const graph = graphWith([
        implNode('N1', { ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'pass' }] }),
      ]);
      const [v] = deriveAcVerdicts(graph, ['ac-1']);
      expect(v?.verdict).toBe('unverified');
    });

    test('wi_2606104bd shape: implement fan + one verifier over all ACs → final_verdict=pass', () => {
      const acs = ['ac-1', 'ac-2', 'ac-3'];
      const graph = graphWith([
        implNode('N1', { acceptance_refs: ['ac-1'] }),
        implNode('N2', { acceptance_refs: ['ac-2'], depends_on: ['N1'] }),
        implNode('N3', { acceptance_refs: ['ac-3'], depends_on: ['N1'] }),
        verifierNode('N7', ['N2', 'N3'], {
          acceptance_refs: acs,
          ac_verdicts: acs.map((id) => ({ criterion_id: id, verdict: 'pass' as const })),
        }),
      ]);
      const c = assembleCompletionFromGraph(graph, workItemWith(acs), { now: NOW });
      expect(c.acceptance.map((a) => a.verdict)).toEqual(['pass', 'pass', 'pass']);
      expect(c.final_verdict).toBe('pass');
    });

    // BUG2 (wi_2606144ta): the seed `design`/planner node carries ALL ACs and
    // passes without evidence → a STRUCTURAL unverified for every AC. A
    // planner-emitted subgraph whose root does NOT depend on the generator would
    // otherwise leave that structural unverified unsuperseded → every AC folds to
    // unverified even though dedicated nodes verified each one. A `design`
    // generator is upstream of all real work by definition, so its structural
    // unverified is superseded by ANY addressing node that verified the AC — no
    // dependency edge required (unlike an implement node, below).
    describe('design generator structural-unverified is superseded without a dep edge (BUG2)', () => {
      const designSeed = (over: Partial<AutopilotNode> = {}) =>
        node({
          id: 'N1',
          kind: 'design',
          owner: 'planner',
          status: 'passed',
          acceptance_refs: ['ac-1'],
          evidence_refs: [],
          ...over,
        });

      test('REPRO: design generator + detached verified pass (no dep edge) → pass (was unverified)', () => {
        const graph = graphWith([
          designSeed(),
          // planner-emitted verify; its depends_on does NOT reference the generator.
          verifierNode('N4', []),
        ]);
        const [v] = deriveAcVerdicts(graph, ['ac-1']);
        expect(v?.verdict).toBe('pass');
      });

      test('design generator is the ONLY addressing node (no evidence anywhere) → unverified (no false-green)', () => {
        const graph = graphWith([designSeed()]);
        const [v] = deriveAcVerdicts(graph, ['ac-1']);
        expect(v?.verdict).toBe('unverified');
      });

      test('an IMPLEMENT node still needs a DOWNSTREAM pass to supersede (non-generator unchanged)', () => {
        // Same detached shape but the evidence-less node is `implement`, not
        // `design` — the ordering requirement (dependsOnNode) still applies.
        const graph = graphWith([implNode('N1'), verifierNode('N4', [])]);
        const [v] = deriveAcVerdicts(graph, ['ac-1']);
        expect(v?.verdict).toBe('unverified');
      });
    });
  });

  // wi_260622kb4 / ac-2: a judging node can attach evidence on the matching
  // ac_verdict entry (per-AC evidence_refs) instead of mirroring it at top-level.
  // The completion bridge must accept that per-AC evidence as proof for closing the
  // AC — exactly like the AC-closing guard (autopilot-dispatch) already does —
  // otherwise a node carrying ONLY per-AC evidence reads as "0 evidence → unverified".
  describe('per-AC evidence_refs close an AC (wi_260622kb4)', () => {
    test('a passed node with ONLY per-AC evidence_refs (no top-level) → pass, carrying that evidence', () => {
      const graph = graphWith([
        node({
          id: 'N3',
          acceptance_refs: ['ac-1'],
          status: 'passed',
          evidence_refs: [],
          ac_verdicts: [
            { criterion_id: 'ac-1', verdict: 'pass', evidence_refs: [ev('per-ac.log')] },
          ],
        }),
      ]);
      const [v] = deriveAcVerdicts(graph, ['ac-1']);
      expect(v?.verdict).toBe('pass');
      expect(v?.evidence).toEqual([ev('per-ac.log')]);
    });

    test('top-level evidence still closes the AC (the existing path is preserved)', () => {
      const graph = graphWith([
        node({
          id: 'N3',
          acceptance_refs: ['ac-1'],
          status: 'passed',
          evidence_refs: [ev('top.log')],
        }),
      ]);
      const [v] = deriveAcVerdicts(graph, ['ac-1']);
      expect(v?.verdict).toBe('pass');
      expect(v?.evidence).toEqual([ev('top.log')]);
    });

    test('neither top-level NOR per-AC evidence on a passed node → unverified (claim ≠ proof)', () => {
      const graph = graphWith([
        node({
          id: 'N3',
          acceptance_refs: ['ac-1'],
          status: 'passed',
          evidence_refs: [],
          // a per-AC pass verdict WITHOUT evidence is still just a claim
          ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'pass' }],
        }),
      ]);
      const [v] = deriveAcVerdicts(graph, ['ac-1']);
      expect(v?.verdict).toBe('unverified');
    });

    test('a per-AC FAIL verdict still folds to fail even when it carries evidence', () => {
      const graph = graphWith([
        node({
          id: 'N3',
          acceptance_refs: ['ac-1'],
          status: 'passed',
          evidence_refs: [],
          ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'fail', evidence_refs: [ev('fail.log')] }],
        }),
      ]);
      const [v] = deriveAcVerdicts(graph, ['ac-1']);
      expect(v?.verdict).toBe('fail');
    });

    test('per-AC evidence is unioned into the derived verdict evidence alongside top-level', () => {
      const graph = graphWith([
        node({
          id: 'N3',
          acceptance_refs: ['ac-1'],
          status: 'passed',
          evidence_refs: [ev('top.log')],
          ac_verdicts: [
            { criterion_id: 'ac-1', verdict: 'pass', evidence_refs: [ev('per-ac.log')] },
          ],
        }),
      ]);
      const [v] = deriveAcVerdicts(graph, ['ac-1']);
      expect(v?.verdict).toBe('pass');
      expect(v?.evidence).toEqual([ev('top.log'), ev('per-ac.log')]);
    });

    test('per-AC evidence for a DIFFERENT criterion does not close this AC', () => {
      const graph = graphWith([
        node({
          id: 'N3',
          acceptance_refs: ['ac-1'],
          status: 'passed',
          evidence_refs: [],
          ac_verdicts: [
            { criterion_id: 'ac-2', verdict: 'pass', evidence_refs: [ev('other.log')] },
          ],
        }),
      ]);
      const [v] = deriveAcVerdicts(graph, ['ac-1']);
      expect(v?.verdict).toBe('unverified'); // no evidence for ac-1
    });
  });

  // A per-AC verdict for an AC the node does not address is ignored (it is not an
  // addressing node for that criterion).
  test('a per-AC verdict on a non-addressed criterion is ignored', () => {
    const graph = graphWith([
      node({
        id: 'N3',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        evidence_refs: [ev('t.log')],
        ac_verdicts: [{ criterion_id: 'ac-2', verdict: 'fail' }],
      }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('pass'); // ac-2's fail does not touch ac-1
  });
});

describe('assembleCompletionFromGraph (deterministic completion from the graph; final_verdict derived)', () => {
  test('all ACs covered by passed nodes with evidence → final_verdict=pass', () => {
    const graph = graphWith([
      node({
        id: 'N3',
        acceptance_refs: ['ac-1', 'ac-2'],
        status: 'passed',
        evidence_refs: [ev('t.log')],
      }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1', 'ac-2']), { now: NOW });
    expect(c.final_verdict).toBe('pass');
    expect(c.declared_by).toBe('verifier');
    expect(c.acceptance.map((a) => a.verdict)).toEqual(['pass', 'pass']);
    expect(c.changed_files).toEqual(['src/x.ts']); // from the work item
  });

  test('a per-AC partial keeps final_verdict off pass even when the node passed with evidence (false-green fix)', () => {
    const graph = graphWith([
      node({
        id: 'N3',
        acceptance_refs: ['ac-1', 'ac-2', 'ac-3'],
        status: 'passed',
        evidence_refs: [ev('t.log')],
        ac_verdicts: [{ criterion_id: 'ac-3', verdict: 'partial' }],
      }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1', 'ac-2', 'ac-3']), {
      now: NOW,
    });
    expect(c.final_verdict).toBe('partial');
    expect(c.acceptance.find((a) => a.criterion_id === 'ac-3')?.verdict).toBe('partial');
  });

  test('an AC passed without evidence keeps final_verdict off pass (evidence-gated)', () => {
    const graph = graphWith([
      node({ id: 'N3', acceptance_refs: ['ac-1'], status: 'passed', evidence_refs: [ev('t')] }),
      node({ id: 'N4', acceptance_refs: ['ac-2'], status: 'passed', evidence_refs: [] }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1', 'ac-2']), { now: NOW });
    expect(c.final_verdict).not.toBe('pass'); // ac-2 unverified
  });

  test('a non-terminal node is surfaced as a remaining risk naming the node ids', () => {
    const graph = graphWith([
      node({ id: 'N3', acceptance_refs: ['ac-1'], status: 'passed', evidence_refs: [ev('t')] }),
      node({ id: 'N4', acceptance_refs: ['ac-1'], status: 'blocked', evidence_refs: [] }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), { now: NOW });
    const risk = c.remaining_risks.find((r) => r.includes('non-terminal graph nodes'));
    expect(risk).toBeDefined();
    expect(risk).toContain('N4');
    expect(risk).not.toContain('N3'); // terminal nodes are not listed
  });

  test('caller-supplied remaining risks are preserved alongside the non-terminal entry', () => {
    const graph = graphWith([node({ id: 'N4', status: 'pending', evidence_refs: [] })]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), {
      now: NOW,
      remainingRisks: ['caller risk'],
    });
    expect(c.remaining_risks).toContain('caller risk');
    expect(c.remaining_risks.some((r) => r.includes('non-terminal graph nodes'))).toBe(true);
  });

  test('a graph where every node is terminal has no non-terminal-node entry', () => {
    const graph = graphWith([
      node({ id: 'N3', acceptance_refs: ['ac-1'], status: 'passed', evidence_refs: [ev('t')] }),
      node({ id: 'N4', acceptance_refs: ['ac-1'], status: 'failed', evidence_refs: [ev('f')] }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), { now: NOW });
    expect(c.remaining_risks.some((r) => r.includes('non-terminal graph nodes'))).toBe(false);
  });

  test('a default summary is derived when none is supplied', () => {
    const graph = graphWith([
      node({ id: 'N3', acceptance_refs: ['ac-1'], evidence_refs: [ev('t')] }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), { now: NOW });
    expect(c.summary.length).toBeGreaterThan(0);
  });
});
