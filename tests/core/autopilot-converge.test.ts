import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyDiscoveredDefect,
  planForwardReexpansion,
  totalForwardRounds,
} from '~/core/autopilot-converge';
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
  ac_verdicts: [],
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
    expect(review?.depends_on).toEqual([(fix as NonNullable<typeof fix>).id]);
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

describe('planForwardReexpansion parameterized triggers (ONE planner, three forward triggers)', () => {
  // The seed for the three new triggers is the node that surfaced the item; its
  // kind is deliberately NOT `verify` here so the test proves the parameterized
  // recheck kind OVERRIDES the seed kind (otherwise a verify seed would pass for
  // the wrong reason). reviewNode has kind `review`.
  const triggers = ['reverify', 'risk_fix', 'follow_up', 'defect_fix'] as const;

  for (const trigger of triggers) {
    test(`${trigger}: same fix→recheck shape — fix(implementer) + re-verify(verifier), forward-only acyclic edges`, () => {
      const r = planForwardReexpansion({
        reviewNode,
        hasFindings: true,
        round: 0,
        budget: 3,
        trigger,
      });
      expect(r.decision).toBe('expand');
      if (r.decision !== 'expand') throw new Error('expected expand');
      expect(r.nodes).toHaveLength(2);
      const [fix, recheck] = r.nodes;
      expect(fix?.kind).toBe('fix');
      expect(fix?.owner).toBe('implementer');
      // ac-2/ac-3/ac-4 all converge through a re-verify: the verifier collects
      // fresh evidence and judges the AC/risk/follow-up resolved (parameterized
      // recheck kind, independent of the seed's kind `review`).
      expect(recheck?.kind).toBe('verify');
      expect(recheck?.owner).toBe('verifier');
      // forward-only edges (fix→seed, recheck→fix); every id fresh ⇒ acyclic.
      expect(fix?.depends_on).toEqual(['N3']);
      expect(recheck?.depends_on).toEqual([(fix as NonNullable<typeof fix>).id]);
      expect(fix?.id).not.toBe('N3');
      expect(recheck?.id).not.toBe('N3');
      expect(recheck?.acceptance_refs).toEqual(['ac-1', 'ac-2']);
      expect(() => validateNodeAddition([reviewNode], r.nodes)).not.toThrow();
    });

    test(`${trigger}: R2 cap inheritance — splice reuses the .rev.r marker so totalForwardRounds counts it`, () => {
      const r = planForwardReexpansion({
        reviewNode,
        hasFindings: true,
        round: 0,
        budget: 3,
        trigger,
      });
      if (r.decision !== 'expand') throw new Error('expected expand');
      const ids = r.nodes.map((n) => n.id);
      // exactly one forward-review marker among the spliced ids (the recheck node),
      // so the graph-wide no-progress floor (loop_rounds) counts this round. A
      // different marker would be UNCAPPED — the exact ac-5 hole.
      expect(totalForwardRounds(ids)).toBe(1);
      expect(ids.some((id) => id.includes('.rev.r'))).toBe(true);
    });
  }

  test('R5 / ADR-0018: optional-tool absence surfaces blocked_external (+grounding), NOT an endless re-verify splice', () => {
    const r = planForwardReexpansion({
      reviewNode,
      hasFindings: true,
      round: 0,
      budget: 3,
      trigger: 'reverify',
      blockedByOptionalTool: {
        tool: 'codeql',
        grounding: 'ADR-0018: CodeQL optional; absent on host',
      },
    });
    // grounding releases blocked_external at the gate, but never releases
    // agent_resolvable (gates.ts:222-237) — so an agent_resolvable re-verify would
    // loop forever. The planner must classify blocked_external and refuse to splice.
    expect(r.decision).toBe('surface');
    if (r.decision !== 'surface') throw new Error('expected surface');
    expect(r.resolvability).toBe('blocked_external');
    expect(r.resolvability).not.toBe('agent_resolvable');
    expect(r.grounding.length).toBeGreaterThan(0);
    expect(r.decision).not.toBe('expand');
  });

  test("default trigger stays 'review' (lane-preserving) — regression: recheck mirrors the seed kind", () => {
    const securitySeed: AutopilotNode = {
      ...reviewNode,
      id: 'S3',
      kind: 'security',
      owner: 'security-reviewer',
    };
    const r = planForwardReexpansion({
      reviewNode: securitySeed,
      hasFindings: true,
      round: 0,
      budget: 3,
    });
    if (r.decision !== 'expand') throw new Error('expected expand');
    // no trigger ⇒ the existing convergence loop ⇒ same lifecycle lane (security).
    expect(r.nodes[1]?.kind).toBe('security');
  });
});

describe('classifyDiscoveredDefect (wi_2607148yg ac-2: conservative reproduction gate)', () => {
  test('a reproduced current-harm bug (no exclusions) is drive-eligible', () => {
    expect(classifyDiscoveredDefect({ reproduced: true })).toBe('drive');
  });

  test('a NOT-reproduced / uncertain finding is backlog-only, never driven', () => {
    expect(classifyDiscoveredDefect({ reproduced: false })).toBe('backlog');
  });

  test('a reproduced but LATENT bug (no current harm) is backlog-only', () => {
    expect(classifyDiscoveredDefect({ reproduced: true, latent: true })).toBe('backlog');
  });

  test('reproduced tech-debt / unrelated pre-existing failure is backlog-only', () => {
    expect(classifyDiscoveredDefect({ reproduced: true, tech_debt: true })).toBe('backlog');
    expect(classifyDiscoveredDefect({ reproduced: true, unrelated_preexisting: true })).toBe(
      'backlog',
    );
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
