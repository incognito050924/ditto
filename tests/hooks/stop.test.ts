import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutopilotStore } from '~/core/autopilot-store';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import {
  acgReviewForcesContinuation,
  assuranceSnapshotForcesContinuation,
  autopilotForcesContinuation,
  decisionConflictForcesContinuation,
  dialecticForcesContinuation,
  impactForcesContinuation,
  residualResolvabilityForcesContinuation,
  semanticForcesContinuation,
  stopHandler,
} from '~/hooks/stop';
import { type Dialectic, dialectic as dialecticSchema } from '~/schemas/dialectic';

let repo: string;
let store: WorkItemStore;
let wiId: string;
const SESSION = 'sess-stop';

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-stop-'));
  store = new WorkItemStore(repo);
  const created = await store.create({
    title: 'pw',
    source_request: 'add endpoint',
    goal: 'endpoint returns score',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'returns 200', verdict: 'unverified', evidence: [] },
      { id: 'ac-2', statement: 'rejects empty', verdict: 'unverified', evidence: [] },
      { id: 'ac-3', statement: 'score 0..100', verdict: 'unverified', evidence: [] },
    ],
  });
  wiId = created.id;
  await new SessionPointerStore(repo).set(SESSION, wiId);
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const artifactPath = (name: string) => join(repo, '.ditto', 'local', 'work-items', wiId, name);
const writeArtifact = (name: string, obj: unknown) =>
  writeFile(artifactPath(name), typeof obj === 'string' ? obj : JSON.stringify(obj));
const run = (raw: Record<string, unknown>) =>
  stopHandler({ raw: { session_id: SESSION, ...raw }, repoRoot: repo, env: {} });

const completion = (overrides: Record<string, unknown>) => ({
  schema_version: '0.1.0',
  work_item_id: wiId,
  declared_by: 'main',
  declared_at: '2026-05-26T02:00:00.000Z',
  summary: 'claim',
  changed_files: [],
  verifications: [{ command: 'bun test', exit_code: 0 }],
  unverified: [],
  remaining_risks: [],
  final_verdict: 'pass',
  ...overrides,
});

const autopilot = (overrides: Record<string, unknown>) => ({
  schema_version: '0.1.0',
  autopilot_id: 'orch_test0001',
  work_item_id: wiId,
  mode: 'autopilot',
  root_goal: 'g',
  completion_boundary: 'entire_work_item',
  approval_gate: {
    status: 'not_required',
    source: null,
    approved_at: null,
    approved_by: null,
    evidence_refs: [],
  },
  nodes: [],
  caps: { fix_per_node: 2, switch_per_node: 1 },
  continue_policy: {},
  stop_conditions: [],
  user_interrupt_policy: 'ask_only_for_user_owned_decisions',
  ...overrides,
});

const node = (overrides: Record<string, unknown>) => ({
  id: 'N1',
  kind: 'implement',
  owner: 'implementer',
  purpose: 'do',
  status: 'pending',
  depends_on: [],
  acceptance_refs: [],
  evidence_refs: [],
  attempts: { fix: 0, switch: 0 },
  ...overrides,
});

// A frozen intent conserved with the beforeEach work item (same goal/source/AC ids).
const intent = (overrides: Record<string, unknown>) => ({
  schema_version: '0.1.0',
  work_item_id: wiId,
  source_request: 'add endpoint',
  goal: 'endpoint returns score',
  in_scope: [],
  out_of_scope: [],
  acceptance_criteria: [
    { id: 'ac-1', statement: 'returns 200' },
    { id: 'ac-2', statement: 'rejects empty' },
    { id: 'ac-3', statement: 'score 0..100' },
  ],
  unknowns: [],
  follow_up_candidates: [],
  ...overrides,
});

// Three passing AC + a terminal node covering them; the chain-conserved baseline
// the intent-drift tests perturb a single field of.
const PASSING_ACCEPTANCE = [
  { criterion_id: 'ac-1', verdict: 'pass' },
  { criterion_id: 'ac-2', verdict: 'pass' },
  { criterion_id: 'ac-3', verdict: 'pass' },
];
const coveringNode = node({ status: 'passed', acceptance_refs: ['ac-1', 'ac-2', 'ac-3'] });

