import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapAutopilot } from '~/core/autopilot-bootstrap';
import { buildInitialNodes, kindToOwner, selectReadyNodes } from '~/core/autopilot-graph';
import { AutopilotStore } from '~/core/autopilot-store';
import { WorkItemStore } from '~/core/work-item-store';
import { intentContract } from '~/schemas/intent';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-boot-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function setup(statement: string) {
  const wi = await new WorkItemStore(repo).create({
    title: 'pw',
    source_request: 'add endpoint',
    goal: 'POST /pw returns a score',
    acceptance_criteria: [{ id: 'ac-1', statement, verdict: 'unverified', evidence: [] }],
  });
  const intent = intentContract.parse({
    schema_version: '0.1.0',
    work_item_id: wi.id,
    source_request: 'add endpoint',
    goal: 'POST /pw returns a score',
    acceptance_criteria: [{ id: 'ac-1', statement, evidence_required: ['test'] }],
    question_policy: 'ask_only_if_user_only_can_answer',
  });
  return { wi, intent };
}

const safeRisk = { non_local: false, irreversible: false, unaudited: false };
const riskyRisk = { non_local: false, irreversible: true, unaudited: false };

describe('bootstrapAutopilot', () => {
  test('ready intent + safe risk => created graph (design→implement→verify + settled-tree test barrier, not_required)', async () => {
    const { wi, intent } = await setup('POST /pw returns 200 with a numeric score');
    const result = await bootstrapAutopilot(repo, { workItem: wi, intent, risk: safeRisk });
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.graph.root_goal).toBe('POST /pw returns a score');
    // wi_260708ds9 ac-1: bootstrap now also seeds a settled-tree `test` barrier.
    expect(result.graph.nodes.map((n) => n.kind)).toEqual([
      'design',
      'implement',
      'verify',
      'test',
    ]);
    expect(result.graph.approval_gate.status).toBe('not_required');
    // persisted via store
    expect(await new AutopilotStore(repo).exists(wi.id)).toBe(true);
  });

  test('high-risk (irreversible) => approval pending', async () => {
    const { wi, intent } = await setup('POST /pw returns 200 with a numeric score');
    const result = await bootstrapAutopilot(repo, { workItem: wi, intent, risk: riskyRisk });
    expect(result.status === 'created' && result.graph.approval_gate.status).toBe('pending');
  });

  test('pre-approved input => approved', async () => {
    const { wi, intent } = await setup('POST /pw returns 200 with a numeric score');
    const result = await bootstrapAutopilot(repo, {
      workItem: wi,
      intent,
      risk: riskyRisk,
      approvedSource: 'approved_spec',
    });
    expect(result.status === 'created' && result.graph.approval_gate.status).toBe('approved');
  });

  test('nodes carry intent.acceptance_criteria ids (not workItem placeholders)', async () => {
    // plan §4 M2.1b — bootstrap reads AC from the ready *intent*, so that the
    // testability gate (intent AC) and the graph nodes (acceptance_refs) share
    // the same source. A draft work item may carry different placeholder AC.
    const wi = await new WorkItemStore(repo).create({
      title: 'pw',
      source_request: 'add endpoint',
      goal: 'POST /pw returns a score',
      acceptance_criteria: [
        { id: 'wi-only', statement: 'placeholder', verdict: 'unverified', evidence: [] },
      ],
    });
    const intent = intentContract.parse({
      schema_version: '0.1.0',
      work_item_id: wi.id,
      source_request: 'add endpoint',
      goal: 'POST /pw returns a score',
      acceptance_criteria: [
        {
          id: 'intent-1',
          statement: 'POST /pw returns 200 with a numeric score',
          evidence_required: ['test'],
        },
      ],
      question_policy: 'ask_only_if_user_only_can_answer',
    });
    const result = await bootstrapAutopilot(repo, { workItem: wi, intent, risk: safeRisk });
    if (result.status !== 'created') throw new Error(`expected created, got ${result.status}`);
    // The settled-tree `test` barrier carries acceptance_refs:[] by design (it judges
    // no single criterion), so only AC-carrying nodes are checked for the intent id.
    for (const node of result.graph.nodes.filter((n) => n.acceptance_refs.length > 0)) {
      expect(node.acceptance_refs).toEqual(['intent-1']);
    }
    expect(result.graph.nodes.find((n) => n.kind === 'test')?.acceptance_refs).toEqual([]);
  });

  test('bootstrap syncs intent AC into the work item (work-item AC == intent AC after)', async () => {
    // false-green seam (wi_260624xb8 ac-1): a draft work item may hold only a
    // placeholder AC while intent.json carries the readied ac-1..ac-3. Bootstrap
    // is the chokepoint all entry paths funnel through — it must mirror intent
    // AC into the work item so completion later evaluates every intent AC.
    const wi = await new WorkItemStore(repo).create({
      title: 'pw',
      source_request: 'add endpoint',
      goal: 'POST /pw returns a score',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'placeholder TBD', verdict: 'unverified', evidence: [] },
      ],
    });
    const intent = intentContract.parse({
      schema_version: '0.1.0',
      work_item_id: wi.id,
      source_request: 'add endpoint',
      goal: 'POST /pw returns a score',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'POST /pw returns 200', evidence_required: ['test'] },
        { id: 'ac-2', statement: 'score is numeric', evidence_required: ['test'] },
        { id: 'ac-3', statement: 'rejects empty body', evidence_required: ['test'] },
      ],
      question_policy: 'ask_only_if_user_only_can_answer',
    });
    const result = await bootstrapAutopilot(repo, { workItem: wi, intent, risk: safeRisk });
    expect(result.status).toBe('created');
    const synced = await new WorkItemStore(repo).get(wi.id);
    expect(synced.acceptance_criteria.map((ac) => ac.id)).toEqual(['ac-1', 'ac-2', 'ac-3']);
    expect(synced.acceptance_criteria.map((ac) => ac.statement)).toEqual([
      'POST /pw returns 200',
      'score is numeric',
      'rejects empty body',
    ]);
  });

  test('default generator seed + settled-tree test barrier (behavior invariant)', async () => {
    const { wi, intent } = await setup('POST /pw returns 200 with a numeric score');
    const result = await bootstrapAutopilot(repo, { workItem: wi, intent, risk: safeRisk });
    if (result.status !== 'created') throw new Error('expected created');
    // wi_260708ds9 ac-1: the design→implement→verify seed is now barrier-terminated.
    expect(result.graph.nodes.map((n) => n.kind)).toEqual([
      'design',
      'implement',
      'verify',
      'test',
    ]);
  });

  test('e2eOptIn seeds an e2e-author node between design and implement (implement depends_on e2e-author)', async () => {
    // wi_260707loq ac-6: the single main-session e2e dialogue runs at ENTRY, before
    // the autonomous implement→verify run. So the seed becomes
    // design → e2e-author → implement → verify, with implement re-pointed onto the
    // e2e-author node (never depending on design directly).
    const { wi, intent } = await setup('POST /pw returns 200 with a numeric score');
    const result = await bootstrapAutopilot(repo, {
      workItem: wi,
      intent,
      risk: safeRisk,
      e2eOptIn: true,
    });
    if (result.status !== 'created') throw new Error(`expected created, got ${result.status}`);
    expect(result.graph.nodes.map((n) => n.kind)).toEqual([
      'design',
      'e2e-author',
      'implement',
      'verify',
      'test',
    ]);
    const design = result.graph.nodes.find((n) => n.kind === 'design');
    const e2e = result.graph.nodes.find((n) => n.kind === 'e2e-author');
    const implement = result.graph.nodes.find((n) => n.kind === 'implement');
    expect(e2e?.owner).toBe('main-session');
    expect(e2e?.depends_on).toEqual([design?.id]);
    expect(implement?.depends_on).toEqual([e2e?.id]);
  });

  test('e2eOptIn off (default) seeds no e2e-author node (autonomous run has no main-session step)', async () => {
    const { wi, intent } = await setup('POST /pw returns 200 with a numeric score');
    const result = await bootstrapAutopilot(repo, { workItem: wi, intent, risk: safeRisk });
    if (result.status !== 'created') throw new Error('expected created');
    expect(result.graph.nodes.map((n) => n.kind)).toEqual([
      'design',
      'implement',
      'verify',
      'test',
    ]);
    expect(result.graph.nodes.some((n) => n.kind === 'e2e-author')).toBe(false);
  });

  test('a custom generateNodes seam is used by bootstrap (>3-node valid chain)', async () => {
    const { wi, intent } = await setup('POST /pw returns 200 with a numeric score');
    const generateNodes = (acceptanceIds: string[]) => {
      const base = buildInitialNodes(acceptanceIds);
      return [
        ...base,
        {
          id: 'N4',
          kind: 'review' as const,
          owner: 'reviewer' as const,
          purpose: 'review',
          status: 'pending' as const,
          depends_on: ['N3'],
          acceptance_refs: acceptanceIds,
          evidence_refs: [],
          attempts: { fix: 0, switch: 0 },
        },
      ];
    };
    const result = await bootstrapAutopilot(repo, {
      workItem: wi,
      intent,
      risk: safeRisk,
      generateNodes,
    });
    if (result.status !== 'created') throw new Error('expected created');
    // The custom chain is preserved and barrier-terminated (seeded on the implement
    // frontier N2 — the only implement node; N3=verify, N4=review are not implements).
    expect(result.graph.nodes.map((n) => n.id)).toEqual(['N1', 'N2', 'N3', 'N4', 'test-barrier']);
    expect(result.graph.nodes.find((n) => n.id === 'test-barrier')?.depends_on).toEqual(['N2']);
  });

  test('intent.work_item_id ≠ workItem.id => work_item_mismatch, no graph created', async () => {
    const { wi, intent } = await setup('POST /pw returns 200 with a numeric score');
    const foreign = { ...intent, work_item_id: 'orch_foreign_0001' as typeof intent.work_item_id };
    const result = await bootstrapAutopilot(repo, {
      workItem: wi,
      intent: foreign,
      risk: safeRisk,
    });
    expect(result.status).toBe('work_item_mismatch');
    expect(await new AutopilotStore(repo).exists(wi.id)).toBe(false);
  });

  test('vague intent => intent_not_ready, no graph created', async () => {
    const { wi, intent } = await setup('make the password feature more robust and user-friendly');
    const result = await bootstrapAutopilot(repo, { workItem: wi, intent, risk: safeRisk });
    expect(result.status).toBe('intent_not_ready');
    expect(await new AutopilotStore(repo).exists(wi.id)).toBe(false);
  });
});

describe('graph helpers', () => {
  test('kindToOwner maps kinds to owner roles', () => {
    expect(kindToOwner('design')).toBe('planner');
    expect(kindToOwner('implement')).toBe('implementer');
    expect(kindToOwner('verify')).toBe('verifier');
  });

  test('selectReadyNodes picks the first runnable node, respecting deps', async () => {
    const { wi, intent } = await setup('POST /pw returns 200 with a numeric score');
    const result = await bootstrapAutopilot(repo, { workItem: wi, intent, risk: safeRisk });
    if (result.status !== 'created') throw new Error('expected created');
    const nodes = result.graph.nodes;
    expect(selectReadyNodes(nodes)[0]?.id).toBe('N1'); // design has no deps
    // mark N1 passed → N2 becomes ready
    const advanced = nodes.map((n) => (n.id === 'N1' ? { ...n, status: 'passed' as const } : n));
    expect(selectReadyNodes(advanced)[0]?.id).toBe('N2');
  });
});
