import { describe, expect, test } from 'bun:test';
import type { AssembleOptions } from '~/core/autopilot-complete';
import {
  assembleCompletionFromGraph,
  attestCompletion,
  deriveAcVerdicts,
  projectAutoHandling,
  projectDirectionDecisions,
} from '~/core/autopilot-complete';
import { type AutopilotDecision, synthesizeDecisionId } from '~/core/autopilot-store';
import { attestAcVerdicts, nonPassTerminationGate } from '~/core/gates';
import { type CaptureResult, phantomRedGate } from '~/core/test-runner';
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
// A command-kind evidence entry — the shape `ditto verify --criterion` records on a
// work-item criterion (verify.ts). This is the "REAL evidence" push-readiness keys on.
const cmdEv = (command: string) => ({ kind: 'command' as const, command, summary: 'exit 0' });

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

  // ac-4 (wi_260710vzu) — the fix-backed drop must be ORDERING-GATED per failed node,
  // not a global "some pass is fix-backed" boolean. These pin down that an EARLIER
  // fix-backed re-verify cannot launder a LATER genuine fail (false-green), while the
  // legitimate downstream convergence still supersedes.
  describe('fix-backed supersession is ordering-gated per failed node (ac-4)', () => {
    // FALSE-GREEN REPRO: N3 fails ac-1, N4 fix + N5 re-verify legitimately supersede it,
    // but N6 discovers a NEW genuine fail AFTER the re-verify (downstream of N5) that NO
    // fix addresses. A global supersedingFix boolean would drop N6's fail too → pass.
    // The AC must stay fail: no fix-backed pass is downstream of N6.
    test('a LATER genuine fail after a fix-backed re-verify is NOT laundered to pass', () => {
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
        // NEW genuine failure discovered AFTER the re-verify — no fix addresses it.
        node({
          id: 'N6',
          kind: 'verify',
          acceptance_refs: ['ac-1'],
          status: 'failed',
          depends_on: ['N5'],
        }),
      ]);
      const [v] = deriveAcVerdicts(graph, ['ac-1']);
      expect(v?.verdict).toBe('fail');
    });

    // The fail→pass wash must not slip the AC past the D1 termination gate: a laundered
    // pass would empty the parked set deriveNonPassStatus reads and let the run claim a
    // clean pass. Assert the completion stays non-pass AND carries the honest declaration.
    test('the un-laundered later fail keeps the completion non-pass and grounds non_pass_status (D1 gate not bypassed)', () => {
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
        node({
          id: 'N6',
          kind: 'verify',
          acceptance_refs: ['ac-1'],
          status: 'failed',
          depends_on: ['N5'],
        }),
      ]);
      const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), { now: NOW });
      expect(c.final_verdict).not.toBe('pass');
      expect(c.non_pass_status).toBeDefined();
      expect(c.non_pass_status?.grounding).toContain('ac-1');
    });

    // ORDERING-OK: a parallel/earlier fix-backed pass that is NOT downstream of the
    // failed node cannot supersede it either — the drop needs V to depend on the fail.
    test('a fix-backed pass NOT downstream of the failed node cannot supersede it', () => {
      const graph = graphWith([
        // N6 fails ac-1 and does not sit behind the N3→N4→N5 convergence chain.
        node({ id: 'N6', kind: 'verify', acceptance_refs: ['ac-1'], status: 'failed' }),
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
      expect(v?.verdict).toBe('fail'); // N6's fail is not downstream of any fix-backed pass
    });

    // ORDERING-OK positive: the legitimate downstream convergence still supersedes — a
    // fix-backed re-verify that DOES transitively depend on the failed node drops it.
    test('a fix-backed re-verify downstream of the failed node still supersedes it → pass', () => {
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

    // wi_2607114zt (wi_260710vzu #23 ac-4 잔여 검증 공백): the ordering gate above requires the
    // fix-backed re-verify `m` to transitively depend on the FAILED node `n` itself
    // (dependsOnNode(m, n)). When a planner wires the fix/reverify chain to the IMPLEMENT node
    // rather than the failed VERIFY node, `m` reaches a passed fix but NOT the failed verify, so
    // the converged AC's earlier fail is NOT superseded — an OVER-STRICT (fail-safe) non-pass, not
    // a false-green. This graph SHAPE — legitimate convergence bypassing the failed verify via the
    // implement node — had no regression test. It is recoverable via a fresh `ditto verify
    // --criterion` (the evidence-backed criterion supersede below), which is what the discovering
    // run actually did. These pin the fail-safe direction AND its escape hatch.
    describe('fix/reverify wired to the implement node (not the failed verify) → over-strict, not false-green (wi_2607114zt)', () => {
      // N1 implement (passed, structural), N2 verify FAILED ac-1, N3 fix depends on N1 (the
      // NON-STANDARD wiring — bypasses N2), N4 re-verify passes ac-1 behind the fix. N4 reaches a
      // passed fix (dependsOnPassedFix) but NOT N2 (dependsOnNode(N4, N2) === false).
      const implWiredGraph = () =>
        graphWith([
          node({ id: 'N1', kind: 'implement', owner: 'implementer', acceptance_refs: ['ac-1'] }),
          node({
            id: 'N2',
            kind: 'verify',
            acceptance_refs: ['ac-1'],
            status: 'passed',
            evidence_refs: [ev('verify.log')],
            ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'fail' }],
          }),
          node({
            id: 'N3',
            kind: 'fix',
            owner: 'implementer',
            status: 'passed',
            depends_on: ['N1'],
          }),
          node({
            id: 'N4',
            kind: 'verify',
            acceptance_refs: ['ac-1'],
            status: 'passed',
            depends_on: ['N3'],
            evidence_refs: [ev('reverify.log')],
          }),
        ]);

      test('implement-wired fix/reverify leaves the AC non-pass (over-strict, fail-safe) and final_verdict≠pass', () => {
        const graph = implWiredGraph();
        const [v] = deriveAcVerdicts(graph, ['ac-1']);
        // N4 is fix-backed and passes, but is NOT downstream of N2 → N2's fail is not superseded.
        expect(v?.verdict).toBe('fail');
        const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), { now: NOW });
        expect(c.final_verdict).not.toBe('pass');
      });

      test('CONTRAST: the SAME chain also wired to the failed verify node (N3 depends on N1+N2) DOES supersede → pass', () => {
        // ONLY the fix's edge set changes: N3 now depends on N1 AND N2 (routing the chain THROUGH
        // the failed verify), so dependsOnNode(N4, N2) === true → the legitimate convergence
        // supersedes N2's fail. (N1 stays reachable too, so its structural unverified is still
        // covered.) Isolates the variable: the over-strictness above is the WIRING that bypasses
        // the failed verify, nothing else in the graph.
        const graph = graphWith([
          node({ id: 'N1', kind: 'implement', owner: 'implementer', acceptance_refs: ['ac-1'] }),
          node({
            id: 'N2',
            kind: 'verify',
            acceptance_refs: ['ac-1'],
            status: 'passed',
            evidence_refs: [ev('verify.log')],
            ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'fail' }],
          }),
          node({
            id: 'N3',
            kind: 'fix',
            owner: 'implementer',
            status: 'passed',
            depends_on: ['N1', 'N2'],
          }),
          node({
            id: 'N4',
            kind: 'verify',
            acceptance_refs: ['ac-1'],
            status: 'passed',
            depends_on: ['N3'],
            evidence_refs: [ev('reverify.log')],
          }),
        ]);
        const [v] = deriveAcVerdicts(graph, ['ac-1']);
        expect(v?.verdict).toBe('pass');
      });

      test('recovery: a fresh evidence-backed criterion pass (ditto verify --criterion) supersedes the over-strict non-pass → pass', () => {
        const graph = implWiredGraph();
        // The sanctioned manual recovery: `ditto verify --criterion` records a command-kind
        // evidence-backed criterion pass, strictly fresher than the graph, which supersedes the
        // stale node fail (false-green guard intact: only command-kind evidence qualifies).
        const criteria = new Map([
          ['ac-1', { verdict: 'pass' as const, evidence: [cmdEv('bun test')] }],
        ]);
        const [v] = deriveAcVerdicts(graph, ['ac-1'], undefined, criteria);
        expect(v?.verdict).toBe('pass');

        const wi = {
          id: 'wi_completetest',
          changed_files: ['src/x.ts'],
          goal: 'the goal',
          acceptance_criteria: [
            {
              id: 'ac-1',
              statement: 'ac-1 is met',
              verdict: 'pass',
              evidence: [cmdEv('bun test')],
            },
          ],
        } as unknown as WorkItem;
        const c = assembleCompletionFromGraph(graph, wi, { now: NOW });
        expect(c.final_verdict).toBe('pass');
      });
    });
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

