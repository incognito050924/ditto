import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInitialNodes } from '~/core/autopilot-graph';
import { recordResult } from '~/core/autopilot-loop';
import { AutopilotStore } from '~/core/autopilot-store';
import { WorkItemStore } from '~/core/work-item-store';
import type { Autopilot } from '~/schemas/autopilot';

// ADR-0024 Decision 6 "loop discipline" (wi_260623u0d, N2). Tests added per
// mechanism, vertical-slice TDD — NOT all up front.

let repo: string;
let aps: AutopilotStore;
let wis: WorkItemStore;
let WI: string;
const NOW = new Date('2026-06-01T00:00:00.000Z');

function graph(overrides: Partial<Autopilot> = {}): Autopilot {
  return {
    schema_version: '0.1.0',
    autopilot_id: 'orch_discipline',
    work_item_id: WI,
    mode: 'autopilot',
    root_goal: 'goal',
    completion_boundary: 'entire_work_item',
    approval_gate: {
      status: 'not_required',
      source: 'small_reversible_policy',
      approved_at: null,
      approved_by: null,
      evidence_refs: [],
    },
    nodes: buildInitialNodes(['ac-1']),
    caps: { fix_per_node: 2, switch_per_node: 1 },
    continue_policy: {
      continue_after_approval: true,
      continue_after_checkpoint: true,
      continue_after_fixable_failure: true,
      ask_user_only_for_user_owned_decisions: true,
    },
    stop_conditions: [],
    user_interrupt_policy: 'ask_only_for_user_owned_decisions',
    ...overrides,
  };
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-discipline-'));
  aps = new AutopilotStore(repo);
  wis = new WorkItemStore(repo);
  const wi = await wis.create(
    {
      title: 'loop discipline',
      source_request: 'test loop discipline',
      goal: 'the loop converges on oracle satisfaction',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'loop runs', verdict: 'unverified', evidence: [] },
      ],
    },
    NOW,
  );
  WI = wi.id;
  await wis.update(WI, (w) => ({ ...w, changed_files: ['src/x.ts'] }));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

// Helper: set the work-item AC oracle (design-assigned), so the in-loop oracle
// check engages for the criterion (presence-gated).
async function assignOracle(
  acId: string,
  oracle: {
    verification_method: 'dynamic_test' | 'static_scan' | 'soft_judgment';
    maps_to: string;
    direction: 'forward' | 'backward';
  },
): Promise<void> {
  await wis.update(WI, (w) => ({
    ...w,
    acceptance_criteria: w.acceptance_criteria.map((ac) =>
      ac.id === acId ? { ...ac, oracle } : ac,
    ),
  }));
}

// A single judging (verify) node `V`, running, that closes ac-1. Mechanism 3
// gates JUDGING nodes (verify/review/security) — a `design` node ASSIGNS oracles
// and is exempt, so the discipline tests use a verify node, not the seed N1=design.
function verifyNode(status: 'pending' | 'running' = 'running') {
  return {
    id: 'V',
    kind: 'verify' as const,
    owner: 'verifier' as const,
    purpose: 'verify ac-1',
    status,
    depends_on: [] as string[],
    acceptance_refs: ['ac-1'],
    evidence_refs: [],
    attempts: { fix: 0, switch: 0 },
  };
}

describe('M3 in-loop oracle authoritative (oracleSatisfaction in the recordResult pass-path)', () => {
  async function dispatchN1(g = graph({ nodes: [verifyNode('running')] })): Promise<void> {
    await aps.write(WI, { ...g, work_item_id: WI });
  }

  test('agent pass but static_scan oracle unsatisfied (note-only evidence) → node stays OPEN, not passed', async () => {
    // ac-1 oracle = static_scan: satisfied only by a recorded re-scan (file/artifact/command),
    // NOT a note. The node closes ac-1 to pass with a NOTE evidence only → oracle unsatisfied.
    await assignOracle('ac-1', {
      verification_method: 'static_scan',
      maps_to: 'ac-1',
      direction: 'forward',
    });
    await dispatchN1();
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V',
        result_text: 'Reviewed ac-1 and it looks clean per my read of the code.',
        outcome: 'pass',
        ac_verdicts: [
          {
            criterion_id: 'ac-1',
            verdict: 'pass',
            evidence_refs: [{ kind: 'note', summary: 'looks clean' }],
          },
        ],
      },
    });
    // oracle unsatisfied ⇒ the agent pass is downgraded; node is NOT passed, stays open.
    expect(res.outcome).toBe('fail');
    expect(res.status).toBe('pending'); // re-armed / open, not passed
    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === 'V')?.status).toBe('pending');
  });

  test('agent pass with static_scan oracle SATISFIED (recorded re-scan) → node passes', async () => {
    await assignOracle('ac-1', {
      verification_method: 'static_scan',
      maps_to: 'ac-1',
      direction: 'forward',
    });
    await dispatchN1();
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V',
        result_text: 'Re-ran the scan over ac-1; recorded the scan artifact.',
        outcome: 'pass',
        ac_verdicts: [
          {
            criterion_id: 'ac-1',
            verdict: 'pass',
            evidence_refs: [{ kind: 'artifact', path: 'scan.sarif', summary: 're-scan' }],
          },
        ],
      },
    });
    expect(res.outcome).toBe('pass');
    expect(res.status).toBe('passed');
  });

  test('no oracle assigned ⇒ legacy pass path unchanged (regression-safe)', async () => {
    await dispatchN1();
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V',
        result_text: 'Closed ac-1 with a recorded run.',
        outcome: 'pass',
        evidence_refs: [{ kind: 'command', summary: 'bun test' }],
        ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'pass' }],
      },
    });
    expect(res.outcome).toBe('pass');
    expect(res.status).toBe('passed');
  });
});

