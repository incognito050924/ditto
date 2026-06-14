import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInitialNodes } from '~/core/autopilot-graph';
import { recordResult } from '~/core/autopilot-loop';
import { AutopilotStore } from '~/core/autopilot-store';
import { nextCoverageNode, recordCoverageRound } from '~/core/coverage-loop';
import { CoverageStore } from '~/core/coverage-store';
import { localDir } from '~/core/ditto-paths';
import { WorkItemStore } from '~/core/work-item-store';
import type { Autopilot } from '~/schemas/autopilot';
import { coverageMap } from '~/schemas/coverage';

/**
 * ac-3 runtime evidence (premortem-coverage §9). The plan-stage coverage loop,
 * driven only through its core step functions (`nextCoverageNode` →
 * `recordCoverageRound`), runs the real fan-out + 6-axis enforcement +
 * loop-until-dry and produces the two §9 runtime artifacts ON DISK:
 * `.ditto/local/runs/<wi>/coverage.json` and `plan-dialog.md`. This is kind:file
 * runtime evidence, not a unit-only command summary.
 */

let repo: string;
let WI: string;
const NOW = new Date('2026-06-01T00:00:00.000Z');

function graph(overrides: Partial<Autopilot> = {}): Autopilot {
  return {
    schema_version: '0.1.0',
    autopilot_id: 'orch_covtest1',
    work_item_id: WI,
    mode: 'autopilot',
    root_goal: 'plan-stage coverage',
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
  repo = await mkdtemp(join(tmpdir(), 'ditto-cov-'));
  const wis = new WorkItemStore(repo);
  const wi = await wis.create(
    {
      title: 'coverage drive test',
      source_request: 'drive the plan-stage coverage loop',
      goal: 'the plan-stage pre-mortem coverage sweep terminates',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'sweep terminates', verdict: 'unverified', evidence: [] },
      ],
    },
    NOW,
  );
  WI = wi.id;
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

/** Pass `verdict:'accept', opponent_ran:true` so the neutrality axis admits a close. */
const passingSignals = {
  neutrality: { opponent_ran: true, verdict: 'accept' as const },
};

