import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderApprovalArtifact } from '~/core/autopilot-approval';
import { buildInitialNodes } from '~/core/autopilot-graph';
import { nextNode, recordResult } from '~/core/autopilot-loop';
import { AutopilotStore } from '~/core/autopilot-store';
import { CoverageStore } from '~/core/coverage-store';
import { WorkItemStore } from '~/core/work-item-store';
import type { Autopilot } from '~/schemas/autopilot';

/**
 * WHY THIS FILE EXISTS (wi_2607105qy N2 — FINAL increment: ac-4 + ac-6 + ac-5 + re-seed):
 *
 *  - ac-4/ac-6: the approval-artifact RENDERER (test-backed vs oracle-only split, AC text
 *    alongside the authored test, per-AC-clause attestation) written to a PREDICTABLE
 *    `.ditto/local/work-items/<wi>/approval/` path, surfaced in the present_plan action.
 *  - ac-5: graceful degrade with a logging marker when zero dynamic_test-oracle ACs, and
 *    the light-tier auto-waive not bypassing a frozen approval when a test_spec is present.
 *  - seed-timing: a POST-DESIGN re-seed of the test-author node once the design node
 *    assigns a dynamic_test oracle (the live deep-interview→design flow).
 */

// ── ac-4: the pure renderer ─────────────────────────────────────────────────
describe('renderApprovalArtifact (ac-4): distinguishes test-backed from oracle-only', () => {
  const gate = {
    status: 'pending' as const,
    source: null,
    approved_at: null,
    approved_by: null,
    evidence_refs: [] as never[],
    plan_brief: {
      interface_changes: [],
      dod: [],
      test_scenarios: [],
      test_spec: {
        test_backed: [
          { criterion_id: 'ac-1', test_path: 'tests/authored-ac1.test.ts', frozen_hash: 'abc123' },
        ],
        oracle_only: ['ac-2'],
      },
    },
  };
  const acById = new Map<string, string>([
    ['ac-1', 'POST /pw returns 200'],
    ['ac-2', 'the code follows the repo style'],
  ]);

  test('renders a test-backed section with the AC text, authored test, and attestation', () => {
    const md = renderApprovalArtifact(gate, acById);
    // test-backed section names the AC, its declared text, and the authored test path.
    expect(md).toContain('Test-backed ACs');
    expect(md).toContain('ac-1');
    expect(md).toContain('POST /pw returns 200');
    expect(md).toContain('tests/authored-ac1.test.ts');
    // per-AC-clause coverage attestation, scoped to the declared contract only.
    expect(md.toLowerCase()).toContain('attestation');
    expect(md.toLowerCase()).toContain('declared contract');
    // over-assert mitigation: no internal-call / signature assertions.
    expect(md.toLowerCase()).toContain('no internal-call');
  });

  test('renders an oracle-only section distinct from the test-backed one', () => {
    const md = renderApprovalArtifact(gate, acById);
    expect(md).toContain('Oracle-only ACs');
    expect(md).toContain('ac-2');
    expect(md).toContain('the code follows the repo style');
    // ac-2 (oracle-only) is NOT presented as guaranteed by an executable test.
    const oracleSection = md.slice(md.indexOf('## Oracle-only'));
    expect(oracleSection).not.toContain('authored test:');
  });
});