describe('M5 same-oracle K failures → blocked (K counter separate from attempts.fix)', () => {
  // The K counter is derived from the append-only decision log (ORACLE_UNSATISFIED
  // markers), NOT from node.attempts.fix. With caps.oracle_failures_to_block=K, the
  // K-th same-oracle failure blocks the node instead of re-opening it.
  async function freshVerifyRunning(): Promise<void> {
    await aps.write(WI, { ...graph({ nodes: [verifyNode('running')] }), work_item_id: WI });
  }
  async function recordOracleFail(): Promise<{ status: string; cap_exceeded: boolean }> {
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V',
        result_text: 'Claims ac-1 pass but only a note backs the static_scan oracle.',
        outcome: 'pass',
        ac_verdicts: [
          {
            criterion_id: 'ac-1',
            verdict: 'pass',
            evidence_refs: [{ kind: 'note', summary: 'looks clean' }],
          },
        ],
      },
    });
    // re-arm the node to running for the next attempt (the driver re-dispatches a pending node)
    if (res.status === 'pending') {
      await aps.updateNode(WI, 'V', (n) => ({ ...n, status: 'running' }));
    }
    return { status: res.status, cap_exceeded: res.cap_exceeded };
  }

  test('K=3 (default): first two failures re-open, the third blocks', async () => {
    await assignOracle('ac-1', {
      verification_method: 'static_scan',
      maps_to: 'ac-1',
      direction: 'forward',
    });
    await freshVerifyRunning();
    const a = await recordOracleFail();
    expect(a.status).toBe('pending'); // 1st: re-open
    const b = await recordOracleFail();
    expect(b.status).toBe('pending'); // 2nd: re-open
    const c = await recordOracleFail();
    expect(c.status).toBe('blocked'); // 3rd (=K): blocked
    expect(c.cap_exceeded).toBe(true);
    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === 'V')?.status).toBe('blocked');
  });

  test('K counter is NOT folded into attempts.fix (convergence layer separate from retry layer)', async () => {
    await assignOracle('ac-1', {
      verification_method: 'static_scan',
      maps_to: 'ac-1',
      direction: 'forward',
    });
    await freshVerifyRunning();
    await recordOracleFail();
    await recordOracleFail();
    // two oracle failures recorded — but attempts.fix must remain 0 (the retry budget
    // is untouched; the K counter lives in the decision log, not in node.attempts).
    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === 'V')?.attempts.fix).toBe(0);
    const decisions = await aps.readDecisions(WI);
    const oracleDecisions = decisions.filter((d) => d.reason.startsWith('oracle-unsatisfied'));
    expect(oracleDecisions.length).toBe(2);
  });

  test('boundary K=1: the FIRST same-oracle failure blocks immediately (cap counts attempts)', async () => {
    await assignOracle('ac-1', {
      verification_method: 'static_scan',
      maps_to: 'ac-1',
      direction: 'forward',
    });
    await aps.write(WI, {
      ...graph({
        nodes: [verifyNode('running')],
        caps: { fix_per_node: 2, switch_per_node: 1, oracle_failures_to_block: 1 },
      }),
      work_item_id: WI,
    });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V',
        result_text: 'Claims ac-1 pass but only a note backs the static_scan oracle.',
        outcome: 'pass',
        ac_verdicts: [
          {
            criterion_id: 'ac-1',
            verdict: 'pass',
            evidence_refs: [{ kind: 'note', summary: 'looks clean' }],
          },
        ],
      },
    });
    expect(res.status).toBe('blocked'); // K=1 ⇒ first failure already at the cap
    expect(res.cap_exceeded).toBe(true);
  });
});

