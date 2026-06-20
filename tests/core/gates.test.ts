import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type DecisionConflict,
  acceptanceTestable,
  completionEvidenceGate,
  completionGate,
  convergenceGate,
  decisionConflictGate,
  decisionConflictRequiresApproval,
  deriveClosureMode,
  deterministicFloor,
  highRiskAssumption,
  intentDriftGate,
  interfaceBaselineDriftGate,
  interviewReadinessGate,
  knowledgeTriggerFired,
  knowledgeUpdateGate,
  resolvabilityBlockers,
  safeDefaultable,
} from '~/core/gates';
import { autopilot } from '~/schemas/autopilot';
import { completionContract } from '~/schemas/completion-contract';
import { convergence } from '~/schemas/convergence';
import { intentContract } from '~/schemas/intent';
import { interviewState } from '~/schemas/interview-state';
import { workItem } from '~/schemas/work-item';

const ROOT = join(import.meta.dir, '..', 'fixtures', 'gates');
const load = (rel: string): unknown => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

describe('deterministicFloor', () => {
  test('is the weighted sum of open sections, conflicts, and assumption ratio', () => {
    expect(
      deterministicFloor({ open_required_sections: 0, conflicting: 0, assumption_ratio: 0 }),
    ).toBe(0);
    expect(
      deterministicFloor({ open_required_sections: 2, conflicting: 1, assumption_ratio: 1 }),
    ).toBeCloseTo(0.05 * 2 + 0.1 + 0.05, 5);
  });

  test('clamps to [0,1]', () => {
    expect(
      deterministicFloor({ open_required_sections: 100, conflicting: 100, assumption_ratio: 1 }),
    ).toBe(1);
  });
});

describe('interviewReadinessGate', () => {
  test('ready fixture passes', () => {
    const state = interviewState.parse(load('interview-state/ready.json'));
    expect(interviewReadinessGate(state).pass).toBe(true);
  });

  test('blocked fixture fails (critical unresolved)', () => {
    const state = interviewState.parse(load('interview-state/blocked.json'));
    const result = interviewReadinessGate(state);
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes('critical'))).toBe(true);
  });
});

describe('acceptanceTestable', () => {
  test('observable criteria pass', () => {
    const intent = intentContract.parse(load('intent/observable-ac.json'));
    for (const ac of intent.acceptance_criteria) {
      expect(acceptanceTestable({ statement: ac.statement }).pass).toBe(true);
    }
  });

  test('vague criteria fail', () => {
    const intent = intentContract.parse(load('intent/vague-ac.json'));
    for (const ac of intent.acceptance_criteria) {
      expect(acceptanceTestable({ statement: ac.statement }).pass).toBe(false);
    }
  });

  test('word-boundary: substrings of vague terms do not false-positive', () => {
    const noFast = acceptanceTestable({ statement: 'serve breakfast within 200ms' });
    expect(noFast.reasons.some((r) => /vague/.test(r))).toBe(false);
    const steadfast = acceptanceTestable({ statement: 'steadfast retries return 200' });
    expect(steadfast.reasons.some((r) => /vague/.test(r))).toBe(false);
    const improvement = acceptanceTestable({ statement: 'reduce improvement lag to under 5' });
    expect(improvement.reasons.some((r) => /vague/.test(r))).toBe(false);
  });

  test('Korean observable predicate passes (no missing-predicate reason)', () => {
    const r = acceptanceTestable({ statement: '사용자가 없으면 빈 목록을 반환한다' });
    expect(r.pass).toBe(true);
    expect(r.reasons.some((x) => /observable/.test(x))).toBe(false);
  });

  test('Korean statement without an observable predicate still fails', () => {
    const r = acceptanceTestable({ statement: '비밀번호 기능을 더 좋게 만든다' });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => /observable/.test(x))).toBe(true);
  });

  test('Korean verb outside keyword list passes when evidence_required declared', () => {
    const invalidated = acceptanceTestable({
      statement: '캐시가 무효화된다',
      evidence_required: ['test'],
    });
    expect(invalidated.pass).toBe(true);
    expect(invalidated.reasons.some((x) => /observable/.test(x))).toBe(false);

    const reproduced = acceptanceTestable({
      statement: '버그가 재현되지 않는다',
      evidence_required: ['test'],
    });
    expect(reproduced.pass).toBe(true);
    expect(reproduced.reasons.some((x) => /observable/.test(x))).toBe(false);
  });

  test('no observable keyword and empty evidence_required still fails', () => {
    const r = acceptanceTestable({
      statement: '비밀번호 기능을 더 좋게 처리한다',
      evidence_required: [],
    });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => /observable/.test(x))).toBe(true);
  });

  test('vague statement still fails even with evidence_required (VAGUE_TERMS independent)', () => {
    const r = acceptanceTestable({ statement: 'makes it robust', evidence_required: ['test'] });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => /vague/.test(x))).toBe(true);
  });

  test('word-boundary: standalone vague terms still flag (incl. multi-word)', () => {
    expect(acceptanceTestable({ statement: 'response must be fast' }).reasons.join()).toContain(
      'fast',
    );
    expect(acceptanceTestable({ statement: 'user-friendly output' }).reasons.join()).toContain(
      'user-friendly',
    );
    expect(acceptanceTestable({ statement: 'be more user friendly' }).reasons.join()).toContain(
      'user friendly',
    );
  });
});