// ── ac-6: the loop writes the artifact to a predictable path + surfaces it ────
let repo: string;
let aps: AutopilotStore;
let wis: WorkItemStore;
let WI: string;
const NOW = new Date('2026-07-11T00:00:00.000Z');

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-approval-artifact-'));
  aps = new AutopilotStore(repo);
  wis = new WorkItemStore(repo);
  const wi = await wis.create(
    {
      title: 'approval artifact',
      source_request: 'author + approve red tests',
      goal: 'the approval artifact renders',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'POST /pw returns 200', verdict: 'unverified', evidence: [] },
        {
          id: 'ac-2',
          statement: 'the code follows the repo style',
          verdict: 'unverified',
          evidence: [],
        },
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

/** A graph at the approval gate (pending) carrying an authored test_spec, implement pending. */
function gatedGraphWithTestSpec(): Autopilot {
  return {
    schema_version: '0.1.0',
    autopilot_id: 'orch_approvalart',
    work_item_id: WI,
    mode: 'autopilot',
    root_goal: 'goal',
    completion_boundary: 'entire_work_item',
    approval_gate: {
      status: 'pending',
      source: null,
      approved_at: null,
      approved_by: null,
      evidence_refs: [],
      change_surface: ['src/x.ts'],
      plan_brief: {
        interface_changes: ['x'],
        dod: ['y'],
        test_scenarios: ['z'],
        test_spec: {
          test_backed: [{ criterion_id: 'ac-1', test_path: 'tests/authored-ac1.test.ts' }],
          oracle_only: ['ac-2'],
        },
      },
    },
    nodes: [
      {
        id: 'N1',
        kind: 'design',
        owner: 'planner',
        purpose: 'plan',
        status: 'passed',
        depends_on: [],
        acceptance_refs: ['ac-1', 'ac-2'],
        evidence_refs: [],
        attempts: { fix: 0, switch: 0 },
      },
      {
        id: 'N1-test-author',
        kind: 'test-author',
        owner: 'implementer',
        purpose: 'author red tests',
        status: 'passed',
        depends_on: ['N1'],
        acceptance_refs: [],
        evidence_refs: [],
        attempts: { fix: 0, switch: 0 },
      },
      {
        id: 'N2',
        kind: 'implement',
        owner: 'implementer',
        purpose: 'implement',
        status: 'pending',
        depends_on: ['N1-test-author'],
        acceptance_refs: ['ac-1', 'ac-2'],
        evidence_refs: [],
        attempts: { fix: 0, switch: 0 },
      },
    ],
    caps: { fix_per_node: 2, switch_per_node: 1, converge_rounds: 3 },
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

describe('present_plan artifact (ac-6): a pending gate with an authored test_spec writes + surfaces the artifact', () => {
  test('nextNode returns present_plan with an artifact_path under .ditto/local/work-items/<wi>/approval/', async () => {
    await aps.write(WI, gatedGraphWithTestSpec());
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('present_plan');
    if (res.action !== 'present_plan') throw new Error('expected present_plan');
    expect(res.artifact_path).toBeDefined();
    expect(res.artifact_path).toContain(`.ditto/local/work-items/${WI}/approval/`);
    // The artifact was actually WRITTEN to that predictable path (not a temp folder).
    const written = await Bun.file(join(repo, res.artifact_path as string)).text();
    expect(written).toContain('Test-backed ACs');
    expect(written).toContain('POST /pw returns 200');
    expect(written).toContain('tests/authored-ac1.test.ts');
  });
});

// ── seed-timing re-seed + ac-5 degrade (design pass drives both) ─────────────
function designGraph(): Autopilot {
  return {
    schema_version: '0.1.0',
    autopilot_id: 'orch_reseednodes',
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
    nodes: buildInitialNodes(['ac-1', 'ac-2']),
    caps: { fix_per_node: 2, switch_per_node: 1, converge_rounds: 3 },
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

describe('seed-timing re-seed: a design pass assigning a dynamic_test oracle seeds the test-author node', () => {
  test('design assigns dynamic_test to ac-1 ⇒ a test-author node is seeded gating implement', async () => {
    await aps.write(WI, designGraph());
    await seedCoverage();
    await nextNode(repo, WI); // dispatch N1 (design)
    await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N1',
        result_text: 'plan: ac-1 is dynamic_test-backed, ac-2 is soft_judgment',
        outcome: 'pass',
        plan_brief: planBrief,
        ac_oracles: [
          {
            criterion_id: 'ac-1',
            oracle: { verification_method: 'dynamic_test', maps_to: 'ac-1', direction: 'forward' },
          },
          {
            criterion_id: 'ac-2',
            oracle: { verification_method: 'soft_judgment', maps_to: 'ac-2', direction: 'forward' },
          },
        ],
      },
    });
    const g = await aps.get(WI);
    const author = g.nodes.find((n) => n.kind === 'test-author');
    expect(author).toBeDefined();
    // it gates the implement node (N2 now depends on the author, not directly on design).
    const implement = g.nodes.find((n) => n.kind === 'implement');
    expect(implement?.depends_on).toContain(author?.id);
    // the approval gate did NOT auto-waive to not_required (a frozen approval is owed).
    expect(g.approval_gate.status).toBe('pending');
  });

  test('a design pass with ZERO dynamic_test ACs degrades gracefully — NO authoring node + a logging marker', async () => {
    await aps.write(WI, designGraph());
    await seedCoverage();
    await nextNode(repo, WI);
    await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N1',
        result_text: 'plan: both ACs are soft_judgment (no red test to author)',
        outcome: 'pass',
        plan_brief: planBrief,
        ac_oracles: [
          {
            criterion_id: 'ac-1',
            oracle: { verification_method: 'soft_judgment', maps_to: 'ac-1', direction: 'forward' },
          },
          {
            criterion_id: 'ac-2',
            oracle: { verification_method: 'soft_judgment', maps_to: 'ac-2', direction: 'forward' },
          },
        ],
      },
    });
    const g = await aps.get(WI);
    // no authoring node fires (nothing to author).
    expect(g.nodes.some((n) => n.kind === 'test-author')).toBe(false);
    // a degrade LOGGING marker is recorded (graceful degrade, not a vacuous firing).
    const decisions = await aps.readDecisions(WI);
    expect(decisions.some((d) => d.reason.includes('authoring-stage-degraded'))).toBe(true);
  });
});