describe('coverage loop drives a plan-stage sweep to disk (ac-3 runtime)', () => {
  test('happy: next→round loop terminates and writes coverage.json + plan-dialog.md ON DISK', async () => {
    // First call seeds the root from the work item goal and persists coverage.json.
    const first = await nextCoverageNode({ repoRoot: repo, workItemId: WI });
    expect(first.action).toBe('interrogate');
    if (first.action !== 'interrogate') return;
    expect(first.node.id).toBe('cov-root');

    // coverage.json exists right after seeding (the §9 runtime artifact).
    const store = new CoverageStore(repo);
    expect(await store.exists(WI)).toBe(true);

    // Round 1: interrogate the root, derive a child, close the root's... no — the
    // root has an open child now so it cannot close (false-green gate). Close the
    // CHILD first, then the root. Drive until {action:'dry'}.
    // Add one derived child off the root (admissible novelty → resets dry counter).
    let r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: 'cov-root',
        derived_nodes: [
          {
            id: 'cov-child',
            parent_id: 'cov-root',
            label: 'data boundary scope',
            origin: 'derived',
            depth_weight: 0,
          },
        ],
        admissibleBranchesAdded: 1,
      },
    });
    expect(r.terminated).toBe(false);

    // Now schedule: the child is the leaf frontier (root has an open child).
    const second = await nextCoverageNode({ repoRoot: repo, workItemId: WI });
    expect(second.action).toBe('interrogate');
    if (second.action !== 'interrogate') return;
    expect(second.node.id).toBe('cov-child');

    // Close the child (no new branches → dry counter starts incrementing).
    r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: 'cov-child',
        admissibleBranchesAdded: 0,
        close_as: 'resolved',
        axis_signals: passingSignals,
      },
    });
    expect(r.terminated).toBe(false);
    if (r.terminated) return;
    expect(r.closed).toBe(true);

    // Close the root (subtree now dry → false-green gate passes).
    r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: 'cov-root',
        admissibleBranchesAdded: 0,
        close_as: 'resolved',
        axis_signals: passingSignals,
      },
      brief: {
        interface_changes: ['add CoverageStore'],
        dod: ['coverage.json on disk'],
        test_scenarios: ['integration drive'],
      },
      tierInputs: {
        changedFileCount: 2,
        interfaceChanged: false,
        risk: { non_local: false, irreversible: false, unaudited: false },
        large: false,
      },
    });

    // After all nodes closed we still need K=2 dry rounds. One more dry round.
    if (!r.terminated) {
      r = await recordCoverageRound({
        repoRoot: repo,
        workItemId: WI,
        payload: { node_id: 'cov-root', admissibleBranchesAdded: 0 },
        brief: {
          interface_changes: ['add CoverageStore'],
          dod: ['coverage.json on disk'],
          test_scenarios: ['integration drive'],
        },
      });
    }

    // Loop reports dry/terminated.
    const dry = await nextCoverageNode({ repoRoot: repo, workItemId: WI });
    expect(dry.action).toBe('dry');
    expect(r.terminated).toBe(true);

    // ── kind:file runtime evidence: BOTH §9 artifacts exist ON DISK ──
    const runDir = localDir(repo, 'runs', WI);
    const covRaw = await readFile(join(runDir, 'coverage.json'), 'utf8');
    const parsed = coverageMap.safeParse(JSON.parse(covRaw));
    expect(parsed.success).toBe(true); // valid schema
    if (parsed.success) {
      expect(parsed.data.root_id).toBe('cov-root');
      expect(parsed.data.nodes.every((n) => n.state !== 'open')).toBe(true);
    }

    const dialog = await readFile(join(runDir, 'plan-dialog.md'), 'utf8');
    expect(dialog).toContain('kind: plan-dialog');
    expect(dialog).toContain('## 사용자 Q&A');
    expect(dialog).toContain('## assumptions');
    expect(dialog).toContain('## 닫힌 항목');
    expect(dialog).toContain('cov-root');
  });

  test('S2: close_as with FAILING neutrality keeps the node open + returns reasons', async () => {
    await nextCoverageNode({ repoRoot: repo, workItemId: WI }); // seed
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: 'cov-root',
        admissibleBranchesAdded: 0,
        close_as: 'resolved',
        // Opponent did not run → neutrality axis rejects the close.
        axis_signals: { neutrality: { opponent_ran: false, verdict: 'accept' } },
      },
    });
    expect(r.terminated).toBe(false);
    if (r.terminated) return;
    expect(r.closed).toBe(false);
    expect(r.reasons.some((x) => x.includes('neutrality'))).toBe(true);

    // The node really stayed open on disk.
    const map = await new CoverageStore(repo).getMap(WI);
    expect(map.nodes.find((n) => n.id === 'cov-root')?.state).toBe('open');
  });

  // LOW1 (wi_2606144ta): a 'resolved' close that OMITS axis_signals.neutrality must
  // be rejected (fail-closed), not silently skipped. Before the fix the non-structural
  // axes were only enforced when present, so a close with no signals slipped through
  // the subtree-dry gate alone, never having been adversarially checked.
  test('LOW1: resolved close with NO neutrality signal is rejected (fail-closed)', async () => {
    await nextCoverageNode({ repoRoot: repo, workItemId: WI }); // seed root
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: 'cov-root',
        admissibleBranchesAdded: 0,
        close_as: 'resolved',
        // axis_signals omitted entirely → neutrality is absent.
      },
    });
    expect(r.terminated).toBe(false);
    if (r.terminated) return;
    expect(r.closed).toBe(false);
    expect(r.reasons.some((x) => x.includes('neutrality'))).toBe(true);
    const map = await new CoverageStore(repo).getMap(WI);
    expect(map.nodes.find((n) => n.id === 'cov-root')?.state).toBe('open');
  });

  test('LOW1: resolved close WITH neutrality signal still closes (positive control)', async () => {
    await nextCoverageNode({ repoRoot: repo, workItemId: WI }); // seed root
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: 'cov-root',
        admissibleBranchesAdded: 0,
        close_as: 'resolved',
        axis_signals: passingSignals,
      },
    });
    expect(r.terminated).toBe(false);
    if (r.terminated) return;
    expect(r.closed).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  test('S4: two consecutive dry rounds → plan-dialog.md + brief returned', async () => {
    await nextCoverageNode({ repoRoot: repo, workItemId: WI }); // seed root
    // Round A: close the lone root (dry counter 0→1).
    let r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: 'cov-root',
        admissibleBranchesAdded: 0,
        close_as: 'resolved',
        axis_signals: passingSignals,
      },
      brief: { interface_changes: ['x'], dod: ['y'], test_scenarios: ['z'] },
    });
    // Round B: no new branches (dry counter 1→2 = K) → termination.
    if (!r.terminated) {
      r = await recordCoverageRound({
        repoRoot: repo,
        workItemId: WI,
        payload: { node_id: 'cov-root', admissibleBranchesAdded: 0 },
        brief: { interface_changes: ['x'], dod: ['y'], test_scenarios: ['z'] },
      });
    }
    expect(r.terminated).toBe(true);
    if (!r.terminated) return;
    expect(r.brief.interface_changes).toEqual(['x']);
    const dialog = await readFile(join(localDir(repo, 'runs', WI), 'plan-dialog.md'), 'utf8');
    expect(dialog).toContain('# plan-dialog');
  });
});

