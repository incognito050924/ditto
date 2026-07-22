/**
 * Isomorphic fixture pairs for the two completion-gate paths (standalone harness,
 * NOT part of the bun test suite).
 *
 * Every fixture is GENERATED through the schema-parse source of truth:
 *  - rebuild side: `queueState.parse` (rebuild/state/queue-state.ts)
 *  - src side: `autopilot.parse` (src/schemas/autopilot.ts) + `workItem.parse`
 *    (src/schemas/work-item.ts)
 * so a fixture that drifts from either schema fails loudly at generation time.
 *
 * Each pair encodes ONE semantic completion state in the two representations
 * (e.g. "pending queue item" <-> "non-terminal addressing node"). The
 * pair-consistency checker asserts the structural mirroring per class.
 *
 * Known encoding boundaries (deliberate, labeled — not silently absorbed):
 *  - evidence emptiness: rebuild checks `evidence_ref.trim().length > 0`
 *    (queue-state.ts hasEvidence), src checks `evidence_refs.length > 0` on the
 *    node (autopilot-complete.ts hasClosingEvidence). The empty-string /
 *    whitespace classes exist exactly to capture that branch difference.
 *  - empty degenerate: rebuild allows items=0 AND acceptance_criteria=0 (vacuous
 *    pass). The src work-item schema floors acceptance_criteria at min(1), so an
 *    AC=0 src state is UNREPRESENTABLE; the closest degenerate is nodes=[] with
 *    the minimal 1-AC work item ("no node addressed this criterion" ->
 *    unverified). The asymmetry is recorded on the pair (asymmetry_note).
 *  - stop_hook_active: a DESIGN divergence, not a fixture axis. rebuild
 *    evaluateStopGate keeps blocking when stop_hook_active repeats (stop-gate.ts
 *    repeatBlock only flags it); src stopHandler exits 0 immediately
 *    (src/hooks/stop.ts, `raw.stop_hook_active === true` early return). The
 *    harness stratifies rebuild runs over both values and reports the src side
 *    as a source-anchored design fact, kept OUT of the mismatch table.
 */

import {
  type QueueState,
  acsClaimingPassWithoutEvidence,
  pendingCount,
  queueState,
} from '../../rebuild/state/queue-state';
import { type Autopilot, autopilot } from '../../src/schemas/autopilot';
import { type WorkItem, workItem } from '../../src/schemas/work-item';

export type ClassId =
  | 'all-green'
  | 'no-evidence-pass'
  | 'red-tests'
  | 'pending-residual'
  | 'evidence-empty-string'
  | 'evidence-whitespace'
  | 'empty-degenerate';

export interface FixturePair {
  class_id: ClassId;
  description: string;
  /** Deliberate representation asymmetry, when the two sides cannot be strictly isomorphic. */
  asymmetry_note?: string;
  rebuild: {
    state: QueueState;
    testExitCode: number;
    foundationCompleteEmitted: boolean;
  };
  src: {
    graph: Autopilot;
    workItem: WorkItem;
  };
  /** Harness prediction used for calibration reporting (deviation is RECORDED, not fatal). */
  expected: {
    rebuild_allows: boolean;
    src_allows: boolean;
    divergence_expected: boolean;
  };
}

const TS = '2026-07-22T00:00:00.000Z';

/* ---------------------------------- rebuild side ---------------------------------- */

interface RebuildAcSpec {
  id: string;
  status: 'pass' | 'unverified' | 'fail';
  evidence_ref: string | null;
}
interface RebuildItemSpec {
  id: string;
  exit: 'resolved' | null;
}

function makeQueueState(items: RebuildItemSpec[], acs: RebuildAcSpec[]): QueueState {
  // Raw JSON document -> schema parse (SoT). Never hand-built typed objects.
  return queueState.parse({
    round: 1,
    items: items.map((i) => ({
      id: i.id,
      kind: 'in-scope-residual',
      exit: i.exit,
      evidence_ref: i.exit === null ? null : 'state/progress.md#resolved',
      disposition_note: i.exit === null ? null : 'closed with evidence',
    })),
    acceptance_criteria: acs.map((ac) => ({
      id: ac.id,
      status: ac.status,
      evidence_ref: ac.evidence_ref,
    })),
    last_stop_hook: null,
    backstop: { turns: 0, no_progress_rounds: 0, queue_size_trend: [] },
    blocker: null,
  });
}