describe('M4 wrong-fixpoint reopen (oracle closed yet evidence mismatch → reopen the passed node, append-only)', () => {
  // A passed node `P` (oracle was marked closed) is found, by a later re-checking
  // node `V`, to have an oracle/evidence mismatch. The wrong-fixpoint reopen returns
  // P (passed → pending) via the reopen transition, SILENTLY (no user interrupt),
  // recorded append-only to the decision log. Guards P.status===passed.
  function passedNode(id: string, status: 'passed' | 'blocked' = 'passed') {
    return {
      id,
      kind: 'implement' as const,
      owner: 'implementer' as const,
      purpose: 'implement ac-1',
      status,
      depends_on: [] as string[],
      acceptance_refs: ['ac-1'],
      evidence_refs: [{ kind: 'file' as const, path: 'src/x.ts', summary: 'edit' }],
      attempts: { fix: 0, switch: 0 },
    };
  }

  test('a passed node with a mismatched oracle is reopened (passed → pending), recorded append-only', async () => {
    await assignOracle('ac-1', {
      verification_method: 'static_scan',
      maps_to: 'ac-1',
      direction: 'forward',
    });
    await aps.write(WI, {
      ...graph({ nodes: [passedNode('P'), verifyNode('running')] }),
      work_item_id: WI,
    });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V',
        result_text: 'Re-check: P closed ac-1 but its recorded evidence does not meet the oracle.',
        outcome: 'pass',
        evidence_refs: [{ kind: 'artifact', path: 'recheck.sarif', summary: 're-scan' }],
        ac_verdicts: [
          {
            criterion_id: 'ac-1',
            verdict: 'pass',
            evidence_refs: [{ kind: 'artifact', path: 'recheck.sarif', summary: 're-scan' }],
          },
        ],
        oracle_fixpoint_reopen: { target_node_id: 'P', criterion_id: 'ac-1' },
      },
    });
    // V itself passed (its own oracle is satisfied by the recorded re-scan artifact).
    expect(res.outcome).toBe('pass');
    const after = await aps.get(WI);
    // P reopened: passed → pending.
    expect(after.nodes.find((n) => n.id === 'P')?.status).toBe('pending');
    // recorded append-only with the K-countable marker.
    const decisions = await aps.readDecisions(WI);
    const reopenDecision = decisions.filter(
      (d) => d.node_id === 'P' && d.reason.startsWith('oracle-unsatisfied'),
    );
    expect(reopenDecision.length).toBe(1);
  });

  test('collision guard: target already moved out of passed (blocked) → no illegal transition, no reopen', async () => {
    await assignOracle('ac-1', {
      verification_method: 'static_scan',
      maps_to: 'ac-1',
      direction: 'forward',
    });
    // P is BLOCKED (the forward loop moved it), not passed. The reopen MUST guard
    // status===passed or nodeTransition(blocked,'reopen') throws.
    await aps.write(WI, {
      ...graph({ nodes: [passedNode('P', 'blocked'), verifyNode('running')] }),
      work_item_id: WI,
    });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V',
        result_text:
          'Re-check flags P, but P is no longer passed (collision with the forward loop).',
        outcome: 'pass',
        evidence_refs: [{ kind: 'artifact', path: 'recheck.sarif', summary: 're-scan' }],
        ac_verdicts: [
          {
            criterion_id: 'ac-1',
            verdict: 'pass',
            evidence_refs: [{ kind: 'artifact', path: 'recheck.sarif', summary: 're-scan' }],
          },
        ],
        oracle_fixpoint_reopen: { target_node_id: 'P', criterion_id: 'ac-1' },
      },
    });
    // No throw; V still passes; P stays blocked (the guard skipped the illegal transition).
    expect(res.outcome).toBe('pass');
    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === 'P')?.status).toBe('blocked');
  });

  test('K shared: a target reopened K times is blocked instead of reopened', async () => {
    await assignOracle('ac-1', {
      verification_method: 'static_scan',
      maps_to: 'ac-1',
      direction: 'forward',
    });
    await aps.write(WI, {
      ...graph({
        nodes: [passedNode('P'), verifyNode('running')],
        caps: { fix_per_node: 2, switch_per_node: 1, oracle_failures_to_block: 1 },
      }),
      work_item_id: WI,
    });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V',
        result_text: 'Re-check: P closed ac-1 but evidence mismatches the oracle.',
        outcome: 'pass',
        evidence_refs: [{ kind: 'artifact', path: 'recheck.sarif', summary: 're-scan' }],
        ac_verdicts: [
          {
            criterion_id: 'ac-1',
            verdict: 'pass',
            evidence_refs: [{ kind: 'artifact', path: 'recheck.sarif', summary: 're-scan' }],
          },
        ],
        oracle_fixpoint_reopen: { target_node_id: 'P', criterion_id: 'ac-1' },
      },
    });
    expect(res.outcome).toBe('pass'); // V passes
    const after = await aps.get(WI);
    // K=1 ⇒ the first wrong-fixpoint on P blocks it instead of reopening.
    expect(after.nodes.find((n) => n.id === 'P')?.status).toBe('blocked');
  });
});

