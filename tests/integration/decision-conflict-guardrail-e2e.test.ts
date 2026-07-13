import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordResult } from '~/core/autopilot-loop';
import { AutopilotStore } from '~/core/autopilot-store';
import { nextCoverageNode } from '~/core/coverage-loop';
import { localDir } from '~/core/ditto-paths';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import { stopHandler } from '~/hooks/stop';
import type { Autopilot } from '~/schemas/autopilot';

/**
 * Decision-conflict guardrail (ADR-0020) live end-to-end. Drives the REAL chain
 * through real stores, the autopilot loop, and the Stop hook — not mocks. The only
 * part not exercised is the LLM judgement that DETECTS a conflict and writes the
 * carrier (ADR-0020 D4: that is host-delegated, not deterministic). We start from
 * the carrier a planner would write and prove both enforcement layers fire:
 *  - prevention: an intent conflict front-loads approval_gate → 'pending' even for
 *    a light/auto-waivable tier, so mutating nodes do not run (autopilot-loop);
 *  - catch + transparency: the Stop hook blocks an intent conflict and discloses
 *    every conflict (even an auto-aligned method one) with its basis.
 */

let repo: string;
let WI: string;
const SESSION = 'sess-dc';
const NOW = new Date('2026-06-16T00:00:00.000Z');

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-dc-e2e-'));
  const wis = new WorkItemStore(repo);
  const wi = await wis.create(
    {
      title: 'decision-conflict e2e',
      source_request: 'add a feature',
      goal: 'the guardrail fires end to end',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'guardrail works', verdict: 'unverified', evidence: [] },
      ],
    },
    NOW,
  );
  WI = wi.id;
  await new SessionPointerStore(repo).set(SESSION, WI);
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const writeCarrier = (conflicts: Array<Record<string, unknown>>) =>
  writeFile(
    localDir(repo, 'work-items', WI, 'decision-conflict.json'),
    JSON.stringify({ schema_version: '0.1.0', mode: 'autopilot', conflicts }),
  );

const conflict = (over: Record<string, unknown> = {}) => ({
  adr_id: 'ADR-0006',
  kind: 'forbid',
  level: 'method',
  basis: 'work adds a TS-AST analyzer; ADR-0006 mandates CodeQL only',
  ...over,
});

const designGraph = (): Autopilot => ({
  schema_version: '0.1.0',
  autopilot_id: 'orch_dce2e001',
  work_item_id: WI,
  mode: 'autopilot',
  root_goal: 'the guardrail fires end to end',
  completion_boundary: 'entire_work_item',
  approval_gate: {
    status: 'not_required',
    source: 'small_reversible_policy',
    approved_at: null,
    approved_by: null,
    evidence_refs: [],
  },
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
});

// A small-reversible (light tier) design pass that, ON ITS OWN, auto-waives
// approval. Any approval=pending therefore comes from the decision-conflict carrier.
const lightDesignPass = {
  node_id: 'D1',
  result_text: 'Designed the plan after the coverage sweep: interfaces, DoD, scenarios enumerated.',
  outcome: 'pass' as const,
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
};

/** Run the real design-node record-result and return the resulting approval_gate status. */
async function drivePlanGate(): Promise<string> {
  const aps = new AutopilotStore(repo);
  await aps.write(WI, designGraph());
  // A real plan-stage sweep writes coverage.json; the design pass needs it to count.
  await nextCoverageNode({ repoRoot: repo, workItemId: WI });
  await recordResult(repo, { workItemId: WI, now: NOW, payload: lightDesignPass });
  return (await aps.get(WI)).approval_gate.status;
}

const runStop = () => stopHandler({ raw: { session_id: SESSION }, repoRoot: repo, env: {} });

describe('decision-conflict guardrail — live e2e (ADR-0020)', () => {
  test('control: light design pass with NO conflict auto-waives approval', async () => {
    expect(await drivePlanGate()).toBe('not_required');
  });

  test('intent conflict: prevention (approval=pending) + catch+disclose at Stop', async () => {
    await writeCarrier([
      conflict({
        adr_id: 'ADR-0005',
        level: 'intent',
        basis: 'work item wants a standalone server; ADR-0005 forbids a server',
      }),
    ]);

    // Prevention layer: the same light tier that auto-waived in the control is now
    // forced to 'pending' by the intent conflict → mutating nodes will not run.
    expect(await drivePlanGate()).toBe('pending');

    // Catch + transparency: the Stop hook blocks and discloses with the basis.
    const out = await runStop();
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('decision conflict');
    expect(out.stderr).toContain('ADR-0005');
    expect(out.stderr).toContain('block');
    expect(out.stderr).toContain('forbids a server'); // basis reached the OUTPUT
  });

  test('method conflict: auto-aligns (approval NOT gated) but is STILL disclosed', async () => {
    await writeCarrier([conflict({ adr_id: 'ADR-0006', level: 'method' })]);

    // A method conflict does NOT gate approval — the agent re-routes by following
    // the ADR, so the light tier still auto-waives.
    expect(await drivePlanGate()).toBe('not_required');

    // Transparency invariant: even an auto-aligned method conflict is disclosed at
    // the boundary with its basis — autonomous compliance is never silent.
    const out = await runStop();
    expect(out.stderr).toContain('decision conflict (disclosed, agent followed ADR)');
    expect(out.stderr).toContain('ADR-0006');
    expect(out.stderr).toContain('CodeQL only'); // basis surfaced even without a block
  });
});
