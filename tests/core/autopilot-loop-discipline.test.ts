import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInitialNodes } from '~/core/autopilot-graph';
import { nextNode, recordResult } from '~/core/autopilot-loop';
import { AutopilotStore } from '~/core/autopilot-store';
import { CoverageStore } from '~/core/coverage-store';
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
    caps: {
      fix_per_node: 2,
      switch_per_node: 1,
      converge_rounds: 3,
      oracle_failures_to_block: 3,
      loop_rounds: 12,
      no_progress_rounds: 3,
      progress_continuation_cap: 24,
    },
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
function verifyNode(status: 'pending' | 'running' | 'passed' = 'running') {
  return {
    id: 'V',
    kind: 'verify' as const,
    owner: 'verifier' as const,
    purpose: 'verify ac-1',
    status,
    depends_on: [] as string[],
    acceptance_refs: ['ac-1'],
    evidence_refs: [],
    ac_verdicts: [],
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

describe('wi_2606274be: envelope owner_kind must match the dispatched node owner (no self-relabel bypass)', () => {
  function implementNode() {
    return {
      id: 'V',
      kind: 'implement' as const,
      owner: 'implementer' as const,
      purpose: 'implement ac-1',
      status: 'running' as const,
      depends_on: [] as string[],
      acceptance_refs: ['ac-1'],
      evidence_refs: [],
      ac_verdicts: [],
      attempts: { fix: 0, switch: 0 },
    };
  }

  test('an implementer pass carrying a relabeled retrospective envelope (bare summary) is downgraded to fail', async () => {
    await aps.write(WI, { ...graph({ nodes: [implementNode()] }), work_item_id: WI });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V',
        result_text: 'Implemented ac-1.',
        outcome: 'pass',
        changed_files: ['src/x.ts'],
        // owner_kind=retrospective clears the schema reachability exemption with an
        // empty verbatim_detail — the owner-match guard is what blocks the relabel.
        envelope: {
          summary: 'did the thing',
          conclusion: 'done',
          evidence: [],
          uncertainty: [],
          verdict: 'pass',
          owner_kind: 'retrospective',
        },
        ac_verdicts: [
          {
            criterion_id: 'ac-1',
            verdict: 'pass',
            evidence_refs: [{ kind: 'command', summary: 'bun test' }],
          },
        ],
      },
    });
    expect(res.outcome).toBe('fail');
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
        caps: {
          fix_per_node: 2,
          switch_per_node: 1,
          oracle_failures_to_block: 1,
          converge_rounds: 3,
          loop_rounds: 12,
          no_progress_rounds: 3,
          progress_continuation_cap: 24,
        },
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

describe('M5 per-AC (criterion) K counter — a multi-AC node does NOT conflate failures across criteria (wi_260624kcv)', () => {
  // The same-oracle K counter is per (node, criterion), not per node. A node closing
  // two ACs (ac-1, ac-2) keeps a SEPARATE failure tally per criterion, so failures on
  // ac-2 never push ac-1 toward its oracle_failures_to_block (K) threshold. Legacy
  // decisions (no criterion_ids field) fall back to node-scoped counting so an
  // in-flight multi-AC run is never silently reset below threshold.

  // A judging node `V` that closes BOTH ac-1 and ac-2 (two oracles in play).
  function multiAcVerifyNode(status: 'pending' | 'running' = 'running') {
    return {
      id: 'V',
      kind: 'verify' as const,
      owner: 'verifier' as const,
      purpose: 'verify ac-1 and ac-2',
      status,
      depends_on: [] as string[],
      acceptance_refs: ['ac-1', 'ac-2'],
      evidence_refs: [],
      ac_verdicts: [],
      attempts: { fix: 0, switch: 0 },
    };
  }

  // Add ac-2 to the work item so the multi-AC node has a second criterion in play.
  async function addAc2(): Promise<void> {
    await wis.update(WI, (w) => ({
      ...w,
      acceptance_criteria: [
        ...w.acceptance_criteria,
        { id: 'ac-2', statement: 'second criterion', verdict: 'unverified', evidence: [] },
      ],
    }));
  }

  async function writeMultiAcGraph(k: number): Promise<void> {
    await aps.write(WI, {
      ...graph({
        nodes: [multiAcVerifyNode('running')],
        caps: {
          fix_per_node: 9,
          switch_per_node: 9,
          oracle_failures_to_block: k,
          converge_rounds: 3,
          loop_rounds: 12,
          no_progress_rounds: 3,
          progress_continuation_cap: 24,
        },
      }),
      work_item_id: WI,
    });
  }

  // Record a note-only (oracle-unsatisfied) pass for a SINGLE criterion. Re-arms V to
  // running for the next attempt (the driver re-dispatches a pending node).
  async function recordOracleFailFor(
    acId: string,
  ): Promise<{ status: string; cap_exceeded: boolean }> {
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V',
        result_text: `Claims ${acId} pass but only a note backs the static_scan oracle.`,
        outcome: 'pass',
        ac_verdicts: [
          {
            criterion_id: acId,
            verdict: 'pass',
            evidence_refs: [{ kind: 'note', summary: 'looks clean' }],
          },
        ],
      },
    });
    if (res.status === 'pending') {
      await aps.updateNode(WI, 'V', (n) => ({ ...n, status: 'running' }));
    }
    return { status: res.status, cap_exceeded: res.cap_exceeded };
  }

  test('multi-AC separation: ac-1 fails K−1 times and ac-2 once → ac-1 NOT blocked; one more ac-1 failure blocks', async () => {
    const K = 3;
    await addAc2();
    await assignOracle('ac-1', {
      verification_method: 'static_scan',
      maps_to: 'ac-1',
      direction: 'forward',
    });
    await assignOracle('ac-2', {
      verification_method: 'static_scan',
      maps_to: 'ac-2',
      direction: 'forward',
    });
    await writeMultiAcGraph(K);
    // ac-1 fails K−1 = 2 times (re-opens, never blocks).
    const a1 = await recordOracleFailFor('ac-1');
    expect(a1.status).toBe('pending');
    const a2 = await recordOracleFailFor('ac-1');
    expect(a2.status).toBe('pending');
    // ac-2 fails ONCE. If the counter conflated, this 3rd same-NODE failure would
    // already be at K and block — it must NOT, because ac-2's own tally is just 1.
    const b1 = await recordOracleFailFor('ac-2');
    expect(b1.status).toBe('pending');
    expect(b1.cap_exceeded).toBe(false);
    // One MORE ac-1 failure is ac-1's K-th → ac-1 blocks (proving the per-criterion
    // tally, not the node tally, drives the block).
    const a3 = await recordOracleFailFor('ac-1');
    expect(a3.status).toBe('blocked');
    expect(a3.cap_exceeded).toBe(true);
  });

  test('single-AC regression: a single-criterion node still blocks at exactly the K-th failure', async () => {
    const K = 3;
    await assignOracle('ac-1', {
      verification_method: 'static_scan',
      maps_to: 'ac-1',
      direction: 'forward',
    });
    await aps.write(WI, {
      ...graph({
        nodes: [verifyNode('running')],
        caps: {
          fix_per_node: 9,
          switch_per_node: 9,
          oracle_failures_to_block: K,
          converge_rounds: 3,
          loop_rounds: 12,
          no_progress_rounds: 3,
          progress_continuation_cap: 24,
        },
      }),
      work_item_id: WI,
    });
    async function failAc1(): Promise<{ status: string; cap_exceeded: boolean }> {
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
      if (res.status === 'pending') {
        await aps.updateNode(WI, 'V', (n) => ({ ...n, status: 'running' }));
      }
      return { status: res.status, cap_exceeded: res.cap_exceeded };
    }
    expect((await failAc1()).status).toBe('pending'); // 1st
    expect((await failAc1()).status).toBe('pending'); // 2nd
    const third = await failAc1();
    expect(third.status).toBe('blocked'); // K-th
    expect(third.cap_exceeded).toBe(true);
  });

  test('legacy fallback: decisions without criterion_ids are counted node-scoped (in-flight node at K−1 legacy failures still blocks next)', async () => {
    const K = 3;
    await assignOracle('ac-1', {
      verification_method: 'static_scan',
      maps_to: 'ac-1',
      direction: 'forward',
    });
    await aps.write(WI, {
      ...graph({
        nodes: [verifyNode('running')],
        caps: {
          fix_per_node: 9,
          switch_per_node: 9,
          oracle_failures_to_block: K,
          converge_rounds: 3,
          loop_rounds: 12,
          no_progress_rounds: 3,
          progress_continuation_cap: 24,
        },
      }),
      work_item_id: WI,
    });
    // Seed K−1 = 2 LEGACY oracle-unsatisfied decisions on V (no criterion_ids field —
    // an in-flight run recorded before this change). The next failure must block.
    for (let i = 0; i < K - 1; i++) {
      await aps.appendDecision(WI, {
        ts: NOW.toISOString(),
        node_id: 'V',
        failure_class: 'fixable',
        decision: 'retry',
        reason: 'oracle-unsatisfied: ac-1: legacy entry (no criterion_ids)',
        attempts: { fix: 0, switch: 0 },
      });
    }
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
    // 2 legacy (node-scoped) + this = 3 = K ⇒ blocked. The legacy entries are NOT
    // silently dropped just because they lack criterion_ids.
    expect(res.status).toBe('blocked');
    expect(res.cap_exceeded).toBe(true);
  });

  test('block reason names the criterion (ADR-0024 Decision 7 SoT stays self-explanatory)', async () => {
    const K = 1;
    await assignOracle('ac-1', {
      verification_method: 'static_scan',
      maps_to: 'ac-1',
      direction: 'forward',
    });
    await aps.write(WI, {
      ...graph({
        nodes: [verifyNode('running')],
        caps: {
          fix_per_node: 9,
          switch_per_node: 9,
          oracle_failures_to_block: K,
          converge_rounds: 3,
          loop_rounds: 12,
          no_progress_rounds: 3,
          progress_continuation_cap: 24,
        },
      }),
      work_item_id: WI,
    });
    await recordResult(repo, {
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
    const decisions = await aps.readDecisions(WI);
    const blockDecision = decisions.find((d) => d.decision === 'escalate');
    expect(blockDecision).toBeDefined();
    // The block reason must name the criterion so the decision log is self-explanatory.
    expect(blockDecision?.reason).toContain('ac-1');
    expect(blockDecision?.reason).toContain('criterion');
    // And the structured criterion_ids field is written.
    expect(blockDecision?.criterion_ids).toEqual(['ac-1']);
    // wi_260718srh (n3): the oracleSatisfaction gate FAIL that drove this append is
    // attributed via the additive-optional gate_id (a gate-triggered site, not owner-result).
    expect(blockDecision?.gate_id).toBe('oracle_satisfaction');
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
      ac_verdicts: [],
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
    // wi_260718srh (n3): the wrong-fixpoint reopen is driven by the SAME oracle authority,
    // so it carries the oracle_satisfaction gate_id (shared parent id, no distinct sibling id).
    expect(reopenDecision[0]?.gate_id).toBe('oracle_satisfaction');
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
        caps: {
          fix_per_node: 2,
          switch_per_node: 1,
          oracle_failures_to_block: 1,
          converge_rounds: 3,
          loop_rounds: 12,
          no_progress_rounds: 3,
          progress_continuation_cap: 24,
        },
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
      ac_verdicts: [],
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
          oracle_failures_to_block: 3,
          no_progress_rounds: 3,
          progress_continuation_cap: 24,
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
        caps: {
          fix_per_node: 2,
          switch_per_node: 1,
          converge_rounds: 99,
          loop_rounds: 5,
          oracle_failures_to_block: 3,
          no_progress_rounds: 3,
          progress_continuation_cap: 24,
        },
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

describe('ADR-0024 Decision 4 — retro is NON-BLOCKING for completion/terminality (ac-3)', () => {
  // A `retro`-kind node must NOT gate work-item completion: a failed or blocked retro
  // must still let the graph reach `done`, must NOT flip all_passed to false, and must
  // NOT trigger the blocked escalation. The retro still runs and reports — it just never
  // gates completion. A NON-retro failed/blocked node behaves exactly as before.
  function retro(status: 'passed' | 'failed' | 'blocked') {
    return {
      id: 'R',
      kind: 'retro' as const,
      owner: 'retrospective' as const,
      purpose: 'retrospective',
      status,
      depends_on: [] as string[],
      acceptance_refs: [] as string[],
      evidence_refs: [],
      ac_verdicts: [],
      attempts: { fix: 0, switch: 0 },
    };
  }
  const allPassedWork = () =>
    buildInitialNodes(['ac-1']).map((n) => ({ ...n, status: 'passed' as const }));

  test('a FAILED retro (only non-passed node) → done, all_passed true, disposition=converged', async () => {
    await aps.write(WI, {
      ...graph({ nodes: [...allPassedWork(), retro('failed')] }),
      work_item_id: WI,
    });
    const { nextNode } = await import('~/core/autopilot-loop');
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('done');
    if (res.action !== 'done') throw new Error('expected done');
    // the failed retro must NOT degrade completion: all_passed stays true (retro excluded).
    expect(res.all_passed).toBe(true);
    expect(res.disposition).toBe('converged');
  });

  test('a BLOCKED retro (only non-passed node) → done, NOT blocked-escalation', async () => {
    await aps.write(WI, {
      ...graph({ nodes: [...allPassedWork(), retro('blocked')] }),
      work_item_id: WI,
    });
    const { nextNode } = await import('~/core/autopilot-loop');
    const res = await nextNode(repo, WI);
    // the blocked retro must NOT halt the run via the blocked escalation — the graph
    // is terminal and reaches `done` with completion not degraded.
    expect(res.action).toBe('done');
    if (res.action !== 'done') throw new Error('expected done');
    expect(res.all_passed).toBe(true);
    expect(res.disposition).toBe('converged');
  });

  test('regression: a FAILED NON-retro node still degrades completion (done, all_passed false)', async () => {
    const nodes = buildInitialNodes(['ac-1']).map((n, i) =>
      i === 2 ? { ...n, status: 'failed' as const } : { ...n, status: 'passed' as const },
    );
    await aps.write(WI, { ...graph({ nodes }), work_item_id: WI });
    const { nextNode } = await import('~/core/autopilot-loop');
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('done');
    if (res.action !== 'done') throw new Error('expected done');
    expect(res.all_passed).toBe(false);
    expect(res.disposition).toBe(null);
  });

  test('regression: a BLOCKED NON-retro node still halts via blocked escalation', async () => {
    const nodes = buildInitialNodes(['ac-1']).map((n, i) =>
      i === 2 ? { ...n, status: 'blocked' as const } : { ...n, status: 'passed' as const },
    );
    await aps.write(WI, { ...graph({ nodes }), work_item_id: WI });
    const { nextNode } = await import('~/core/autopilot-loop');
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('blocked');
  });
});

describe('ADR-0024 Decision 7 — loop termination is an EXPLICIT recorded decision (ac-6, not silent)', () => {
  // The whole-graph loop disposition (converged | capped | blocked) is currently
  // COMPUTED but never persisted — it lives only as the done-action return value.
  // Decision 7 (의사결정 투명성): the loop termination must be recorded (확인 OR 문서
  // OR 계약 중 최소 하나), with a reason. The single SoT is the autopilot decision
  // log (the SAME log the `capped` disposition is already derived from), recorded
  // via a `loop_terminated` decision carrying an explicit `disposition` field that
  // MATCHES the returned action's disposition (no second drifting derivation).
  const allPassed = () =>
    buildInitialNodes(['ac-1']).map((n) => ({ ...n, status: 'passed' as const }));

  function termination(decisions: Awaited<ReturnType<AutopilotStore['readDecisions']>>) {
    return decisions.filter((d) => d.decision === 'loop_terminated');
  }

  test('converged termination records ONE loop_terminated decision with disposition=converged + a reason', async () => {
    await aps.write(WI, { ...graph({ nodes: allPassed() }), work_item_id: WI });
    const { nextNode } = await import('~/core/autopilot-loop');
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('done');
    if (res.action !== 'done') throw new Error('expected done');
    const recs = termination(await aps.readDecisions(WI));
    expect(recs.length).toBe(1);
    expect(recs[0]?.disposition).toBe('converged');
    // recorded disposition matches the returned (computed) one — one SoT, no drift.
    expect(recs[0]?.disposition).toBe(res.disposition as 'converged' | 'capped' | undefined);
    expect((recs[0]?.reason ?? '').length).toBeGreaterThan(0);
  });

  test('capped termination records disposition=capped (matches convergence exit.reason cap_reached semantics)', async () => {
    await aps.write(WI, { ...graph({ nodes: allPassed() }), work_item_id: WI });
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
    expect(res.disposition).toBe('capped');
    const recs = termination(await aps.readDecisions(WI));
    expect(recs.length).toBe(1);
    expect(recs[0]?.disposition).toBe('capped');
  });

  test('partial-fail termination (all_passed false at done) records disposition=blocked WITH a reason (this is when the record matters most)', async () => {
    const nodes = buildInitialNodes(['ac-1']).map((n, i) =>
      i === 2 ? { ...n, status: 'failed' as const } : { ...n, status: 'passed' as const },
    );
    await aps.write(WI, { ...graph({ nodes }), work_item_id: WI });
    const { nextNode } = await import('~/core/autopilot-loop');
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('done');
    if (res.action !== 'done') throw new Error('expected done');
    expect(res.all_passed).toBe(false);
    const recs = termination(await aps.readDecisions(WI));
    expect(recs.length).toBe(1);
    // a failure-termination is NOT a fixpoint — recorded as `blocked` (the
    // convergence vocabulary for "closed without convergence"), never null/silent.
    expect(recs[0]?.disposition).toBe('blocked');
    expect((recs[0]?.reason ?? '').length).toBeGreaterThan(0);
  });

  test('blocked-escalation termination (a node blocked on a user-owned decision) records disposition=blocked', async () => {
    const nodes = buildInitialNodes(['ac-1']).map((n, i) =>
      i === 2 ? { ...n, status: 'blocked' as const } : { ...n, status: 'passed' as const },
    );
    await aps.write(WI, { ...graph({ nodes }), work_item_id: WI });
    const { nextNode } = await import('~/core/autopilot-loop');
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('blocked');
    const recs = termination(await aps.readDecisions(WI));
    expect(recs.length).toBe(1);
    expect(recs[0]?.disposition).toBe('blocked');
  });

  test('idempotent: a repeated next-node at terminal does NOT append a second termination record', async () => {
    await aps.write(WI, { ...graph({ nodes: allPassed() }), work_item_id: WI });
    const { nextNode } = await import('~/core/autopilot-loop');
    await nextNode(repo, WI);
    await nextNode(repo, WI);
    await nextNode(repo, WI);
    const recs = termination(await aps.readDecisions(WI));
    expect(recs.length).toBe(1);
  });

  test('disposition drift: a blocked termination that later UNBLOCKS+CONVERGES records the LATEST disposition (converged), and a same-disposition re-poll appends nothing', async () => {
    // A node can transition blocked → running (autopilot-graph), so a run can
    // record `blocked`, then unblock and converge. The guard must key on the
    // DISPOSITION too: the LATEST loop_terminated entry must be the authoritative
    // final disposition (append-only log, latest wins) — not a stale `blocked`.
    const { nextNode } = await import('~/core/autopilot-loop');

    // Phase 1: one node blocked on a user-owned decision → blocked-escalation
    // termination recorded as `blocked`.
    const blockedNodes = buildInitialNodes(['ac-1']).map((n, i) =>
      i === 2 ? { ...n, status: 'blocked' as const } : { ...n, status: 'passed' as const },
    );
    await aps.write(WI, { ...graph({ nodes: blockedNodes }), work_item_id: WI });
    const blockedRes = await nextNode(repo, WI);
    expect(blockedRes.action).toBe('blocked');
    let recs = termination(await aps.readDecisions(WI));
    expect(recs.length).toBe(1);
    expect(recs.at(-1)?.disposition).toBe('blocked');

    // A same-disposition re-poll (still blocked) must append NOTHING (idempotent).
    await nextNode(repo, WI);
    recs = termination(await aps.readDecisions(WI));
    expect(recs.length).toBe(1);

    // Phase 2: the node unblocks and the run converges (every node passed).
    await aps.write(WI, { ...graph({ nodes: allPassed() }), work_item_id: WI });
    const doneRes = await nextNode(repo, WI);
    expect(doneRes.action).toBe('done');
    if (doneRes.action !== 'done') throw new Error('expected done');
    expect(doneRes.disposition).toBe('converged');

    // The disposition DIFFERS (blocked → converged) ⇒ a new entry is appended, and
    // the LATEST entry is the authoritative final disposition.
    recs = termination(await aps.readDecisions(WI));
    expect(recs.length).toBe(2);
    expect(recs.at(-1)?.disposition).toBe('converged');

    // A same-disposition re-poll now (still converged) appends nothing.
    await nextNode(repo, WI);
    recs = termination(await aps.readDecisions(WI));
    expect(recs.length).toBe(2);
    expect(recs.at(-1)?.disposition).toBe('converged');
  });

  test('a retro-only non-pass still terminates `converged` and records it (retro non-blocking preserved)', async () => {
    const retro = {
      id: 'R',
      kind: 'retro' as const,
      owner: 'retrospective' as const,
      purpose: 'retrospective',
      status: 'failed' as const,
      depends_on: [] as string[],
      acceptance_refs: [] as string[],
      evidence_refs: [],
      ac_verdicts: [],
      attempts: { fix: 0, switch: 0 },
    };
    await aps.write(WI, { ...graph({ nodes: [...allPassed(), retro] }), work_item_id: WI });
    const { nextNode } = await import('~/core/autopilot-loop');
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('done');
    if (res.action !== 'done') throw new Error('expected done');
    expect(res.disposition).toBe('converged');
    const recs = termination(await aps.readDecisions(WI));
    expect(recs.length).toBe(1);
    expect(recs[0]?.disposition).toBe('converged');
  });
});

describe('ADR-0024 Decision 4 — a retro node is appended at design-close after the terminal verify (ac-2)', () => {
  // Observable: every work-item graph includes a `retro` node after the FINAL verify.
  // The retro is NOT in the static seed (that would leave a dangling depends_on when
  // the seed verify is superseded); it is added when the design node CLOSES the plan
  // stage (carries plan_brief), AFTER promotion + supersede have settled, so it
  // attaches to the verify node nothing else depends on. owner=retrospective,
  // acceptance_refs=[] (it measures, it covers no criterion).
  const planBrief = {
    change_surface: ['src/x.ts'],
    interface_changes: [],
    dod: ['done'],
    test_scenarios: ['t'],
    tier_inputs: {
      changedFileCount: 1,
      interfaceChanged: false,
      risk: { non_local: false, irreversible: false, unaudited: false },
      large: false,
    },
  };
  const proposal = (
    id: string,
    kind: 'implement' | 'verify',
    depends_on: string[],
    acceptance_refs: string[],
  ) => ({ id, kind, purpose: `p-${id}`, depends_on, acceptance_refs });

  // A design pass carrying plan_brief is only valid after a real coverage sweep
  // wrote coverage.json (the plan-stage-close precondition); seed it.
  async function seedCoverage(): Promise<void> {
    await new CoverageStore(repo).writeMap(WI, {
      schema_version: '0.1.0',
      work_item_id: WI,
      root_id: 'cov-root',
      nodes: [
        {
          id: 'cov-root',
          parent_id: null,
          label: 'intent',
          origin: 'seed',
          depth_weight: 0,
          state: 'resolved',
          children: [],
        },
      ],
    });
  }

  function retros(g: Autopilot) {
    return g.nodes.filter((n) => n.kind === 'retro');
  }
  // the terminal verify = a verify-kind node no NON-retro node depends on (the retro
  // we appended depends on it by design, so it is excluded from the "depends on"
  // scan — otherwise the very edge under test would mask the terminal verify).
  function terminalVerifyIds(g: Autopilot): string[] {
    const work = g.nodes.filter((n) => n.kind !== 'retro');
    return work
      .filter((n) => n.kind === 'verify')
      .filter((v) => !work.some((m) => m.depends_on.includes(v.id)))
      .map((v) => v.id);
  }

  test('design close with promoted generated_nodes → retro attaches to the promoted terminal verify', async () => {
    await aps.write(WI, { ...graph(), work_item_id: WI });
    await seedCoverage();
    await nextNode(repo, WI); // dispatch N1 (design)
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N1',
        result_text: 'plan: G1 implements ac-1, G2 verifies it; seed N2/N3 superseded',
        outcome: 'pass',
        plan_brief: planBrief,
        generated_nodes: [
          proposal('G1', 'implement', ['N1'], ['ac-1']),
          proposal('G2', 'verify', ['G1'], ['ac-1']),
        ],
      },
    });
    expect(res.superseded_node_ids?.sort()).toEqual(['N2', 'N3']);
    const g = await aps.get(WI);
    const rs = retros(g);
    expect(rs.length).toBe(1);
    const retro = rs[0];
    if (!retro) throw new Error('expected a retro node');
    expect(retro.owner).toBe('retrospective');
    expect(retro.acceptance_refs).toEqual([]);
    // attaches to the terminal verify (G2, the promoted verify nothing depends on).
    expect(terminalVerifyIds(g)).toEqual(['G2']);
    expect(retro.depends_on).toEqual(['G2']);
  });

  test('design close with NO generated_nodes (3-node seed) → retro attaches to the seed verify N3', async () => {
    await aps.write(WI, { ...graph(), work_item_id: WI });
    await seedCoverage();
    await nextNode(repo, WI); // dispatch N1 (design)
    await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N1',
        result_text: 'plan: keep the seed chain; no subgraph generated',
        outcome: 'pass',
        plan_brief: planBrief,
      },
    });
    const g = await aps.get(WI);
    const rs = retros(g);
    expect(rs.length).toBe(1);
    const retro = rs[0];
    if (!retro) throw new Error('expected a retro node');
    expect(retro.owner).toBe('retrospective');
    expect(retro.acceptance_refs).toEqual([]);
    // the seed verify N3 is the terminal verify; the retro depends on it.
    expect(terminalVerifyIds(g)).toEqual(['N3']);
    expect(retro.depends_on).toEqual(['N3']);
  });

  test('a legacy design pass WITHOUT plan_brief does NOT add a retro (plan stage not closed)', async () => {
    await aps.write(WI, { ...graph(), work_item_id: WI });
    await nextNode(repo, WI);
    await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N1',
        result_text: 'legacy design pass, no plan_brief',
        outcome: 'pass',
      },
    });
    const g = await aps.get(WI);
    expect(retros(g).length).toBe(0);
  });
});

