import { describe, expect, test } from 'bun:test';
import { assembleCompletionFromGraph, deriveAcVerdicts } from '~/core/autopilot-complete';
import { type Autopilot, type AutopilotNode, autopilot } from '~/schemas/autopilot';
import type { AcOracle, WorkItem } from '~/schemas/work-item';

// ── ac-4 (ADR-0024 ③ JUDGE): an oracle-present AC may not close to `pass` unless
// its oracle is satisfied. An oracle-ABSENT AC keeps the EXACT prior closure
// behavior (regression-safe; presence-gated). ──────────────────────────────────

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
    autopilot_id: 'orch_oracletest',
    work_item_id: 'wi_oracletest',
    root_goal: 'goal',
    approval_gate: { status: 'not_required', source: 'small_reversible_policy' },
    nodes,
    caps: { fix_per_node: 2, switch_per_node: 1, converge_rounds: 3 },
    continue_policy: {},
    stop_conditions: [],
  });

const oracleMap = (oracle: AcOracle): Map<string, AcOracle> => new Map([['ac-1', oracle]]);

const dynamicOracle: AcOracle = {
  verification_method: 'dynamic_test',
  maps_to: 'ac-1',
  direction: 'forward',
};
const staticOracle: AcOracle = {
  verification_method: 'static_scan',
  maps_to: 'src/x.ts',
  direction: 'forward',
};
const softOracle: AcOracle = {
  verification_method: 'soft_judgment',
  maps_to: 'ac-1',
  direction: 'forward',
};

// Evidence kinds: a recorded test/scan/file ref vs an ack-only note.
const fileEv = (path: string) => ({ kind: 'file' as const, path, summary: `re-scan ${path}` });
const cmdEv = (command: string) => ({ kind: 'command' as const, command, summary: 'ran' });
const noteEv = (summary: string) => ({ kind: 'note' as const, summary });

const workItemWithOracle = (oracle: AcOracle): WorkItem =>
  ({
    id: 'wi_oracletest',
    changed_files: ['src/x.ts'],
    goal: 'the goal',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'ac-1 is met', verdict: 'unverified', evidence: [], oracle },
    ],
  }) as unknown as WorkItem;

describe('deriveAcVerdicts oracle gate (ac-4: oracle-present AC needs its oracle satisfied to close pass)', () => {
  // (a) oracle-present AC WITH satisfying evidence → closes pass.
  test('dynamic_test oracle + closing test evidence → pass (satisfied by existing closing-evidence rule)', () => {
    const graph = graphWith([
      node({
        id: 'N3',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        evidence_refs: [cmdEv('bun test')],
      }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1'], oracleMap(dynamicOracle));
    expect(v?.verdict).toBe('pass');
  });

  test('static_scan oracle + recorded re-scan file evidence → pass', () => {
    const graph = graphWith([
      node({
        id: 'N3',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        evidence_refs: [fileEv('scan.sarif')],
      }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1'], oracleMap(staticOracle));
    expect(v?.verdict).toBe('pass');
  });

  test('soft_judgment oracle + a review/decision note evidence → pass', () => {
    const graph = graphWith([
      node({
        id: 'N3',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        evidence_refs: [noteEv('reviewer approved')],
      }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1'], oracleMap(softOracle));
    expect(v?.verdict).toBe('pass');
  });

  // (b) oracle-present AC WITHOUT satisfying evidence → NOT pass + reasons/notes naming AC+oracle.
  test('dynamic_test oracle but NO closing evidence → unverified (not pass) + note names AC+oracle', () => {
    const graph = graphWith([
      node({ id: 'N3', acceptance_refs: ['ac-1'], status: 'passed', evidence_refs: [] }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1'], oracleMap(dynamicOracle));
    expect(v?.verdict).not.toBe('pass');
    expect(v?.verdict).toBe('unverified');
  });

  // (c) static_scan oracle with no recorded re-scan evidenceRef → unverified (NOT auto-pass).
  // ADR-0018 graceful-degrade: a note-only "looks clean" ack is not a recorded re-scan.
  test('static_scan oracle with only a note (no recorded re-scan ref) → unverified, note names the unmet oracle', () => {
    const graph = graphWith([
      node({
        id: 'N3',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        evidence_refs: [noteEv('looks clean')],
      }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1'], oracleMap(staticOracle));
    expect(v?.verdict).toBe('unverified');
    expect(v?.notes ?? '').toMatch(/ac-1/);
    expect(v?.notes ?? '').toMatch(/static_scan|oracle/);
  });

  // (d) REGRESSION: oracle-ABSENT AC closes EXACTLY as before — a note-only passed
  // node still closes pass via hasClosingEvidence (no new constraint applies).
  test('REGRESSION: oracle-absent AC with note-only evidence → pass, exactly as before', () => {
    const graph = graphWith([
      node({
        id: 'N3',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        evidence_refs: [noteEv('done')],
      }),
    ]);
    // no oracle map → legacy path
    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('pass');
    // and explicitly with an empty oracle map (presence-gated: this AC has no oracle)
    const [v2] = deriveAcVerdicts(graph, ['ac-1'], new Map());
    expect(v2?.verdict).toBe('pass');
  });

  // assembleCompletionFromGraph must thread the work item's oracle into the gate.
  test('assembleCompletionFromGraph: static_scan oracle with only a note → criterion not pass, final_verdict not pass', () => {
    const graph = graphWith([
      node({
        id: 'N3',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        evidence_refs: [noteEv('looks clean')],
      }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWithOracle(staticOracle), { now: NOW });
    expect(c.acceptance[0]?.verdict).not.toBe('pass');
    expect(c.final_verdict).not.toBe('pass');
  });

  test('assembleCompletionFromGraph: static_scan oracle WITH a recorded re-scan file → criterion pass', () => {
    const graph = graphWith([
      node({
        id: 'N3',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        evidence_refs: [fileEv('scan.sarif')],
      }),
    ]);
    const c = assembleCompletionFromGraph(graph, workItemWithOracle(staticOracle), { now: NOW });
    expect(c.acceptance[0]?.verdict).toBe('pass');
  });
});
