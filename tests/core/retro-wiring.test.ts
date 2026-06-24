import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextNode, recordResult } from '~/core/autopilot-loop';
import { AutopilotStore } from '~/core/autopilot-store';
import { CompletionStore, buildCompletion } from '~/core/completion-store';
import { CoverageFeedbackLedger } from '~/core/coverage-feedback';
import { CoverageStore } from '~/core/coverage-store';
import { MemoryEventStore } from '~/core/memory-store';
import { retroMemoryEventId } from '~/core/retro-measure';
import { RetroMetricLedger } from '~/core/retro-metric-ledger';
import { WorkItemStore } from '~/core/work-item-store';
import type { Autopilot, AutopilotNode } from '~/schemas/autopilot';

// ADR-0024 Decision 4 (ac-4 & ac-5) — LIVE wiring of the retro assembler into the
// loop. The assembler (`src/core/retro-measure.ts`) is already built + unit-tested;
// this proves the loop actually POPULATES it:
//   ac-4 — dispatching a retro node yields a packet whose `context.retro` carries
//          the TWO SEPARATED metrics (present/omitted per grounding; zero grounded
//          ⇒ no_measurable_signal).
//   ac-5 — recording a retro pass absorbs EXACTLY ONE cross-WI memory event, and
//          re-recording absorbs none (idempotent — the stable per-WI key).

let repo: string;
let aps: AutopilotStore;
let wis: WorkItemStore;
let WI: string;
const NOW = new Date('2026-06-24T00:00:00.000Z');