// ── T1 (wi_2606266az) runtime driver wiring ─────────────────────────────────

describe('T1 ac-2 reverify — an unverified-but-gatherable in-scope AC auto-splices a re-verify round', () => {
  test('verify node leaves ac-1 unverified with a RUNNABLE (dynamic_test) oracle → splice reverify fix+verify', async () => {
    await assignOracle('ac-1', {
      verification_method: 'dynamic_test',
      maps_to: 'ac-1',
      direction: 'backward',
    });
    await aps.write(WI, { ...graph({ nodes: [verifyNode('running')] }), work_item_id: WI });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V',
        result_text: 'inspected ac-1 by hand but the runnable test was not executed this round',
        outcome: 'pass',
        ac_verdicts: [
          { criterion_id: 'ac-1', verdict: 'unverified', notes: 'runnable test not yet executed' },
        ],
      },
    });
    // the verify node itself passes; the loop keeps going through the spliced
    // reverify round so the missing evidence is collected (residual → 0).
    expect(res.status).toBe('passed');
    expect(res.promoted_node_ids).toEqual(['V.fix.r0', 'V.rev.r0']);
    const g = await aps.get(WI);
    const fix = g.nodes.find((n) => n.id === 'V.fix.r0');
    expect(fix?.kind).toBe('fix');
    expect(fix?.owner).toBe('implementer');
    expect(fix?.depends_on).toEqual(['V']); // forward edge only
    const recheck = g.nodes.find((n) => n.id === 'V.rev.r0');
    expect(recheck?.kind).toBe('verify'); // ac-2 reverify converges through a verify recheck
    expect(recheck?.depends_on).toEqual(['V.fix.r0']);
  });

  test('unverified AC with NO gatherable oracle (soft_judgment) stays honest-unverified → no splice', async () => {
    await assignOracle('ac-1', {
      verification_method: 'soft_judgment',
      maps_to: 'ac-1',
      direction: 'backward',
    });
    await aps.write(WI, { ...graph({ nodes: [verifyNode('running')] }), work_item_id: WI });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V',
        result_text:
          'ac-1 rests on a human judgment call; there is no runnable oracle to auto-collect',
        outcome: 'pass',
        ac_verdicts: [
          {
            criterion_id: 'ac-1',
            verdict: 'unverified',
            notes: 'soft judgment, not auto-collectable',
          },
        ],
      },
    });
    expect(res.status).toBe('passed');
    expect(res.promoted_node_ids).toEqual([]); // honest-unverified, NOT re-verified
    expect((await aps.get(WI)).nodes).toHaveLength(1);
  });

  test('the run does NOT close on a collectable unverified: nextNode drives the spliced re-verify forward', async () => {
    await assignOracle('ac-1', {
      verification_method: 'dynamic_test',
      maps_to: 'ac-1',
      direction: 'backward',
    });
    await aps.write(WI, { ...graph({ nodes: [verifyNode('running')] }), work_item_id: WI });
    await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V',
        result_text: 'inspected ac-1 by hand but did not run the available test this round',
        outcome: 'pass',
        ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'unverified' }],
      },
    });
    // Before the run can close, the loop keeps going: the spliced fix is dispatched,
    // and the re-run trace (V.fix.r0 → V.rev.r0) lives in the graph the completion
    // is assembled from.
    const next = await nextNode(repo, WI);
    expect(next.action).toBe('spawn');
    if (next.action === 'spawn') expect(next.node_id).toBe('V.fix.r0');
  });

  test('unverified AC with NO oracle at all stays honest-unverified → no splice', async () => {
    await aps.write(WI, { ...graph({ nodes: [verifyNode('running')] }), work_item_id: WI });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V',
        result_text: 'ac-1 was not assigned an oracle, so there is no runnable evidence to gather',
        outcome: 'pass',
        ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'unverified' }],
      },
    });
    expect(res.status).toBe('passed');
    expect(res.promoted_node_ids).toEqual([]);
    expect((await aps.get(WI)).nodes).toHaveLength(1);
  });
});