describe('M2 loop-level iteration cap (graph-derived total forward rounds; cap → capped, stops infinite loop)', () => {
  // The loop-level cap (caps.loop_rounds) is the SUM of forward re-expansion rounds
  // across the WHOLE graph, distinct from the per-chain converge_rounds. When the
  // graph already holds loop_rounds forward rounds, a further findings-bearing review
  // does NOT expand — it escalates (capped ≠ converged), blocking the node. This is
  // the infinite-loop floor.
  function rev(id: string, status: 'passed' | 'running') {
    return {
      id,
      kind: 'review' as const,
      owner: 'reviewer' as const,
      purpose: 'review',
      status,
      depends_on: [] as string[],
      acceptance_refs: ['ac-1'],
      evidence_refs: [],
      attempts: { fix: 0, switch: 0 },
    };
  }

  test('graph at the loop_rounds cap → a further findings review blocks (capped), no expand', async () => {
    // loop_rounds = 2: build two prior forward rounds, then the tail review still has
    // findings. The per-chain converge_rounds budget is high (so it is NOT what stops
    // us) — the LOOP-LEVEL cap is.
    const tail = rev('N3.rev.r0.rev.r1', 'running');
    const priors = [rev('N3', 'passed'), rev('N3.rev.r0', 'passed')];
    await aps.write(WI, {
      ...graph({
        nodes: [...priors, tail],
        caps: {
          fix_per_node: 2,
          switch_per_node: 1,
          converge_rounds: 99,
          loop_rounds: 2,
        },
      }),
      work_item_id: WI,
    });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N3.rev.r0.rev.r1',
        result_text: 'Re-review still finds open issues after two forward rounds.',
        outcome: 'pass',
        evidence_refs: [{ kind: 'file', path: 'review.md', summary: 'findings' }],
        has_findings: true,
      },
    });
    // capped: blocked, not expanded; cap_exceeded true.
    expect(res.status).toBe('blocked');
    expect(res.cap_exceeded).toBe(true);
    expect(res.promoted_node_ids).toEqual([]); // no fix+review pair spliced
  });

  test('below the loop_rounds cap → findings still expand (loop continues)', async () => {
    const tail = rev('N3', 'running');
    await aps.write(WI, {
      ...graph({
        nodes: [tail],
        caps: { fix_per_node: 2, switch_per_node: 1, converge_rounds: 99, loop_rounds: 5 },
      }),
      work_item_id: WI,
    });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N3',
        result_text: 'Review finds issues on the first pass.',
        outcome: 'pass',
        evidence_refs: [{ kind: 'file', path: 'review.md', summary: 'findings' }],
        has_findings: true,
      },
    });
    expect(res.status).toBe('passed'); // review node itself passes
    expect(res.promoted_node_ids.length).toBe(2); // fix + review spliced
  });
});

describe('M1 converged vs capped disposition at done (all_passed distinguishes oracle-satisfied vs loop-cap-hit)', () => {
  test('all passed with no loop-cap in the log → disposition=converged', async () => {
    await aps.write(WI, {
      ...graph({
        nodes: buildInitialNodes(['ac-1']).map((n) => ({ ...n, status: 'passed' as const })),
      }),
      work_item_id: WI,
    });
    const { nextNode } = await import('~/core/autopilot-loop');
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('done');
    if (res.action !== 'done') throw new Error('expected done');
    expect(res.all_passed).toBe(true);
    expect(res.disposition).toBe('converged');
  });

  test('all passed but a loop-cap was recorded → disposition=capped (≠ converged)', async () => {
    await aps.write(WI, {
      ...graph({
        nodes: buildInitialNodes(['ac-1']).map((n) => ({ ...n, status: 'passed' as const })),
      }),
      work_item_id: WI,
    });
    // a prior loop-level cap escalation is in the decision log (the loop hit the cap
    // at some point, even if the run later closed every node).
    await aps.appendDecision(WI, {
      ts: NOW.toISOString(),
      node_id: 'N3',
      failure_class: 'user_decision_needed',
      decision: 'escalate',
      reason:
        'loop-level iteration cap reached (12 forward rounds ≥ loop_rounds 12) with findings still open on N3; capped ≠ converged, escalate rather than expand',
      attempts: { fix: 0, switch: 0 },
    });
    const { nextNode } = await import('~/core/autopilot-loop');
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('done');
    if (res.action !== 'done') throw new Error('expected done');
    expect(res.all_passed).toBe(true);
    expect(res.disposition).toBe('capped');
  });
});
