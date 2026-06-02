import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapAutopilot } from '~/core/autopilot-bootstrap';
import { kindToOwner, selectReadyNodes } from '~/core/autopilot-graph';
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
  test('ready intent + safe risk => created graph (design→implement→verify, not_required)', async () => {
    const { wi, intent } = await setup('POST /pw returns 200 with a numeric score');
    const result = await bootstrapAutopilot(repo, { workItem: wi, intent, risk: safeRisk });
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.graph.root_goal).toBe('POST /pw returns a score');
    expect(result.graph.nodes.map((n) => n.kind)).toEqual(['design', 'implement', 'verify']);
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
    for (const node of result.graph.nodes) {
      expect(node.acceptance_refs).toEqual(['intent-1']);
    }
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