describe('T1 ac-3 risk routing — agent_resolvable auto-fixes BY DEFAULT, the 4 reasons surface in-flow', () => {
  test('an agent_resolvable residual risk auto-routes to a risk_fix forward round + ledger discloses auto_fix', async () => {
    await aps.write(WI, { ...graph({ nodes: [verifyNode('running')] }), work_item_id: WI });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V',
        result_text:
          'verified ac-1; one residual the agent can resolve remains (a missing null guard)',
        outcome: 'pass',
        residual_risks: [
          { risk: 'a missing null guard on the new path', resolvability: 'agent_resolvable' },
        ],
      },
    });
    expect(res.status).toBe('passed');
    expect(res.promoted_node_ids).toEqual(['V.fix.r0', 'V.rev.r0']);
    const g = await aps.get(WI);
    expect(g.nodes.find((n) => n.id === 'V.fix.r0')?.kind).toBe('fix');
    expect(g.nodes.find((n) => n.id === 'V.rev.r0')?.kind).toBe('verify');
    // ledger discloses the auto-fix + its structured reason-category (not free-text).
    const decisions = await aps.readDecisions(WI);
    const autoFix = decisions.find((d) => d.decision === 'auto_fix');
    expect(autoFix?.resolvability).toBe('agent_resolvable');
  });

  test('default (unlabeled) residual risk auto-fixes BY DEFAULT', async () => {
    await aps.write(WI, { ...graph({ nodes: [verifyNode('running')] }), work_item_id: WI });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V',
        result_text: 'verified ac-1; one unlabeled residual the agent should just fix',
        outcome: 'pass',
        residual_risks: [{ risk: 'an unlabeled residual' }],
      },
    });
    expect(res.promoted_node_ids).toEqual(['V.fix.r0', 'V.rev.r0']);
    const decisions = await aps.readDecisions(WI);
    expect(decisions.some((d) => d.decision === 'auto_fix')).toBe(true);
  });

  for (const reason of [
    'decision_or_adr_conflict',
    'multiple_comparable_solutions',
    'out_of_scope',
    'genuinely_dangerous',
  ] as const) {
    test(`a ${reason} residual risk SURFACES in-flow (no splice, flow continues) + ledger discloses the category`, async () => {
      await aps.write(WI, { ...graph({ nodes: [verifyNode('running')] }), work_item_id: WI });
      const res = await recordResult(repo, {
        workItemId: WI,
        now: NOW,
        payload: {
          node_id: 'V',
          result_text: `verified ac-1; one residual must be surfaced to the user (${reason})`,
          outcome: 'pass',
          residual_risks: [
            { risk: 'a residual the loop must not auto-fix', resolvability: reason },
          ],
        },
      });
      // flow CONTINUES: the node still passes, the loop does NOT terminate, no splice.
      expect(res.status).toBe('passed');
      expect(res.promoted_node_ids).toEqual([]);
      expect((await aps.get(WI)).nodes).toHaveLength(1);
      const decisions = await aps.readDecisions(WI);
      const surfaced = decisions.find((d) => d.decision === 'surface');
      expect(surfaced?.resolvability).toBe(reason);
    });
  }

  test('mixed: an agent_resolvable + an out_of_scope risk → auto-fix spliced AND the surface disclosed', async () => {
    await aps.write(WI, { ...graph({ nodes: [verifyNode('running')] }), work_item_id: WI });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V',
        result_text:
          'verified ac-1; one residual is auto-fixable, one is out of the approved scope',
        outcome: 'pass',
        residual_risks: [
          { risk: 'auto-fixable residual', resolvability: 'agent_resolvable' },
          { risk: 'scope-creep residual', resolvability: 'out_of_scope' },
        ],
      },
    });
    expect(res.promoted_node_ids).toEqual(['V.fix.r0', 'V.rev.r0']); // the auto-fix drives a round
    const decisions = await aps.readDecisions(WI);
    expect(
      decisions.some((d) => d.decision === 'auto_fix' && d.resolvability === 'agent_resolvable'),
    ).toBe(true);
    expect(
      decisions.some((d) => d.decision === 'surface' && d.resolvability === 'out_of_scope'),
    ).toBe(true);
  });
});