/* ------------------------------------ src side ------------------------------------ */

function makeWorkItem(acIds: string[]): WorkItem {
  return workItem.parse({
    schema_version: '0.1.0',
    id: 'wi_measure0000',
    title: 'stop-gate measurement fixture',
    source_request: 'measure the two completion-gate paths side by side',
    goal: 'both gate paths judged on isomorphic completion states',
    acceptance_criteria: acIds.map((id) => ({
      id,
      statement: `criterion ${id} observable behavior`,
    })),
    status: 'in_progress',
    created_at: TS,
    updated_at: TS,
  });
}

type NodeEvidence =
  | { kind: 'command'; command: string; summary: string }
  | { kind: 'note'; summary: string };

interface SrcNodeSpec {
  id: string;
  kind: 'implement' | 'test';
  status: 'pending' | 'passed' | 'failed';
  acceptance_refs: string[];
  evidence_refs: NodeEvidence[];
}

function makeGraph(nodes: SrcNodeSpec[]): Autopilot {
  return autopilot.parse({
    schema_version: '0.1.0',
    autopilot_id: 'orch_measure0000',
    work_item_id: 'wi_measure0000',
    root_goal: 'measure the two completion-gate paths side by side',
    approval_gate: { status: 'approved', source: 'user', approved_at: TS, approved_by: 'measure' },
    nodes: nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      owner: n.kind === 'test' ? 'tester' : 'implementer',
      purpose: `measurement fixture node ${n.id}`,
      status: n.status,
      depends_on: [],
      acceptance_refs: n.acceptance_refs,
      evidence_refs: n.evidence_refs,
    })),
    caps: { fix_per_node: 2, switch_per_node: 1 },
    continue_policy: {},
  });
}

const cmdEvidence = (what: string): NodeEvidence => ({
  kind: 'command',
  command: 'bun test scoped/',
  summary: what,
});

const greenBarrier: SrcNodeSpec = {
  id: 'n-barrier',
  kind: 'test',
  status: 'passed',
  acceptance_refs: [],
  evidence_refs: [cmdEvidence('settled-tree suite green (exit 0)')],
};

/* ----------------------------------- the classes ----------------------------------- */