describe('stopHandler', () => {
  test('stop_hook_active=true short-circuits to exit 0 (8-iter guard)', async () => {
    await writeArtifact(
      'completion.json',
      completion({ acceptance: [{ criterion_id: 'ac-1', verdict: 'pass' }] }),
    );
    expect((await run({ stop_hook_active: true })).exitCode).toBe(0);
  });

  test('no session_id => exit 0 but warns the Stop completion gate did not run', async () => {
    const out = await stopHandler({ raw: {}, repoRoot: repo, env: {} });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('session_id');
    expect(out.stderr).toContain('did not run');
  });

  test('no session pointer => exit 0 and no session_id warning', async () => {
    const out = await stopHandler({ raw: { session_id: 'unknown' }, repoRoot: repo, env: {} });
    expect(out.exitCode).toBe(0);
    expect(out.stderr ?? '').not.toContain('session_id');
  });

  test('completion claims pass but misses a criterion => exit 2 with reasons', async () => {
    await writeArtifact(
      'completion.json',
      completion({
        acceptance: [
          { criterion_id: 'ac-1', verdict: 'pass' },
          { criterion_id: 'ac-2', verdict: 'pass' },
        ],
      }),
    );
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('missing');
  });

  test('completion with exact passing AC-set => exit 0', async () => {
    await writeArtifact(
      'completion.json',
      completion({
        acceptance: [
          { criterion_id: 'ac-1', verdict: 'pass' },
          { criterion_id: 'ac-2', verdict: 'pass' },
          { criterion_id: 'ac-3', verdict: 'pass' },
        ],
      }),
    );
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  test('intent drift: a conserved chain (intent+autopilot+completion) does not block => exit 0', async () => {
    await writeArtifact('intent.json', intent({}));
    await writeArtifact(
      'autopilot.json',
      autopilot({ root_goal: 'endpoint returns score', nodes: [coveringNode] }),
    );
    await writeArtifact('completion.json', completion({ acceptance: PASSING_ACCEPTANCE }));
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  test('intent drift: root_goal divergence is ADVISORY => exit 0 with non-blocking advisory in stderr', async () => {
    // goal-string divergence is a re-statement-or-drift judgment → surfaced, not
    // blocked (a legitimate reworded re-finalize must still be able to close).
    await writeArtifact('intent.json', intent({}));
    await writeArtifact(
      'autopilot.json',
      autopilot({ root_goal: 'do something else entirely', nodes: [coveringNode] }),
    );
    await writeArtifact('completion.json', completion({ acceptance: PASSING_ACCEPTANCE }));
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('advisory');
    expect(out.stderr).toContain('최상위 목표');
  });

  test('intent drift: malformed intent.json => exit 2 (fail-closed governance floor)', async () => {
    await writeArtifact('intent.json', '{ not valid json');
    await writeArtifact(
      'autopilot.json',
      autopilot({ root_goal: 'endpoint returns score', nodes: [coveringNode] }),
    );
    await writeArtifact('completion.json', completion({ acceptance: PASSING_ACCEPTANCE }));
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('intent.json');
  });

  test('intent drift: intent declares an AC the work item dropped => exit 2 (scope shrink)', async () => {
    await writeArtifact(
      'intent.json',
      intent({
        acceptance_criteria: [
          { id: 'ac-1', statement: 'returns 200' },
          { id: 'ac-2', statement: 'rejects empty' },
          { id: 'ac-3', statement: 'score 0..100' },
          { id: 'ac-4', statement: 'logs the request' },
        ],
      }),
    );
    await writeArtifact(
      'autopilot.json',
      autopilot({ root_goal: 'endpoint returns score', nodes: [coveringNode] }),
    );
    await writeArtifact('completion.json', completion({ acceptance: PASSING_ACCEPTANCE }));
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('intent drift');
    expect(out.stderr).toContain('ac-4');
  });

  test('intent drift (P3): the drift verdict is persisted to metrics.jsonl, de-duped on re-run, exit unchanged', async () => {
    // Same scope-shrink fixture as above → a blocking H1 drift the Stop gate records.
    await writeArtifact(
      'intent.json',
      intent({
        acceptance_criteria: [
          { id: 'ac-1', statement: 'returns 200' },
          { id: 'ac-2', statement: 'rejects empty' },
          { id: 'ac-3', statement: 'score 0..100' },
          { id: 'ac-4', statement: 'logs the request' },
        ],
      }),
    );
    await writeArtifact(
      'autopilot.json',
      autopilot({ root_goal: 'endpoint returns score', nodes: [coveringNode] }),
    );
    await writeArtifact('completion.json', completion({ acceptance: PASSING_ACCEPTANCE }));

    const first = await run({ stop_hook_active: false });
    expect(first.exitCode).toBe(2); // gate verdict unchanged by the side effect
    const afterFirst = await store.readMetrics(wiId);
    expect(afterFirst.length).toBe(1);
    expect(afterFirst[0]?.kind).toBe('intent_drift');
    expect(afterFirst[0]?.source).toBe('stop_hook');
    expect(afterFirst[0]?.hops).toContain('H1');

    // Re-run on the identical state: de-dup keeps it at one record, exit unchanged.
    const second = await run({ stop_hook_active: false });
    expect(second.exitCode).toBe(2);
    expect((await store.readMetrics(wiId)).length).toBe(1);
  });

  test('intent drift (P3): a conserved chain (no drift) writes no metrics record', async () => {
    await writeArtifact('intent.json', intent({}));
    await writeArtifact(
      'autopilot.json',
      autopilot({ root_goal: 'endpoint returns score', nodes: [coveringNode] }),
    );
    await writeArtifact('completion.json', completion({ acceptance: PASSING_ACCEPTANCE }));
    await run({ stop_hook_active: false });
    expect(await store.readMetrics(wiId)).toEqual([]);
  });

  test('final_verdict=pass with all-AC-pass but no runnable verification evidence => exit 2 (G8 ack≠verification)', async () => {
    await writeArtifact(
      'completion.json',
      completion({
        acceptance: [
          { criterion_id: 'ac-1', verdict: 'pass', evidence: [{ kind: 'note', summary: 'ok' }] },
          { criterion_id: 'ac-2', verdict: 'pass' },
          { criterion_id: 'ac-3', verdict: 'pass' },
        ],
        verifications: [],
      }),
    );
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('ack');
  });

  test('no completion artifact + active autopilot has a ready node => exit 2', async () => {
    await writeArtifact('autopilot.json', autopilot({ nodes: [node({ status: 'pending' })] }));
    expect((await run({ stop_hook_active: false })).exitCode).toBe(2);
  });

  // wi_260713w0g: an ABANDONED work item whose autopilot graph was left with a
  // runnable node (an orphaned graph from a mid-run abandon) must NOT keep forcing
  // continuation — the item is already closed by explicit decision. The
  // runnable-node gate must honor terminal status, mirroring the (B) bypass gate.
  test('terminal (abandoned) + autopilot with a runnable node => exit 0 (no re-force on orphaned graph)', async () => {
    await store.update(wiId, (c) => ({ ...c, status: 'abandoned' }));
    await writeArtifact('autopilot.json', autopilot({ nodes: [node({ status: 'running' })] }));
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  // wi_260713w0g: the explicit escape hatch — an autopilot_exempt item closes on
  // completion alone, so a leftover runnable node must not force continuation.
  test('autopilot_exempt + autopilot with a runnable node => exit 0', async () => {
    await store.update(wiId, (c) => ({ ...c, autopilot_exempt: true }));
    await writeArtifact('autopilot.json', autopilot({ nodes: [node({ status: 'running' })] }));
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  test('all three ledgers absent + NON_TERMINAL work item => exit 2 (§M1.4 strong-block 2026-05-31)', async () => {
    // Default work item from beforeEach is status=draft → NON_TERMINAL.
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('no completion.json');
    expect(out.stderr).toContain('done/abandoned');
  });

  test('all three ledgers absent + terminal work item (done) => exit 0', async () => {
    // Take the draft work item to in_progress (re_entry not needed for that)
    // then directly to done. Avoids the partial/unverified/blocked guards.
    await store.update(wiId, (current) => ({ ...current, status: 'in_progress' }));
    await store.update(wiId, (current) => ({
      ...current,
      status: 'done',
      closed_at: '2026-05-31T00:00:00.000Z',
    }));
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  test('all three ledgers absent + terminal work item (abandoned) => exit 0', async () => {
    await store.update(wiId, (current) => ({ ...current, status: 'abandoned' }));
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  // wi_2607083ch: a TERMINAL work item that carries a STALE non-pass completion
  // (e.g. an abandoned item whose completion.json was left at partial) must not
  // re-force continuation — the completion-continuation checks are moot once the
  // work is closed by explicit decision. The prior abandoned test above has NO
  // completion; this one specifically exercises the non-pass completion path.
  // A stale non-pass completion parks an in-scope criterion at unverified without
  // a non_pass_status declaration — the shape that trips nonPassTerminationGate.
  // (next_handoff_path is required by the schema for any non-pass final_verdict.)
  const stalePartialCompletion = () =>
    completion({
      final_verdict: 'partial',
      next_handoff_path: '.ditto/local/handoff/x.md',
      acceptance: [{ criterion_id: 'ac-1', verdict: 'unverified' }],
    });

  test('terminal (abandoned) + a stale NON-PASS completion => exit 0 (no re-force on a closed item)', async () => {
    await store.update(wiId, (c) => ({ ...c, status: 'abandoned' }));
    await writeArtifact('completion.json', stalePartialCompletion());
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  // Guard against over-skipping: only TERMINAL items are exempted. A NON-terminal
  // (in_progress) item with the same non-pass completion still force-continues.
  test('NON-terminal (in_progress) + a NON-PASS completion still => exit 2 (no over-skip)', async () => {
    await store.update(wiId, (c) => ({ ...c, status: 'in_progress' }));
    await writeArtifact('completion.json', stalePartialCompletion());
    expect((await run({ stop_hook_active: false })).exitCode).toBe(2);
  });

  describe('(B) plan→autopilot transition gate (wi_260615xby)', () => {
    // PASSING_ACCEPTANCE closes the completion gate so only the (B) gate decides.
    const passingCompletion = (overrides: Record<string, unknown> = {}) =>
      completion({ acceptance: PASSING_ACCEPTANCE, ...overrides });

    test('non-trivial completion-only close (changed files, no autopilot.json) => exit 2', async () => {
      await writeArtifact('completion.json', passingCompletion({ changed_files: ['src/x.ts'] }));
      const out = await run({ stop_hook_active: false });
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toContain('autopilot을 거치지 않고');
      expect(out.stderr).toContain('ditto autopilot exempt');
    });

    test('autopilot_exempt work item closes on completion alone => exit 0', async () => {
      await store.update(wiId, (c) => ({ ...c, autopilot_exempt: true }));
      await writeArtifact('completion.json', passingCompletion({ changed_files: ['src/x.ts'] }));
      expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
    });

    test('trivial completion-only close (no changed files) does NOT fire the (B) gate => exit 0', async () => {
      await writeArtifact('completion.json', passingCompletion({ changed_files: [] }));
      expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
    });

    test('autopilot.json present (path taken) => (B) gate does not fire => exit 0', async () => {
      await writeArtifact('autopilot.json', autopilot({ nodes: [coveringNode] }));
      await writeArtifact('completion.json', passingCompletion({ changed_files: ['src/x.ts'] }));
      expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
    });

    test('terminal work item (done) with changed-files completion, no autopilot => exit 0', async () => {
      await store.update(wiId, (c) => ({ ...c, status: 'in_progress' }));
      await store.update(wiId, (c) => ({
        ...c,
        status: 'done',
        closed_at: '2026-06-16T00:00:00.000Z',
      }));
      await writeArtifact('completion.json', passingCompletion({ changed_files: ['src/x.ts'] }));
      expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
    });

    test('work item changed_files (completion empty) also triggers => exit 2', async () => {
      await store.update(wiId, (c) => ({ ...c, changed_files: ['src/y.ts'] }));
      await writeArtifact('completion.json', passingCompletion({ changed_files: [] }));
      const out = await run({ stop_hook_active: false });
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toContain('autopilot');
    });

    test('OBJ-1/OBJ-5: a NON-passing completion (handoff/partial checkpoint) does NOT fire the (B) gate', async () => {
      // A partial/handoff completion misses a criterion → completionGate already
      // blocks. The (B) message must stay silent (no double-messaging, and a
      // handoff checkpoint of incomplete work is not a bypass-to-close).
      await writeArtifact(
        'completion.json',
        completion({
          changed_files: ['src/x.ts'],
          acceptance: [{ criterion_id: 'ac-1', verdict: 'pass' }],
        }),
      );
      const out = await run({ stop_hook_active: false });
      expect(out.exitCode).toBe(2); // blocked by completion gate, not (B)
      expect(out.stderr).toContain('missing');
      expect(out.stderr).not.toContain('autopilot을 거치지 않고');
    });

    test('OBJ-2: a fig-leaf autopilot.json with no plan (no implementer node) still fires => exit 2', async () => {
      // autopilot.json PRESENT but degenerate (zero mutating/implementer nodes) is
      // the "플랜 없는 degenerate" bypass (handoff §2 B). A real graph with a
      // passed implementer node passes (the sibling test above).
      await writeArtifact('autopilot.json', autopilot({ nodes: [] }));
      await writeArtifact('completion.json', passingCompletion({ changed_files: ['src/x.ts'] }));
      const out = await run({ stop_hook_active: false });
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toContain('autopilot을 거치지 않고');
    });
  });

  test('approval_gate pending on a ROUTINE plan (no real decision) => exit 2 force-continue (P6, wi_260707loq §1)', async () => {
    // OLD contract yielded exit 0 for ANY pending; the §1 classifier force-continues a
    // routine procedure-punt (no intent-conflict / high-risk / oracle-gap to yield for)
    // so the loop keeps going instead of stalling on a pending nobody approves.
    await writeArtifact(
      'autopilot.json',
      autopilot({
        approval_gate: {
          status: 'pending',
          source: null,
          approved_at: null,
          approved_by: null,
          evidence_refs: [],
        },
        nodes: [node({ status: 'pending' })],
      }),
    );
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('procedure-punt');
  });

  test('approval_gate pending but NO pending implementer node => does not yield; completion gate runs (exit 2)', async () => {
    // Bypass/empty autopilot.json: approval marked pending but no real mutating
    // plan awaits. The yield branch must NOT swallow the completion gate.
    await writeArtifact(
      'autopilot.json',
      autopilot({
        approval_gate: {
          status: 'pending',
          source: null,
          approved_at: null,
          approved_by: null,
          evidence_refs: [],
        },
        // only a verify node (owner=verifier), no pending implementer-owned node
        nodes: [node({ kind: 'verify', owner: 'verifier', status: 'pending' })],
      }),
    );
    // completion claims pass but misses a criterion → completion gate must block.
    await writeArtifact(
      'completion.json',
      completion({
        acceptance: [
          { criterion_id: 'ac-1', verdict: 'pass' },
          { criterion_id: 'ac-2', verdict: 'pass' },
        ],
      }),
    );
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('missing');
  });

  test('degenerate pending autopilot present, NO completion/convergence, NON_TERMINAL => exit 2 (§5#7 pure bypass blocked)', async () => {
    // Pure §5#7: autopilot.json PRESENT, approval_gate pending, but ZERO pending
    // implementer nodes, and NO completion.json / convergence.json. Default work
    // item is draft (NON_TERMINAL). Must hit the strong-block, not exit 0.
    await writeArtifact(
      'autopilot.json',
      autopilot({
        approval_gate: {
          status: 'pending',
          source: null,
          approved_at: null,
          approved_by: null,
          evidence_refs: [],
        },
        nodes: [node({ kind: 'verify', owner: 'verifier', status: 'pending' })],
      }),
    );
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('no real verification path');
  });

  test('approval_gate pending on a HIGH-RISK plan => still yields (exit 0, P3 — never force past a risk decision)', async () => {
    // A declared-risk (irreversible) work item whose plan awaits approval is a real
    // decision to surface — the §1 classifier YIELDS (P3), it must NOT force-continue.
    await store.update(wiId, (w) => ({ ...w, declared_risk: { irreversible: true } }));
    await writeArtifact(
      'autopilot.json',
      autopilot({
        approval_gate: {
          status: 'pending',
          source: null,
          approved_at: null,
          approved_by: null,
          evidence_refs: [],
        },
        nodes: [node({ kind: 'implement', owner: 'implementer', status: 'pending' })],
      }),
    );
    // Even with a failing completion present, a legitimate risk-decision wait yields.
    await writeArtifact(
      'completion.json',
      completion({
        acceptance: [
          { criterion_id: 'ac-1', verdict: 'pass' },
          { criterion_id: 'ac-2', verdict: 'pass' },
        ],
      }),
    );
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  test('only blocked node remains (external/user/safety) => exit 0', async () => {
    await writeArtifact('autopilot.json', autopilot({ nodes: [node({ status: 'blocked' })] }));
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  test('malformed completion.json => exit 2 (fail-closed, not fail-open)', async () => {
    await writeArtifact('completion.json', '{ this is not valid json');
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('malformed');
  });
});

describe('autopilotForcesContinuation', () => {
  const base = autopilot({});
  test('runnable pending node (deps passed) forces continuation', () => {
    expect(
      autopilotForcesContinuation({ ...base, nodes: [node({ status: 'pending' })] } as never),
    ).toBe(true);
  });
  test('approval pending never forces continuation', () => {
    expect(
      autopilotForcesContinuation({
        ...base,
        approval_gate: {
          status: 'pending',
          source: null,
          approved_at: null,
          approved_by: null,
          evidence_refs: [],
        },
        nodes: [node({ status: 'pending' })],
      } as never),
    ).toBe(false);
  });
  test('pending node with unmet deps is not runnable', () => {
    expect(
      autopilotForcesContinuation({
        ...base,
        nodes: [
          node({ id: 'N1', status: 'failed' }),
          node({ id: 'N2', status: 'pending', depends_on: ['N1'] }),
        ],
      } as never),
    ).toBe(false);
  });
  test('all terminal nodes => no continuation', () => {
    expect(
      autopilotForcesContinuation({ ...base, nodes: [node({ status: 'passed' })] } as never),
    ).toBe(false);
  });
});

const passingAcceptance = [
  { criterion_id: 'ac-1', verdict: 'pass' },
  { criterion_id: 'ac-2', verdict: 'pass' },
  { criterion_id: 'ac-3', verdict: 'pass' },
];

describe('stopHandler — ACG review ledger (high-risk needs evidence)', () => {
  test('acc-a: high-risk change without evidence => exit 2 (continuation forced)', async () => {
    await writeArtifact('completion.json', completion({ acceptance: passingAcceptance }));
    await writeArtifact('acg-review.json', {
      kind: 'acg.review-graph.v1',
      files: [
        {
          path: 'src/payment/charge.ts',
          risk: 'high',
          risk_reason: 'no idempotency key',
          unresolved: false,
        },
      ],
      human_review_set: ['src/payment/charge.ts'],
    });
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('high-risk change without evidence');
    expect(out.stderr).toContain('src/payment/charge.ts');
  });

  test('high-risk WITH evidence attached => exit 0 (cleared)', async () => {
    await writeArtifact('completion.json', completion({ acceptance: passingAcceptance }));
    await writeArtifact('acg-review.json', {
      kind: 'acg.review-graph.v1',
      files: [
        {
          path: 'src/payment/charge.ts',
          risk: 'high',
          risk_reason: 'idempotency verified',
          evidence: { kind: 'test' },
          unresolved: false,
        },
        { path: 'src/util/log.ts', risk: 'low', risk_reason: 'noisy log', unresolved: true },
      ],
      human_review_set: ['src/payment/charge.ts'],
    });
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  test('no-op: absent acg-review.json does not change a passing completion (exit 0)', async () => {
    await writeArtifact('completion.json', completion({ acceptance: passingAcceptance }));
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  test('malformed acg-review.json => exit 2 (fail-closed)', async () => {
    await writeArtifact('completion.json', completion({ acceptance: passingAcceptance }));
    await writeArtifact('acg-review.json', '{ not valid json');
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('acg-review.json');
    expect(out.stderr).toContain('malformed');
  });

  test('completion carrying the optional acg_governance slot still passes (no regression)', async () => {
    await writeArtifact(
      'completion.json',
      completion({
        acceptance: passingAcceptance,
        acg_governance: {
          review_graph: '.ditto/local/work-items/wi/acg-review.json',
          unresolved_high_risk: [],
        },
      }),
    );
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  test('un-evidenced high-risk on a journey role uses journey_id identity', async () => {
    await writeArtifact('completion.json', completion({ acceptance: passingAcceptance }));
    await writeArtifact('acg-review.json', {
      kind: 'acg.review-graph.v1',
      files: [
        {
          journey_id: 'jrn-checkout',
          role: 'user_journey',
          risk: 'high',
          risk_reason: 'checkout regressed',
          unresolved: false,
        },
      ],
      human_review_set: ['jrn-checkout'],
    });
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('jrn-checkout');
  });
});

describe('acgReviewForcesContinuation', () => {
  test('high-risk without evidence forces continuation (one reason per file)', () => {
    const reasons = acgReviewForcesContinuation({
      kind: 'acg.review-graph.v1',
      files: [
        { path: 'a.ts', risk: 'high', risk_reason: 'r1', unresolved: false },
        { path: 'b.ts', risk: 'high', risk_reason: 'r2', unresolved: false },
      ],
      human_review_set: [],
    } as never);
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain('a.ts');
  });

  test('high-risk WITH evidence is not a blocker (cleared)', () => {
    expect(
      acgReviewForcesContinuation({
        kind: 'acg.review-graph.v1',
        files: [
          {
            path: 'a.ts',
            risk: 'high',
            risk_reason: 'r',
            evidence: { kind: 'test' },
            unresolved: false,
          },
        ],
        human_review_set: [],
      } as never),
    ).toHaveLength(0);
  });

  test('low/medium-risk files never block (only high-risk needs evidence)', () => {
    expect(
      acgReviewForcesContinuation({
        kind: 'acg.review-graph.v1',
        files: [
          { path: 'a.ts', risk: 'low', risk_reason: 'r', unresolved: true },
          { path: 'b.ts', risk: 'medium', risk_reason: 'r', unresolved: true },
        ],
        human_review_set: [],
      } as never),
    ).toHaveLength(0);
  });

  test('empty ledger => no continuation', () => {
    expect(
      acgReviewForcesContinuation({
        kind: 'acg.review-graph.v1',
        files: [],
        human_review_set: [],
      } as never),
    ).toHaveLength(0);
  });
});

const assuranceSnapshot = (results: unknown[]) => ({
  schema_version: '0.1.0',
  kind: 'acg.assurance-snapshot.v1',
  produced_by: 'agent',
  produced_at: '2026-06-04T00:00:00.000Z',
  at: '2026-06-04T00:00:00.000Z',
  trigger: 'per_change',
  change_ref: null,
  results,
});

const impactGraph = (overrides: Record<string, unknown>) => ({
  schema_version: '0.1.0',
  kind: 'acg.impact-graph.v1',
  work_item_id: wiId,
  produced_by: 'agent',
  produced_at: '2026-06-04T00:00:00.000Z',
  change_target: 'src/x.ts: foo (signature)',
  change_type: 'signature',
  affected_nodes: [],
  unresolved: [],
  ...overrides,
});

const semanticCompat = (
  verdict: Record<string, unknown>,
  characterization?: Record<string, unknown>,
) => ({
  schema_version: '0.1.0',
  kind: 'acg.semantic-compatibility.v1',
  work_item_id: wiId,
  produced_by: 'agent',
  produced_at: '2026-06-05T00:00:00.000Z',
  changes: [
    {
      before: 'getUser(): User | null',
      after: 'getUser(): User',
      old_meaning: 'absent user returns null',
      business_assumptions: [],
      compatibility: 'breaking',
      ...(characterization ? { characterization } : {}),
      verdict,
    },
  ],
});

describe('stopHandler — ACG fitness (AssuranceSnapshot) ledger', () => {
  test('a failed fitness function forces continuation (exit 2)', async () => {
    await writeArtifact('completion.json', completion({ acceptance: passingAcceptance }));
    await writeArtifact(
      'assurance-snapshot.json',
      assuranceSnapshot([
        { function_id: 'ff-sb-version', outcome: 'fail', violations: 2, new_violations: 1 },
      ]),
    );
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('fitness');
    expect(out.stderr).toContain('ff-sb-version');
  });

  test('all-pass/skip snapshot does not block a passing completion (exit 0)', async () => {
    await writeArtifact('completion.json', completion({ acceptance: passingAcceptance }));
    await writeArtifact(
      'assurance-snapshot.json',
      assuranceSnapshot([
        { function_id: 'ff-a', outcome: 'pass' },
        { function_id: 'ff-b', outcome: 'skip' },
      ]),
    );
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  test('malformed assurance-snapshot.json => exit 2 (fail-closed)', async () => {
    await writeArtifact('completion.json', completion({ acceptance: passingAcceptance }));
    await writeArtifact('assurance-snapshot.json', '{ not valid');
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('assurance-snapshot.json');
    expect(out.stderr).toContain('malformed');
  });
});

describe('stopHandler — ACG impact (ImpactGraph) ledger', () => {
  test('an unresolved impact forces continuation (exit 2)', async () => {
    await writeArtifact('completion.json', completion({ acceptance: passingAcceptance }));
    await writeArtifact(
      'impact-graph.json',
      impactGraph({
        unresolved: [
          { kind: 'cross_repo', path: 'src/api/client.ts', reason: 'consumed by another repo' },
        ],
      }),
    );
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('impact: unresolved');
    expect(out.stderr).toContain('src/api/client.ts');
  });

  test('a graph with only resolved affected_nodes (no unresolved) does not block (exit 0)', async () => {
    await writeArtifact('completion.json', completion({ acceptance: passingAcceptance }));
    await writeArtifact(
      'impact-graph.json',
      impactGraph({
        affected_nodes: [
          { kind: 'direct_caller', path: 'src/y.ts', symbol: 'bar', handled: false },
        ],
        unresolved: [],
      }),
    );
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  test('malformed impact-graph.json => exit 2 (fail-closed)', async () => {
    await writeArtifact('completion.json', completion({ acceptance: passingAcceptance }));
    await writeArtifact('impact-graph.json', '{ not valid');
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('impact-graph.json');
    expect(out.stderr).toContain('malformed');
  });
});

describe('assuranceSnapshotForcesContinuation', () => {
  test('one reason per failed function; pass/skip ignored', () => {
    const reasons = assuranceSnapshotForcesContinuation({
      results: [
        { function_id: 'a', outcome: 'fail', new_violations: 3 },
        { function_id: 'b', outcome: 'pass' },
        { function_id: 'c', outcome: 'skip' },
        { function_id: 'd', outcome: 'fail' },
      ],
    } as never);
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain('a');
    expect(reasons[0]).toContain('3');
  });

  test('empty results => no continuation', () => {
    expect(assuranceSnapshotForcesContinuation({ results: [] } as never)).toHaveLength(0);
  });
});

describe('impactForcesContinuation', () => {
  test('one reason per unresolved entry', () => {
    const reasons = impactForcesContinuation({
      unresolved: [
        { kind: 'journey_unknown', path: 'src/route.ts', reason: 'no journey map' },
        { kind: 'reflection', path: 'src/dyn.ts', reason: 'reflective call' },
      ],
    } as never);
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain('journey_unknown');
    expect(reasons[1]).toContain('src/dyn.ts');
  });

  test('no unresolved => no continuation', () => {
    expect(impactForcesContinuation({ unresolved: [] } as never)).toHaveLength(0);
  });
});

describe('stopHandler — ACG semantic (SemanticCompatibility) ledger', () => {
  test('unintended meaning break (semantic_safe=no, not intended) forces continuation (exit 2)', async () => {
    await writeArtifact('completion.json', completion({ acceptance: passingAcceptance }));
    await writeArtifact(
      'semantic-compatibility.json',
      semanticCompat({ type_safe: true, semantic_safe: 'no', intended_breaking: false }),
    );
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('semantic: 의도치 않은 의미 파손');
  });

  test('unverified meaning forces continuation (exit 2)', async () => {
    await writeArtifact('completion.json', completion({ acceptance: passingAcceptance }));
    await writeArtifact(
      'semantic-compatibility.json',
      semanticCompat({ type_safe: true, semantic_safe: 'unverified' }),
    );
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('semantic: 의미 호환성 미검증');
  });

  test('declared-intended break (semantic_safe=no, intended_breaking) does not block (exit 0)', async () => {
    await writeArtifact('completion.json', completion({ acceptance: passingAcceptance }));
    await writeArtifact(
      'semantic-compatibility.json',
      semanticCompat({ type_safe: true, semantic_safe: 'no', intended_breaking: true }),
    );
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  test('verified-safe meaning (semantic_safe=yes, reproducible) does not block (exit 0)', async () => {
    await writeArtifact('completion.json', completion({ acceptance: passingAcceptance }));
    await writeArtifact(
      'semantic-compatibility.json',
      // yes now requires reproducibility (OBJ-43 O5) AND, for an agent, a cited
      // characterization test (B / sv1 O6) — without either the artifact is
      // malformed and fail-closes; with both it clears.
      semanticCompat(
        {
          type_safe: true,
          semantic_safe: 'yes',
          reproducibility: { model_version: 'claude-opus-4-8' },
        },
        {
          exists: true,
          test_ref: 'tests/user.test.ts::keeps null-absence',
          candidate: null,
          adequacy: 'l1_met',
        },
      ),
    );
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  test('malformed semantic-compatibility.json => exit 2 (fail-closed)', async () => {
    await writeArtifact('completion.json', completion({ acceptance: passingAcceptance }));
    await writeArtifact('semantic-compatibility.json', '{ not valid');
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('semantic-compatibility.json');
    expect(out.stderr).toContain('malformed');
  });
});

describe('semanticForcesContinuation', () => {
  const change = (verdict: Record<string, unknown>, before = 'a', after = 'b') => ({
    before,
    after,
    old_meaning: 'm',
    verdict,
  });
  const sem = (...changes: ReturnType<typeof change>[]) => ({ changes }) as never;

  test('semantic_safe=no without intended_breaking → one reason', () => {
    expect(
      semanticForcesContinuation(sem(change({ semantic_safe: 'no', intended_breaking: false }))),
    ).toHaveLength(1);
    expect(semanticForcesContinuation(sem(change({ semantic_safe: 'no' })))).toHaveLength(1); // intended_breaking absent
  });
  test('semantic_safe=unverified → one reason', () => {
    expect(semanticForcesContinuation(sem(change({ semantic_safe: 'unverified' })))).toHaveLength(
      1,
    );
  });
  test('semantic_safe=no with intended_breaking, or =yes → no reason', () => {
    expect(
      semanticForcesContinuation(sem(change({ semantic_safe: 'no', intended_breaking: true }))),
    ).toHaveLength(0);
    expect(semanticForcesContinuation(sem(change({ semantic_safe: 'yes' })))).toHaveLength(0);
  });

  // G4 multi-change: every blocking pair contributes a reason.
  test('two breaking pairs → both summed into reasons', () => {
    const reasons = semanticForcesContinuation(
      sem(
        change({ semantic_safe: 'unverified' }, 'f(): A', 'f(): B'),
        change({ semantic_safe: 'no', intended_breaking: false }, 'g(): C', 'g(): D'),
      ),
    );
    expect(reasons).toHaveLength(2);
    expect(reasons.some((r) => r.includes('f(): A → f(): B'))).toBe(true);
    expect(reasons.some((r) => r.includes('g(): C → g(): D'))).toBe(true);
  });
  test('one pair resolved + one unresolved → only the unresolved blocks', () => {
    const reasons = semanticForcesContinuation(
      sem(
        change({ semantic_safe: 'no', intended_breaking: true }, 'f(): A', 'f(): B'),
        change({ semantic_safe: 'unverified' }, 'g(): C', 'g(): D'),
      ),
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('g(): C → g(): D');
  });
  test('all pairs cleared (intended/yes) → no reason', () => {
    expect(
      semanticForcesContinuation(
        sem(
          change({ semantic_safe: 'no', intended_breaking: true }, 'f', 'f2'),
          change({ semantic_safe: 'yes' }, 'g', 'g2'),
        ),
      ),
    ).toHaveLength(0);
  });
});

describe('stopHandler — knowledge-update gate (carrier-driven, G1)', () => {
  const carrier = (overrides: Record<string, unknown>) => ({
    schema_version: '0.1.0',
    triggers: { adr_worthy_decision: false, new_agreed_term: false, repeated_pattern: false },
    delta: { decisions: 0, glossary_terms: 0, patterns: 0, learnings: 0 },
    ...overrides,
  });
  const knowledgeNode = (overrides: Record<string, unknown>) =>
    node({
      id: 'NK',
      kind: 'knowledge',
      owner: 'knowledge-curator',
      status: 'passed',
      acceptance_refs: ['ac-1', 'ac-2', 'ac-3'],
      ...overrides,
    });

  // (a) trigger fired but nothing recorded → under-recording → Stop blocks.
  test('terminal knowledge node + carrier with a fired trigger but delta 0 => exit 2', async () => {
    await writeArtifact('completion.json', completion({ acceptance: PASSING_ACCEPTANCE }));
    await writeArtifact('autopilot.json', autopilot({ nodes: [knowledgeNode({})] }));
    await writeArtifact(
      'knowledge-gate.json',
      carrier({
        triggers: { adr_worthy_decision: true, new_agreed_term: false, repeated_pattern: false },
      }),
    );
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('knowledge');
    expect(out.stderr).toContain('under-recording');
  });

  // (b) no trigger + empty record carrier → valid explicit skip → Stop passes.
  test('terminal knowledge node + no-trigger empty carrier => exit 0 (valid skip)', async () => {
    await writeArtifact('completion.json', completion({ acceptance: PASSING_ACCEPTANCE }));
    await writeArtifact('autopilot.json', autopilot({ nodes: [knowledgeNode({})] }));
    await writeArtifact('knowledge-gate.json', carrier({}));
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  // (c) no knowledge node in the graph → gate inert even if a carrier exists
  // (ADR-0010 (b): the gate never forces "record something").
  test('no knowledge node in graph => gate inert (exit 0) even with a fired-trigger carrier', async () => {
    await writeArtifact('completion.json', completion({ acceptance: PASSING_ACCEPTANCE }));
    await writeArtifact(
      'autopilot.json',
      autopilot({ nodes: [node({ status: 'passed', acceptance_refs: ['ac-1', 'ac-2', 'ac-3'] })] }),
    );
    await writeArtifact(
      'knowledge-gate.json',
      carrier({
        triggers: { adr_worthy_decision: true, new_agreed_term: false, repeated_pattern: false },
      }),
    );
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  // Inert when the knowledge node exists but no carrier was written (no-trigger
  // work that recorded nothing is a valid explicit skip — never blocks).
  test('terminal knowledge node but no carrier => gate inert (exit 0)', async () => {
    await writeArtifact('completion.json', completion({ acceptance: PASSING_ACCEPTANCE }));
    await writeArtifact('autopilot.json', autopilot({ nodes: [knowledgeNode({})] }));
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  // Malformed carrier = gate-input violation → fail closed, like every ledger.
  test('malformed knowledge-gate.json => exit 2 (fail-closed)', async () => {
    await writeArtifact('completion.json', completion({ acceptance: PASSING_ACCEPTANCE }));
    await writeArtifact('autopilot.json', autopilot({ nodes: [knowledgeNode({})] }));
    await writeArtifact('knowledge-gate.json', '{ not valid');
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('knowledge-gate.json');
    expect(out.stderr).toContain('malformed');
  });
});

describe('stopHandler — residual resolvability gate (ac-2 runtime wiring)', () => {
  // A passing completion (all-AC pass, ran a command) carrying ONE residual. The
  // superRefine forbids an in-scope (out_of_scope=false) unverified on a pass, so
  // the residual is out_of_scope=true; the gate inspects resolvability regardless.
  const passingWithResidual = (residual: Record<string, unknown>) =>
    completion({
      acceptance: PASSING_ACCEPTANCE,
      unverified: [{ item: 'flaky path X', reason: 'parked', out_of_scope: true, ...residual }],
    });

  // (a) parked-resolvable bypass: out_of_scope=true but labeled agent_resolvable.
  test('passing completion with an agent_resolvable residual => exit 2, reason mentions resolvable', async () => {
    await writeArtifact(
      'completion.json',
      passingWithResidual({ resolvability: 'agent_resolvable' }),
    );
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('해결 가능');
  });

  // (b) accepted_tradeoff WITH grounding → not blocked by THIS gate.
  test('accepted_tradeoff residual WITH grounding does not block this gate => exit 0', async () => {
    await writeArtifact(
      'completion.json',
      passingWithResidual({ resolvability: 'accepted_tradeoff', grounding: 'ADR-0017' }),
    );
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  // (c) ungrounded blocked_external → exit 2.
  test('ungrounded blocked_external residual => exit 2', async () => {
    await writeArtifact(
      'completion.json',
      passingWithResidual({ resolvability: 'blocked_external' }),
    );
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('외부 요인');
  });

  // (d) ungrounded user_decision → exit 2 with a user-decision-surface reason.
  test('ungrounded user_decision residual => exit 2 with a deferred_needs_user_ok reason', async () => {
    await writeArtifact('completion.json', passingWithResidual({ resolvability: 'user_decision' }));
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('사용자 승인 대기');
  });

  // (e) a NON-passing completion (would-close=false) must NOT add the residual
  // reason — no double-message on a completion that already fails its own gate.
  test('NON-passing completion (misses a criterion) does NOT add the resolvability reason', async () => {
    await writeArtifact(
      'completion.json',
      completion({
        acceptance: [{ criterion_id: 'ac-1', verdict: 'pass' }],
        // an agent_resolvable residual would block IF the gate fired here
        unverified: [{ item: 'flaky path X', reason: 'parked', resolvability: 'agent_resolvable' }],
        final_verdict: 'fail',
        next_handoff_path: 'handoff.md',
      }),
    );
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2); // blocked by completion gate (missing criteria), not this gate
    expect(out.stderr).toContain('missing');
    expect(out.stderr).not.toContain('parked (resolve it');
  });

  // (f) the direct-verify path: completion.json present with NO autopilot.json
  // still triggers (it does not require an autopilot run). Mark out_of_scope=true
  // so the (B) bypass gate does not also fire (no changed files either).
  test('completion.json present with NO autopilot.json (direct verify) still triggers => exit 2', async () => {
    await writeArtifact(
      'completion.json',
      passingWithResidual({ resolvability: 'agent_resolvable' }),
    );
    // no autopilot.json written
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('해결 가능');
  });
});

describe('stopHandler — residual-risk-record gate (ac-3 completion-side, riskRecordBlockers)', () => {
  // A passing completion (all-AC pass, ran a command) carrying ONE structured
  // remaining_risk_record. Unlike an in-scope `unverified` (forbidden on a pass by the
  // superRefine), `remaining_risk_records` is unconstrained on a pass, so a would-close
  // completion may carry one; the gate routes it through the SAME default-DENY
  // classifier (`riskRecordBlockers`) the unverified[] residual gate uses (R11).
  const passingWithRiskRecord = (rec: Record<string, unknown>) =>
    completion({ acceptance: PASSING_ACCEPTANCE, remaining_risk_records: [rec] });

  // a parked agent_resolvable record ALWAYS blocks (parking what the agent can resolve
  // is the anti-pattern) — mirrors how unverified[]/ac-1 blocks.
  test('agent_resolvable-record-blocks-Stop: a parked agent_resolvable risk record => exit 2', async () => {
    await writeArtifact(
      'completion.json',
      passingWithRiskRecord({
        risk: 'a missing null guard on the new path',
        resolvability: 'agent_resolvable',
      }),
    );
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('해결 가능');
  });

  // a blocked_external record WITH grounding releases (genuine residual).
  test('blocked_external-releases: a grounded blocked_external risk record => exit 0', async () => {
    await writeArtifact(
      'completion.json',
      passingWithRiskRecord({
        risk: 'upstream vendor API outage',
        resolvability: 'blocked_external',
        grounding: 'vendor status page; ADR-0018 graceful-degrade',
      }),
    );
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  // R5/ADR-0018: a tool-absence record is blocked_external+grounding (releases),
  // never agent_resolvable.
  test('R5: an optional-tool-absence risk is blocked_external+grounding => releases (exit 0)', async () => {
    await writeArtifact(
      'completion.json',
      passingWithRiskRecord({
        risk: 'CodeQL re-scan not run (analyzer absent)',
        resolvability: 'blocked_external',
        grounding: 'ADR-0018: optional tool absent — graceful degrade',
      }),
    );
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  // an ungrounded blocked_external record blocks (default-deny on ungrounded residual).
  test('an ungrounded blocked_external risk record => exit 2', async () => {
    await writeArtifact(
      'completion.json',
      passingWithRiskRecord({ risk: 'flaky integration path', resolvability: 'blocked_external' }),
    );
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('외부 요인');
  });

  // Regression: a pass completion with NO remaining_risk_records behaves exactly as
  // before — the global Stop gate is unchanged when the field is absent.
  test('regression: a pass completion with NO remaining_risk_records => exit 0 (unchanged)', async () => {
    await writeArtifact('completion.json', completion({ acceptance: PASSING_ACCEPTANCE }));
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });
});

describe('residualResolvabilityForcesContinuation', () => {
  const wi = { acceptance_criteria: [{ id: 'ac-1' }, { id: 'ac-2' }, { id: 'ac-3' }] };
  const comp = (unverified: unknown[]) => ({ unverified });

  test('agent_resolvable blocks; reason mentions resolvable', () => {
    const reasons = residualResolvabilityForcesContinuation(
      comp([{ item: 'x', reason: 'parked', resolvability: 'agent_resolvable' }]) as never,
      wi as never,
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('해결 가능');
  });

  test('user_decision (ungrounded) → a deferred_needs_user_ok reason, distinct wording', () => {
    const reasons = residualResolvabilityForcesContinuation(
      comp([{ item: 'x', reason: 'r', resolvability: 'user_decision' }]) as never,
      wi as never,
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('사용자 승인 대기');
  });

  test('no blockers => empty array', () => {
    expect(residualResolvabilityForcesContinuation(comp([]) as never, wi as never)).toHaveLength(0);
  });
});

describe('decisionConflictForcesContinuation (ADR-0020: fail-closed block + always-disclose)', () => {
  const carrier = (
    conflicts: Array<Record<string, unknown>>,
    mode: 'interactive' | 'autopilot' = 'autopilot',
  ) => ({ schema_version: '0.1.0', mode, conflicts }) as never;
  const conflict = (over: Record<string, unknown> = {}) => ({
    adr_id: 'ADR-0006',
    kind: 'forbid',
    level: 'method',
    basis: 'work adds a TS-AST analyzer; ADR-0006 mandates CodeQL only',
    ...over,
  });

  test('absent carrier → inert (no reasons, no advisories)', () => {
    const r = decisionConflictForcesContinuation(undefined);
    expect(r.reasons).toHaveLength(0);
    expect(r.advisories).toHaveLength(0);
  });

  test('intent conflict under autopilot → blocks (reason), not a mere advisory', () => {
    const r = decisionConflictForcesContinuation(carrier([conflict({ level: 'intent' })]));
    expect(r.reasons).toHaveLength(1);
    expect(r.advisories).toHaveLength(0);
    expect(r.reasons[0]).toContain('ADR-0006'); // basis/adr surfaced in the blocking line
    expect(r.reasons[0]).toContain('CodeQL');
  });

  test('method conflict (auto-aligned) → NOT blocking but STILL disclosed (transparency)', () => {
    const r = decisionConflictForcesContinuation(carrier([conflict({ level: 'method' })]));
    expect(r.reasons).toHaveLength(0);
    expect(r.advisories).toHaveLength(1);
    expect(r.advisories[0]).toContain('ADR-0006');
    expect(r.advisories[0]).toContain('CodeQL'); // basis is in the OUTPUT, never silent
  });

  test('prefer conflict → disclosed advisory only, never blocks', () => {
    const r = decisionConflictForcesContinuation(carrier([conflict({ kind: 'prefer' })]));
    expect(r.reasons).toHaveLength(0);
    expect(r.advisories).toHaveLength(1);
  });

  test('mixed: method aligns (advisory) while intent blocks (reason) — both surface', () => {
    const r = decisionConflictForcesContinuation(
      carrier([
        conflict({ adr_id: 'ADR-0006', level: 'method' }),
        conflict({ adr_id: 'ADR-0005', level: 'intent' }),
      ]),
    );
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toContain('ADR-0005');
    expect(r.advisories).toHaveLength(1);
    expect(r.advisories[0]).toContain('ADR-0006');
  });

  test('empty conflict list → inert', () => {
    const r = decisionConflictForcesContinuation(carrier([]));
    expect(r.reasons).toHaveLength(0);
    expect(r.advisories).toHaveLength(0);
  });
});

// wi_260707loq §1 — Stop-hook yield precedence classifier. The old broad early-return
// yielded exit 0 for ANY pending; the classifier is ORDERED: YIELDS (P1 valid fork,
// P2 intent-conflict, P3 high-risk, P4 oracle-gap) before FORCES (P5 incomplete fork,
// P6 routine procedure-punt); malformed (P0) fail-closes outermost. All disk-derived.
describe('stopHandler — yield precedence classifier (wi_260707loq §1)', () => {
  const forkCondition = (present: boolean, basis: string) => ({ present, basis });
  const directionFork = (over: Record<string, unknown> = {}) => ({
    schema_version: '0.1.0',
    mode: 'autopilot',
    node_id: 'N1',
    purpose_change: forkCondition(true, 'the chosen path grows the AC id-set'),
    no_clear_advantage: forkCondition(true, 'both options score equally on the intent'),
    intent_cannot_break_tie: forkCondition(true, 'the frozen intent is silent on the tie'),
    ...over,
  });
  const pendingGate = {
    status: 'pending',
    source: null,
    approved_at: null,
    approved_by: null,
    evidence_refs: [],
  };
  const pendingImplNode = node({ kind: 'implement', owner: 'implementer', status: 'pending' });

  // ── P1: a VALID 3-condition fork yields (ac-2) ──────────────────────────────
  test('P1: a valid 3-condition direction fork yields => exit 0', async () => {
    await writeArtifact('direction-fork.json', directionFork());
    // No autopilot/completion — without the fork this draft item would strong-block (exit 2).
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  // ── P5: a PRESENT-but-INCOMPLETE fork force-continues + names the gap (ac-2) ──
  test('P5: a fork missing a condition => exit 2 naming the missing condition', async () => {
    await writeArtifact(
      'direction-fork.json',
      directionFork({ no_clear_advantage: forkCondition(false, '') }),
    );
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('방향 분기'); // fork-incomplete prefix Koreanized (#30); `direction fork` anchor kept
    expect(out.stderr).toContain('no_clear_advantage');
  });

  test('P5: a fork with an EMPTY basis => exit 2 (fail-closed, evidence required)', async () => {
    await writeArtifact(
      'direction-fork.json',
      directionFork({ intent_cannot_break_tie: forkCondition(true, '   ') }),
    );
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('intent_cannot_break_tie');
  });

  // ── P0: malformed carrier fail-closes (outermost) ───────────────────────────
  test('P0: malformed direction-fork.json => exit 2 malformed (fail-closed, precedes every yield)', async () => {
    await writeArtifact('direction-fork.json', '{ not valid json');
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('malformed');
    expect(out.stderr).toContain('direction-fork.json');
  });

  // ── P2: ADR-0020 intent-conflict pending yields (ac-7, must not regress) ─────
  test('P2: an intent-conflict pending plan yields => exit 0', async () => {
    await writeArtifact('decision-conflict.json', {
      schema_version: '0.1.0',
      mode: 'autopilot',
      conflicts: [
        {
          adr_id: 'ADR-0006',
          kind: 'forbid',
          level: 'intent',
          basis: 'the request itself wants what ADR-0006 forbids',
        },
      ],
    });
    await writeArtifact(
      'autopilot.json',
      autopilot({ approval_gate: pendingGate, nodes: [pendingImplNode] }),
    );
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  // ── P4: ADR-0024 oracle-gap pending yields ──────────────────────────────────
  test('P4: an oracle-gap pending plan yields => exit 0', async () => {
    // Assignment IS in play (ac-1 has an oracle) but ac-2 — covered by the design
    // node — has none: the gap a pending plan awaits.
    await store.update(wiId, (w) => ({
      ...w,
      acceptance_criteria: w.acceptance_criteria.map((ac) =>
        ac.id === 'ac-1'
          ? {
              ...ac,
              oracle: {
                verification_method: 'soft_judgment',
                maps_to: 'ac-1',
                direction: 'backward',
              },
            }
          : ac,
      ),
    }));
    await writeArtifact(
      'autopilot.json',
      autopilot({
        approval_gate: pendingGate,
        nodes: [
          node({
            id: 'D1',
            kind: 'design',
            owner: 'planner',
            status: 'passed',
            acceptance_refs: ['ac-1', 'ac-2'],
          }),
          pendingImplNode,
        ],
      }),
    );
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  // ── P6: routine punt force-continues + records the decision (ac-1) ───────────
  test('P6: a routine pending force-continues (exit 2) and RECORDS procedure_punt_continued once', async () => {
    await writeArtifact(
      'autopilot.json',
      autopilot({ approval_gate: pendingGate, nodes: [pendingImplNode] }),
    );
    const out1 = await run({ stop_hook_active: false });
    expect(out1.exitCode).toBe(2);
    expect(out1.stderr).toContain('procedure-punt');
    // dedup: a second Stop on the same pending state records nothing new.
    const out2 = await run({ stop_hook_active: false });
    expect(out2.exitCode).toBe(2);
    const decisions = await new AutopilotStore(repo).readDecisions(wiId);
    const punts = decisions.filter((d) => d.decision === 'procedure_punt_continued');
    expect(punts).toHaveLength(1);
    expect(punts[0]?.node_id).toContain('N1');
  });

  // ── NEGATIVE: never force-continue past a real decision (P2/P3/P4 yields) ─────
  test('NEGATIVE: a high-risk pending is NEVER force-continued (no procedure_punt recorded)', async () => {
    await store.update(wiId, (w) => ({ ...w, declared_risk: { non_local: true } }));
    await writeArtifact(
      'autopilot.json',
      autopilot({ approval_gate: pendingGate, nodes: [pendingImplNode] }),
    );
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
    const decisions = await new AutopilotStore(repo).readDecisions(wiId);
    expect(decisions.some((d) => d.decision === 'procedure_punt_continued')).toBe(false);
  });

  test('NEGATIVE: an intent-conflict pending is NEVER force-continued', async () => {
    await writeArtifact('decision-conflict.json', {
      schema_version: '0.1.0',
      mode: 'autopilot',
      conflicts: [
        {
          adr_id: 'ADR-0005',
          kind: 'require',
          level: 'intent',
          basis: 'request contradicts ADR-0005',
        },
      ],
    });
    await writeArtifact(
      'autopilot.json',
      autopilot({ approval_gate: pendingGate, nodes: [pendingImplNode] }),
    );
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
    const decisions = await new AutopilotStore(repo).readDecisions(wiId);
    expect(decisions.some((d) => d.decision === 'procedure_punt_continued')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ac-4 clause 2 (wi_260623uap): the dialectic oracle gate must check that a
// backward-finding objection's `maps_to` ANCHOR actually resolves — not just
// that the string is present + severity admissible. Only file:line / file-path
// anchors get the existence check; ac-N / intent: / doc: / prose are out of
// scope and must stay exactly as before.
describe('dialecticForcesContinuation — backward-finding anchor existence (ac-4 clause 2)', () => {
  // Create a real file under the tmp `repo` so a file-anchor RESOLVES on disk;
  // returns the repo-relative path to use as a maps_to anchor.
  const makeAnchorFile = async (rel: string) => {
    const parts = rel.split('/');
    if (parts.length > 1) await mkdir(join(repo, ...parts.slice(0, -1)), { recursive: true });
    await writeFile(join(repo, rel), '// anchor target\n');
    return rel;
  };

  const baseObjection = (over: Record<string, unknown> = {}) => ({
    severity: 'critical' as const,
    claim: 'oracle anchor objection',
    evidence: [],
    maps_to: 'src/core/gates.ts:42',
    failure_mode: 'gate misfires',
    required_fix: 'fix gate',
    ...over,
  });

  const build = (objOver: Record<string, unknown> = {}): Dialectic =>
    dialecticSchema.parse({
      schema_version: '0.1.0',
      review_id: 'rv_dia00009',
      input: { mode: 'review', target_artifact: 'src/api.ts', question: 'correct?' },
      producer: { position: 'ok', proposal: 'ship' },
      opponent: {
        run: {
          provider: 'codex',
          model: 'codex',
          command: 'codex review',
          timestamp: '2026-06-23T00:00:00.000Z',
        },
        objections: [baseObjection(objOver)],
      },
      // accept + objection unresolved → the admissibility branch would normally fire;
      // we resolve it by claim so ONLY the anchor-existence reason is under test.
      synthesizer: {
        verdict: 'accept',
        synthesis: 'agreed',
        accepted_objections: ['oracle anchor objection'],
      },
    });

  test('(a) admissible objection maps_to an EXISTING file:line → no anchor reason', async () => {
    const rel = await makeAnchorFile('src/core/real-anchor.ts');
    const d = build({ maps_to: `${rel}:88` });
    const reasons = dialecticForcesContinuation(d, repo);
    expect(reasons.some((r) => r.includes('does not resolve'))).toBe(false);
    // resolved by claim, file exists → no continuation at all.
    expect(reasons).toEqual([]);
  });

  test('(a2) admissible objection maps_to an EXISTING file path (no :line) → no anchor reason', async () => {
    const rel = await makeAnchorFile('src/core/real-anchor2.ts');
    const d = build({ maps_to: rel });
    const reasons = dialecticForcesContinuation(d, repo);
    expect(reasons.some((r) => r.includes('does not resolve'))).toBe(false);
    expect(reasons).toEqual([]);
  });

  test('(b) admissible objection maps_to a NON-EXISTENT file:line → "does not resolve" reason', () => {
    const d = build({ maps_to: 'src/core/ghost-file.ts:42' });
    const reasons = dialecticForcesContinuation(d, repo);
    expect(reasons.some((r) => r.includes('does not resolve'))).toBe(true);
    expect(reasons.some((r) => r.includes('src/core/ghost-file.ts'))).toBe(true);
  });

  test('(b2) admissible objection maps_to a NON-EXISTENT file path (no :line) → "does not resolve"', () => {
    const d = build({ maps_to: 'src/core/ghost-file.ts' });
    const reasons = dialecticForcesContinuation(d, repo);
    expect(reasons.some((r) => r.includes('does not resolve'))).toBe(true);
  });

  test('(c) ac-N maps_to is OUT of scope → no anchor existence reason', () => {
    const d = build({ maps_to: 'ac-3' });
    const reasons = dialecticForcesContinuation(d, repo);
    expect(reasons.some((r) => r.includes('does not resolve'))).toBe(false);
    expect(reasons).toEqual([]);
  });

  test('(c2) intent: maps_to is OUT of scope → no anchor existence reason', () => {
    const d = build({ maps_to: 'intent:returns-200' });
    const reasons = dialecticForcesContinuation(d, repo);
    expect(reasons.some((r) => r.includes('does not resolve'))).toBe(false);
    expect(reasons).toEqual([]);
  });

  test('(c3) doc: maps_to is OUT of scope → no anchor existence reason', () => {
    const d = build({ maps_to: 'doc:dialectic-contract.md' });
    const reasons = dialecticForcesContinuation(d, repo);
    expect(reasons.some((r) => r.includes('does not resolve'))).toBe(false);
    expect(reasons).toEqual([]);
  });

  test('(c4) free-prose maps_to is OUT of scope → no anchor existence reason', () => {
    const d = build({ maps_to: 'the empty-input handling path in the API layer' });
    const reasons = dialecticForcesContinuation(d, repo);
    expect(reasons.some((r) => r.includes('does not resolve'))).toBe(false);
    expect(reasons).toEqual([]);
  });

  test('(d) existing admissibility + verdict behavior unchanged when repoRoot present', async () => {
    // verdict reject still forces continuation
    const reject = dialecticSchema.parse({
      schema_version: '0.1.0',
      review_id: 'rv_dia00010',
      input: { mode: 'review', target_artifact: 'src/api.ts', question: 'q' },
      producer: { position: 'ok', proposal: 'ship' },
      opponent: {
        run: {
          provider: 'codex',
          model: 'codex',
          command: 'c',
          timestamp: '2026-06-23T00:00:00.000Z',
        },
        objections: [],
      },
      synthesizer: { verdict: 'reject', synthesis: 'no' },
    });
    expect(dialecticForcesContinuation(reject, repo).length).toBeGreaterThan(0);

    // admissible objection UNRESOLVED (existing file anchor) still forces the
    // admissibility reason — anchor existence is additive, not a replacement.
    const rel = await makeAnchorFile('src/core/real-anchor3.ts');
    const unresolved = build({ maps_to: `${rel}:88` });
    unresolved.synthesizer.accepted_objections = [];
    const r = dialecticForcesContinuation(unresolved, repo);
    expect(r.some((x) => x.includes('admissible'))).toBe(true);
    expect(r.some((x) => x.includes('does not resolve'))).toBe(false);
  });

  test('(d2) non-file anchor with a NON-EXISTENT-looking string is never blocked', () => {
    // a prose anchor that happens to contain a slash but is not a file path form
    const d = build({ maps_to: 'ac-3/empty-input' });
    const reasons = dialecticForcesContinuation(d, repo);
    expect(reasons.some((r) => r.includes('does not resolve'))).toBe(false);
  });

  test('(d3) no repoRoot passed → anchor check skipped (backward-compat one-arg call)', () => {
    const d = build({ maps_to: 'src/core/ghost-file.ts:42' });
    // one-arg call (legacy) must behave exactly as before: no anchor existence check.
    const reasons = dialecticForcesContinuation(d);
    expect(reasons.some((r) => r.includes('does not resolve'))).toBe(false);
    expect(reasons).toEqual([]);
  });
});

// ── n1i-stop wiring (wi_2606266az): nonPassTerminationGate (ac-1/ac-5) +
//    attestAcVerdicts surfacing (ac-6) into the runtime Stop exit-code path ──
describe('stopHandler — non-pass termination gate (ac-1) + no-progress (ac-5)', () => {
  // A non-pass completion whose AC-set matches the work item (so completionGate
  // passes) but that PARKS one in-scope criterion at unverified. Without the ac-1
  // wiring this sails to exit 0 (the leak). `next_handoff_path` is required by the
  // schema superRefine for any non-pass completion.
  const nonPassParked = (overrides: Record<string, unknown> = {}) =>
    completion({
      acceptance: [
        { criterion_id: 'ac-1', verdict: 'pass' },
        { criterion_id: 'ac-2', verdict: 'pass' },
        { criterion_id: 'ac-3', verdict: 'unverified' },
      ],
      final_verdict: 'partial',
      next_handoff_path: '.ditto/handoff/x.md',
      ...overrides,
    });

  test('CORE leak: a non-pass completion parking an in-scope unverified AC WITHOUT non_pass_status => exit 2 (blocks, no silent-terminate)', async () => {
    await writeArtifact('completion.json', nonPassParked());
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('ac-3');
    expect(out.stderr).toContain('정직한 부분완료');
  });

  test('a non-pass completion parking an in-scope FAIL AC without an honest declaration also blocks => exit 2', async () => {
    await writeArtifact(
      'completion.json',
      nonPassParked({
        acceptance: [
          { criterion_id: 'ac-1', verdict: 'pass' },
          { criterion_id: 'ac-2', verdict: 'pass' },
          { criterion_id: 'ac-3', verdict: 'fail' },
        ],
        final_verdict: 'fail',
      }),
    );
    expect((await run({ stop_hook_active: false })).exitCode).toBe(2);
  });

  test('D2 alive: an HONEST partial (non_pass_status with reason+grounding) parking the SAME AC TERMINATES => exit 0', async () => {
    await writeArtifact(
      'completion.json',
      nonPassParked({
        non_pass_status: {
          state: 'partial',
          reason: 'ac-3 needs a downstream service not yet available',
          grounding: 'depends on payments-svc#42',
        },
      }),
    );
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  test('exit code differs per path: ungrounded parked unverified => 2, honest partial => 0', async () => {
    await writeArtifact('completion.json', nonPassParked());
    const blocked = await run({ stop_hook_active: false });
    await writeArtifact(
      'completion.json',
      nonPassParked({
        non_pass_status: { state: 'blocked', reason: 'cannot proceed', grounding: 'ADR-0013' },
      }),
    );
    const terminated = await run({ stop_hook_active: false });
    expect(blocked.exitCode).toBe(2);
    expect(terminated.exitCode).toBe(0);
    expect(blocked.exitCode).not.toBe(terminated.exitCode);
  });

  test('ac-5: a no-progress run surfacing as a non-pass completion with an ungrounded parked AC does NOT silent-terminate => exit 2', async () => {
    // A no-progress halt that writes a non-pass completion (final_verdict unverified)
    // parking an in-scope AC without an honest declaration must block, not pass.
    await writeArtifact(
      'completion.json',
      nonPassParked({
        acceptance: [
          { criterion_id: 'ac-1', verdict: 'pass' },
          { criterion_id: 'ac-2', verdict: 'unverified' },
          { criterion_id: 'ac-3', verdict: 'unverified' },
        ],
        final_verdict: 'unverified',
      }),
    );
    expect((await run({ stop_hook_active: false })).exitCode).toBe(2);
  });

  // REGRESSION (hard constraint): a PASS completion still terminates exactly as
  // before — the existing completionGate path owns it, ac-1 no-ops on pass.
  test('REGRESSION: a passing completion still terminates => exit 0 (ac-1 no-ops on pass)', async () => {
    await writeArtifact('completion.json', completion({ acceptance: PASSING_ACCEPTANCE }));
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  // REGRESSION (hard constraint): a work item with NO completion.json is unaffected
  // by ac-1 — the strong-block (its own path) still blocks the no-verification-path
  // stop, and the ac-1 message never appears (mirrors lj6/t8o).
  test('REGRESSION: no completion.json => strong-block exit 2, ac-1 message absent', async () => {
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('no completion.json');
    expect(out.stderr ?? '').not.toContain('정직한 부분완료');
  });
});

describe('stopHandler — per-AC positive attestation surfaced (ac-6)', () => {
  test('a terminating passing completion surfaces a per-AC attestation in the Stop output', async () => {
    await writeArtifact('completion.json', completion({ acceptance: PASSING_ACCEPTANCE }));
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('attestation');
    expect(out.stderr).toContain('ac-1');
    expect(out.stderr).toContain('verified-by-evidence');
  });

  test('an honest-partial terminate surfaces reasoned-honest-partial for the parked AC', async () => {
    await writeArtifact(
      'completion.json',
      completion({
        acceptance: [
          { criterion_id: 'ac-1', verdict: 'pass' },
          { criterion_id: 'ac-2', verdict: 'pass' },
          { criterion_id: 'ac-3', verdict: 'unverified' },
        ],
        final_verdict: 'partial',
        next_handoff_path: '.ditto/handoff/x.md',
        non_pass_status: { state: 'partial', reason: 'svc down', grounding: 'svc#42' },
      }),
    );
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('reasoned-honest-partial');
    expect(out.stderr).toContain('ac-3');
  });
});

// (ac-3, wi_260627vl6) last-mile land gate: a done ∧ pass close whose own
// changed_files are still uncommitted in git is hard-blocked (verified but not
// landed); partial/blocked closes are exempt (honest termination, T1 ac-1).
describe('stopHandler — last-mile land gate (ac-3)', () => {
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'ignore', 'pipe'] });
  const initGit = () => {
    git(['init']);
    git(['config', 'user.email', 't@t.t']);
    git(['config', 'user.name', 't']);
  };

  test('done + pass + changed_files left UNCOMMITTED in git => exit 2 (verified but not landed)', async () => {
    initGit();
    await writeFile(join(repo, 'x.ts'), 'export const x = 1;\n'); // uncommitted
    await store.update(wiId, (c) => ({ ...c, status: 'done', autopilot_exempt: true }));
    await writeArtifact(
      'completion.json',
      completion({ acceptance: PASSING_ACCEPTANCE, changed_files: ['x.ts'] }),
    );
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('uncommitted');
    expect(out.stderr).toContain('x.ts');
  });

  test('done + pass + changed_files COMMITTED => exit 0 (landed)', async () => {
    initGit();
    await writeFile(join(repo, 'x.ts'), 'export const x = 1;\n');
    git(['add', 'x.ts']);
    git(['commit', '-m', 'land x.ts']);
    await store.update(wiId, (c) => ({ ...c, status: 'done', autopilot_exempt: true }));
    await writeArtifact(
      'completion.json',
      completion({ acceptance: PASSING_ACCEPTANCE, changed_files: ['x.ts'] }),
    );
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  test('partial status + uncommitted changed_files => exit 0 (exempt, honest termination)', async () => {
    initGit();
    await writeFile(join(repo, 'x.ts'), 'export const x = 1;\n'); // uncommitted
    await store.update(wiId, (c) => ({
      ...c,
      status: 'partial',
      autopilot_exempt: true,
      re_entry: { command: 'bun test', fresh_evidence_needed: [] },
    }));
    await writeArtifact(
      'completion.json',
      completion({
        acceptance: [
          { criterion_id: 'ac-1', verdict: 'partial' },
          { criterion_id: 'ac-2', verdict: 'partial' },
          { criterion_id: 'ac-3', verdict: 'partial' },
        ],
        final_verdict: 'partial',
        next_handoff_path: '.ditto/handoff/x.md',
        changed_files: ['x.ts'],
      }),
    );
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  test('blocked status + uncommitted changed_files => exit 0 (exempt, honest termination)', async () => {
    initGit();
    await writeFile(join(repo, 'x.ts'), 'export const x = 1;\n'); // uncommitted
    await store.update(wiId, (c) => ({
      ...c,
      status: 'blocked',
      autopilot_exempt: true,
      re_entry: { command: 'bun test', fresh_evidence_needed: [] },
    }));
    await writeArtifact(
      'completion.json',
      completion({
        acceptance: [
          { criterion_id: 'ac-1', verdict: 'partial' },
          { criterion_id: 'ac-2', verdict: 'partial' },
          { criterion_id: 'ac-3', verdict: 'partial' },
        ],
        final_verdict: 'partial',
        next_handoff_path: '.ditto/handoff/x.md',
        changed_files: ['x.ts'],
      }),
    );
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });
});