describe('T1 ac-4 follow-ups — in-scope driven as a graph node, out-of-scope = ONE batch-escalate signal (R9)', () => {
  test('an IN-scope follow-up is DRIVEN as a current-graph node (a follow_up forward round)', async () => {
    await aps.write(WI, { ...graph({ nodes: [verifyNode('running')] }), work_item_id: WI });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V',
        result_text:
          'verified ac-1; one in-scope follow-up should be done now as part of this work',
        outcome: 'pass',
        follow_ups: [{ item: 'tighten the in-scope error path', in_scope: true }],
      },
    });
    expect(res.status).toBe('passed');
    expect(res.promoted_node_ids).toEqual(['V.fix.r0', 'V.rev.r0']); // driven in the current graph
    const g = await aps.get(WI);
    expect(g.nodes.find((n) => n.id === 'V.fix.r0')?.kind).toBe('fix');
  });

  test('an OUT-of-scope follow-up emits ONE batch-escalate signal and is NOT driven (materialize ≠ drive, R9)', async () => {
    await aps.write(WI, { ...graph({ nodes: [verifyNode('running')] }), work_item_id: WI });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V',
        result_text:
          'verified ac-1; two follow-ups belong to a separate work item, out of this scope',
        outcome: 'pass',
        follow_ups: [
          { item: 'a separate refactor', in_scope: false },
          { item: 'a new feature idea', in_scope: false },
        ],
      },
    });
    expect(res.status).toBe('passed');
    expect(res.promoted_node_ids).toEqual([]); // NOT driven here
    expect((await aps.get(WI)).nodes).toHaveLength(1); // no follow-up node materialized in this graph
    const decisions = await aps.readDecisions(WI);
    const signals = decisions.filter((d) => d.decision === 'batch_escalate');
    expect(signals).toHaveLength(1); // exactly ONE in-flow batch-escalate signal
    expect(signals[0]?.resolvability).toBe('out_of_scope');
  });

  test('mixed: in-scope is driven AND the out-of-scope batch-escalate signal is emitted', async () => {
    await aps.write(WI, { ...graph({ nodes: [verifyNode('running')] }), work_item_id: WI });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V',
        result_text:
          'verified ac-1; one follow-up is in scope, one is out of scope for batch handling',
        outcome: 'pass',
        follow_ups: [
          { item: 'in-scope tightening', in_scope: true },
          { item: 'out-of-scope idea', in_scope: false },
        ],
      },
    });
    expect(res.promoted_node_ids).toEqual(['V.fix.r0', 'V.rev.r0']);
    const decisions = await aps.readDecisions(WI);
    expect(decisions.filter((d) => d.decision === 'batch_escalate')).toHaveLength(1);
  });
});