export function buildFixtures(): FixturePair[] {
  return [
    {
      class_id: 'all-green',
      description:
        'normal green: queue drained, AC pass with live evidence, tests green / all nodes passed with command evidence, barrier green',
      rebuild: {
        state: makeQueueState(
          [{ id: 'q-1', exit: 'resolved' }],
          [{ id: 'ac-1', status: 'pass', evidence_ref: 'artifacts/ac-1-test-run.txt' }],
        ),
        testExitCode: 0,
        foundationCompleteEmitted: false,
      },
      src: {
        graph: makeGraph([
          {
            id: 'n-impl',
            kind: 'implement',
            status: 'passed',
            acceptance_refs: ['ac-1'],
            evidence_refs: [cmdEvidence('ac-1 unit test green')],
          },
          greenBarrier,
        ]),
        workItem: makeWorkItem(['ac-1']),
      },
      expected: { rebuild_allows: true, src_allows: true, divergence_expected: false },
    },
    {
      class_id: 'no-evidence-pass',
      description:
        'over-claim: AC claims pass with evidence_ref null / addressing node passed with zero evidence_refs',
      rebuild: {
        state: makeQueueState(
          [{ id: 'q-1', exit: 'resolved' }],
          [{ id: 'ac-1', status: 'pass', evidence_ref: null }],
        ),
        testExitCode: 0,
        foundationCompleteEmitted: false,
      },
      src: {
        graph: makeGraph([
          {
            id: 'n-impl',
            kind: 'implement',
            status: 'passed',
            acceptance_refs: ['ac-1'],
            evidence_refs: [],
          },
          greenBarrier,
        ]),
        workItem: makeWorkItem(['ac-1']),
      },
      expected: { rebuild_allows: false, src_allows: false, divergence_expected: false },
    },
    {
      class_id: 'red-tests',
      description:
        'suite red: runner exit 1 with otherwise-green state / settled-tree test barrier node failed',
      rebuild: {
        state: makeQueueState(
          [{ id: 'q-1', exit: 'resolved' }],
          [{ id: 'ac-1', status: 'pass', evidence_ref: 'artifacts/ac-1-test-run.txt' }],
        ),
        testExitCode: 1,
        foundationCompleteEmitted: false,
      },
      src: {
        graph: makeGraph([
          {
            id: 'n-impl',
            kind: 'implement',
            status: 'passed',
            acceptance_refs: ['ac-1'],
            evidence_refs: [cmdEvidence('ac-1 unit test green')],
          },
          { ...greenBarrier, status: 'failed', evidence_refs: [] },
        ]),
        workItem: makeWorkItem(['ac-1']),
      },
      expected: { rebuild_allows: false, src_allows: false, divergence_expected: false },
    },
    {
      class_id: 'pending-residual',
      description:
        'unfinished work: one queue item with exit null / one non-terminal (pending) addressing node',
      rebuild: {
        state: makeQueueState(
          [
            { id: 'q-1', exit: 'resolved' },
            { id: 'q-2', exit: null },
          ],
          [{ id: 'ac-1', status: 'pass', evidence_ref: 'artifacts/ac-1-test-run.txt' }],
        ),
        testExitCode: 0,
        foundationCompleteEmitted: false,
      },
      src: {
        graph: makeGraph([
          {
            id: 'n-impl',
            kind: 'implement',
            status: 'passed',
            acceptance_refs: ['ac-1'],
            evidence_refs: [cmdEvidence('ac-1 unit test green')],
          },
          {
            id: 'n-residual',
            kind: 'implement',
            status: 'pending',
            acceptance_refs: ['ac-1'],
            evidence_refs: [],
          },
          greenBarrier,
        ]),
        workItem: makeWorkItem(['ac-1']),
      },
      expected: { rebuild_allows: false, src_allows: false, divergence_expected: false },
    },
    {
      class_id: 'evidence-empty-string',
      description:
        'boundary: evidence_ref is "" — rebuild trims (no evidence -> block); src counts array length (1 entry -> evidence present). Captures the trim-vs-length branch.',
      rebuild: {
        state: makeQueueState(
          [{ id: 'q-1', exit: 'resolved' }],
          [{ id: 'ac-1', status: 'pass', evidence_ref: '' }],
        ),
        testExitCode: 0,
        foundationCompleteEmitted: false,
      },
      src: {
        graph: makeGraph([
          {
            id: 'n-impl',
            kind: 'implement',
            status: 'passed',
            acceptance_refs: ['ac-1'],
            evidence_refs: [{ kind: 'note', summary: '' }],
          },
          greenBarrier,
        ]),
        workItem: makeWorkItem(['ac-1']),
      },
      expected: { rebuild_allows: false, src_allows: true, divergence_expected: true },
    },
    {
      class_id: 'evidence-whitespace',
      description:
        'boundary: evidence_ref is whitespace-only — rebuild trim() rejects; src length>0 accepts a content-empty note entry.',
      rebuild: {
        state: makeQueueState(
          [{ id: 'q-1', exit: 'resolved' }],
          [{ id: 'ac-1', status: 'pass', evidence_ref: '   ' }],
        ),
        testExitCode: 0,
        foundationCompleteEmitted: false,
      },
      src: {
        graph: makeGraph([
          {
            id: 'n-impl',
            kind: 'implement',
            status: 'passed',
            acceptance_refs: ['ac-1'],
            evidence_refs: [{ kind: 'note', summary: '   ' }],
          },
          greenBarrier,
        ]),
        workItem: makeWorkItem(['ac-1']),
      },
      expected: { rebuild_allows: false, src_allows: true, divergence_expected: true },
    },
    {
      class_id: 'empty-degenerate',
      description:
        'empty-state degenerate: rebuild items=0 & AC=0 (vacuous allow); src closest representable state is nodes=[] with the minimal 1-AC work item (unaddressed AC -> unverified).',
      asymmetry_note:
        'src workItem schema floors acceptance_criteria at min(1) (work-item.ts), so AC=0 is unrepresentable on the src side; the pair is degenerate-by-design and its divergence is an ENCODING artifact, not a runtime misjudgment.',
      rebuild: {
        state: makeQueueState([], []),
        testExitCode: 0,
        foundationCompleteEmitted: false,
      },
      src: {
        graph: makeGraph([]),
        workItem: makeWorkItem(['ac-1']),
      },
      expected: { rebuild_allows: true, src_allows: false, divergence_expected: true },
    },
  ];
}