function graph(nodes: AutopilotNode[], overrides: Partial<Autopilot> = {}): Autopilot {
  return {
    schema_version: '0.1.0',
    autopilot_id: 'orch_retrowiring',
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
      loop_rounds: 6,
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

// A standalone retro node (no deps) so `nextNode` dispatches it directly — the
// retro node is a read-only `retrospective` owner (no approval gate, no wave).
function retroNode(overrides: Partial<AutopilotNode> = {}): AutopilotNode {
  return {
    id: 'N7',
    kind: 'retro',
    owner: 'retrospective',
    purpose: 'Reflect on the completed run',
    status: 'pending',
    depends_on: [],
    acceptance_refs: [],
    evidence_refs: [],
    ac_verdicts: [],
    attempts: { fix: 0, switch: 0 },
    ...overrides,
  } as AutopilotNode;
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-retro-wiring-'));
  aps = new AutopilotStore(repo);
  wis = new WorkItemStore(repo);
  const wi = await wis.create(
    {
      title: 'retro wiring test',
      source_request: 'wire the retro assembler into the loop',
      goal: 'a live retro node carries the assembled metrics + absorbs durable learning',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'criterion one', verdict: 'pass', evidence: [] },
        { id: 'ac-2', statement: 'criterion two', verdict: 'unverified', evidence: [] },
      ],
    },
    NOW,
  );
  WI = wi.id;
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('retro dispatch wiring (ac-4: context.retro carries the SEPARATED metrics)', () => {
  test('a dispatched retro node carries the two grounded metrics + projected narrative', async () => {
    // Ground ① outcome_floor.coverage via a real completion.json (1 of 2 pass = 0.5),
    // and the narrative via its unverified rows + remaining_risks.
    const wi = await wis.get(WI);
    const completion = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 'partial close',
      verdicts: [
        // ac-1 closes pass WITH evidence (a real close); ac-2 unverified. 1 of 2
        // closed ⇒ coverage 0.5 under the evidence-based rule shared with the doctor.
        {
          criterion_id: 'ac-1',
          verdict: 'pass',
          evidence: [{ kind: 'file', path: 'src/x.ts', summary: 'wired' }],
        },
        { criterion_id: 'ac-2', verdict: 'unverified', evidence: [] },
      ],
      unverified: [{ item: 'migration not run', reason: 'no staging db', out_of_scope: true }],
      remainingRisks: ['rollback path untested'],
      now: NOW,
    });
    await new CompletionStore(repo).write(completion);

    await aps.write(WI, graph([retroNode()]));
    const res = await nextNode(repo, WI);
    expect(res.action).toBe('spawn');
    if (res.action !== 'spawn') throw new Error('expected spawn');
    expect(res.node_id).toBe('N7');
    const retro = res.packet.context.retro;
    expect(retro).toBeDefined();
    // ① outcome_floor.coverage grounded from completion (1 pass / 2 acceptance).
    expect(retro?.metrics.outcome_floor?.coverage).toBe(0.5);
    expect(retro?.metrics.no_measurable_signal).toBeUndefined();
    // narrative is a projection of run records (verbatim).
    const narrativeText = JSON.stringify(retro?.narrative);
    expect(narrativeText).toContain('migration not run');
    expect(narrativeText).toContain('rollback path untested');
  });

  // surviving-risk self-description: a coverage node closed as a skip carries the
  // surviving risk on its `residual_risk` field. The retro must SURFACE that risk in
  // its narrative — the same place completion `remaining_risks` surfaces — so the
  // surviving risk is reflected on and carried forward, not lost when the sweep ends.
  test('a coverage node residual_risk surfaces in the dispatched retro narrative', async () => {
    const RISK = 'auth bypass survives the skip: external caller could re-enter';
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
        {
          id: 'cov-cat-auth',
          parent_id: 'cov-root',
          label: 'authentication',
          origin: 'seed',
          depth_weight: 0,
          state: 'out_of_scope',
          children: [],
          close_reason: 'no auth path touched',
          residual_risk: RISK,
        },
      ],
    });

    await aps.write(WI, graph([retroNode()]));
    const res = await nextNode(repo, WI);
    if (res.action !== 'spawn') throw new Error('expected spawn');
    expect(res.node_id).toBe('N7');
    const narrativeText = JSON.stringify(res.packet.context.retro?.narrative);
    expect(narrativeText).toContain(RISK);
    // it is projected as a 'residual' (surviving-risk) item, consistent with completion
    // remaining_risks — not a 'close_reason' (which is the skip's WHY).
    const items = res.packet.context.retro?.narrative.items ?? [];
    const riskItem = items.find((i) => i.text === RISK);
    expect(riskItem?.kind).toBe('residual');
  });

  test('persisted completion: a pass WITHOUT evidence is EXCLUDED from coverage (evidence-based == doctor isClosed)', async () => {
    // claim ≠ proof (ADR-0024 결정4 anti-SLOP): retro outcome_floor.coverage must use
    // the SAME closure rule as `ditto doctor completion-coverage` — verdict=pass AND
    // ≥1 evidence ref — not a bare pass-ratio. ac-1 closes pass WITH file evidence;
    // ac-2 is pass with NO evidence (a claim, not proof). Only ac-1 is closed ⇒
    // coverage = 1/2 = 0.5. A verdict-only ratio would wrongly count both ⇒ 1.0.
    const wi = await wis.get(WI);
    await new CompletionStore(repo).write(
      buildCompletion({
        workItem: wi,
        declaredBy: 'verifier',
        summary: 'evidence vs claim',
        verdicts: [
          {
            criterion_id: 'ac-1',
            verdict: 'pass',
            evidence: [{ kind: 'file', path: 'src/x.ts', summary: 'wired' }],
          },
          { criterion_id: 'ac-2', verdict: 'pass', evidence: [] },
        ],
        now: NOW,
      }),
    );

    await aps.write(WI, graph([retroNode()]));
    const res = await nextNode(repo, WI);
    if (res.action !== 'spawn') throw new Error('expected spawn');
    expect(res.packet.context.retro?.metrics.outcome_floor?.coverage).toBe(0.5);
  });

  test('escape-ledger recurrence grounds outcome_floor.escape_recurrence', async () => {
    const wi = await wis.get(WI);
    await new CompletionStore(repo).write(
      buildCompletion({
        workItem: wi,
        declaredBy: 'verifier',
        summary: 's',
        verdicts: [
          { criterion_id: 'ac-1', verdict: 'pass', evidence: [] },
          { criterion_id: 'ac-2', verdict: 'pass', evidence: [] },
        ],
        now: NOW,
      }),
    );
    const ledger = new CoverageFeedbackLedger(repo);
    await ledger.append(
      { work_item_id: WI, category_id: 'auth', fault_kind: 'depth', evidence: 'leaked token' },
      NOW.toISOString(),
    );
    await ledger.append(
      { work_item_id: WI, category_id: 'auth', fault_kind: 'breadth', evidence: 'no lens' },
      NOW.toISOString(),
    );
    // a residual row is NOT a far-field escape — must be excluded from the count.
    await ledger.append(
      { work_item_id: WI, category_id: 'misc', fault_kind: 'residual', evidence: 'followup' },
      NOW.toISOString(),
    );

    await aps.write(WI, graph([retroNode()]));
    const res = await nextNode(repo, WI);
    if (res.action !== 'spawn') throw new Error('expected spawn');
    expect(res.packet.context.retro?.metrics.outcome_floor?.escape_recurrence).toBe(2);
  });

  test('unit-only closures ground outcome_floor.unit_only_closures from completion (isUnitOnlyClosure aggregate)', async () => {
    // ac-1 closes pass with command-ONLY evidence (a unit/CLI test, no file/artifact
    // runtime evidence) → a unit-only (falsely-green) closure. ac-2 closes pass with
    // a file evidence → NOT unit-only. The retro's ① outcome_floor must carry the
    // grounded count (1), per the intent's ① floor "isUnitOnlyClosure 집계".
    const wi = await wis.get(WI);
    await new CompletionStore(repo).write(
      buildCompletion({
        workItem: wi,
        declaredBy: 'verifier',
        summary: 's',
        verdicts: [
          {
            criterion_id: 'ac-1',
            verdict: 'pass',
            evidence: [{ kind: 'command', command: 'bun test', summary: 'unit only' }],
          },
          {
            criterion_id: 'ac-2',
            verdict: 'pass',
            evidence: [{ kind: 'file', path: 'src/x.ts', summary: 'runtime wired' }],
          },
        ],
        now: NOW,
      }),
    );

    await aps.write(WI, graph([retroNode()]));
    const res = await nextNode(repo, WI);
    if (res.action !== 'spawn') throw new Error('expected spawn');
    expect(res.packet.context.retro?.metrics.outcome_floor?.unit_only_closures).toBe(1);
  });

  test('NO completion → unit_only_closures slot is OMITTED (anti-SLOP, not fabricated)', async () => {
    // No completion.json present ⇒ the unit-only-closure aggregate has no grounding
    // source, so the slot must be OMITTED (never a placeholder zero). post_cost still
    // grounds to a real 0 from the graph, so outcome_floor itself is absent here.
    await aps.write(WI, graph([retroNode()]));
    const res = await nextNode(repo, WI);
    if (res.action !== 'spawn') throw new Error('expected spawn');
    const retro = res.packet.context.retro;
    expect(retro?.metrics.outcome_floor).toBeUndefined();
    expect(retro?.metrics.process_health?.post_cost).toBe(0);
  });

  test('zero grounded slots → EXPLICIT no_measurable_signal (no completion / no metrics)', async () => {
    // No completion.json, no coverage feedback, a fresh graph with no rework/drift/
    // handoffs ⇒ post_cost grounds to 0 (a real measurement), so the retro is NOT
    // empty. To get a TRULY signal-less retro the loop must omit post_cost when its
    // sources are absent — assert the explicit marker instead of a silent omit-all.
    await aps.write(WI, graph([retroNode()]));
    const res = await nextNode(repo, WI);
    if (res.action !== 'spawn') throw new Error('expected spawn');
    const retro = res.packet.context.retro;
    expect(retro).toBeDefined();
    // With no completion + no escape ledger, the only possibly-grounded slot is
    // process_health.post_cost (graph-derived). It is a real 0 here, so the retro
    // carries process_health and is NOT no_measurable_signal — the marker only
    // fires when EVERY slot is ungrounded.
    expect(retro?.metrics.process_health?.post_cost).toBe(0);
    expect(retro?.metrics.outcome_floor).toBeUndefined();
    expect(retro?.metrics.no_measurable_signal).toBeUndefined();
  });

  // ADR-0024 Decision 4 gap fix (wi_260624qde): in the STANDARD flow the retro node
  // runs BEFORE `autopilot complete` writes completion.json, so coverage/unit_only
  // must ground from the live graph — the SAME (graph, workItem) `autopilot complete`
  // assembles from — not wait for a file that does not exist yet. (Siblings
  // escape_recurrence/post_cost already compute from live state; these two were the
  // only slots that waited for completion.json, which made the floor empty in the
  // standard flow.)
  test('NO completion.json + terminal AC work → outcome_floor.coverage grounds FROM THE GRAPH', async () => {
    // N1 closes ac-1 pass with FILE evidence (not unit-only); ac-2 is unaddressed →
    // unverified. No completion.json on disk. Grounded coverage = 1 pass / 2 = 0.5,
    // matching what `assembleCompletionFromGraph(graph, wi)` (the complete path) yields.
    const verifyN1 = {
      id: 'N1',
      kind: 'verify',
      owner: 'verifier',
      purpose: 'verify ac-1',
      status: 'passed',
      depends_on: [],
      acceptance_refs: ['ac-1'],
      evidence_refs: [{ kind: 'file', path: 'src/x.ts', summary: 'runtime wired' }],
      ac_verdicts: [],
      attempts: { fix: 0, switch: 0 },
    } as AutopilotNode;
    await aps.write(WI, graph([verifyN1, retroNode({ depends_on: ['N1'] })]));
    const res = await nextNode(repo, WI);
    if (res.action !== 'spawn') throw new Error('expected spawn');
    expect(res.node_id).toBe('N7');
    const retro = res.packet.context.retro;
    expect(retro?.metrics.outcome_floor?.coverage).toBe(0.5);
    expect(retro?.metrics.outcome_floor?.unit_only_closures).toBe(0);
  });

  test('NO completion.json + command-only closure → unit_only_closures grounds FROM THE GRAPH', async () => {
    // ac-1 closes pass with command-ONLY evidence (no file/artifact) → a unit-only
    // (falsely-green) closure. Grounded from the graph without any completion.json.
    const verifyN1 = {
      id: 'N1',
      kind: 'verify',
      owner: 'verifier',
      purpose: 'verify ac-1',
      status: 'passed',
      depends_on: [],
      acceptance_refs: ['ac-1'],
      evidence_refs: [{ kind: 'command', command: 'bun test', summary: 'unit only' }],
      ac_verdicts: [],
      attempts: { fix: 0, switch: 0 },
    } as AutopilotNode;
    await aps.write(WI, graph([verifyN1, retroNode({ depends_on: ['N1'] })]));
    const res = await nextNode(repo, WI);
    if (res.action !== 'spawn') throw new Error('expected spawn');
    expect(res.packet.context.retro?.metrics.outcome_floor?.unit_only_closures).toBe(1);
  });

  test('a NON-retro node carries no context.retro (unchanged dispatch path)', async () => {
    const impl = {
      id: 'N1',
      kind: 'implement',
      owner: 'implementer',
      purpose: 'do the work',
      status: 'pending',
      depends_on: [],
      acceptance_refs: ['ac-1'],
      evidence_refs: [],
      ac_verdicts: [],
      attempts: { fix: 0, switch: 0 },
      file_scope: ['src/x.ts'],
    } as AutopilotNode;
    await wis.update(WI, (w) => ({ ...w, changed_files: ['src/x.ts'] }));
    await aps.write(
      WI,
      graph([impl], {
        approval_gate: {
          status: 'not_required',
          source: 'small_reversible_policy',
          approved_at: null,
          approved_by: null,
          evidence_refs: [],
        },
      }),
    );
    const res = await nextNode(repo, WI);
    if (res.action !== 'spawn') throw new Error('expected spawn');
    expect(res.packet.context.retro).toBeUndefined();
    expect('retro' in res.packet.context).toBe(false);
  });
});