describe('completionGate cross-checks against the work item', () => {
  const item = workItem.parse(load('completion-crosscheck/workitem.json'));
  const completionOf = (rel: string) =>
    completionContract.parse(load(`completion-crosscheck/${rel}`));

  test('exact AC-set match passes', () => {
    expect(completionGate(item, completionOf('completion-match.json')).pass).toBe(true);
  });

  test('missing criterion fails', () => {
    const r = completionGate(item, completionOf('completion-missing.json'));
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.includes('missing'))).toBe(true);
  });

  test('extra criterion fails', () => {
    const r = completionGate(item, completionOf('completion-extra.json'));
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.includes('extra'))).toBe(true);
  });

  test('duplicate criterion fails (count-based, not Set-based)', () => {
    const r = completionGate(item, completionOf('completion-duplicate.json'));
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.includes('duplicate'))).toBe(true);
  });

  test('V5: a NON-pass completion that omits a criterion is still blocked', () => {
    // The AC-set cross-check used to run only for pass completions; a non-pass
    // completion could silently drop a criterion and slip the Stop gate.
    expect(item.acceptance_criteria.length).toBeGreaterThan(1);
    const firstId = item.acceptance_criteria[0]?.id;
    const partial = {
      acceptance: [{ criterion_id: firstId, verdict: 'partial' }],
      final_verdict: 'partial',
    } as unknown as Parameters<typeof completionGate>[1];
    const r = completionGate(item, partial);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.includes('missing'))).toBe(true);
  });
});

describe('convergenceGate reads recorded fields only', () => {
  test('converged fixture passes', () => {
    const c = convergence.parse(load('convergence/converged.json'));
    expect(convergenceGate(c).pass).toBe(true);
  });

  test('treadmill fixture fails (open admissible remains)', () => {
    const c = convergence.parse(load('convergence/treadmill.json'));
    const r = convergenceGate(c);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.includes('not converged'))).toBe(true);
  });

  test('early-converge fixture fails (declares converged with open admissible)', () => {
    const c = convergence.parse(load('convergence/early-converge.json'));
    const r = convergenceGate(c);
    expect(r.pass).toBe(false);
    // open_admissible_count recorded 0 but ledger has an open admissible objection,
    // and selected_version is not argmax.
    expect(r.reasons.length).toBeGreaterThan(0);
  });
});

describe('highRiskAssumption / safeDefaultable are two sides of one predicate', () => {
  test('high-risk fixture is high risk and not safe-defaultable', () => {
    const a = load('assumption/high-risk.json') as {
      non_local: boolean;
      irreversible: boolean;
      unaudited: boolean;
    };
    expect(highRiskAssumption(a)).toBe(true);
    expect(safeDefaultable(a)).toBe(false);
  });

  test('safe fixture is not high risk and is safe-defaultable', () => {
    const a = load('assumption/safe.json') as {
      non_local: boolean;
      irreversible: boolean;
      unaudited: boolean;
    };
    expect(highRiskAssumption(a)).toBe(false);
    expect(safeDefaultable(a)).toBe(true);
  });
});