// wi_2607074rs: a fresh `ditto verify` pass recorded on the WORK-ITEM criterion —
// AFTER the autopilot run — must supersede a stale node verdict, so a genuinely
// re-verified WI can close. The supersession is EVIDENCE-GATED: only a criterion
// pass carrying command-kind evidence (what `ditto verify` writes) supersedes; a
// bare/placeholder pass is powerless (false-green protection preserved).
describe('work-item criterion fresh verify evidence supersedes a stale node verdict (wi_2607074rs)', () => {
  // The real bug shape (wi_260707loq): a terminal verify node recorded ac-1 fail
  // via a per-AC verdict; the node itself passed as a node (it ran, evidence present).
  const staleFailNode = () =>
    node({
      id: 'N3',
      kind: 'verify',
      acceptance_refs: ['ac-1'],
      status: 'passed',
      evidence_refs: [ev('verify.log')],
      ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'fail' }],
    });

  test('ac-1: node fail + fresh evidence-backed criterion pass → deriveAcVerdicts returns pass', () => {
    const graph = graphWith([staleFailNode()]);
    const criteria = new Map([
      ['ac-1', { verdict: 'pass' as const, evidence: [cmdEv('bun test')] }],
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1'], undefined, criteria);
    expect(v?.verdict).toBe('pass');
    // the verify evidence is carried into the derived verdict (so the mirror keeps
    // the command-kind proof push-readiness needs).
    expect(v?.evidence).toContainEqual(cmdEv('bun test'));
  });

  test('ac-1: node fail + fresh criterion pass → assembleCompletionFromGraph final_verdict=pass', () => {
    const graph = graphWith([staleFailNode()]);
    const wi = {
      id: 'wi_completetest',
      changed_files: ['src/x.ts'],
      goal: 'the goal',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'ac-1 is met', verdict: 'pass', evidence: [cmdEv('bun test')] },
      ],
    } as unknown as WorkItem;
    const c = assembleCompletionFromGraph(graph, wi, { now: NOW });
    expect(c.final_verdict).toBe('pass');
    expect(c.acceptance.find((a) => a.criterion_id === 'ac-1')?.verdict).toBe('pass');
  });

  test('ac-2 (false-green guard): criterion pass with NO command evidence + node fail → stays fail', () => {
    const graph = graphWith([staleFailNode()]);
    // a bare/placeholder pass — verdict flipped to pass but no recorded verify evidence.
    const criteria = new Map([['ac-1', { verdict: 'pass' as const, evidence: [] }]]);
    const [v] = deriveAcVerdicts(graph, ['ac-1'], undefined, criteria);
    expect(v?.verdict).toBe('fail');
  });

  test('ac-2 (false-green guard): a note-only criterion pass (no command evidence) + node fail → stays fail', () => {
    const graph = graphWith([staleFailNode()]);
    const criteria = new Map([
      [
        'ac-1',
        { verdict: 'pass' as const, evidence: [{ kind: 'note' as const, summary: 'looks fine' }] },
      ],
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1'], undefined, criteria);
    expect(v?.verdict).toBe('fail');
  });

  test('a criterion whose own verdict is NOT pass never supersedes (even with command evidence)', () => {
    const graph = graphWith([staleFailNode()]);
    const criteria = new Map([
      ['ac-1', { verdict: 'fail' as const, evidence: [cmdEv('bun test')] }],
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1'], undefined, criteria);
    expect(v?.verdict).toBe('fail');
  });

  test('absent criteria map → exact prior behavior (regression-safe): node fail stays fail', () => {
    const graph = graphWith([staleFailNode()]);
    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('fail');
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

// ── ac-6 attestation (gate↔score one input) ─────────────────────────────────
describe('attestCompletion (ac-6: per-AC attestation from the SAME derived verdicts)', () => {
  test('matches attestAcVerdicts(deriveAcVerdicts(...)) — one input, not a parallel recompute', () => {
    const graph = graphWith([
      // pass (evidence), fail, unverified (evidence-less pass) → 3 attestation states
      node({ id: 'N1', acceptance_refs: ['ac-1'], status: 'passed', evidence_refs: [ev('t.log')] }),
      node({ id: 'N2', acceptance_refs: ['ac-2'], status: 'failed', evidence_refs: [ev('f.log')] }),
      node({ id: 'N3', acceptance_refs: ['ac-3'], status: 'passed', evidence_refs: [] }),
    ]);
    const wi = workItemWith(['ac-1', 'ac-2', 'ac-3']);
    const acIds = wi.acceptance_criteria.map((c) => c.id);
    const oracles = new Map(wi.acceptance_criteria.map((c) => [c.id, c.oracle]));
    const verdicts = deriveAcVerdicts(graph, acIds, oracles);
    const completion = assembleCompletionFromGraph(graph, wi, { now: NOW });
    // The wired attestation reads completion.acceptance (what assembleCompletionFromGraph
    // wrote from those verdicts) — so it cannot disagree with the raw deriveAcVerdicts output.
    expect(attestCompletion(completion)).toEqual(attestAcVerdicts(verdicts));
    expect(attestCompletion(completion).map((a) => [a.criterion_id, a.state])).toEqual([
      ['ac-1', 'verified-by-evidence'],
      ['ac-2', 'blocked-for-user'],
      ['ac-3', 'reasoned-honest-partial'],
    ]);
  });
});

// ── ac-6 auto-handling ledger (project existing decision-log entries) ────────
describe('projectAutoHandling (ac-6: project auto_fix/surface/batch_escalate, no re-derive)', () => {
  const dec = (over: Partial<AutopilotDecision> & Pick<AutopilotDecision, 'decision'>) =>
    ({ ts: '2026-06-02T00:00:00.000Z', node_id: 'N1', reason: 'r', ...over }) as AutopilotDecision;

  test('groups the three auto-handling kinds with their resolvability category', () => {
    const ledger = projectAutoHandling([
      dec({ decision: 'auto_fix', resolvability: 'agent_resolvable', reason: 'auto-fix risk x' }),
      dec({ decision: 'surface', resolvability: 'blocked_external', reason: 'surface x in-flow' }),
      dec({
        decision: 'batch_escalate',
        resolvability: 'out_of_scope',
        reason: 'batch 2 follow-ups',
      }),
      // non-auto-handling decisions are ignored (not re-derived into the ledger)
      dec({ decision: 'loop_terminated', disposition: 'converged', reason: 'done' }),
      dec({ decision: 'escalate', failure_class: 'user_decision_needed', reason: 'cap' }),
    ]);
    expect(ledger.auto_fixed).toEqual([
      {
        node_id: 'N1',
        decision: 'auto_fix',
        resolvability: 'agent_resolvable',
        reason: 'auto-fix risk x',
      },
    ]);
    expect(ledger.surfaced).toEqual([
      {
        node_id: 'N1',
        decision: 'surface',
        resolvability: 'blocked_external',
        reason: 'surface x in-flow',
      },
    ]);
    expect(ledger.materialized).toEqual([
      {
        node_id: 'N1',
        decision: 'batch_escalate',
        resolvability: 'out_of_scope',
        reason: 'batch 2 follow-ups',
      },
    ]);
  });

  test('empty ledger when nothing was auto-handled', () => {
    const ledger = projectAutoHandling([
      dec({ decision: 'loop_terminated', disposition: 'capped', reason: 'capped' }),
    ]);
    expect(ledger).toEqual({ auto_fixed: [], surfaced: [], materialized: [] });
    expect(projectAutoHandling([])).toEqual({ auto_fixed: [], surfaced: [], materialized: [] });
  });
});

// ── ac-4 direction ledger (dedicated section, distinct from auto-handling) ────
describe('projectDirectionDecisions (ac-4: expose autonomous direction forks with the 4 disclosure fields)', () => {
  const dir = (fork: string): AutopilotDecision => ({
    ts: '2026-06-02T00:00:00.000Z',
    node_id: 'N2',
    decision: 'direction',
    reason: 'autonomous direction fork on the frozen purpose',
    direction_record: {
      fork_node_id: fork,
      trigger: '기존 접근이 AC를 만족 못 함',
      options: ['A: 어댑터 확장', 'B: 스키마 우회'],
      choice: 'A: 어댑터 확장',
      intent_basis: 'frozen purpose는 스키마 SoT 보존을 요구 (ADR-0002)',
      blast_radius: 'src/core/adapter.ts + 3 callers',
      reverse_cost: 'single revert commit',
    },
  });

  test('projects each direction decision with node_id, fork, decision_id and the 4 disclosure fields', () => {
    const decisions: AutopilotDecision[] = [
      { ts: '2026-06-02T00:00:00.000Z', node_id: 'N1', decision: 'retry', reason: 'r' },
      dir('N1'),
    ];
    const entries = projectDirectionDecisions(decisions);
    expect(entries).toHaveLength(1);
    const [e] = entries;
    expect(e?.node_id).toBe('N2');
    expect(e?.fork_node_id).toBe('N1');
    // the decision_id is the handle `revise --decision` takes — same synthesis, index 1.
    expect(e?.decision_id).toBe(synthesizeDecisionId(decisions[1] as AutopilotDecision, 1));
    // the 4 disclosure fields (무엇때문에 · 선택지 · 선택+의도근거 · 파급/되돌리기비용)
    expect(e?.trigger).toBe('기존 접근이 AC를 만족 못 함');
    expect(e?.options).toEqual(['A: 어댑터 확장', 'B: 스키마 우회']);
    expect(e?.choice).toBe('A: 어댑터 확장');
    expect(e?.intent_basis).toBe('frozen purpose는 스키마 SoT 보존을 요구 (ADR-0002)');
    expect(e?.blast_radius).toBe('src/core/adapter.ts + 3 callers');
    expect(e?.reverse_cost).toBe('single revert commit');
  });

  test('non-direction decisions are ignored (not folded into the direction ledger)', () => {
    const entries = projectDirectionDecisions([
      { ts: '2026-06-02T00:00:00.000Z', node_id: 'N1', decision: 'auto_fix', reason: 'x' },
      { ts: '2026-06-02T00:00:00.000Z', node_id: 'N1', decision: 'surface', reason: 'y' },
    ]);
    expect(entries).toEqual([]);
  });

  test('a malformed direction decision missing direction_record is skipped (defensive)', () => {
    const entries = projectDirectionDecisions([
      { ts: '2026-06-02T00:00:00.000Z', node_id: 'N2', decision: 'direction', reason: 'no record' },
    ]);
    expect(entries).toEqual([]);
  });

  test('decision_id is stable per append-position across multiple direction forks', () => {
    const decisions: AutopilotDecision[] = [dir('N1'), dir('N5')];
    const entries = projectDirectionDecisions(decisions);
    expect(entries.map((e) => e.decision_id)).toEqual([
      synthesizeDecisionId(decisions[0] as AutopilotDecision, 0),
      synthesizeDecisionId(decisions[1] as AutopilotDecision, 1),
    ]);
    // distinct fork nodes → distinct ids (append-position discriminates, not just content).
    expect(entries[0]?.decision_id).not.toBe(entries[1]?.decision_id);
  });
});

describe('ac-3 producer: an unresolved auto-resolvable risk lands in remaining_risk_records', () => {
  const dec = (over: Partial<AutopilotDecision> & Pick<AutopilotDecision, 'decision'>) =>
    ({ ts: '2026-06-02T00:00:00.000Z', node_id: 'V', reason: 'r', ...over }) as AutopilotDecision;
  const autoFix = dec({
    decision: 'auto_fix',
    resolvability: 'agent_resolvable',
    reason: 'auto-fix residual risk: a missing null guard on the new path',
  });

  // The auto-fix spliced a re-verify recheck (<node>.rev.r<k>) that did NOT pass, so
  // the agent_resolvable risk is unresolved at completion assembly — it must reach
  // `remaining_risk_records` so the Stop gate can block on it (no silent leak).
  test('auto_fix(agent_resolvable) whose re-verify recheck did NOT pass → recorded', () => {
    const graph = graphWith([
      node({ id: 'V', acceptance_refs: ['ac-1'], evidence_refs: [ev('out.txt')] }),
      node({ id: 'V.rev.r0', kind: 'verify', status: 'blocked', depends_on: [] }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), {
      now: NOW,
      decisions: [autoFix],
    });
    expect(c.remaining_risk_records).toEqual([
      { risk: 'a missing null guard on the new path', resolvability: 'agent_resolvable' },
    ]);
  });

  // The recheck PASSED → the risk was actually resolved/auto-fixed → NOT re-recorded.
  test('auto_fix(agent_resolvable) whose re-verify recheck PASSED → NOT re-recorded', () => {
    const graph = graphWith([
      node({ id: 'V', acceptance_refs: ['ac-1'], evidence_refs: [ev('out.txt')] }),
      node({ id: 'V.rev.r0', kind: 'verify', status: 'passed', depends_on: [] }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), {
      now: NOW,
      decisions: [autoFix],
    });
    expect(c.remaining_risk_records).toBeUndefined();
  });

  // No ledger threaded → field omitted (legacy completion shape, backward compat).
  test('no decisions threaded → remaining_risk_records omitted', () => {
    const graph = graphWith([
      node({ id: 'V', acceptance_refs: ['ac-1'], evidence_refs: [ev('out.txt')] }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), { now: NOW });
    expect(c.remaining_risk_records).toBeUndefined();
  });
});

// ── wi_260709sq3: recipe `barrier_opt_out` → completion seam ─────────────────
// The settled-tree test barrier FLOORS final_verdict below pass when a `test`
// barrier is present but not GREEN (degraded: passed WITHOUT command evidence).
// That floor is the safe default (catches "forgot to declare one"). `barrier_opt_out`
// is the EXPLICIT opt-out: a project that intentionally relies on push_gate/CI marks
// a merely-absent/no-command barrier NOT-APPLICABLE, so the ACs alone decide. The
// opt-out affects ONLY the no-command DEGRADE path — it never converts a barrier that
// RAN and FAILED into a pass (false-green guard).
describe('assembleCompletionFromGraph (recipe barrier_opt_out: degraded-barrier not-applicable opt-out)', () => {
  // The "all AC pass" leg: a verify node closing ac-1 with real evidence.
  const passingAc1 = () =>
    node({
      id: 'V1',
      kind: 'verify',
      acceptance_refs: ['ac-1'],
      evidence_refs: [ev('verify.log')],
    });

  // A DEGRADED barrier: passed as a node but carrying NO command-kind evidence
  // (the suite could not run) — the current FLOOR trigger.
  const degradedBarrier = () =>
    node({
      id: 'BARRIER',
      kind: 'test',
      owner: 'tester',
      acceptance_refs: [],
      status: 'passed',
      evidence_refs: [],
    });

  test('ac-2: opt_out=true + DEGRADED barrier + all AC pass → final_verdict=pass, NO barrier unverified injected', () => {
    const graph = graphWith([passingAc1(), degradedBarrier()]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), {
      now: NOW,
      barrierOptOut: true,
    });
    expect(c.acceptance.find((a) => a.criterion_id === 'ac-1')?.verdict).toBe('pass');
    expect(c.unverified.some((u) => u.item.includes('BARRIER'))).toBe(false);
    expect(c.final_verdict).toBe('pass');
  });

  test('ac-3: opt_out omitted (false) + same DEGRADED barrier → in-scope barrier unverified injected, final_verdict=unverified (floor preserved)', () => {
    const graph = graphWith([passingAc1(), degradedBarrier()]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), { now: NOW });
    const inScope = c.unverified.filter((u) => !u.out_of_scope);
    expect(inScope.some((u) => u.item.includes('BARRIER'))).toBe(true);
    expect(c.final_verdict).toBe('unverified');
  });

  test('ac-4: opt_out=true + barrier that RAN and FAILED (command evidence, status failed) → completion reflects the failure (final_verdict≠pass, in-scope barrier unverified); opt-out did NOT rescue it', () => {
    const graph = graphWith([
      passingAc1(),
      node({
        id: 'BARRIER',
        kind: 'test',
        owner: 'tester',
        acceptance_refs: [],
        status: 'failed',
        evidence_refs: [cmdEv('bun test')],
      }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), {
      now: NOW,
      barrierOptOut: true,
    });
    // A REAL barrier failure is untouched by the opt-out (only the no-command degrade
    // is suppressed): final_verdict is floored off pass and the RED barrier is recorded.
    expect(c.final_verdict).not.toBe('pass');
    expect(c.unverified.some((u) => !u.out_of_scope && u.item.includes('BARRIER'))).toBe(true);
  });
});

// ── wi_2607103tp ac-3 (M3): phantom-red DEGRADE → completion floor ───────────
// WHY THIS BLOCK EXISTS: the pre-approval phantom-red gate can return a `degrade`
// verdict (indeterminate — e.g. a non-bun runner whose authored red could not be
// deterministically confirmed as an assertion-red). Today that degrade leaves the
// test-author node's outcome UNTOUCHED (autopilot-loop.ts: only `block` fails the
// node), so a non-bun stack whose ACs all fold to pass is SILENTLY passed
// (false-green) — the exact bug ac-3 closes.
//
// The fix MIRRORS `testBarrierUnverified` (the settled-tree barrier floor): a
// recorded phantom-red degrade must inject an IN-SCOPE `unverified[]` entry so
// `deriveFinalVerdict` floors `final_verdict ≠ pass`. A DEDICATED recipe flag
// `phantom_red_opt_out: true` (NOT `barrier_opt_out`) suppresses that floor.
//
// SIGNAL CONTRACT (the frozen shape s3i records + reads — chosen to need NO schema
// migration and to mirror how the barrier floor reads node fields): a `test-author`
// node that PASSED (a degrade never fails the node) carries a `note`-kind
// evidence_ref whose summary contains the marker `phantom-red-degrade`. The
// completion floor scans passed `test-author` nodes for that marker and injects the
// in-scope unverified entry (grounded in the node id), suppressed by
// `phantomRedOptOut` (the resolved `recipe.phantom_red_opt_out`, threaded through
// AssembleOptions exactly as `barrierOptOut` threads `recipe.barrier_opt_out`).
//
// These tests use NO `kind:'test'` barrier node, so the ONLY thing that can hold
// `final_verdict` off pass is the phantom-red floor under test — an isolated red.
describe('assembleCompletionFromGraph (wi_2607103tp ac-3 / M3: phantom-red degrade floors completion)', () => {
  const PHANTOM_RED_DEGRADE_MARKER = 'phantom-red-degrade';

  // The "all AC pass" leg — a verify node closing ac-1 with real evidence, so WITHOUT
  // the phantom-red floor final_verdict would be `pass`.
  const passingAc1 = () =>
    node({
      id: 'V1',
      kind: 'verify',
      acceptance_refs: ['ac-1'],
      evidence_refs: [ev('verify.log')],
    });

  // A `test-author` node that PASSED but recorded a phantom-red DEGRADE (the authored
  // red could not be deterministically confirmed as assertion-red — indeterminate).
  const phantomRedDegradedAuthor = () =>
    node({
      id: 'AUTHOR',
      kind: 'test-author',
      owner: 'implementer',
      acceptance_refs: [],
      status: 'passed',
      evidence_refs: [
        {
          kind: 'note',
          summary: `${PHANTOM_RED_DEGRADE_MARKER}: authored red test tests/authored-ac1.test.ts could not be deterministically confirmed as assertion-red (indeterminate) — ADR-0018 proceed unverified`,
        },
      ],
    });

  const namesPhantom = (u: { item: string; reason: string }) =>
    /phantom.?red/i.test(`${u.item} ${u.reason}`);

  test('FLOOR: a passed test-author node that recorded a phantom-red DEGRADE floors final_verdict off pass with an IN-SCOPE unverified entry naming it (no barrier present)', () => {
    const graph = graphWith([passingAc1(), phantomRedDegradedAuthor()]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), { now: NOW });
    // ac-1 itself passes with evidence: the ONLY thing that can keep final_verdict off
    // pass is the phantom-red degrade floor (there is no `test` barrier node here).
    expect(c.acceptance.find((a) => a.criterion_id === 'ac-1')?.verdict).toBe('pass');
    const inScope = c.unverified.filter((u) => !u.out_of_scope);
    expect(inScope.some(namesPhantom)).toBe(true);
    expect(c.final_verdict).not.toBe('pass');
  });

  test('OPT-OUT: the DEDICATED phantom_red_opt_out flag SUPPRESSES the floor (ACs alone decide → pass); the SAME degrade without the flag still floors', () => {
    const graph = graphWith([passingAc1(), phantomRedDegradedAuthor()]);
    // Baseline leg — WITHOUT the opt-out the degrade floors. This leg is RED today (the
    // floor does not exist yet), which is exactly the ac-3 FLOOR behavior s3i must add.
    const floored = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), { now: NOW });
    expect(floored.final_verdict).not.toBe('pass');
    // With the DEDICATED phantom_red_opt_out (threaded as `phantomRedOptOut`, mirroring
    // `barrierOptOut`), the SAME degrade is NOT-APPLICABLE: no floor, no injected entry.
    // Cast the options literal so the file COMPILES before s3i adds `phantomRedOptOut`
    // to AssembleOptions (the `as` suppresses excess-property checking) — the failure is
    // an assertion about final_verdict, never a type/compile error.
    const suppressed = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), {
      now: NOW,
      phantomRedOptOut: true,
    } as AssembleOptions);
    expect(suppressed.final_verdict).toBe('pass');
    expect(suppressed.unverified.filter((u) => !u.out_of_scope).some(namesPhantom)).toBe(false);
  });

  test('OPT-OUT is DEDICATED: reusing barrier_opt_out (barrierOptOut) does NOT suppress the phantom-red floor', () => {
    // The design requires a SEPARATE flag — barrier_opt_out governs the settled-tree
    // barrier, not the phantom-red degrade. Passing barrierOptOut must leave the
    // phantom-red floor in place (final_verdict still floored).
    const graph = graphWith([passingAc1(), phantomRedDegradedAuthor()]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), {
      now: NOW,
      barrierOptOut: true,
    });
    expect(c.final_verdict).not.toBe('pass');
    expect(c.unverified.filter((u) => !u.out_of_scope).some(namesPhantom)).toBe(true);
  });
});

// wi_260710l33 (#24): the completion-boundary FROZEN-test breach floor. Frozen-test
// integrity (assertFrozenTestsIntact) was bound ONLY to in-loop mutating passes
// (autopilot-loop.ts). A frozen red test breached OUT-OF-BAND after the last mutating
// pass (deleted / edited by a later read-only pass or a separate session) was never
// re-checked at completion assembly — so a `dynamic_test` AC that closed green could
// have its proving test gutted and `final_verdict=pass` would still slip through
// (vacuous-green reopened at the completion boundary). This floor re-runs the frozen
// integrity check at assembly (currentTestHash injected — same purity as the loop's
// check) and injects an IN-SCOPE unverified entry per breach, mirroring the barrier /
// phantom-red floors. Absent injection ⇒ no-op (byte-identical, backward compat).
describe('assembleCompletionFromGraph (wi_260710l33 / #24: completion-boundary frozen-breach floor)', () => {
  // A graph whose approval gate carries a FROZEN manifest (test-author freeze), plus a
  // verify node closing ac-1 with real evidence — so WITHOUT the frozen floor
  // final_verdict would be `pass`. No `test` barrier node → the frozen floor is the ONLY
  // thing that can hold final_verdict off pass.
  const FROZEN_PATH = 'tests/authored-ac1.test.ts';
  const FROZEN_HASH = 'HASH_FROZEN_A';
  const graphWithFrozen = (frozen_hash?: string): Autopilot =>
    autopilot.parse({
      schema_version: '0.1.0',
      autopilot_id: 'orch_frozentest',
      work_item_id: 'wi_completetest',
      root_goal: 'goal',
      approval_gate: {
        status: 'approved',
        source: 'approved_spec',
        plan_brief: {
          test_spec: {
            test_backed: [
              {
                criterion_id: 'ac-1',
                test_path: FROZEN_PATH,
                ...(frozen_hash ? { frozen_hash } : {}),
              },
            ],
          },
        },
      },
      nodes: [
        node({
          id: 'V1',
          kind: 'verify',
          acceptance_refs: ['ac-1'],
          evidence_refs: [ev('verify.log')],
        }),
      ],
      caps: { fix_per_node: 2, switch_per_node: 1, converge_rounds: 3 },
      continue_policy: {},
      stop_conditions: [],
    });

  const namesFrozen = (u: { item: string; reason: string }) =>
    /frozen/i.test(`${u.item} ${u.reason}`);

  test('FLOOR: a DELETED frozen test (current hash undefined) injects an IN-SCOPE unverified entry naming it and floors final_verdict off pass', () => {
    const graph = graphWithFrozen(FROZEN_HASH);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), {
      now: NOW,
      currentTestHash: () => undefined, // the frozen test was DELETED out-of-band
    } as AssembleOptions);
    // ac-1 itself passes with evidence: the ONLY thing that can keep final_verdict off
    // pass is the frozen-breach floor (there is no `test` barrier node here).
    expect(c.acceptance.find((a) => a.criterion_id === 'ac-1')?.verdict).toBe('pass');
    const inScope = c.unverified.filter((u) => !u.out_of_scope);
    expect(inScope.some(namesFrozen)).toBe(true);
    expect(inScope.some((u) => `${u.item} ${u.reason}`.includes(FROZEN_PATH))).toBe(true);
    expect(c.final_verdict).not.toBe('pass');
  });

  test('FLOOR: a WEAKENED frozen test (current hash differs) also floors final_verdict off pass', () => {
    const graph = graphWithFrozen(FROZEN_HASH);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), {
      now: NOW,
      currentTestHash: () => 'HASH_DIFFERENT', // edited/weakened after freeze
    } as AssembleOptions);
    expect(c.final_verdict).not.toBe('pass');
    expect(c.unverified.filter((u) => !u.out_of_scope).some(namesFrozen)).toBe(true);
  });

  test('INTACT: an unchanged frozen test (current hash == frozen hash) injects NO floor entry → ACs alone decide (pass)', () => {
    const graph = graphWithFrozen(FROZEN_HASH);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), {
      now: NOW,
      currentTestHash: () => FROZEN_HASH,
    } as AssembleOptions);
    expect(c.final_verdict).toBe('pass');
    expect(c.unverified.filter((u) => !u.out_of_scope).some(namesFrozen)).toBe(false);
  });

  test('UNBOUND: a manifest entry with no frozen_hash contributes no binding (degrade, never a false reject) even when the file is gone', () => {
    const graph = graphWithFrozen(undefined); // frozen_hash absent → unbound
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), {
      now: NOW,
      currentTestHash: () => undefined,
    } as AssembleOptions);
    expect(c.final_verdict).toBe('pass');
    expect(c.unverified.filter((u) => !u.out_of_scope).some(namesFrozen)).toBe(false);
  });

  test('NO-OP: without currentTestHash injection the floor is inert — byte-identical to the no-frozen completion (backward compat)', () => {
    const graph = graphWithFrozen(FROZEN_HASH);
    const withoutInjection = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), {
      now: NOW,
    });
    // No injection ⇒ the floor cannot run (no filesystem/hash source) ⇒ no entry, pass.
    expect(withoutInjection.final_verdict).toBe('pass');
    expect(withoutInjection.unverified.filter((u) => !u.out_of_scope).some(namesFrozen)).toBe(
      false,
    );
  });
});