describe('T1 #2 — generated_nodes/plan_brief ⊥ residual_risks/follow_ups (no silent promotion drop)', () => {
  // The ac-2/3/4 auto-resolve lanes early-return BEFORE the generated_nodes/plan_brief
  // promotion. A single payload carrying BOTH a promotion signal AND an auto-resolve
  // lane would silently DROP the promotion — assert mutual exclusivity with a clear
  // error instead.
  test('both-fields guard: generated_nodes + residual_risks throws (mutually exclusive, not silent drop)', async () => {
    await aps.write(WI, { ...graph({ nodes: [verifyNode('running')] }), work_item_id: WI });
    await expect(
      recordResult(repo, {
        workItemId: WI,
        now: NOW,
        payload: {
          node_id: 'V',
          result_text: 'a pass that both promotes a subgraph and surfaces a residual risk',
          outcome: 'pass',
          generated_nodes: [
            {
              id: 'G1',
              kind: 'implement',
              purpose: 'p-G1',
              depends_on: ['V'],
              acceptance_refs: ['ac-1'],
            },
          ],
          residual_risks: [{ risk: 'an auto-fixable residual', resolvability: 'agent_resolvable' }],
        },
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  test('both-fields guard: plan_brief + follow_ups throws', async () => {
    await aps.write(WI, { ...graph({ nodes: [verifyNode('running')] }), work_item_id: WI });
    await expect(
      recordResult(repo, {
        workItemId: WI,
        now: NOW,
        payload: {
          node_id: 'V',
          result_text: 'a pass that both carries a plan brief and surfaces an in-scope follow-up',
          outcome: 'pass',
          plan_brief: {
            change_surface: ['src/x.ts'],
            interface_changes: [],
            dod: ['d'],
            test_scenarios: ['t'],
            tier_inputs: {
              changedFileCount: 1,
              interfaceChanged: false,
              risk: { non_local: false, irreversible: false, unaudited: false },
              large: false,
            },
          },
          follow_ups: [{ item: 'an in-scope follow-up', in_scope: true }],
        },
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  // Regression: a promotion-only payload (no auto-resolve lane) still promotes.
  test('regression: generated_nodes WITHOUT an auto-resolve lane still promotes (no throw)', async () => {
    await aps.write(WI, { ...graph({ nodes: [verifyNode('running')] }), work_item_id: WI });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V',
        result_text: 'a pass that promotes a subgraph, no residual/follow-up lane',
        outcome: 'pass',
        generated_nodes: [
          {
            id: 'G1',
            kind: 'implement',
            purpose: 'p-G1',
            depends_on: ['V'],
            acceptance_refs: ['ac-1'],
          },
        ],
      },
    });
    expect(res.status).toBe('passed');
    expect(res.promoted_node_ids).toContain('G1');
  });
});

describe('T1 ac-5 / R5 / R2 — no-progress floor, optional-tool surface, loop-cap inheritance', () => {
  test('ac-5 no-progress floor: a reverify chain at caps.no_progress_rounds escalates IN-FLOW (blocked, NOT a silent pass)', async () => {
    await assignOracle('ac-1', {
      verification_method: 'dynamic_test',
      maps_to: 'ac-1',
      direction: 'backward',
    });
    // seed id carries one .rev.r marker → forwardRound 1; no_progress_rounds 1 ⇒ 1 ≥ 1 escalate.
    const seed = { ...verifyNode('running'), id: 'V.rev.r0' };
    await aps.write(WI, {
      ...graph({
        nodes: [seed],
        caps: {
          fix_per_node: 2,
          switch_per_node: 1,
          no_progress_rounds: 1,
          converge_rounds: 99,
          loop_rounds: 99,
          oracle_failures_to_block: 3,
          progress_continuation_cap: 24,
        },
      }),
      work_item_id: WI,
    });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V.rev.r0',
        result_text:
          'still cannot collect the runnable evidence after the prior round — no progress',
        outcome: 'pass',
        ac_verdicts: [
          { criterion_id: 'ac-1', verdict: 'unverified', notes: 'still not collected' },
        ],
      },
    });
    // capped ≠ converged: in-flow escalate, NOT a silent pass; no further splice.
    expect(res.status).toBe('blocked');
    expect(res.outcome).toBe('fail');
    expect(res.failure_class).toBe('user_decision_needed');
    expect(res.promoted_node_ids).toEqual([]);
    const decisions = await aps.readDecisions(WI);
    expect(decisions.at(-1)?.decision).toBe('escalate');
  });

  test('R5/ADR-0018: an unverified AC blocked ONLY by an absent optional tool surfaces blocked_external, NOT an endless re-verify', async () => {
    await assignOracle('ac-1', {
      verification_method: 'static_scan',
      maps_to: 'ac-1',
      direction: 'backward',
    });
    await aps.write(WI, { ...graph({ nodes: [verifyNode('running')] }), work_item_id: WI });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V',
        result_text:
          'ac-1 needs the static scanner which is absent on this host; cannot collect this round',
        outcome: 'pass',
        ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'unverified' }],
        blocked_by_tool: {
          tool: 'codeql',
          grounding: 'ADR-0018: CodeQL optional; absent on this host',
        },
      },
    });
    expect(res.status).toBe('passed'); // honest-unverified — the node passes
    expect(res.promoted_node_ids).toEqual([]); // NO re-verify splice (would loop forever)
    expect((await aps.get(WI)).nodes).toHaveLength(1);
    const decisions = await aps.readDecisions(WI);
    const surfaced = decisions.find((d) => d.decision === 'surface');
    expect(surfaced?.resolvability).toBe('blocked_external');
  });

  test('R2 loop-cap inheritance: an auto-resolve splice is refused once the graph reaches loop_rounds (capped, no new uncapped path)', async () => {
    await assignOracle('ac-1', {
      verification_method: 'dynamic_test',
      maps_to: 'ac-1',
      direction: 'backward',
    });
    // two existing forward-review nodes already consume loop_rounds=2 (counted by
    // the SAME .rev.r marker the auto-resolve splices reuse).
    const prior1 = { ...verifyNode('passed'), id: 'X.rev.r0' };
    const prior2 = { ...verifyNode('passed'), id: 'X.rev.r0.rev.r1' };
    await aps.write(WI, {
      ...graph({
        nodes: [prior1, prior2, verifyNode('running')],
        caps: {
          fix_per_node: 2,
          switch_per_node: 1,
          no_progress_rounds: 99,
          converge_rounds: 99,
          loop_rounds: 2,
          oracle_failures_to_block: 3,
          progress_continuation_cap: 24,
        },
      }),
      work_item_id: WI,
    });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'V',
        result_text: 'ac-1 is unverified+gatherable but the graph already hit the loop-level cap',
        outcome: 'pass',
        ac_verdicts: [{ criterion_id: 'ac-1', verdict: 'unverified' }],
      },
    });
    expect(res.status).toBe('blocked');
    expect(res.cap_exceeded).toBe(true);
    expect(res.promoted_node_ids).toEqual([]); // refused — counted against loop_rounds
  });
});