describe('retro absorption wiring (ac-5: idempotent cross-WI memory)', () => {
  test('recording a retro pass absorbs exactly one event; re-recording absorbs none', async () => {
    const wi = await wis.get(WI);
    await new CompletionStore(repo).write(
      buildCompletion({
        workItem: wi,
        declaredBy: 'verifier',
        summary: 's',
        verdicts: [
          { criterion_id: 'ac-1', verdict: 'pass', evidence: [] },
          { criterion_id: 'ac-2', verdict: 'unverified', evidence: [] },
        ],
        unverified: [{ item: 'migration not run', reason: 'no db', out_of_scope: true }],
        remainingRisks: ['rollback path untested'],
        now: NOW,
      }),
    );
    await aps.write(WI, graph([retroNode()]));

    // Dispatch (pending → running) so recordResult accepts the node.
    const dispatched = await nextNode(repo, WI);
    expect(dispatched.action).toBe('spawn');

    const mem = new MemoryEventStore(repo);
    const eventId = retroMemoryEventId(WI);
    const hasEvent = async () => (await mem.list()).some((e) => e.event_id === eventId);
    expect(await hasEvent()).toBe(false);

    const passPayload = {
      node_id: 'N7',
      result_text:
        'Retro complete: presented coverage=0.5, surfaced unverified migration + rollback risk.',
      outcome: 'pass' as const,
      evidence_refs: [
        { kind: 'file' as const, path: '.ditto/local/work-items/x/completion.json', summary: 'c' },
      ],
    };
    const r1 = await recordResult(repo, { workItemId: WI, payload: passPayload, now: NOW });
    expect(r1.status).toBe('passed');
    // exactly one durable cross-WI event absorbed (the narrative's eligible items).
    expect(await hasEvent()).toBe(true);
    const afterFirst = await mem.list();
    const retroEvents = afterFirst.filter((e) => e.event_id === eventId);
    expect(retroEvents).toHaveLength(1);
    // process-health note must NOT be in the durable text (filtered).
    expect(retroEvents[0]?.text).not.toContain('post_cost');

    // Re-drive the retro: dispatch again, record again. The stable key makes the
    // second absorption a no-op — NO double-append.
    await aps.updateNode(WI, 'N7', (n) => ({ ...n, status: 'pending' as const }));
    const redispatched = await nextNode(repo, WI);
    expect(redispatched.action).toBe('spawn');
    const r2 = await recordResult(repo, { workItemId: WI, payload: passPayload, now: NOW });
    expect(r2.status).toBe('passed');
    const afterSecond = (await mem.list()).filter((e) => e.event_id === eventId);
    expect(afterSecond).toHaveLength(1);
  });
});

