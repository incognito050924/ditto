import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActiveNodeLeaseStore } from '~/core/active-node-lease';
import { nextNode, reopenImplementNode } from '~/core/autopilot-loop';
import { AutopilotStore } from '~/core/autopilot-store';
import { WorkItemStore } from '~/core/work-item-store';
import type { Autopilot, AutopilotNode } from '~/schemas/autopilot';

// Background (wi_260713wxq, issue #31 — n2-reopen): these mock-unit tests pin the
// USER-ACTION reopen primitive. Each test encodes exactly one AC clause:
//   ac-2  reopen a passed implement node → pending; the target lease is released
//         (re-dispatch mints a fresh scoped lease that passes the guard, no BYPASS).
//   ac-3  the re-dispatched delegation packet carries the user's feedback as DATA.
//   ac-4  every transitive downstream verify/review node re-arms to pending (ids
//         preserved) AND the affected work-item AC verdicts reset to unverified so a
//         pre-reopen command-evidence pass can no longer re-close the AC (false-green).
//   ac-5  refused on a fully-terminal graph and on a non-passed / non-implement target.
//   ac-7  repeated reopens are bounded by a per-node cap (decision-log-derived, NOT a
//         stored counter); a reopen appends a durable `reopen` decision entry.

let repo: string;
let aps: AutopilotStore;
let wis: WorkItemStore;
let WI: string;
const NOW = new Date('2026-06-01T00:00:00.000Z');

function node(
  id: string,
  kind: AutopilotNode['kind'],
  owner: AutopilotNode['owner'],
  status: AutopilotNode['status'],
  depends_on: string[],
  acceptance_refs: string[] = ['ac-1'],
): AutopilotNode {
  return {
    id,
    kind,
    owner,
    purpose: `${kind} step`,
    status,
    depends_on,
    acceptance_refs,
    evidence_refs: [],
    ac_verdicts: [],
    attempts: { fix: 0, switch: 0 },
    file_scope: kind === 'implement' ? ['src/x.ts'] : [],
  };
}