describe('wi_2607148yg discovered real-behavior defects (materialize + chain-drive vs backlog)', () => {
  // A running implement node that discovers a defect mid-run. Not a verify node so the
  // gatherable-reverify path never engages — the discovered_defects channel is exercised alone.
  function implementNode(id = 'IMP', status: 'running' | 'passed' = 'running') {
    return {
      id,
      kind: 'implement' as const,
      owner: 'implementer' as const,
      purpose: 'implement ac-1',
      status,
      depends_on: [] as string[],
      acceptance_refs: ['ac-1'],
      evidence_refs: [],
      ac_verdicts: [],
      attempts: { fix: 0, switch: 0 },
    };
  }
  const passEvidence = [{ kind: 'file' as const, path: 'src/x.ts', summary: 'impl' }];

  // The created child WI id is the FIRST wi_ token in the disclosure reason (the origin id
  // only appears after `discovered_by`).
  const childWiFromReason = (reason: string): string | undefined =>
    reason.match(/work item \((wi_[a-z0-9]+),/)?.[1];

  test('(a) a REPRODUCED defect is materialized into a REAL back-linked work item AND chain-driven — splices a defect_fix round + records defect_chain_driven', async () => {
    await aps.write(WI, { ...graph({ nodes: [implementNode()] }), work_item_id: WI });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'IMP',
        result_text: 'Implemented ac-1; a re-run reproduced a real crash on the error path.',
        outcome: 'pass',
        evidence_refs: passEvidence,
        changed_files: ['src/x.ts'],
        discovered_defects: [{ item: 'error-path crash reproduced', reproduced: true }],
      },
    });
    // The origin node passes; a fix+verify pair is spliced (drive in the SAME graph).
    expect(res.status).toBe('passed');
    expect(res.promoted_node_ids).toHaveLength(2);
    // the spliced round carries the .rev.r marker (shares the run-level loop_rounds budget).
    expect(res.promoted_node_ids.some((id) => id.includes('.rev.r'))).toBe(true);
    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === res.promoted_node_ids[1])?.kind).toBe('verify');
    const decisions = await aps.readDecisions(WI);
    const driven = decisions.find((d) => d.decision === 'defect_chain_driven');
    expect(driven).toBeDefined();
    expect(driven?.resolvability).toBe('discovered_defect');
    expect(driven?.reason.toLowerCase()).toContain('own commit'); // ac-3 isolation attested
    // ac-1: a REAL persisted child work item was created (not a free-text mention) …
    const childId = childWiFromReason(driven?.reason ?? '');
    if (!childId) throw new Error('expected a materialized child wi id in the disclosure reason');
    expect(await wis.exists(childId)).toBe(true);
    // … with a discovered_by backlink to the ORIGIN work item (provenance, not hierarchy).
    const child = await wis.get(childId);
    expect(child.discovered_by).toBe(WI);
    expect(child.id).not.toBe(WI); // ac-3: a DISTINCT work item from the origin
  });

  test('(b) a NOT-reproduced / uncertain defect is backlog-only — NO splice, NOT driven', async () => {
    await aps.write(WI, { ...graph({ nodes: [implementNode()] }), work_item_id: WI });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'IMP',
        result_text: 'Implemented ac-1; noticed a possibly-latent edge case, could not reproduce.',
        outcome: 'pass',
        evidence_refs: passEvidence,
        changed_files: ['src/x.ts'],
        discovered_defects: [{ item: 'possible latent edge case', reproduced: false }],
      },
    });
    expect(res.status).toBe('passed');
    expect(res.promoted_node_ids).toEqual([]); // NOT driven
    const decisions = await aps.readDecisions(WI);
    // materialized (surfaced) with resolvability discovered_defect, but no drive.
    const surfaced = decisions.find(
      (d) => d.decision === 'surface' && d.resolvability === 'discovered_defect',
    );
    expect(surfaced).toBeDefined();
    // ac-1/ac-10: backlog-only still materializes a REAL back-linked work item (the close
    // gate resolves this id; a fabricated string could not stand in for it).
    const backlogChild = childWiFromReason(surfaced?.reason ?? '');
    if (!backlogChild)
      throw new Error('expected a materialized backlog wi id in the surface reason');
    expect(await wis.exists(backlogChild)).toBe(true);
    expect((await wis.get(backlogChild)).discovered_by).toBe(WI);
    expect(decisions.some((d) => d.decision === 'defect_chain_driven')).toBe(false);
  });

  test('(b2) a reproduced but LATENT bug is backlog-only (conservative exclusion, not driven)', async () => {
    await aps.write(WI, { ...graph({ nodes: [implementNode()] }), work_item_id: WI });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'IMP',
        result_text: 'Implemented ac-1; found a latent bug with no current harm.',
        outcome: 'pass',
        evidence_refs: passEvidence,
        changed_files: ['src/x.ts'],
        discovered_defects: [{ item: 'latent, no current harm', reproduced: true, latent: true }],
      },
    });
    expect(res.promoted_node_ids).toEqual([]);
    const decisions = await aps.readDecisions(WI);
    expect(decisions.some((d) => d.decision === 'defect_chain_driven')).toBe(false);
    expect(
      decisions.some((d) => d.decision === 'surface' && d.resolvability === 'discovered_defect'),
    ).toBe(true);
  });

  test('(c) nested derived defects SHARE the run-level budget — a drive at the loop_rounds cap escalates (no N×fresh-caps runaway)', async () => {
    // The graph already holds loop_rounds=2 forward rounds (prior derived-defect drives,
    // counted by the SAME .rev.r marker the defect_fix splice reuses). A further reproduced
    // defect must NOT get a fresh caps block — it shares the ORIGINATING run's budget and
    // escalates to a fail-handoff at the shared cap. This is the ac-6 runaway floor.
    const prior1 = { ...implementNode('IMP.rev.r0', 'passed') };
    const prior2 = { ...implementNode('IMP.rev.r0.rev.r1', 'passed') };
    await aps.write(WI, {
      ...graph({
        nodes: [prior1, prior2, implementNode()],
        caps: {
          fix_per_node: 2,
          switch_per_node: 1,
          no_progress_rounds: 99,
          converge_rounds: 99,
          loop_rounds: 2,
          oracle_failures_to_block: 3,
          progress_continuation_cap: 24,
        },
      }),
      work_item_id: WI,
    });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'IMP',
        result_text: 'Yet another reproduced defect after the graph already hit the loop cap.',
        outcome: 'pass',
        evidence_refs: passEvidence,
        changed_files: ['src/x.ts'],
        discovered_defects: [{ item: 'nth reproduced defect', reproduced: true }],
      },
    });
    // capped, not driven: the shared run budget stops the chain (termination guaranteed).
    expect(res.status).toBe('blocked');
    expect(res.cap_exceeded).toBe(true);
    expect(res.promoted_node_ids).toEqual([]);
    const decisions = await aps.readDecisions(WI);
    // NOT recorded as driven (the splice never drove) — it escalated instead.
    expect(decisions.some((d) => d.decision === 'defect_chain_driven')).toBe(false);
    expect(decisions.some((d) => d.failure_class === 'user_decision_needed')).toBe(true);
    // (wi_260714mfx) the capped/undriven defect is still forward-traceable: materialize-only,
    // disclosed as surface(discovered_defect) so its child wi_ is not lost from the ledger.
    expect(
      decisions.some((d) => d.decision === 'surface' && d.resolvability === 'discovered_defect'),
    ).toBe(true);
  });

  test('(e) a condition-b defect fix does NOT auto-drive — fail-closed blocked handoff', async () => {
    await aps.write(WI, { ...graph({ nodes: [implementNode()] }), work_item_id: WI });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'IMP',
        result_text: 'Reproduced a defect, but fixing it needs a security-adverse decision.',
        outcome: 'pass',
        evidence_refs: passEvidence,
        changed_files: ['src/x.ts'],
        discovered_defects: [
          {
            item: 'reproduced defect whose fix weakens auth',
            reproduced: true,
            condition_b: [
              { domain: 'security', adverse: true, basis: 'fix would relax an auth check' },
            ],
          },
        ],
      },
    });
    // fail-closed: blocked, user-owned decision, NO auto-drive splice.
    expect(res.status).toBe('blocked');
    expect(res.decision).toBe('escalate');
    expect(res.failure_class).toBe('user_decision_needed');
    expect(res.promoted_node_ids).toEqual([]);
    expect(res.reason.toLowerCase()).toContain('condition-b');
    const decisions = await aps.readDecisions(WI);
    expect(decisions.some((d) => d.decision === 'defect_chain_driven')).toBe(false);
  });

  test('(e2) a NON-adverse condition-b touch does NOT block — the drive proceeds (only ADVERSE decisions fail-close)', async () => {
    await aps.write(WI, { ...graph({ nodes: [implementNode()] }), work_item_id: WI });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'IMP',
        result_text: 'Reproduced a defect whose fix touches security but is not adverse.',
        outcome: 'pass',
        evidence_refs: passEvidence,
        changed_files: ['src/x.ts'],
        discovered_defects: [
          {
            item: 'reproduced defect, non-adverse security touch',
            reproduced: true,
            condition_b: [
              { domain: 'security', adverse: false, basis: 'adds a defensive check, not adverse' },
            ],
          },
        ],
      },
    });
    expect(res.status).toBe('passed'); // not fail-closed — the drive proceeds
    expect(res.promoted_node_ids).toHaveLength(2);
    expect((await aps.readDecisions(WI)).some((d) => d.decision === 'defect_chain_driven')).toBe(
      true,
    );
  });

  test('(d) ac-5 non-defect path UNCHANGED — an out-of-scope follow-up still batch_escalates (no auto-drive), no defect_chain_driven', async () => {
    await aps.write(WI, { ...graph({ nodes: [implementNode()] }), work_item_id: WI });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'IMP',
        result_text: 'Implemented ac-1; noted an out-of-scope idea for later.',
        outcome: 'pass',
        evidence_refs: passEvidence,
        changed_files: ['src/x.ts'],
        follow_ups: [{ item: 'a nice-to-have refactor idea', in_scope: false }],
      },
    });
    expect(res.status).toBe('passed');
    expect(res.promoted_node_ids).toEqual([]); // no-auto-pick: signal only, not driven
    const decisions = await aps.readDecisions(WI);
    expect(decisions.some((d) => d.decision === 'batch_escalate')).toBe(true);
    // the defect drive route never fires for a non-defect follow-up.
    expect(decisions.some((d) => d.decision === 'defect_chain_driven')).toBe(false);
  });

  // ── wi_260714mfx: honest multi-defect disclosure ──────────────────────────
  // A single defect_fix splice drives ONE generic fix round, NOT per-defect. When
  // N>1 drive-eligible defects are reported, only ONE may be attested as chain-driven;
  // the others are materialize-only and must be disclosed as `surface`, never falsely
  // logged as `defect_chain_driven` (the over-claim bug).

  test('mfx-1 N>1 drive-eligible + splice pass → EXACTLY ONE defect_chain_driven, the other N-1 are surface(discovered_defect)', async () => {
    await aps.write(WI, { ...graph({ nodes: [implementNode()] }), work_item_id: WI });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'IMP',
        result_text: 'Implemented ac-1; a re-run reproduced TWO distinct real crashes.',
        outcome: 'pass',
        evidence_refs: passEvidence,
        changed_files: ['src/x.ts'],
        discovered_defects: [
          { item: 'first reproduced defect', reproduced: true },
          { item: 'second reproduced defect', reproduced: true },
        ],
      },
    });
    // ONE splice (a fix+verify pair), not two — a single defect_fix round.
    expect(res.status).toBe('passed');
    expect(res.promoted_node_ids).toHaveLength(2);
    const decisions = await aps.readDecisions(WI);
    const driven = decisions.filter((d) => d.decision === 'defect_chain_driven');
    // exactly ONE driven — the over-claim (N drivens for 1 round) is the bug.
    expect(driven).toHaveLength(1);
    // deterministic: the FIRST drive-eligible defect (array order) is the driven one.
    expect(driven[0]?.reason).toContain('first reproduced defect');
    // the OTHER defect is disclosed as surface(discovered_defect), NOT driven.
    const surfaced = decisions.filter(
      (d) => d.decision === 'surface' && d.resolvability === 'discovered_defect',
    );
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]?.reason).toContain('second reproduced defect');
    expect(surfaced[0]?.reason.toLowerCase()).toContain('not driven');
    // both defects are materialized into REAL back-linked child work items (ac-3 traceable).
    const drivenChild = childWiFromReason(driven[0]?.reason ?? '');
    const surfacedChild = childWiFromReason(surfaced[0]?.reason ?? '');
    if (!drivenChild || !surfacedChild)
      throw new Error('expected a materialized child wi id in each disclosure reason');
    expect(await wis.exists(drivenChild)).toBe(true);
    expect(await wis.exists(surfacedChild)).toBe(true);
    expect((await wis.get(surfacedChild)).discovered_by).toBe(WI);
    expect(drivenChild).not.toBe(surfacedChild);
  });

  test('mfx-2 N>1 drive-eligible + splice ESCALATE (loop cap) → ALL N surface(discovered_defect) with a child wi_ in each reason, NONE driven', async () => {
    const prior1 = { ...implementNode('IMP.rev.r0', 'passed') };
    const prior2 = { ...implementNode('IMP.rev.r0.rev.r1', 'passed') };
    await aps.write(WI, {
      ...graph({
        nodes: [prior1, prior2, implementNode()],
        caps: {
          fix_per_node: 2,
          switch_per_node: 1,
          no_progress_rounds: 99,
          converge_rounds: 99,
          loop_rounds: 2,
          oracle_failures_to_block: 3,
          progress_continuation_cap: 24,
        },
      }),
      work_item_id: WI,
    });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'IMP',
        result_text: 'Two reproduced defects after the graph already hit the loop cap.',
        outcome: 'pass',
        evidence_refs: passEvidence,
        changed_files: ['src/x.ts'],
        discovered_defects: [
          { item: 'first capped defect', reproduced: true },
          { item: 'second capped defect', reproduced: true },
        ],
      },
    });
    // the splice escalated at the shared cap — the SAME outcome is returned (no new block added).
    expect(res.status).toBe('blocked');
    expect(res.cap_exceeded).toBe(true);
    expect(res.promoted_node_ids).toEqual([]);
    const decisions = await aps.readDecisions(WI);
    // NONE driven (the splice never drove a round).
    expect(decisions.some((d) => d.decision === 'defect_chain_driven')).toBe(false);
    // ALL N are disclosed as surface(discovered_defect), each traceable to its own child wi_.
    const surfaced = decisions.filter(
      (d) => d.decision === 'surface' && d.resolvability === 'discovered_defect',
    );
    expect(surfaced).toHaveLength(2);
    for (const s of surfaced) {
      const child = childWiFromReason(s.reason ?? '');
      if (!child) throw new Error('expected a materialized child wi id in each surface reason');
      expect(await wis.exists(child)).toBe(true);
    }
    expect(surfaced.map((s) => s.reason).join('\n')).toContain('first capped defect');
    expect(surfaced.map((s) => s.reason).join('\n')).toContain('second capped defect');
  });

  test('mfx-3 N=1 drive-eligible + splice pass → behavior-identical: exactly 1 defect_chain_driven, 0 surface(discovered_defect)', async () => {
    await aps.write(WI, { ...graph({ nodes: [implementNode()] }), work_item_id: WI });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'IMP',
        result_text: 'Implemented ac-1; a re-run reproduced ONE real crash.',
        outcome: 'pass',
        evidence_refs: passEvidence,
        changed_files: ['src/x.ts'],
        discovered_defects: [{ item: 'sole reproduced defect', reproduced: true }],
      },
    });
    expect(res.status).toBe('passed');
    expect(res.promoted_node_ids).toHaveLength(2);
    const decisions = await aps.readDecisions(WI);
    expect(decisions.filter((d) => d.decision === 'defect_chain_driven')).toHaveLength(1);
    // no spurious surface(discovered_defect) when the single defect IS driven.
    expect(
      decisions.some((d) => d.decision === 'surface' && d.resolvability === 'discovered_defect'),
    ).toBe(false);
  });

  test('mfx-4 shared helper UNCHANGED — a non-defect (follow_up) escalate reason carries NO defect child wi_ id', async () => {
    const prior1 = { ...implementNode('IMP.rev.r0', 'passed') };
    const prior2 = { ...implementNode('IMP.rev.r0.rev.r1', 'passed') };
    await aps.write(WI, {
      ...graph({
        nodes: [prior1, prior2, implementNode()],
        caps: {
          fix_per_node: 2,
          switch_per_node: 1,
          no_progress_rounds: 99,
          converge_rounds: 99,
          loop_rounds: 2,
          oracle_failures_to_block: 3,
          progress_continuation_cap: 24,
        },
      }),
      work_item_id: WI,
    });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'IMP',
        result_text: 'An in-scope follow-up after the graph already hit the loop cap.',
        outcome: 'pass',
        evidence_refs: passEvidence,
        changed_files: ['src/x.ts'],
        follow_ups: [{ item: 'an in-scope follow-up', in_scope: true }],
      },
    });
    // the shared helper escalated generically — NOT a defect route, no child wi_ minted here.
    expect(res.status).toBe('blocked');
    expect(res.decision).toBe('escalate');
    const escalate = (await aps.readDecisions(WI)).find((d) => d.decision === 'escalate');
    expect(escalate).toBeDefined();
    // the generic escalate reason must not embed a defect child wi_ id (contamination guard).
    expect(escalate?.reason).not.toMatch(/wi_[a-z0-9]+/);
  });

  // ── wi_260714pjs: condition_b sibling starvation ──────────────────────────
  // When N>1 drive-eligible defects are reported and ANY of them carries an ADVERSE
  // condition_b, the run fail-closes (blocked/escalate) — but EVERY drive-eligible
  // defect (the condition_b one AND its non-condition_b siblings) must still be
  // materialized and disclosed so nothing is silently dropped from the ledger.

  test('pjs-1 N>1 drive-eligible with one condition_b → surface(discovered_defect) recorded for ALL, each reason carries its materialized child wi_ id', async () => {
    await aps.write(WI, { ...graph({ nodes: [implementNode()] }), work_item_id: WI });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'IMP',
        result_text: 'Two reproduced defects; one fix needs a security-adverse decision.',
        outcome: 'pass',
        evidence_refs: passEvidence,
        changed_files: ['src/x.ts'],
        discovered_defects: [
          { item: 'plain reproduced sibling defect', reproduced: true },
          {
            item: 'reproduced defect whose fix weakens auth',
            reproduced: true,
            condition_b: [
              { domain: 'security', adverse: true, basis: 'fix would relax an auth check' },
            ],
          },
        ],
      },
    });
    // fail-closed block (see pjs-2), but NOTHING dropped: both drive-eligible defects surfaced.
    expect(res.status).toBe('blocked');
    const decisions = await aps.readDecisions(WI);
    // NONE driven — the block prevents the auto-drive.
    expect(decisions.some((d) => d.decision === 'defect_chain_driven')).toBe(false);
    const surfaced = decisions.filter(
      (d) => d.decision === 'surface' && d.resolvability === 'discovered_defect',
    );
    // BOTH drive-eligible defects (incl. the condition_b one) are disclosed — the fix for the
    // sibling-starvation bug (the condition_b defect + its siblings were silently dropped).
    expect(surfaced).toHaveLength(2);
    const joined = surfaced.map((s) => s.reason).join('\n');
    expect(joined).toContain('plain reproduced sibling defect');
    expect(joined).toContain('reproduced defect whose fix weakens auth');
    // each disclosure carries a REAL materialized back-linked child work item (lossless channel).
    for (const s of surfaced) {
      const child = childWiFromReason(s.reason ?? '');
      if (!child) throw new Error('expected a materialized child wi id in each surface reason');
      expect(await wis.exists(child)).toBe(true);
      expect((await wis.get(child)).discovered_by).toBe(WI);
    }
  });

  test('pjs-2 same scenario → record-result stays fail-closed: blocked / escalate / user_decision_needed', async () => {
    await aps.write(WI, { ...graph({ nodes: [implementNode()] }), work_item_id: WI });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'IMP',
        result_text: 'Two reproduced defects; one fix needs a security-adverse decision.',
        outcome: 'pass',
        evidence_refs: passEvidence,
        changed_files: ['src/x.ts'],
        discovered_defects: [
          { item: 'plain reproduced sibling defect', reproduced: true },
          {
            item: 'reproduced defect whose fix weakens auth',
            reproduced: true,
            condition_b: [
              { domain: 'security', adverse: true, basis: 'fix would relax an auth check' },
            ],
          },
        ],
      },
    });
    // the condition_b block semantics are preserved unchanged.
    expect(res.status).toBe('blocked');
    expect(res.decision).toBe('escalate');
    expect(res.failure_class).toBe('user_decision_needed');
    expect(res.promoted_node_ids).toEqual([]);
    expect(res.reason.toLowerCase()).toContain('condition-b');
    const decisions = await aps.readDecisions(WI);
    expect(decisions.some((d) => d.failure_class === 'user_decision_needed')).toBe(true);
    expect(decisions.some((d) => d.decision === 'escalate')).toBe(true);
  });

  // ── wi_260714f4p: best-effort materialization (silent partial-materialization) ──
  // The drive-eligible materialize loop calls WorkItemStore.create per defect with NO
  // try/catch. If create THROWS mid-loop, earlier defects are persisted, the rest are
  // never created, ZERO disclosures are appended, and the exception escapes
  // recordResultCore leaving the node mid-flight — a silent partial failure with orphan
  // Records. The fix makes the loop resilient: EVERY drive-eligible defect ends with
  // EITHER a materialized child + its normal disclosure OR a failure-disclosure.
  const INJECTED_CREATE_ERR = 'injected disk write failure';
  const materializeFailingFor =
    (failItem: string) =>
    async (
      repoRoot: string,
      originWorkItemId: string,
      item: string,
      now: Date,
    ): Promise<string> => {
      if (item === failItem) throw new Error(INJECTED_CREATE_ERR);
      const child = await new WorkItemStore(repoRoot).create(
        {
          title: `defect: ${item}`.slice(0, 200),
          source_request: `Discovered mid-run while working on ${originWorkItemId}: ${item}`,
          goal: `Fix: ${item}`,
          acceptance_criteria: [
            { id: 'ac-1', statement: 'fix the defect', verdict: 'unverified', evidence: [] },
          ],
          discovered_by: originWorkItemId,
        },
        now,
      );
      return child.id;
    };

  test('f4p-1 a create throw for ONE drive-eligible defect does NOT escape — the others still materialize, the failed one gets a surface(discovered_defect) failure disclosure (no silent drop)', async () => {
    await aps.write(WI, { ...graph({ nodes: [implementNode()] }), work_item_id: WI });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      materializeDefect: materializeFailingFor('the create-failing defect'),
      payload: {
        node_id: 'IMP',
        result_text: 'Three reproduced defects; the disk write fails for the middle one.',
        outcome: 'pass',
        evidence_refs: passEvidence,
        changed_files: ['src/x.ts'],
        discovered_defects: [
          { item: 'first ok defect', reproduced: true },
          { item: 'the create-failing defect', reproduced: true },
          { item: 'third ok defect', reproduced: true },
        ],
      },
    });
    // recordResultCore did NOT throw — the loop absorbed the create failure.
    expect(res.status).toBe('passed');
    const decisions = await aps.readDecisions(WI);
    const disclosures = decisions.filter((d) => d.resolvability === 'discovered_defect');
    // every drive-eligible defect is accounted for: 2 materialized + 1 failure = 3 disclosures.
    expect(disclosures).toHaveLength(3);
    // the failed defect is disclosed as a materialization FAILURE (item text + error), NOT dropped.
    const failure = disclosures.find((d) => d.reason.includes('the create-failing defect'));
    expect(failure).toBeDefined();
    expect(failure?.decision).toBe('surface');
    expect(failure?.reason).toContain(INJECTED_CREATE_ERR);
    expect(failure?.reason.toLowerCase()).toContain('could not be materialized');
    // it carries NO child wi_ (there is none — create failed).
    expect(childWiFromReason(failure?.reason ?? '')).toBeUndefined();
    // the OTHER two defects still materialized into REAL back-linked child work items.
    const okDisclosures = disclosures.filter((d) => d !== failure);
    expect(okDisclosures).toHaveLength(2);
    for (const d of okDisclosures) {
      const child = childWiFromReason(d.reason ?? '');
      if (!child) throw new Error('expected a materialized child wi id for a non-failing defect');
      expect(await wis.exists(child)).toBe(true);
      expect((await wis.get(child)).discovered_by).toBe(WI);
    }
    // the failed defect is disclosed EXACTLY once (not re-disclosed as materialize-only).
    expect(disclosures.filter((d) => d.reason.includes('the create-failing defect'))).toHaveLength(
      1,
    );
  });

  test('f4p-2 3 drive-eligible defects all create-successfully → exactly 3 discovered_defect disclosures, each reason child wi_ exists', async () => {
    await aps.write(WI, { ...graph({ nodes: [implementNode()] }), work_item_id: WI });
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'IMP',
        result_text: 'Three reproduced defects, all materialize successfully.',
        outcome: 'pass',
        evidence_refs: passEvidence,
        changed_files: ['src/x.ts'],
        discovered_defects: [
          { item: 'defect one', reproduced: true },
          { item: 'defect two', reproduced: true },
          { item: 'defect three', reproduced: true },
        ],
      },
    });
    expect(res.status).toBe('passed');
    const decisions = await aps.readDecisions(WI);
    const disclosures = decisions.filter((d) => d.resolvability === 'discovered_defect');
    expect(disclosures).toHaveLength(3);
    for (const d of disclosures) {
      const child = childWiFromReason(d.reason ?? '');
      if (!child) throw new Error('expected a materialized child wi id in each disclosure reason');
      expect(await wis.exists(child)).toBe(true);
    }
  });
});
