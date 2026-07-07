import { describe, expect, test } from 'bun:test';
import { allNodesTerminal, mutationGate, rollbackOnRejection } from '~/core/autopilot-driver';
import { buildInitialNodes } from '~/core/autopilot-graph';
import { producePlanGate } from '~/core/coverage-manager';
import { type Autopilot, autopilot } from '~/schemas/autopilot';

function graph(overrides: Partial<Autopilot> = {}): Autopilot {
  return {
    schema_version: '0.1.0',
    autopilot_id: 'orch_driver01',
    work_item_id: 'wi_driver001',
    mode: 'autopilot',
    root_goal: 'g',
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

describe('mutationGate (M2.3 consumes approval status)', () => {
  test('approved / not_required => proceed', () => {
    expect(
      mutationGate(
        graph({
          approval_gate: {
            status: 'approved',
            source: 'user',
            approved_at: null,
            approved_by: null,
            evidence_refs: [],
          },
        }),
      ).allowed,
    ).toBe(true);
    expect(mutationGate(graph()).allowed).toBe(true);
  });
  test('pending => present_plan, not allowed', () => {
    const g = graph({
      approval_gate: {
        status: 'pending',
        source: null,
        approved_at: null,
        approved_by: null,
        evidence_refs: [],
      },
    });
    const result = mutationGate(g);
    expect(result.allowed).toBe(false);
    expect(result.action).toBe('present_plan');
  });
  test('rejected => blocked', () => {
    const g = graph({
      approval_gate: {
        status: 'rejected',
        source: null,
        approved_at: null,
        approved_by: null,
        evidence_refs: [],
      },
    });
    expect(mutationGate(g).action).toBe('blocked');
  });
});

describe('mutationGate brief hard-gate (ac-7 — plan_brief required before implement)', () => {
  const briefRegimeGate = (
    overrides: Partial<Autopilot['approval_gate']> = {},
  ): Autopilot['approval_gate'] => ({
    status: 'approved',
    source: 'user',
    approved_at: null,
    approved_by: null,
    evidence_refs: [],
    // change_surface present == the brief regime is active for this graph.
    change_surface: ['src/foo.ts'],
    ...overrides,
  });

  const brief: NonNullable<Autopilot['approval_gate']['plan_brief']> = {
    interface_changes: ['mutationGate now reads brief approval'],
    dod: ['implement is blocked before brief approval'],
    test_scenarios: ['absent brief under approved status returns pending'],
  };

  test('brief regime + approved + brief present => proceed', () => {
    const g = graph({ approval_gate: briefRegimeGate({ plan_brief: brief }) });
    const result = mutationGate(g);
    expect(result.allowed).toBe(true);
    expect(result.action).toBe('proceed');
  });

  test('brief regime + approved + brief ABSENT => pending (not proceed; false-green guard)', () => {
    const g = graph({ approval_gate: briefRegimeGate({ plan_brief: undefined }) });
    const result = mutationGate(g);
    expect(result.allowed).toBe(false);
    expect(result.action).toBe('present_plan');
    expect(result.reason).toContain('brief');
  });

  test('brief regime + pending => present_plan (pre-approval blocks as before)', () => {
    const g = graph({
      approval_gate: briefRegimeGate({ status: 'pending', source: null, plan_brief: brief }),
    });
    const result = mutationGate(g);
    expect(result.allowed).toBe(false);
    expect(result.action).toBe('present_plan');
  });

  test('small-reversible auto-approval (not_required) proceeds even without brief approval', () => {
    const g = graph({
      approval_gate: briefRegimeGate({
        status: 'not_required',
        source: 'small_reversible_policy',
        plan_brief: brief,
      }),
    });
    const result = mutationGate(g);
    expect(result.allowed).toBe(true);
    expect(result.action).toBe('proceed');
  });

  test('legacy graph (no change_surface, approved, no brief) still proceeds — backward compat', () => {
    const g = graph({
      approval_gate: {
        status: 'approved',
        source: 'user',
        approved_at: null,
        approved_by: null,
        evidence_refs: [],
      },
    });
    expect(mutationGate(g).action).toBe('proceed');
  });

  // ac-6 (wi_260614z7r) + LOW2 (wi_2606144ta): close the change_surface escape-hatch,
  // but only for an UN-authorized approval. A passed design node with an absent
  // change_surface means producePlanGate did not run on it. Whether that is a
  // bypass depends on WHO approved: an explicit human/spec authorizer
  // (source != null) took responsibility for mutating without a brief → proceed; an
  // approval with NO recorded authorizer (source === null) is the suspicious case
  // → fail-closed (block). The brief itself is still forced whenever the sweep DID
  // run (change_surface present → the plan_brief check above).
  test('escape-hatch: passed design + approved + no change_surface + source=null => pending (fail-closed)', () => {
    const withPassedDesign = buildInitialNodes(['ac-1']).map((n) =>
      n.kind === 'design' ? { ...n, status: 'passed' as const } : n,
    );
    const g = graph({
      nodes: withPassedDesign,
      approval_gate: {
        status: 'approved',
        source: null,
        approved_at: null,
        approved_by: null,
        evidence_refs: [],
      },
    });
    const result = mutationGate(g);
    expect(result.allowed).toBe(false);
    expect(result.action).toBe('present_plan');
  });

  test('LOW2: passed design + approved + no change_surface + source=user => proceed (manual approval is authorization)', () => {
    const withPassedDesign = buildInitialNodes(['ac-1']).map((n) =>
      n.kind === 'design' ? { ...n, status: 'passed' as const } : n,
    );
    const g = graph({
      nodes: withPassedDesign,
      approval_gate: {
        status: 'approved',
        source: 'user',
        approved_at: null,
        approved_by: null,
        evidence_refs: [],
      },
    });
    expect(mutationGate(g).action).toBe('proceed');
  });

  test('escape-hatch: pending design node + approved + no change_surface still proceeds (brief stage not yet run — legacy)', () => {
    // The default seed has a PENDING design node — the brief regime has not run,
    // so this is the legacy approved→proceed path and must stay open.
    const g = graph({
      approval_gate: {
        status: 'approved',
        source: 'user',
        approved_at: null,
        approved_by: null,
        evidence_refs: [],
      },
    });
    expect(mutationGate(g).action).toBe('proceed');
  });
});

describe('approval_gate schema (ac-7 — plan_brief/change_surface additive, backward compatible)', () => {
  test('legacy gate with no plan_brief / change_surface still parses', () => {
    const parsed = autopilot.safeParse(graph());
    expect(parsed.success).toBe(true);
  });

  test('gate with plan_brief + change_surface parses', () => {
    const g = graph({
      approval_gate: {
        status: 'approved',
        source: 'user',
        approved_at: null,
        approved_by: null,
        evidence_refs: [],
        change_surface: ['src/foo.ts'],
        plan_brief: {
          interface_changes: ['a'],
          dod: ['b'],
          test_scenarios: ['c'],
        },
      },
    });
    const parsed = autopilot.safeParse(g);
    expect(parsed.success).toBe(true);
  });
});

describe('allNodesTerminal (M2.5 — continuation stops only when nothing is left)', () => {
  test('false while any node is non-terminal, true once all passed/failed', () => {
    const g = graph();
    expect(allNodesTerminal(g)).toBe(false);
    const allPassed = {
      ...g,
      nodes: g.nodes.map((n) => ({ ...n, status: 'passed' as const })),
    };
    expect(allNodesTerminal(allPassed)).toBe(true);
  });

  // ADR-0024 Decision 4 (ac-3): a `retro` node is NON-BLOCKING — its failed/blocked
  // status must NOT keep the graph non-terminal. It still runs and reports; it never
  // gates terminality. A non-retro blocked node is unaffected (stays non-terminal).
  function retro(status: 'passed' | 'failed' | 'blocked') {
    return {
      id: 'R',
      kind: 'retro' as const,
      owner: 'retrospective' as const,
      purpose: 'retrospective',
      status,
      depends_on: [] as string[],
      acceptance_refs: [] as string[],
      evidence_refs: [],
      ac_verdicts: [],
      attempts: { fix: 0, switch: 0 },
    };
  }

  test('a BLOCKED retro alongside all-passed work is still terminal (non-blocking)', () => {
    const passed = buildInitialNodes(['ac-1']).map((n) => ({ ...n, status: 'passed' as const }));
    const g = graph({ nodes: [...passed, retro('blocked')] });
    expect(allNodesTerminal(g)).toBe(true);
  });

  test('a FAILED retro alongside all-passed work is still terminal', () => {
    const passed = buildInitialNodes(['ac-1']).map((n) => ({ ...n, status: 'passed' as const }));
    const g = graph({ nodes: [...passed, retro('failed')] });
    expect(allNodesTerminal(g)).toBe(true);
  });

  test('regression: a non-retro blocked node still keeps the graph non-terminal', () => {
    const nodes = buildInitialNodes(['ac-1']).map((n, i) =>
      i === 0 ? { ...n, status: 'blocked' as const } : { ...n, status: 'passed' as const },
    );
    expect(allNodesTerminal(graph({ nodes }))).toBe(false);
  });
});

// §2 livelock fix (wi_260707loq): mutationGate returns present_plan while the
// approval gate is 'pending', so force-continuing a routine pending at Stop alone
// re-hits present_plan → livelock. producePlanGate is where the pending is cleared
// AT SOURCE: a purpose-preserving, non-forced change auto-waives to not_required so
// mutationGate proceeds; a forced pending (requireApproval / oracleAssignmentIncomplete
// / highRisk) STILL blocks. forcePending WINS over purposePreserving (ternary order).
describe('producePlanGate — livelock-fix status logic (purposePreserving / highRisk)', () => {
  const lightInputs = {
    changeSurface: ['src/x.ts'],
    brief: { interface_changes: [], dod: [], test_scenarios: [] },
    tierInputs: {
      changedFileCount: 1,
      interfaceChanged: false,
      risk: { non_local: false, irreversible: false, unaudited: false },
      large: false,
    },
  };
  // 5 changed files ⇒ not "few files" ⇒ standard tier ⇒ tierBriefApproval = 'pending'.
  const standardInputs = {
    ...lightInputs,
    tierInputs: { ...lightInputs.tierInputs, changedFileCount: 5 },
  };

  test('neither flag ⇒ falls back to the tier (backward compatible)', () => {
    // light auto-waives, standard requires approval — the pre-existing behavior.
    expect(producePlanGate(lightInputs).status).toBe('not_required');
    expect(producePlanGate(standardInputs).status).toBe('pending');
  });

  test('purposePreserving auto-waives even a standard tier to not_required (livelock fix)', () => {
    expect(producePlanGate({ ...standardInputs, purposePreserving: true }).status).toBe(
      'not_required',
    );
  });

  test('highRisk forces pending even on an otherwise auto-waivable light tier', () => {
    expect(producePlanGate({ ...lightInputs, highRisk: true }).status).toBe('pending');
  });

  test('forcePending WINS over purposePreserving (highRisk + purposePreserving ⇒ pending)', () => {
    expect(
      producePlanGate({ ...lightInputs, highRisk: true, purposePreserving: true }).status,
    ).toBe('pending');
  });

  test('requireApproval / oracleAssignmentIncomplete keep forcing pending over purposePreserving', () => {
    expect(
      producePlanGate({ ...standardInputs, requireApproval: true, purposePreserving: true }).status,
    ).toBe('pending');
    expect(
      producePlanGate({
        ...standardInputs,
        oracleAssignmentIncomplete: true,
        purposePreserving: true,
      }).status,
    ).toBe('pending');
  });
});

describe('rollbackOnRejection (G3: denied plan → rollback in-flight nodes)', () => {
  const rejected = {
    status: 'rejected' as const,
    source: null,
    approved_at: null,
    approved_by: null,
    evidence_refs: [],
  };

  test('rejected approval rolls running nodes back to pending and stops', () => {
    const nodes = buildInitialNodes(['ac-1']).map((n, i) =>
      i === 1 ? { ...n, status: 'running' as const } : n,
    );
    const result = rollbackOnRejection(graph({ approval_gate: rejected, nodes }));
    expect(result.stopped).toBe(true);
    expect(result.nodes.some((n) => n.status === 'running')).toBe(false);
    expect(result.nodes[1]?.status).toBe('pending');
  });

  test('passed nodes are left intact (only in-flight work rolls back)', () => {
    const nodes = buildInitialNodes(['ac-1']).map((n, i) =>
      i === 0 ? { ...n, status: 'passed' as const } : n,
    );
    const result = rollbackOnRejection(graph({ approval_gate: rejected, nodes }));
    expect(result.nodes[0]?.status).toBe('passed');
  });

  test('throws when called and approval is not rejected (guard the precondition)', () => {
    expect(() => rollbackOnRejection(graph())).toThrow();
  });
});
