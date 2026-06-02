import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planForwardReexpansion } from '~/core/autopilot-converge';
import { buildInitialNodes, validateNodeAddition } from '~/core/autopilot-graph';
import { AutopilotStore } from '~/core/autopilot-store';
import { type Autopilot, type AutopilotNode, autopilot } from '~/schemas/autopilot';

const reviewNode: AutopilotNode = {
  id: 'N3',
  kind: 'review',
  owner: 'reviewer',
  purpose: 'review the change against the acceptance criteria',
  status: 'running',
  depends_on: ['N2'],
  acceptance_refs: ['ac-1', 'ac-2'],
  evidence_refs: [],
  attempts: { fix: 0, switch: 0 },
};

describe('planForwardReexpansion (§2.4 forward re-expansion · §4.3 two-layer escape)', () => {
  test('findings=0 verdict closes the loop (close, no new nodes) — agent verdict, not budget', () => {
    const r = planForwardReexpansion({ reviewNode, hasFindings: false, round: 0, budget: 3 });
    expect(r.decision).toBe('close');
  });

  test('findings>0 within budget expands forward: new fix + review with forward-only edges', () => {
    const r = planForwardReexpansion({ reviewNode, hasFindings: true, round: 0, budget: 3 });
    expect(r.decision).toBe('expand');
    if (r.decision !== 'expand') throw new Error('expected expand');
    expect(r.nodes).toHaveLength(2);
    const [fix, review] = r.nodes;
    expect(fix?.kind).toBe('fix');
    expect(fix?.owner).toBe('implementer');
    expect(review?.kind).toBe('review');
    expect(review?.owner).toBe('reviewer');
    // forward edges only: fix depends on the review that found issues; new review
    // depends on the fix. Every new id is fresh, every edge points backward in
    // time (to an already-existing node), so the merged graph stays acyclic.
    expect(fix?.depends_on).toEqual(['N3']);
    expect(review?.depends_on).toEqual([fix?.id]);
    expect(fix?.id).not.toBe('N3');
    expect(review?.id).not.toBe('N3');
    // carries the same acceptance refs so the loop keeps targeting the same AC.
    expect(review?.acceptance_refs).toEqual(['ac-1', 'ac-2']);
    // the integrity gate accepts the addition against the existing graph (acyclic).
    expect(() => validateNodeAddition([reviewNode], r.nodes)).not.toThrow();
  });

  test('findings>0 at budget escalates (user_decision_needed) and never passes', () => {
    const r = planForwardReexpansion({ reviewNode, hasFindings: true, round: 3, budget: 3 });
    expect(r.decision).toBe('escalate');
    if (r.decision !== 'escalate') throw new Error('expected escalate');
    expect(r.reason.toLowerCase()).toContain('budget');
    // budget exhaustion may stop, never close/pass.
    expect(r.decision).not.toBe('close');
  });

  test('successive rounds produce distinct ids (no collision across the chain)', () => {
    const r0 = planForwardReexpansion({ reviewNode, hasFindings: true, round: 0, budget: 3 });
    const r1 = planForwardReexpansion({ reviewNode, hasFindings: true, round: 1, budget: 3 });
    if (r0.decision !== 'expand' || r1.decision !== 'expand') throw new Error('expected expand');
    const ids = [...r0.nodes, ...r1.nodes].map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('caps.converge_rounds schema (ac-1: default on legacy graphs)', () => {
  test('an autopilot.json missing converge_rounds parses to the default (no regression)', () => {
    const legacy = {
      schema_version: '0.1.0',
      autopilot_id: 'orch_legacy12345',
      work_item_id: 'wi_legacy12345',
      mode: 'autopilot',
      root_goal: 'goal',
      completion_boundary: 'entire_work_item',
      approval_gate: { status: 'not_required', source: 'small_reversible_policy' },
      nodes: buildInitialNodes(['ac-1']),
      caps: { fix_per_node: 2, switch_per_node: 1 }, // no converge_rounds
      continue_policy: {},
      stop_conditions: [],
    };
    const parsed = autopilot.parse(legacy);
    expect(parsed.caps.converge_rounds).toBeGreaterThan(0);
  });
});

describe('forward re-expansion round-trips through the store (ac-3)', () => {
  let repo: string;
  const WI = 'wi_convtest';
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-conv-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test('expanded nodes splice via addNodes and re-read deep-equals', async () => {
    const store = new AutopilotStore(repo);
    const graph: Autopilot = autopilot.parse({
      schema_version: '0.1.0',
      autopilot_id: 'orch_convtest123',
      work_item_id: WI,
      root_goal: 'goal',
      approval_gate: { status: 'not_required', source: 'small_reversible_policy' },
      nodes: [...buildInitialNodes(['ac-1']).slice(0, 2), reviewNode], // N1, N2, N3(review)
      caps: { fix_per_node: 2, switch_per_node: 1, converge_rounds: 3 },
      continue_policy: {},
      stop_conditions: [],
    });
    await store.write(WI, graph);
    const plan = planForwardReexpansion({ reviewNode, hasFindings: true, round: 0, budget: 3 });
    if (plan.decision !== 'expand') throw new Error('expected expand');
    const written = await store.addNodes(WI, plan.nodes);
    const read = await store.get(WI);
    expect(read.nodes).toHaveLength(5);
    expect(read.nodes).toEqual(written.nodes);
  });
});
