import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleProgressReport, nextNode, recordResult } from '~/core/autopilot-loop';
import { AutopilotStore } from '~/core/autopilot-store';
import { localDir } from '~/core/ditto-paths';
import { WorkItemStore } from '~/core/work-item-store';
import type { Autopilot, AutopilotNode } from '~/schemas/autopilot';

// WS3 (wi_2607068bo) — disk-derived context-pressure accounting + edge-triggered
// report directive. The proxy is `COUNT_WEIGHT * (decisionCount + nodeCount) +
// postCost`; with COUNT_WEIGHT=2 and THRESHOLD=60, a run with no churn crosses at
// `decisionCount + nodeCount >= 30`.

let repo: string;
let aps: AutopilotStore;
let wis: WorkItemStore;
let WI: string;
const NOW = new Date('2026-07-06T00:00:00.000Z');

function node(id: string, over: Partial<AutopilotNode> = {}): AutopilotNode {
  return {
    id,
    kind: 'research',
    owner: 'researcher',
    purpose: `work ${id}`,
    status: 'pending',
    depends_on: [],
    acceptance_refs: [],
    evidence_refs: [],
    attempts: { fix: 0, switch: 0 },
    ...over,
  } as AutopilotNode;
}

function graph(nodes: AutopilotNode[]): Autopilot {
  return {
    schema_version: '0.1.0',
    autopilot_id: 'orch_pressure',
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

/** Append `n` neutral escalate decisions (no retry/switch ⇒ no post_cost churn). */
async function appendEscalations(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await aps.appendDecision(WI, {
      ts: NOW.toISOString(),
      node_id: 'N1',
      failure_class: 'user_decision_needed',
      decision: 'escalate',
      reason: `escalation ${i}`,
      attempts: { fix: 0, switch: 0 },
    });
  }
}

/** Three nodes in a linear chain ⇒ exactly one ready node (single spawn). */
function chained3(): Autopilot {
  return graph([
    node('N1'),
    node('N2', { depends_on: ['N1'] }),
    node('N3', { depends_on: ['N2'] }),
  ]);
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-pressure-'));
  aps = new AutopilotStore(repo);
  wis = new WorkItemStore(repo);
  const wi = await wis.create(
    {
      title: 'pressure test',
      source_request: 'test context pressure',
      goal: 'pressure accounting works',
      acceptance_criteria: [{ id: 'ac-1', statement: 'runs', verdict: 'unverified', evidence: [] }],
    },
    NOW,
  );
  WI = wi.id;
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('WS3-T1 context-pressure signal (ac-1/ac-2/ac-5)', () => {
  test('below threshold ⇒ no pressure fields on the loop output (byte-identical)', async () => {
    // 1 node, 0 decisions ⇒ proxy = 2*(0+1) = 2 < 60.
    await aps.write(WI, graph([node('N1')]));
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('spawn');
    expect('context_pressure' in res).toBe(false);
    expect('report_directive' in res).toBe(false);
  });

  test('above threshold ⇒ signal + directive fire on nextNode; action still advances (ac-1/ac-3/ac-5)', async () => {
    // 3 nodes + 30 escalate decisions ⇒ proxy = 2*(30+3) = 66 >= 60, band 1.
    await aps.write(
      WI,
      graph([node('N1'), node('N2', { depends_on: ['N1'] }), node('N3', { depends_on: ['N2'] })]),
    );
    await appendEscalations(30);
    const res = await nextNode(repo, WI);
    // ac-5: still a normal advancing action, never halt/blocked.
    expect(res.action).toBe('spawn');
    if (res.action !== 'spawn') throw new Error('expected spawn');
    // ac-1: signal fires and is disk-derived.
    expect(res.context_pressure).toBeDefined();
    expect(res.context_pressure?.over_threshold).toBe(true);
    expect(res.context_pressure?.degraded).toBe(false);
    expect(res.context_pressure?.proxy).toBe(66);
    expect(res.context_pressure?.decision_count).toBe(30);
    expect(res.context_pressure?.node_count).toBe(3);
    expect(res.context_pressure?.band).toBe(1);
    // ac-3: report directive fires (edge trigger), untrusted-data fenced.
    expect(res.report_directive).toBeDefined();
    expect(res.report_directive?.kind).toBe('progress_report');
    expect(res.report_directive?.action).toBe('spawn_summarizer_shed');
    expect(res.report_directive?.band).toBe(1);
    expect(res.report_directive?.summary).toContain('UNTRUSTED DATA');
    expect(res.report_directive?.artifact_path).toContain('progress-report-band-1.json');
    // The on-disk progress-report artifact (the latch) exists.
    const artifact = localDir(repo, 'runs', WI, 'progress-report-band-1.json');
    expect(await Bun.file(artifact).exists()).toBe(true);
    // Lossless: the assembler appended nothing to the decision log.
    expect((await aps.readDecisions(WI)).length).toBe(30);
  });

  test('== threshold boundary fires (>=)', async () => {
    // 3 nodes + 27 decisions ⇒ proxy = 2*(27+3) = 60 == threshold.
    await aps.write(
      WI,
      graph([node('N1'), node('N2', { depends_on: ['N1'] }), node('N3', { depends_on: ['N2'] })]),
    );
    await appendEscalations(27);
    const res = await nextNode(repo, WI);
    if (res.action !== 'spawn') throw new Error('expected spawn');
    expect(res.context_pressure?.proxy).toBe(60);
    expect(res.context_pressure?.over_threshold).toBe(true);
    expect(res.report_directive).toBeDefined();
  });

  test('proxy is reconstructed from disk each round — no stored counter (ac-2)', async () => {
    await aps.write(WI, chained3());
    await appendEscalations(30);
    const first = await nextNode(repo, WI);
    if (first.action !== 'spawn') throw new Error('expected spawn');
    expect(first.context_pressure?.decision_count).toBe(30);
    expect(first.context_pressure?.decision_count).toBe((await aps.readDecisions(WI)).length);
    expect(first.context_pressure?.node_count).toBe((await aps.get(WI)).nodes.length);
    // No pressure counter is persisted into the graph state.
    const rawGraph = await readFile(localDir(repo, 'work-items', WI, 'autopilot.json'), 'utf8');
    expect(rawGraph).not.toContain('context_pressure');
    expect(rawGraph).not.toContain('pressure_count');
    // Append 5 more decisions directly to disk and re-seed pending nodes: the proxy
    // recomputes from the NEW disk count, proving it is not an in-memory counter.
    await appendEscalations(5);
    await aps.write(WI, chained3());
    const second = await nextNode(repo, WI);
    if (second.action !== 'spawn') throw new Error('expected spawn');
    expect(second.context_pressure?.decision_count).toBe(35);
  });

  test('corrupt/truncated decisions.jsonl ⇒ fail-open degraded state, loop advances, no throw', async () => {
    await aps.write(WI, graph([node('N1')]));
    // A non-JSON line makes readDecisions throw (fail-closed parse).
    await Bun.write(
      localDir(repo, 'work-items', WI, 'autopilot-decisions.jsonl'),
      'this is not json\n',
    );
    const res = await nextNode(repo, WI);
    // Loop still advances (no throw).
    expect(res.action).toBe('spawn');
    if (res.action !== 'spawn') throw new Error('expected spawn');
    // Distinct degraded/unknown state — NOT read as low pressure.
    expect(res.context_pressure).toBeDefined();
    expect(res.context_pressure?.degraded).toBe(true);
    expect(res.context_pressure?.over_threshold).toBe(true);
    // Degraded is not a real band crossing ⇒ no shed directive fires.
    expect('report_directive' in res).toBe(false);
  });
});

describe('WS3-T2 report directive edge-trigger + assembler (ac-3/ac-4)', () => {
  test('a long over-threshold run does NOT re-fire the directive (band latch)', async () => {
    // Two independent running nodes so record-result can run twice in band 1.
    await aps.write(
      WI,
      graph([node('Ra', { status: 'running' }), node('Rb', { status: 'running' })]),
    );
    await appendEscalations(30); // proxy = 2*(30+2) = 64, band 1
    const first = await recordResult(repo, {
      workItemId: WI,
      payload: {
        node_id: 'Ra',
        result_text: 'attempted the change but a downstream check still fails; details recorded',
        outcome: 'fail',
        failure_class: 'fixable',
      },
      now: NOW,
    });
    expect(first.context_pressure).toBeDefined();
    expect(first.report_directive).toBeDefined(); // first crossing fires
    const second = await recordResult(repo, {
      workItemId: WI,
      payload: {
        node_id: 'Rb',
        result_text:
          'second node attempt also blocked on the same downstream check; details recorded',
        outcome: 'fail',
        failure_class: 'fixable',
      },
      now: NOW,
    });
    // Same band, artifact already on disk ⇒ signal still fires, directive does NOT re-fire.
    expect(second.context_pressure).toBeDefined();
    expect(second.report_directive).toBeUndefined();
  });

  test('assembler synthesizes deterministically from decisions.jsonl + autopilot.json; graph/decisions lossless (ac-4)', async () => {
    const g = graph([
      node('Ra', { status: 'passed', evidence_refs: [{ kind: 'command', path: 'bun test' }] }),
      node('Rb', { status: 'running' }),
    ]);
    await aps.write(WI, g);
    await aps.appendDecision(WI, {
      ts: NOW.toISOString(),
      node_id: 'Ra',
      decision: 'surface',
      resolvability: 'out_of_scope',
      reason: 'surfaced residual risk in-flow',
    });
    await aps.appendDecision(WI, {
      ts: NOW.toISOString(),
      node_id: 'Rb',
      failure_class: 'user_decision_needed',
      decision: 'escalate',
      reason: 'blocked on a user decision',
      attempts: { fix: 0, switch: 0 },
    });

    const decisionsPath = localDir(repo, 'work-items', WI, 'autopilot-decisions.jsonl');
    const graphPath = localDir(repo, 'work-items', WI, 'autopilot.json');
    const decisionsBefore = await readFile(decisionsPath, 'utf8');
    const graphBefore = await readFile(graphPath, 'utf8');

    const loaded = await aps.get(WI);
    const a = await assembleProgressReport(repo, WI, loaded);
    const b = await assembleProgressReport(repo, WI, loaded);
    expect(a).toBeDefined();
    if (a === undefined || b === undefined) throw new Error('expected an assembled report');
    // Deterministic: identical inputs ⇒ identical output.
    expect(a).toEqual(b);
    // Synthesized from disk: reflects the decision log + the graph.
    expect(a.decision_count).toBe(2);
    expect(a.node_count).toBe(2);
    expect(a.node_census).toEqual(['Ra (research) → passed', 'Rb (research) → running']);
    // Copy-only projection carries the run's own decision reasons + evidence.
    const texts = a.narrative.items.map((i) => i.text);
    expect(texts).toContain('surfaced residual risk in-flow');
    expect(texts).toContain('blocked on a user decision');
    expect(texts).toContain('command: bun test');

    // Lossless: the assembler wrote NOTHING back to the decision log or the graph.
    expect(await readFile(decisionsPath, 'utf8')).toBe(decisionsBefore);
    expect(await readFile(graphPath, 'utf8')).toBe(graphBefore);
  });
});
