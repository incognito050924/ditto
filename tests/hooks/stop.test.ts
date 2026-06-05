import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import {
  acgReviewForcesContinuation,
  assuranceSnapshotForcesContinuation,
  autopilotForcesContinuation,
  impactForcesContinuation,
  semanticForcesContinuation,
  stopHandler,
} from '~/hooks/stop';

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

const artifactPath = (name: string) => join(repo, '.ditto', 'work-items', wiId, name);
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

  test('approval_gate pending (with remaining nodes) => exit 0 (yield to surface plan)', async () => {
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
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
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

  test('approval_gate pending WITH a pending implementer node => still yields (exit 0)', async () => {
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
    // Even with a failing completion present, a legitimate approval wait yields.
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
          review_graph: '.ditto/work-items/wi/acg-review.json',
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
  change: { before: 'getUser(): User | null', after: 'getUser(): User' },
  old_meaning: 'absent user returns null',
  business_assumptions: [],
  compatibility: 'breaking',
  ...(characterization ? { characterization } : {}),
  verdict,
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
    expect(out.stderr).toContain('semantic: unintended meaning break');
  });

  test('unverified meaning forces continuation (exit 2)', async () => {
    await writeArtifact('completion.json', completion({ acceptance: passingAcceptance }));
    await writeArtifact(
      'semantic-compatibility.json',
      semanticCompat({ type_safe: true, semantic_safe: 'unverified' }),
    );
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('semantic: meaning compatibility unverified');
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
        { exists: true, test_ref: 'tests/user.test.ts::keeps null-absence', candidate: null },
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
  const sem = (verdict: Record<string, unknown>) =>
    ({
      change: { before: 'a', after: 'b' },
      old_meaning: 'm',
      verdict,
    }) as never;

  test('semantic_safe=no without intended_breaking → one reason', () => {
    expect(
      semanticForcesContinuation(sem({ semantic_safe: 'no', intended_breaking: false })),
    ).toHaveLength(1);
    expect(semanticForcesContinuation(sem({ semantic_safe: 'no' }))).toHaveLength(1); // intended_breaking absent
  });
  test('semantic_safe=unverified → one reason', () => {
    expect(semanticForcesContinuation(sem({ semantic_safe: 'unverified' }))).toHaveLength(1);
  });
  test('semantic_safe=no with intended_breaking, or =yes → no reason', () => {
    expect(
      semanticForcesContinuation(sem({ semantic_safe: 'no', intended_breaking: true })),
    ).toHaveLength(0);
    expect(semanticForcesContinuation(sem({ semantic_safe: 'yes' }))).toHaveLength(0);
  });
});