describe('completionEvidenceGate (G8: ack/approval is not verification)', () => {
  test('a pass with a real verification command passes', () => {
    const c = completionContract.parse(load('completion/pass.json'));
    expect(completionEvidenceGate(c).pass).toBe(true);
  });

  test('an ack-only pass (schema-legal, note evidence, no commands) is rejected', () => {
    const raw = load('completion/ack-only-pass.json');
    // the schema itself ACCEPTS it — the ack≠verification gap is not a schema gap.
    expect(completionContract.safeParse(raw).success).toBe(true);
    const c = completionContract.parse(raw);
    const r = completionEvidenceGate(c);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.includes('ack'))).toBe(true);
  });

  test('a non-pass verdict is not subject to the evidence gate', () => {
    const c = completionContract.parse(load('completion/pass.json'));
    expect(completionEvidenceGate({ ...c, final_verdict: 'partial' }).pass).toBe(true);
  });
});

describe('deriveClosureMode records HOW closure was reached (ledger-primary)', () => {
  test('gate-passing closure is mutual_agreement', () => {
    expect(deriveClosureMode('readiness_met', true)).toBe('mutual_agreement');
    expect(deriveClosureMode('converged', true)).toBe('mutual_agreement');
  });

  test('cap/diminishing with gate NOT passing is ledger_only (floor/cap forced closure)', () => {
    expect(deriveClosureMode('cap_reached', false)).toBe('ledger_only');
    expect(deriveClosureMode('diminishing_returns', false)).toBe('ledger_only');
  });

  test('cap reached WHILE gate passes is mutual_agreement, not ledger_only', () => {
    expect(deriveClosureMode('cap_reached', true)).toBe('mutual_agreement');
  });

  test('user-deferred / blocked closures are safe_default', () => {
    expect(deriveClosureMode('user_deferred', false)).toBe('safe_default');
    expect(deriveClosureMode('user_owned_decision', false)).toBe('safe_default');
    expect(deriveClosureMode('blocked', false)).toBe('safe_default');
  });

  test('recorded closure_mode on fixtures matches the derivation', () => {
    const ready = interviewState.parse(load('interview-state/ready.json'));
    expect(ready.exit.closure_mode).toBe(
      deriveClosureMode(ready.exit.reason, ready.readiness.gate === 'ready'),
    );
    const conv = convergence.parse(load('convergence/converged.json'));
    expect(conv.exit.closure_mode).toBe(deriveClosureMode(conv.exit.reason, conv.gate.converged));
  });
});

describe('knowledgeUpdateGate (axis-4 durable-change triggers: under ∧ over-recording)', () => {
  const NONE = { adr_worthy_decision: false, new_agreed_term: false, repeated_pattern: false };
  const ZERO = { decisions: 0, glossary_terms: 0, patterns: 0, learnings: 0 };

  test('no trigger + nothing recorded → pass (valid explicit skip)', () => {
    expect(knowledgeUpdateGate(NONE, ZERO).pass).toBe(true);
    expect(knowledgeTriggerFired(NONE)).toBe(false);
  });

  test('over-recording: content with no trigger declared → fail (noise)', () => {
    const r = knowledgeUpdateGate(NONE, { ...ZERO, decisions: 1 });
    expect(r.pass).toBe(false);
    expect(r.reasons.join(' ')).toContain('over-recording');
  });

  test('under-recording: adr trigger fired but no decision recorded → fail', () => {
    const r = knowledgeUpdateGate({ ...NONE, adr_worthy_decision: true }, ZERO);
    expect(r.pass).toBe(false);
    expect(r.reasons.join(' ')).toContain('under-recording');
  });

  test('under-recording: term trigger fired but no glossary term → fail', () => {
    expect(knowledgeUpdateGate({ ...NONE, new_agreed_term: true }, ZERO).pass).toBe(false);
  });

  test('repeated_pattern is satisfied by EITHER a pattern OR a learning', () => {
    const t = { ...NONE, repeated_pattern: true };
    expect(knowledgeUpdateGate(t, { ...ZERO, patterns: 1 }).pass).toBe(true);
    expect(knowledgeUpdateGate(t, { ...ZERO, learnings: 1 }).pass).toBe(true);
    expect(knowledgeUpdateGate(t, ZERO).pass).toBe(false);
  });

  test('every fired trigger backed by matching content → pass', () => {
    const t = { adr_worthy_decision: true, new_agreed_term: true, repeated_pattern: true };
    const d = { decisions: 1, glossary_terms: 2, patterns: 0, learnings: 1 };
    expect(knowledgeUpdateGate(t, d).pass).toBe(true);
  });
});

