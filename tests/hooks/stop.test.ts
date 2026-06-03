import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import {
  acgReviewForcesContinuation,
  autopilotForcesContinuation,
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

describe('stopHandler — ACG review ledger (WU-6, D5)', () => {
  test('acc-a: unresolved high-risk in acg-review.json => exit 2 (continuation forced)', async () => {
    await writeArtifact('completion.json', completion({ acceptance: passingAcceptance }));
    await writeArtifact('acg-review.json', {
      kind: 'acg.review-graph.v1',
      files: [
        {
          path: 'src/payment/charge.ts',
          risk: 'high',
          risk_reason: 'no idempotency key',
          unresolved: true,
        },
      ],
      human_review_set: ['src/payment/charge.ts'],
    });
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('unresolved high-risk');
    expect(out.stderr).toContain('src/payment/charge.ts');
  });

  test('acc-b: high-risk WITH evidence (resolved) + clear ledger => exit 0', async () => {
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

  test('acc-c: completion carrying the optional acg_governance slot still passes (no regression)', async () => {
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

  test('unresolved high-risk on a journey role uses journey_id identity', async () => {
    await writeArtifact('completion.json', completion({ acceptance: passingAcceptance }));
    await writeArtifact('acg-review.json', {
      kind: 'acg.review-graph.v1',
      files: [
        {
          journey_id: 'jrn-checkout',
          role: 'user_journey',
          risk: 'high',
          risk_reason: 'checkout regressed',
          unresolved: true,
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
  test('high-risk + unresolved forces continuation (one reason per file)', () => {
    const reasons = acgReviewForcesContinuation({
      kind: 'acg.review-graph.v1',
      files: [
        { path: 'a.ts', risk: 'high', risk_reason: 'r1', unresolved: true },
        { path: 'b.ts', risk: 'high', risk_reason: 'r2', unresolved: true },
      ],
      human_review_set: [],
    } as never);
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain('a.ts');
  });

  test('high-risk but resolved (unresolved=false) is not a blocker', () => {
    expect(
      acgReviewForcesContinuation({
        kind: 'acg.review-graph.v1',
        files: [{ path: 'a.ts', risk: 'high', risk_reason: 'r', unresolved: false }],
        human_review_set: [],
      } as never),
    ).toHaveLength(0);
  });

  test('low/medium unresolved gaps are not blockers (only high-risk)', () => {
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