// wi_260710676 (#18): the MISSING writer for `completion.non_pass_status`. The Stop
// gate `nonPassTerminationGate` unlocks an honest non-pass termination only when the
// completion carries a `non_pass_status` declaration — but no code ever wrote it, so
// an autopilot that honestly finished non-pass was blocked at the gate and needed a
// manual completion.json edit. The autopilot completion writer is the honest-terminate
// author: it derives the declaration when (and only when) the graph is FULLY TERMINAL
// and a criterion is parked (unverified/fail). A still-unfinished graph gets no
// declaration, so the gate keeps blocking a no-progress park (ac-5 protection intact).
describe('assembleCompletionFromGraph → non_pass_status (wi_260710676, #18)', () => {
  test('fully-terminal non-pass with a parked unverified AC → derives non_pass_status; gate passes; state=partial (progress made)', () => {
    // ac-1 passed WITH evidence → pass; ac-2 has no addressing node → unverified.
    // Every node terminal → the run honestly finished non-pass.
    const graph = graphWith([
      node({ id: 'N1', acceptance_refs: ['ac-1'], status: 'passed', evidence_refs: [ev('t.log')] }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1', 'ac-2']), { now: NOW });
    expect(c.final_verdict).not.toBe('pass');
    expect(c.non_pass_status).toBeDefined();
    expect(c.non_pass_status?.state).toBe('partial'); // ac-1 passed = progress
    expect(c.non_pass_status?.reason.length).toBeGreaterThan(0);
    expect(c.non_pass_status?.grounding).toContain('ac-2'); // grounded in the parked id
    expect(nonPassTerminationGate(c).pass).toBe(true);
  });

  test('fully-terminal non-pass with NO passed AC → state=blocked (nothing achieved)', () => {
    // A single passed node addressing no AC keeps the graph terminal while both ACs
    // stay unverified (no addressing verification) → zero progress.
    const graph = graphWith([node({ id: 'N1', acceptance_refs: [], status: 'passed' })]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1', 'ac-2']), { now: NOW });
    expect(c.final_verdict).not.toBe('pass');
    expect(c.non_pass_status?.state).toBe('blocked');
    expect(nonPassTerminationGate(c).pass).toBe(true);
  });

  test('UNFINISHED graph (a non-terminal node) → NO non_pass_status; gate still BLOCKS (ac-5 no-progress protection preserved)', () => {
    const graph = graphWith([
      node({ id: 'N1', acceptance_refs: ['ac-1'], status: 'passed', evidence_refs: [ev('t.log')] }),
      node({ id: 'N2', acceptance_refs: [], status: 'running' }), // non-terminal: work unfinished
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1', 'ac-2']), { now: NOW });
    expect(c.final_verdict).not.toBe('pass');
    expect(c.non_pass_status).toBeUndefined();
    expect(nonPassTerminationGate(c).pass).toBe(false);
  });

  test('a pass completion carries NO non_pass_status (byte-identical to before)', () => {
    const graph = graphWith([
      node({ id: 'N1', acceptance_refs: ['ac-1'], status: 'passed', evidence_refs: [ev('t.log')] }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), { now: NOW });
    expect(c.final_verdict).toBe('pass');
    expect(c.non_pass_status).toBeUndefined();
  });

  test('non-pass whose only non-pass AC is a declared partial (no unverified/fail) → NO non_pass_status (partial is an honest signal, nothing parked)', () => {
    const graph = graphWith([
      node({
        id: 'N1',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        evidence_refs: [ev('t.log')],
        ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'partial' }],
      }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), { now: NOW });
    expect(c.final_verdict).toBe('partial');
    expect(c.non_pass_status).toBeUndefined();
    expect(nonPassTerminationGate(c).pass).toBe(true);
  });

  // ac-1 (wi_260710tjd) blocked-graph deadlock fix. The settle guard formerly required
  // `allNodesTerminal`, so a NON-terminal graph the loop cannot advance (no ready node,
  // nothing running, ≥1 blocked node — the loop's action:'blocked') got NO declaration,
  // and the Stop gate then DEADLOCKED it (parked criteria, no non_pass_status, yet the
  // loop can make no further progress). Broaden the guard to mirror action:'blocked'.
  test('BLOCKED graph (non-terminal, no runnable node) → derives non_pass_status state=blocked; gate passes (no deadlock)', () => {
    // ac-1 passed WITH evidence → pass; N2 BLOCKED (escalated, user-owned) addressing
    // ac-2 → parked. The graph is NON-terminal (N2 blocked) yet nothing is runnable.
    const graph = graphWith([
      node({ id: 'N1', acceptance_refs: ['ac-1'], status: 'passed', evidence_refs: [ev('t.log')] }),
      node({ id: 'N2', acceptance_refs: ['ac-2'], status: 'blocked' }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1', 'ac-2']), { now: NOW });
    expect(c.final_verdict).not.toBe('pass');
    expect(c.non_pass_status).toBeDefined();
    // The loop is stuck → the honest disposition is `blocked` (mirrors the loop's
    // disposition:'blocked'), even though ac-1 reached pass.
    expect(c.non_pass_status?.state).toBe('blocked');
    expect(c.non_pass_status?.grounding).toContain('ac-2');
    expect(nonPassTerminationGate(c).pass).toBe(true);
  });

  // A non-terminal graph with a still-RUNNING node is NOT stuck (transient progress) —
  // the guard must keep returning undefined so the gate keeps blocking a no-progress
  // park (ac-5 protection). Guards the broadening against over-firing.
  test('non-terminal graph with a RUNNING node (not stuck) → still NO non_pass_status (gate blocks)', () => {
    const graph = graphWith([
      node({ id: 'N1', acceptance_refs: ['ac-1'], status: 'passed', evidence_refs: [ev('t.log')] }),
      node({ id: 'N2', acceptance_refs: ['ac-2'], status: 'running' }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1', 'ac-2']), { now: NOW });
    expect(c.non_pass_status).toBeUndefined();
    expect(nonPassTerminationGate(c).pass).toBe(false);
  });
});

// ── wi_2607103tp ac-5: EXPLICIT ≥2-STACK phantom-red end-to-end fixture ───────
// WHY THIS FIXTURE EXISTS (the 70→3 lesson): a single-stack green can hide a
// cross-stack regression. The per-slice unit tests already cover each hop in
// isolation (buildAuthoredRedRunCommand command derivation; classifyAuthoredRed
// RUNNER-AWARE; the phantomRedGate block/present/degrade fold; the ac-3/M3 floor
// with a SYNTHETIC degrade note). What none of them does is tie the FULL chain —
// runner shape → classifyAuthoredRed → phantomRedGate verdict → (non-bun)
// completion floor — for BOTH a bun-shaped and a non-bun-shaped stack IN ONE
// PLACE. That consolidation is the genuine gap: it makes a bun-only pass unable to
// mask the non-bun false-block/false-green this WI fixes, because the SAME fixture
// exercises both stacks end-to-end. The non-bun FLOOR leg is chained from the REAL
// gate output (the phantom-red-degrade note is built from `phantom.reasons` exactly
// as autopilot-loop.ts:2509-2515 records it), so the degrade the gate emits is the
// very signal the completion floor consumes — not a hand-written synthetic.
//
// Mock `runOne` + synthetic graph only (ADR-20260708 unit/mock tier — NO real
// go/rust/python toolchain is spawned; the "non-bun stack" is modeled purely by
// `runnerIsBunShaped:false` + representative captured output).
describe('wi_2607103tp ac-5: ≥2-STACK phantom-red end-to-end (bun + non-bun), one fixture — no single-stack blind spot', () => {
  const failed = (captured: string): CaptureResult => ({
    outcome: { kind: 'failed', exitCode: 1 },
    captured,
  });
  // A genuine bun assertion-red (the AC assertion itself failed).
  const BUN_ASSERTION_RED = failed(
    '(fail) t > x\n error: expect(received).toBe(expected)\n 0 pass\n 1 fail',
  );
  // A bun compile/import red — a PHANTOM (loaded-as-nothing, never reached the assertion).
  const BUN_COMPILE_RED = failed("error: Cannot find module './handler'\n 0 pass\n 0 fail");
  // A NON-bun runner whose chatter COINCIDENTALLY contains bun-shaped markers
  // ("Cannot find module", "SyntaxError"). On a bun runner this would BLOCK; on a
  // non-bun runner it must DEGRADE, never false-block a legitimately-authored red.
  const NONBUN_BUNSHAPED_OUTPUT = failed(
    [
      '# example.com/pkg',
      './handler_test.go:7:2: cannot find module providing package ./handler',
      'SyntaxError-lookalike chatter from a foreign toolchain',
      'FAIL    example.com/pkg [build failed]',
    ].join('\n'),
  );
  const one = (cap: CaptureResult) => async (_p: string) => cap;
  const namesPhantom = (u: { item: string; reason: string }) =>
    /phantom.?red/i.test(`${u.item} ${u.reason}`);

  describe('BUN stack (runnerIsBunShaped=true) through phantomRedGate', () => {
    test('bun-block leg: a bun compile/import red ⇒ verdict block (definite phantom blocks)', async () => {
      const res = await phantomRedGate({
        tests: [{ criterion_id: 'ac-1', test_path: 'tests/authored-ac1.test.ts' }],
        runOne: one(BUN_COMPILE_RED),
        runnerIsBunShaped: true,
      });
      expect(res.verdict).toBe('block');
    });

    test('bun-present leg: a genuine bun assertion-red ⇒ verdict present (a real red is allowed through)', async () => {
      const res = await phantomRedGate({
        tests: [{ criterion_id: 'ac-1', test_path: 'tests/authored-ac1.test.ts' }],
        runOne: one(BUN_ASSERTION_RED),
        runnerIsBunShaped: true,
      });
      expect(res.verdict).toBe('present');
      expect(res.perTest[0]?.classification).toBe('assertion_red');
    });
  });

  describe('NON-bun stack (runnerIsBunShaped=false) through phantomRedGate → degrade → completion floor', () => {
    test('non-bun-degrade leg: bun-marker-shaped chatter on a non-bun runner ⇒ verdict degrade (NOT block — the false-block this WI fixes)', async () => {
      const res = await phantomRedGate({
        tests: [{ criterion_id: 'ac-1', test_path: 'tests/authored_ac1_test.go' }],
        runOne: one(NONBUN_BUNSHAPED_OUTPUT),
        runnerIsBunShaped: false,
      });
      expect(res.verdict).toBe('degrade');
      expect(res.perTest[0]?.classification).toBe('indeterminate');
    });

    // Chain the SAME degrade the gate just produced into the completion floor: build the
    // test-author node's phantom-red-degrade note from `phantom.reasons` EXACTLY as the loop
    // records it (autopilot-loop.ts:2509-2515), so this is a true end-to-end tie, not a
    // hand-written synthetic. ac-1 itself passes with evidence, so the ONLY thing that can
    // keep final_verdict off pass is the phantom-red floor under test (no `test` barrier here).
    const degradedAuthorFrom = (phantom: { reasons: string[] }) =>
      node({
        id: 'AUTHOR',
        kind: 'test-author',
        owner: 'implementer',
        acceptance_refs: [],
        status: 'passed',
        evidence_refs: [
          {
            kind: 'note',
            summary: `phantom-red-degrade: authored red test could not be deterministically confirmed as assertion-red (indeterminate) — ADR-0018 proceed unverified — ${phantom.reasons.join('; ')}`,
          },
        ],
      });
    const passingAc1 = () =>
      node({
        id: 'V1',
        kind: 'verify',
        acceptance_refs: ['ac-1'],
        evidence_refs: [ev('verify.log')],
      });

    test('non-bun-floor leg: the gate degrade floors completion (final_verdict≠pass, in-scope phantom-red unverified); phantom_red_opt_out suppresses it, barrier_opt_out does NOT', async () => {
      const phantom = await phantomRedGate({
        tests: [{ criterion_id: 'ac-1', test_path: 'tests/authored_ac1_test.go' }],
        runOne: one(NONBUN_BUNSHAPED_OUTPUT),
        runnerIsBunShaped: false,
      });
      expect(phantom.verdict).toBe('degrade');
      const graph = graphWith([passingAc1(), degradedAuthorFrom(phantom)]);

      // Floor: ac-1 passes, but the chained degrade holds final_verdict off pass.
      const floored = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), { now: NOW });
      expect(floored.acceptance.find((a) => a.criterion_id === 'ac-1')?.verdict).toBe('pass');
      expect(floored.unverified.filter((u) => !u.out_of_scope).some(namesPhantom)).toBe(true);
      expect(floored.final_verdict).not.toBe('pass');

      // DEDICATED opt-out suppresses the floor (ACs alone decide → pass).
      const suppressed = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), {
        now: NOW,
        phantomRedOptOut: true,
      });
      expect(suppressed.final_verdict).toBe('pass');

      // barrier_opt_out is a DIFFERENT seam — it must NOT suppress the phantom-red floor.
      const barrierOnly = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), {
        now: NOW,
        barrierOptOut: true,
      });
      expect(barrierOnly.final_verdict).not.toBe('pass');
    });
  });
});