describe('intentDriftGate (axis-2 intent conservation across the contract chain)', () => {
  const GOAL = 'the endpoint returns 200';
  const REQUEST = 'add a health endpoint';
  const acList = (ids: string[]) => ids.map((id) => ({ id, statement: `${id} returns 200` }));

  const mkIntent = (ids: string[]) =>
    intentContract.parse({
      schema_version: '0.1.0',
      work_item_id: 'wi_drift001',
      source_request: REQUEST,
      goal: GOAL,
      acceptance_criteria: acList(ids),
    });
  const mkWorkItem = (ids: string[], over: Record<string, unknown> = {}) =>
    workItem.parse({
      schema_version: '0.1.0',
      id: 'wi_drift001',
      title: 'drift',
      source_request: REQUEST,
      goal: GOAL,
      acceptance_criteria: acList(ids),
      created_at: '2026-06-06T00:00:00Z',
      updated_at: '2026-06-06T00:00:00Z',
      ...over,
    });
  const mkGraph = (refs: string[], over: Record<string, unknown> = {}) =>
    autopilot.parse({
      schema_version: '0.1.0',
      autopilot_id: 'orch_drift001',
      work_item_id: 'wi_drift001',
      root_goal: GOAL,
      approval_gate: { status: 'not_required' },
      caps: { fix_per_node: 2, switch_per_node: 1 },
      continue_policy: {},
      nodes: [
        {
          id: 'N3',
          kind: 'verify',
          owner: 'verifier',
          purpose: 'verify every criterion',
          status: 'pending',
          acceptance_refs: refs,
        },
      ],
      ...over,
    });

  const IDS = ['ac-1', 'ac-2'];

  test('a chain conserved from one finalize payload passes (no completion yet)', () => {
    const r = intentDriftGate({
      intent: mkIntent(IDS),
      workItem: mkWorkItem(IDS),
      graph: mkGraph(IDS),
    });
    expect(r.pass).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.advisories).toEqual([]);
  });

  test('H1: work-item goal divergence is ADVISORY (non-blocking), not a fail', () => {
    const r = intentDriftGate({
      intent: mkIntent(IDS),
      workItem: mkWorkItem(IDS, { goal: 'the endpoint returns 404' }),
      graph: mkGraph(IDS),
    });
    // Goal-string divergence is a re-statement-or-drift judgment ACG assigns to
    // review → surfaced as advisory, does NOT block (pass stays true).
    expect(r.pass).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.advisories.some((x) => x.startsWith('H1') && x.includes('goal'))).toBe(true);
  });

  test('H1: source_request divergence is ADVISORY (non-blocking)', () => {
    const r = intentDriftGate({
      intent: mkIntent(IDS),
      workItem: mkWorkItem(IDS, { source_request: 'totally different request' }),
      graph: mkGraph(IDS),
    });
    expect(r.pass).toBe(true);
    expect(r.advisories.some((x) => x.startsWith('H1') && x.includes('source_request'))).toBe(true);
  });

  test('H1: work-item adds an AC id not in intent → scope grow', () => {
    const r = intentDriftGate({
      intent: mkIntent(IDS),
      workItem: mkWorkItem(['ac-1', 'ac-2', 'ac-3']),
      graph: mkGraph(IDS),
    });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.includes('scope grow') && x.includes('ac-3'))).toBe(true);
  });

  test('H1: work-item drops an intent AC id → scope shrink', () => {
    const r = intentDriftGate({
      intent: mkIntent(IDS),
      workItem: mkWorkItem(['ac-1']),
      graph: mkGraph(['ac-1']),
    });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.includes('scope shrink') && x.includes('ac-2'))).toBe(true);
  });

  test('H1: AC statement may be refined while the id is conserved → pass', () => {
    const intent = mkIntent(IDS);
    const wi = mkWorkItem(IDS);
    const first = wi.acceptance_criteria[0];
    if (first) first.statement = 'the /health endpoint returns HTTP 200 within 50ms';
    const r = intentDriftGate({ intent, workItem: wi, graph: mkGraph(IDS) });
    expect(r.pass).toBe(true);
  });

  test('H2: autopilot root_goal divergence is ADVISORY (non-blocking)', () => {
    const r = intentDriftGate({
      intent: mkIntent(IDS),
      workItem: mkWorkItem(IDS),
      graph: mkGraph(IDS, { root_goal: 'do something else entirely' }),
    });
    expect(r.pass).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.advisories.some((x) => x.startsWith('H2') && x.includes('root_goal'))).toBe(true);
  });

  test('H2: an intent AC addressed by no node → scope shrink', () => {
    const r = intentDriftGate({
      intent: mkIntent(IDS),
      workItem: mkWorkItem(IDS),
      graph: mkGraph(['ac-1']),
    });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('H2') && x.includes('ac-2'))).toBe(true);
  });

  test('H2: a node references an AC id not in intent → scope grow (invented)', () => {
    const r = intentDriftGate({
      intent: mkIntent(IDS),
      workItem: mkWorkItem(IDS),
      graph: mkGraph(['ac-1', 'ac-2', 'ac-9']),
    });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('H2') && x.includes('ac-9'))).toBe(true);
  });

  test('H3: a conserved non-pass completion passes; the full chain passes', () => {
    const completion = completionContract.parse({
      schema_version: '0.1.0',
      work_item_id: 'wi_drift001',
      declared_by: 'verifier',
      declared_at: '2026-06-06T01:00:00Z',
      summary: 'done',
      acceptance: IDS.map((id) => ({ criterion_id: id, verdict: 'partial' })),
      final_verdict: 'partial',
      next_handoff_path: '.ditto/handoff/x.md',
    });
    const r = intentDriftGate({
      intent: mkIntent(IDS),
      workItem: mkWorkItem(IDS),
      graph: mkGraph(IDS),
      completion,
    });
    expect(r.pass).toBe(true);
  });

  test('H3: a non-pass completion dropping an intent AC id → scope shrink (blocks)', () => {
    const completion = completionContract.parse({
      schema_version: '0.1.0',
      work_item_id: 'wi_drift001',
      declared_by: 'verifier',
      declared_at: '2026-06-06T01:00:00Z',
      summary: 'done',
      acceptance: [{ criterion_id: 'ac-1', verdict: 'partial' }],
      final_verdict: 'partial',
      next_handoff_path: '.ditto/handoff/x.md',
    });
    const r = intentDriftGate({
      intent: mkIntent(IDS),
      workItem: mkWorkItem(IDS),
      graph: mkGraph(IDS),
      completion,
    });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('H3') && x.includes('ac-2'))).toBe(true);
  });

  test('H3: a PASS completion is NOT re-checked here (de-dup; completionGate owns it)', () => {
    // A pass completion that dropped ac-2 would be caught by completionGate; H3
    // skips on pass so the two gates do not double-emit the same missing id.
    const completion = completionContract.parse({
      schema_version: '0.1.0',
      work_item_id: 'wi_drift001',
      declared_by: 'verifier',
      declared_at: '2026-06-06T01:00:00Z',
      summary: 'done',
      acceptance: [{ criterion_id: 'ac-1', verdict: 'pass' }],
      final_verdict: 'pass',
    });
    const r = intentDriftGate({
      intent: mkIntent(IDS),
      workItem: mkWorkItem(IDS),
      graph: mkGraph(IDS),
      completion,
    });
    expect(r.pass).toBe(true);
    expect(r.reasons.some((x) => x.startsWith('H3'))).toBe(false);
  });

  test('whitespace-only goal difference is not drift (trimmed compare)', () => {
    const r = intentDriftGate({
      intent: mkIntent(IDS),
      workItem: mkWorkItem(IDS, { goal: `  ${GOAL}  ` }),
      graph: mkGraph(IDS),
    });
    expect(r.pass).toBe(true);
  });

  // ── ac-5: the frozen temporal baseline is consumed by drift enforcement ──
  // The baseline read here is the REAL frozen surface on a parsed autopilot graph
  // (approval_gate.change_surface, set by producePlanGate at plan stage), not a
  // stub — this exercises the baseline→comparison wiring the reviewer/verifier
  // drift path uses, reusing COVERAGE_AXIS_MECHANISMS.temporal.enforce.
  describe('interfaceBaselineDriftGate (axis-2 temporal: frozen plan baseline)', () => {
    const BASELINE = ['src/core/gates.ts', 'src/core/coverage-manager.ts'];
    const mkBaselineGraph = (surface: string[]) =>
      mkGraph(IDS, {
        approval_gate: { status: 'pending', change_surface: surface },
      });

    test('a current surface matching the frozen baseline passes', () => {
      const graph = mkBaselineGraph(BASELINE);
      // order-insensitive: reverse the current surface, still conserved
      const r = interfaceBaselineDriftGate(
        graph.approval_gate.change_surface,
        [...BASELINE].reverse(),
      );
      expect(r.pass).toBe(true);
      expect(r.reasons).toEqual([]);
    });

    test('an unconsented interface ADD vs the frozen baseline is flagged', () => {
      const graph = mkBaselineGraph(BASELINE);
      const r = interfaceBaselineDriftGate(graph.approval_gate.change_surface, [
        ...BASELINE,
        'src/core/secret-new-surface.ts',
      ]);
      expect(r.pass).toBe(false);
      expect(r.reasons.some((x) => x.includes('grow') && x.includes('secret-new-surface'))).toBe(
        true,
      );
    });

    test('an unconsented interface REMOVAL vs the frozen baseline is flagged', () => {
      const graph = mkBaselineGraph(BASELINE);
      const r = interfaceBaselineDriftGate(graph.approval_gate.change_surface, [BASELINE[0] ?? '']);
      expect(r.pass).toBe(false);
      expect(r.reasons.some((x) => x.includes('shrink') && x.includes('coverage-manager'))).toBe(
        true,
      );
    });

    test('no frozen baseline (brief regime inactive) is a no-op pass', () => {
      const graph = mkGraph(IDS); // approval_gate.status not_required, no change_surface
      expect(graph.approval_gate.change_surface).toBeUndefined();
      const r = interfaceBaselineDriftGate(graph.approval_gate.change_surface, ['src/anything.ts']);
      expect(r.pass).toBe(true);
    });
  });
});