describe('design plan_brief precondition (ac-3 hard gate)', () => {
  test('S3: design pass with plan_brief but NO coverage.json → forced fixable failure', async () => {
    const aps = new AutopilotStore(repo);
    // Build a graph whose first node is a design node, mark it running.
    await aps.write(
      WI,
      graph({
        nodes: [
          {
            id: 'D1',
            kind: 'design',
            owner: 'planner',
            purpose: 'plan stage',
            status: 'running',
            depends_on: [],
            acceptance_refs: ['ac-1'],
            evidence_refs: [],
            ac_verdicts: [],
            attempts: { fix: 0, switch: 0 },
          },
        ],
      }),
    );

    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'D1',
        result_text:
          'Designed the plan: interface changes, DoD, and test scenarios are all enumerated below in detail.',
        outcome: 'pass',
        plan_brief: {
          change_surface: ['src/x.ts'],
          interface_changes: ['add X'],
          dod: ['X works'],
          test_scenarios: ['test X'],
          tier_inputs: {
            changedFileCount: 1,
            interfaceChanged: false,
            risk: { non_local: false, irreversible: false, unaudited: false },
            large: false,
          },
        },
      },
    });

    // No coverage.json exists → the claimed design pass is overridden to fixable.
    expect(res.outcome).toBe('fail');
    expect(res.failure_class).toBe('fixable');
    expect(res.guard_contentful).toBe(false);
    expect(res.reason).toContain('coverage.json');
  });

  test('S3-pass: same design pass SUCCEEDS once coverage.json exists', async () => {
    const aps = new AutopilotStore(repo);
    await aps.write(
      WI,
      graph({
        nodes: [
          {
            id: 'D1',
            kind: 'design',
            owner: 'planner',
            purpose: 'plan stage',
            status: 'running',
            depends_on: [],
            acceptance_refs: ['ac-1'],
            evidence_refs: [],
            ac_verdicts: [],
            attempts: { fix: 0, switch: 0 },
          },
        ],
      }),
    );
    // A real sweep already wrote coverage.json.
    await nextCoverageNode({ repoRoot: repo, workItemId: WI });

    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'D1',
        result_text:
          'Designed the plan after the coverage sweep: interface changes, DoD, and test scenarios enumerated.',
        outcome: 'pass',
        plan_brief: {
          change_surface: ['src/x.ts'],
          interface_changes: ['add X'],
          dod: ['X works'],
          test_scenarios: ['test X'],
          tier_inputs: {
            changedFileCount: 1,
            interfaceChanged: false,
            risk: { non_local: false, irreversible: false, unaudited: false },
            large: false,
          },
        },
      },
    });

    expect(res.outcome).toBe('pass');
    expect(res.status).toBe('passed');
    // producePlanGate populated the approval gate (light tier auto-waives).
    const g = await aps.get(WI);
    expect(g.approval_gate.change_surface).toEqual(['src/x.ts']);
    expect(g.approval_gate.plan_brief?.interface_changes).toEqual(['add X']);
  });
});
