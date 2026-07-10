import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInitialNodes } from '~/core/autopilot-graph';
import { recordResult } from '~/core/autopilot-loop';
import { AutopilotStore } from '~/core/autopilot-store';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import { stopHandler } from '~/hooks/stop';
import { type Autopilot, autopilot } from '~/schemas/autopilot';

// wi_260710qpr / #20 item 1 — the direction-fork STOP path END-TO-END through the
// PRODUCTION producer. Prior coverage tested the two halves SEPARATELY: the loop
// persist half (autopilot-loop.test.ts writes a carrier via recordResult, asserts
// directionForkGate would pass — a gate PROXY, not the hook) and the Stop half
// (stop.test.ts hand-writes direction-fork.json, asserts stopHandler exit 0). Neither
// chained the REAL producer to the REAL consumer through the on-disk carrier — so a
// genuine 3-condition fork firing a P1 yield in a real run stayed unproven. This does:
// recordResult(direction_fork_stop) → direction-fork.json → stopHandler → exit 0.
describe('direction-fork STOP end-to-end: recordResult producer → stopHandler P1 yield', () => {
  let repo: string;
  let wiId: string;
  const SESSION = 'sess-fork-e2e';
  const NOW = new Date('2026-07-10T00:00:00.000Z');

  // N1 (design) passed, N2 (implement) running — a mid-implementation node that hits a
  // fork it cannot resolve, exactly where a genuine direction-fork STOP is declared.
  const runningImplement = (): Autopilot =>
    autopilot.parse({
      schema_version: '0.1.0',
      autopilot_id: 'orch_forke2e01',
      work_item_id: wiId,
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
      nodes: buildInitialNodes(['ac-1']).map((n) =>
        n.id === 'N1'
          ? { ...n, status: 'passed' }
          : n.id === 'N2'
            ? { ...n, status: 'running' }
            : n,
      ),
      caps: { fix_per_node: 2, switch_per_node: 1 },
      continue_policy: {},
      stop_conditions: [],
      user_interrupt_policy: 'ask_only_for_user_owned_decisions',
    });

  const genuineForkPayload = {
    node_id: 'N2',
    result_text:
      'hit a genuine direction fork mid-implementation: the only viable path redefines the frozen purpose, no option has a clear advantage, and the original intent cannot break the tie',
    outcome: 'fail' as const,
    failure_class: 'user_decision_needed' as const,
    direction_fork_stop: {
      purpose_change: { present: true, basis: 'the chosen path grows the frozen AC id-set' },
      no_clear_advantage: { present: true, basis: 'both options trade off equally on intent' },
      intent_cannot_break_tie: {
        present: true,
        basis: 'the frozen intent is silent on this axis',
      },
    },
  };

  const run = () =>
    stopHandler({ raw: { session_id: SESSION, stop_hook_active: false }, repoRoot: repo, env: {} });

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-fork-e2e-'));
    const store = new WorkItemStore(repo);
    const created = await store.create({
      title: 'fork e2e',
      source_request: 'implement a thing',
      goal: 'the thing works',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'works', verdict: 'unverified', evidence: [] },
      ],
    });
    wiId = created.id;
    await new SessionPointerStore(repo).set(SESSION, wiId);
    await new AutopilotStore(repo).write(wiId, runningImplement());
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test('a genuine 3-condition direction_fork_stop makes the next Stop yield (exit 0)', async () => {
    // The production producer: the loop persists the direction-fork.json carrier the
    // Stop hook reads (no hand-written carrier, no gate proxy).
    await recordResult(repo, { workItemId: wiId, payload: genuineForkPayload, now: NOW });

    // The REAL Stop hook, reading the REAL on-disk carrier, yields P1.
    expect((await run()).exitCode).toBe(0);
  });

  test('contrast: with NO fork declared, the running node instead force-continues (exit 2)', async () => {
    // Same graph, but no direction_fork_stop emitted → no carrier → the running node
    // is a runnable-work strong-block, proving the yield above is caused by the carrier,
    // not by the graph state.
    const out = await run();
    expect(out.exitCode).toBe(2);
  });
});