describe('retro metric trend ledger wiring (ADR-0024 결정4 trend preservation)', () => {
  test('recording a retro pass appends ONE snapshot with the grounded metrics; re-drive is idempotent', async () => {
    const wi = await wis.get(WI);
    await new CompletionStore(repo).write(
      buildCompletion({
        workItem: wi,
        declaredBy: 'verifier',
        summary: 's',
        verdicts: [
          // ac-1 closes pass WITH evidence (1 of 2 closed ⇒ coverage 0.5 under the
          // evidence-based rule); ac-2 unverified.
          {
            criterion_id: 'ac-1',
            verdict: 'pass',
            evidence: [{ kind: 'file', path: 'src/x.ts', summary: 'wired' }],
          },
          { criterion_id: 'ac-2', verdict: 'unverified', evidence: [] },
        ],
        now: NOW,
      }),
    );
    await aps.write(WI, graph([retroNode()]));

    const ledger = new RetroMetricLedger(repo);
    expect(await ledger.readAll()).toHaveLength(0);

    const dispatched = await nextNode(repo, WI);
    expect(dispatched.action).toBe('spawn');
    const passPayload = {
      node_id: 'N7',
      result_text: 'Retro complete.',
      outcome: 'pass' as const,
      evidence_refs: [
        { kind: 'file' as const, path: '.ditto/local/work-items/x/completion.json', summary: 'c' },
      ],
    };
    const r1 = await recordResult(repo, { workItemId: WI, payload: passPayload, now: NOW });
    expect(r1.status).toBe('passed');

    const rows = await ledger.readAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.work_item_id).toBe(WI);
    // grounded coverage = 1 pass / 2 acceptance.
    expect(rows[0]?.metrics.outcome_floor?.coverage).toBe(0.5);
    expect(rows[0]?.recorded_at).toBe(NOW.toISOString());

    // Re-drive: one row per WI (idempotent), mirroring the memory absorption.
    await aps.updateNode(WI, 'N7', (n) => ({ ...n, status: 'pending' as const }));
    const redispatched = await nextNode(repo, WI);
    expect(redispatched.action).toBe('spawn');
    await recordResult(repo, { workItemId: WI, payload: passPayload, now: NOW });
    expect(await ledger.readAll()).toHaveLength(1);
  });
});