/* ------------------------------- pair consistency -------------------------------- */

const isTerminal = (s: string) => s === 'passed' || s === 'failed';

/**
 * Structural mirroring checks per pair — "the same semantic state in two
 * representations". Violations are FATAL for the harness (an inconsistent pair
 * invalidates the comparison). The empty-degenerate class is exempt from the
 * AC-count mirror (documented asymmetry).
 */
export function checkPairConsistency(pair: FixturePair): string[] {
  const v: string[] = [];
  const { state, testExitCode } = pair.rebuild;
  const { graph } = pair.src;

  // pending mirror: pending queue items <-> non-terminal nodes.
  const rebuildPending = pendingCount(state) > 0;
  const srcNonTerminal = graph.nodes.some((n) => !isTerminal(n.status));
  if (pair.class_id !== 'empty-degenerate' && rebuildPending !== srcNonTerminal) {
    v.push(
      `${pair.class_id}: pending mirror broken (rebuild pending=${rebuildPending}, src non-terminal=${srcNonTerminal})`,
    );
  }

  // red mirror: runner exit != 0 <-> test barrier node failed.
  const srcBarrierFailed = graph.nodes.some((n) => n.kind === 'test' && n.status === 'failed');
  if (pair.class_id !== 'empty-degenerate' && (testExitCode !== 0) !== srcBarrierFailed) {
    v.push(
      `${pair.class_id}: red mirror broken (testExitCode=${testExitCode}, src barrier failed=${srcBarrierFailed})`,
    );
  }

  // evidence-emptiness mirror: an AC claiming pass whose evidence_ref is
  // null/empty/whitespace <-> an addressing passed node whose evidence entries
  // are all content-empty (or absent). Content-emptiness is judged the same way
  // on both sides (trim) so the fixture STATE is isomorphic; only the two
  // implementations' checks (trim vs length) differ — that is the branch under test.
  const rebuildEvidenceEmpty = acsClaimingPassWithoutEvidence(state).length > 0;
  const srcEvidenceEmpty = graph.nodes.some(
    (n) =>
      n.kind === 'implement' &&
      n.status === 'passed' &&
      n.acceptance_refs.length > 0 &&
      n.evidence_refs.every((e) => (e.command ?? e.path ?? e.url ?? e.summary ?? '').trim() === ''),
  );
  if (pair.class_id !== 'empty-degenerate' && rebuildEvidenceEmpty !== srcEvidenceEmpty) {
    v.push(
      `${pair.class_id}: evidence-emptiness mirror broken (rebuild=${rebuildEvidenceEmpty}, src=${srcEvidenceEmpty})`,
    );
  }

  // AC-count mirror (exempt for the documented degenerate asymmetry).
  if (
    pair.class_id !== 'empty-degenerate' &&
    state.acceptance_criteria.length !== pair.src.workItem.acceptance_criteria.length
  ) {
    v.push(`${pair.class_id}: AC-count mirror broken`);
  }

  // degenerate class shape guards.
  if (pair.class_id === 'empty-degenerate') {
    if (state.items.length !== 0 || state.acceptance_criteria.length !== 0) {
      v.push('empty-degenerate: rebuild side must be items=0, AC=0');
    }
    if (graph.nodes.length !== 0) v.push('empty-degenerate: src side must be nodes=[]');
    if (!pair.asymmetry_note) v.push('empty-degenerate: asymmetry_note is required');
  }

  return v;
}