describe('resolvabilityBlockers (default-DENY classifier over declared unverified labels)', () => {
  const ACS = ['ac-1', 'ac-2'];

  test('empty list → no blockers', () => {
    expect(resolvabilityBlockers([], ACS)).toEqual([]);
  });

  test('agent_resolvable ALWAYS blocks, even with grounding', () => {
    const b = resolvabilityBlockers(
      [
        {
          item: 'flaky test',
          reason: 'could fix',
          out_of_scope: false,
          resolvability: 'agent_resolvable',
          grounding: 'ADR-0099',
        },
      ],
      ACS,
    );
    expect(b).toHaveLength(1);
    expect(b[0]?.kind).toBe('agent_resolvable');
    expect(b[0]?.item).toBe('flaky test');
  });

  test('blocked_external ungrounded blocks; grounded does NOT block', () => {
    const ungrounded = resolvabilityBlockers(
      [
        {
          item: 'upstream API down',
          reason: 'cannot reach',
          out_of_scope: false,
          resolvability: 'blocked_external',
        },
      ],
      ACS,
    );
    expect(ungrounded).toHaveLength(1);
    const grounded = resolvabilityBlockers(
      [
        {
          item: 'upstream API down',
          reason: 'cannot reach',
          out_of_scope: false,
          resolvability: 'blocked_external',
          grounding: 'depends on payments-svc#42',
        },
      ],
      ACS,
    );
    expect(grounded).toEqual([]);
  });

  test('accepted_tradeoff grounded passes; ungrounded blocks', () => {
    const grounded = resolvabilityBlockers(
      [
        {
          item: 'perf not tuned',
          reason: 'tradeoff',
          out_of_scope: false,
          resolvability: 'accepted_tradeoff',
          grounding: 'ADR-0017',
        },
      ],
      ACS,
    );
    expect(grounded).toEqual([]);
    const ungrounded = resolvabilityBlockers(
      [
        {
          item: 'perf not tuned',
          reason: 'tradeoff',
          out_of_scope: false,
          resolvability: 'accepted_tradeoff',
        },
      ],
      ACS,
    );
    expect(ungrounded).toHaveLength(1);
  });

  test('user_decision ungrounded → blocks AND is flagged a user-decision surface', () => {
    const b = resolvabilityBlockers(
      [
        {
          item: 'which retention policy?',
          reason: 'needs product call',
          out_of_scope: false,
          resolvability: 'user_decision',
        },
      ],
      ACS,
    );
    expect(b).toHaveLength(1);
    expect(b[0]?.kind).toBe('user_decision');
    expect(b[0]?.userDecision).toBe(true);
  });

  test('user_decision grounded (recorded decision pointer) does NOT block', () => {
    const b = resolvabilityBlockers(
      [
        {
          item: 'retention policy',
          reason: 'decided',
          out_of_scope: false,
          resolvability: 'user_decision',
          grounding: 'decision in handoff.md:12',
        },
      ],
      ACS,
    );
    expect(b).toEqual([]);
  });

  test('AC-referencing item blocks (structural ac-id match) unless grounded', () => {
    const blocks = resolvabilityBlockers(
      [{ item: 'ac-2 path not exercised', reason: 'no test run', out_of_scope: false }],
      ACS,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe('agent_resolvable');
    const grounded = resolvabilityBlockers(
      [
        {
          item: 'ac-2 path not exercised',
          reason: 'no test run',
          out_of_scope: false,
          grounding: 'covered by e2e-7',
        },
      ],
      ACS,
    );
    expect(grounded).toEqual([]);
  });

  test('AC id matched as a whole token, not a brittle substring (ac-1 ≠ ac-12)', () => {
    const b = resolvabilityBlockers(
      [{ item: 'see ticket ac-12 unrelated', reason: 'note', out_of_scope: false }],
      ['ac-1'],
    );
    expect(b).toEqual([]);
  });

  test('absent label and no AC reference → does NOT block (legacy backward-compat)', () => {
    const b = resolvabilityBlockers(
      [{ item: 'docs not regenerated', reason: 'out of scope', out_of_scope: true }],
      ACS,
    );
    expect(b).toEqual([]);
  });

  test('pure: same input → same output and reads no files (does not touch fs)', () => {
    const input = [
      {
        item: 'flaky',
        reason: 'x',
        out_of_scope: false,
        resolvability: 'agent_resolvable' as const,
      },
      { item: 'ext', reason: 'y', out_of_scope: false, resolvability: 'blocked_external' as const },
    ];
    const a = resolvabilityBlockers(input, ACS);
    const b = resolvabilityBlockers(input, ACS);
    expect(a).toEqual(b);
    // structural guard against accidental fs access in the implementation source.
    const src = readFileSync(join(import.meta.dir, '..', '..', 'src', 'core', 'gates.ts'), 'utf8');
    const fnBody = src.slice(src.indexOf('export function resolvabilityBlockers'));
    expect(/readFileSync|Bun\.file|readFile\b|require\(/.test(fnBody)).toBe(false);
  });
});

describe('decisionConflictGate (ADR-contradiction guardrail: classify × route × disclose)', () => {
  const C = (over: Partial<DecisionConflict> = {}): DecisionConflict => ({
    adr_id: 'ADR-0006',
    kind: 'forbid',
    level: 'method',
    basis: 'work would add a TS-AST analyzer; ADR-0006 mandates CodeQL only',
    ...over,
  });

  test('no conflicts → nothing to disclose, not blocked, no approval', () => {
    const r = decisionConflictGate([], 'autopilot');
    expect(r.dispositions).toEqual([]);
    expect(r.blocked).toBe(false);
    expect(r.needsApproval).toBe(false);
    expect(r.disclose).toBe(false);
  });

  test('method conflict → align autonomously (no approval, not blocked) but STILL disclosed', () => {
    const r = decisionConflictGate([C({ level: 'method' })], 'autopilot');
    expect(r.dispositions[0]?.route).toBe('align');
    expect(r.blocked).toBe(false);
    expect(r.needsApproval).toBe(false);
    // Transparency: autonomous compliance is never silent — the basis must surface.
    expect(r.disclose).toBe(true);
    expect(r.dispositions[0]?.conflict.basis).toContain('CodeQL');
  });

  test('intent conflict, interactive → ask the user, not blocked, disclosed', () => {
    const r = decisionConflictGate([C({ level: 'intent' })], 'interactive');
    expect(r.dispositions[0]?.route).toBe('ask_user');
    expect(r.needsApproval).toBe(true);
    expect(r.blocked).toBe(false);
    expect(r.disclose).toBe(true);
  });

  test('intent conflict, autopilot → fail-closed block (no live wait), disclosed', () => {
    const r = decisionConflictGate([C({ level: 'intent' })], 'autopilot');
    expect(r.dispositions[0]?.route).toBe('block');
    expect(r.blocked).toBe(true);
    expect(r.needsApproval).toBe(false);
    expect(r.disclose).toBe(true);
  });

  test('prefer conflict → justify only, never blocks regardless of level/mode', () => {
    for (const mode of ['interactive', 'autopilot'] as const) {
      for (const level of ['intent', 'method'] as const) {
        const r = decisionConflictGate([C({ kind: 'prefer', level })], mode);
        expect(r.dispositions[0]?.route).toBe('justify');
        expect(r.blocked).toBe(false);
        expect(r.needsApproval).toBe(false);
        expect(r.disclose).toBe(true);
      }
    }
  });

  test('require kind routes like forbid (hard), not like prefer', () => {
    const r = decisionConflictGate([C({ kind: 'require', level: 'intent' })], 'autopilot');
    expect(r.dispositions[0]?.route).toBe('block');
  });

  test('mixed batch: method aligns while intent blocks (autopilot)', () => {
    const r = decisionConflictGate(
      [C({ adr_id: 'ADR-0006', level: 'method' }), C({ adr_id: 'ADR-0005', level: 'intent' })],
      'autopilot',
    );
    expect(r.dispositions.map((d) => d.route)).toEqual(['align', 'block']);
    expect(r.blocked).toBe(true);
    expect(r.disclose).toBe(true);
  });
});

describe('decisionConflictRequiresApproval (front-load intent conflict to the approval gate)', () => {
  const C = (over: Partial<DecisionConflict> = {}): DecisionConflict => ({
    adr_id: 'ADR-0006',
    kind: 'forbid',
    level: 'method',
    basis: 'b',
    ...over,
  });

  test('intent-level forbid/require → approval required', () => {
    expect(decisionConflictRequiresApproval([C({ kind: 'forbid', level: 'intent' })])).toBe(true);
    expect(decisionConflictRequiresApproval([C({ kind: 'require', level: 'intent' })])).toBe(true);
  });

  test('method conflict (auto-aligned) → no approval gate', () => {
    expect(decisionConflictRequiresApproval([C({ kind: 'forbid', level: 'method' })])).toBe(false);
  });

  test('prefer at intent level → no approval gate (justify only)', () => {
    expect(decisionConflictRequiresApproval([C({ kind: 'prefer', level: 'intent' })])).toBe(false);
  });

  test('no conflicts → no approval gate', () => {
    expect(decisionConflictRequiresApproval([])).toBe(false);
  });

  test('mixed: one intent conflict among methods still requires approval', () => {
    expect(
      decisionConflictRequiresApproval([
        C({ level: 'method' }),
        C({ adr_id: 'ADR-0005', level: 'intent' }),
      ]),
    ).toBe(true);
  });
});