function graph(nodes: AutopilotNode[]): Autopilot {
  return {
    schema_version: '0.1.0',
    autopilot_id: 'orch_reopentest',
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
    nodes,
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
  };
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-reopen-'));
  aps = new AutopilotStore(repo);
  wis = new WorkItemStore(repo);
  const wi = await wis.create(
    {
      title: 'reopen test',
      source_request: 'test reopen',
      goal: 'user reopen of a passed implement node',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'the implement is correct', verdict: 'unverified', evidence: [] },
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

describe('reopenImplementNode — user-action reopen of a passed implement node', () => {
  test('ac-2: a passed implement node reopens to pending and its stale lease is released', async () => {
    // N4 pending keeps the graph non-terminal (ac-5 precondition for a legal reopen).
    await aps.write(
      WI,
      graph([
        node('N1', 'design', 'planner', 'passed', []),
        node('N2', 'implement', 'implementer', 'passed', ['N1']),
        node('N3', 'verify', 'verifier', 'passed', ['N2']),
        node('N4', 'docs', 'implementer', 'pending', []),
      ]),
    );
    const leases = new ActiveNodeLeaseStore(repo);
    // Simulate the orphaned lease that a non-terminal re-arm would otherwise leave.
    await leases.set({
      node_id: 'N2',
      work_item_id: WI,
      file_scope: ['src/x.ts'],
      scope_source: 'declared',
      created_at: NOW.toISOString(),
    });

    const res = await reopenImplementNode(repo, { workItemId: WI, nodeId: 'N2', now: NOW });
    expect(res.status).toBe('reopened');

    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === 'N2')?.status).toBe('pending');
    // Old lease released so a leaked one cannot linger.
    const active = await leases.listActive(WI);
    expect(active.some((l) => l.node_id === 'N2')).toBe(false);
  });

  test('ac-2: after reopen, next-node re-dispatch mints a fresh scoped lease (no BYPASS)', async () => {
    // N4 pending (downstream of N3) keeps the graph non-terminal without becoming ready,
    // so after reopen only N2 (implement) is dispatchable — a clean single-node spawn.
    await aps.write(
      WI,
      graph([
        node('N1', 'design', 'planner', 'passed', []),
        node('N2', 'implement', 'implementer', 'passed', ['N1']),
        node('N3', 'verify', 'verifier', 'passed', ['N2']),
        node('N4', 'docs', 'implementer', 'pending', ['N3']),
      ]),
    );
    await reopenImplementNode(repo, { workItemId: WI, nodeId: 'N2', now: NOW });
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('spawn');
    if (res.action !== 'spawn') throw new Error('expected spawn');
    expect(res.node_id).toBe('N2');
    const active = await new ActiveNodeLeaseStore(repo).listActive(WI);
    const lease = active.find((l) => l.node_id === 'N2');
    expect(lease).toBeDefined();
    expect(lease?.file_scope).toEqual(['src/x.ts']);
  });

  test('ac-3: the re-dispatched delegation packet carries the user feedback', async () => {
    await aps.write(
      WI,
      graph([
        node('N1', 'design', 'planner', 'passed', []),
        node('N2', 'implement', 'implementer', 'passed', ['N1']),
        node('N3', 'verify', 'verifier', 'passed', ['N2']),
        node('N4', 'docs', 'implementer', 'pending', ['N3']),
      ]),
    );
    await reopenImplementNode(repo, {
      workItemId: WI,
      nodeId: 'N2',
      feedback: 'the retry path is still wrong on empty input',
      now: NOW,
    });
    const res = await nextNode(repo, WI);
    if (res.action !== 'spawn') throw new Error('expected spawn');
    const blob = JSON.stringify(res.packet);
    expect(blob).toContain('the retry path is still wrong on empty input');
  });

  test('ac-4: reopen re-arms transitive downstream verify/review to pending (ids preserved) and resets affected work-item ACs', async () => {
    // ac-1 pre-reopen carries a command-evidence PASS — the deepest false-green channel
    // (completion reconciliation would flip a re-armed node back to pass off this).
    await wis.update(WI, (w) => ({
      ...w,
      acceptance_criteria: w.acceptance_criteria.map((c) =>
        c.id === 'ac-1'
          ? { ...c, verdict: 'pass', evidence: [{ kind: 'command', command: 'bun test' }] }
          : c,
      ),
    }));
    await aps.write(
      WI,
      graph([
        node('N1', 'design', 'planner', 'passed', []),
        node('N2', 'implement', 'implementer', 'passed', ['N1']),
        node('N3', 'verify', 'verifier', 'running', ['N2']), // running downstream → rollback
        node('R1', 'review', 'reviewer', 'passed', ['N3']), // transitive downstream → reopen
      ]),
    );
    const res = await reopenImplementNode(repo, { workItemId: WI, nodeId: 'N2', now: NOW });
    expect(res.status).toBe('reopened');

    const after = await aps.get(WI);
    // ids preserved (no destructive regeneration), all re-armed to pending.
    expect(after.nodes.find((n) => n.id === 'N2')?.status).toBe('pending');
    expect(after.nodes.find((n) => n.id === 'N3')?.status).toBe('pending');
    expect(after.nodes.find((n) => n.id === 'R1')?.status).toBe('pending');

    // work-item AC reset so the stale command-evidence pass can no longer re-close it.
    const wi = await wis.get(WI);
    const ac1 = wi.acceptance_criteria.find((c) => c.id === 'ac-1');
    expect(ac1?.verdict).toBe('unverified');
    expect(ac1?.evidence).toEqual([]);
  });

  test('ac-5: refused on a non-passed target', async () => {
    await aps.write(
      WI,
      graph([
        node('N1', 'design', 'planner', 'passed', []),
        node('N2', 'implement', 'implementer', 'running', ['N1']),
      ]),
    );
    const res = await reopenImplementNode(repo, { workItemId: WI, nodeId: 'N2', now: NOW });
    expect(res.status).toBe('refused');
  });

  test('ac-5: refused on a non-implement target', async () => {
    await aps.write(
      WI,
      graph([
        node('N1', 'design', 'planner', 'passed', []),
        node('N2', 'implement', 'implementer', 'passed', ['N1']),
        node('N3', 'verify', 'verifier', 'passed', ['N2']),
        node('N4', 'docs', 'implementer', 'pending', []),
      ]),
    );
    const res = await reopenImplementNode(repo, { workItemId: WI, nodeId: 'N3', now: NOW });
    expect(res.status).toBe('refused');
  });

  test('ac-5: refused on a fully-terminal graph', async () => {
    await aps.write(
      WI,
      graph([
        node('N1', 'design', 'planner', 'passed', []),
        node('N2', 'implement', 'implementer', 'passed', ['N1']),
        node('N3', 'verify', 'verifier', 'passed', ['N2']),
      ]),
    );
    const res = await reopenImplementNode(repo, { workItemId: WI, nodeId: 'N2', now: NOW });
    expect(res.status).toBe('refused');
  });

  test('ac-7: a reopen appends a durable reopen decision carrying the feedback', async () => {
    await aps.write(
      WI,
      graph([
        node('N1', 'design', 'planner', 'passed', []),
        node('N2', 'implement', 'implementer', 'passed', ['N1']),
        node('N3', 'verify', 'verifier', 'passed', ['N2']),
        node('N4', 'docs', 'implementer', 'pending', []),
      ]),
    );
    await reopenImplementNode(repo, {
      workItemId: WI,
      nodeId: 'N2',
      feedback: 'off-by-one on the boundary',
      actor: 'user',
      now: NOW,
    });
    const decisions = await aps.readDecisions(WI);
    const reopen = decisions.filter((d) => d.node_id === 'N2' && d.decision === 'reopen');
    expect(reopen).toHaveLength(1);
    expect(reopen[0]?.feedback).toBe('off-by-one on the boundary');
  });

  test('ac-7: at the per-node reopen cap the node stops and reports instead of reopening', async () => {
    await aps.write(
      WI,
      graph([
        node('N1', 'design', 'planner', 'passed', []),
        node('N2', 'implement', 'implementer', 'passed', ['N1']),
        node('N3', 'verify', 'verifier', 'passed', ['N2']),
        node('N4', 'docs', 'implementer', 'pending', []),
      ]),
    );
    // Seed the decision log with `oracle_failures_to_block` (3) prior user reopens of N2
    // — the cap is derived from the append-only log, NOT a stored counter (ac-8 invariant).
    for (let i = 0; i < 3; i++) {
      await aps.appendDecision(WI, {
        ts: NOW.toISOString(),
        node_id: 'N2',
        decision: 'reopen',
        reason: 'user reopen',
      });
    }
    const res = await reopenImplementNode(repo, { workItemId: WI, nodeId: 'N2', now: NOW });
    expect(res.status).toBe('capped');
    // No further reopen decision was appended at the cap.
    const decisions = await aps.readDecisions(WI);
    expect(decisions.filter((d) => d.node_id === 'N2' && d.decision === 'reopen')).toHaveLength(3);
    // The target stays passed (not re-armed) — stop-and-report, not reopen.
    const after = await aps.get(WI);
    expect(after.nodes.find((n) => n.id === 'N2')?.status).toBe('passed');
  });
});
