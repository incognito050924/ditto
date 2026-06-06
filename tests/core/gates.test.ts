import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  acceptanceTestable,
  completionEvidenceGate,
  completionGate,
  convergenceGate,
  deriveClosureMode,
  deterministicFloor,
  highRiskAssumption,
  intentDriftGate,
  interviewReadinessGate,
  knowledgeTriggerFired,
  knowledgeUpdateGate,
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
  });

  test('H1: work-item goal silently rewritten → fail', () => {
    const r = intentDriftGate({
      intent: mkIntent(IDS),
      workItem: mkWorkItem(IDS, { goal: 'the endpoint returns 404' }),
      graph: mkGraph(IDS),
    });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('H1') && x.includes('goal'))).toBe(true);
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

  test('H2: autopilot root_goal diverges from intent goal → fail', () => {
    const r = intentDriftGate({
      intent: mkIntent(IDS),
      workItem: mkWorkItem(IDS),
      graph: mkGraph(IDS, { root_goal: 'do something else entirely' }),
    });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('H2') && x.includes('root_goal'))).toBe(true);
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

  test('H3: completion conserves the work-item AC id set → pass; the full chain passes', () => {
    const completion = completionContract.parse({
      schema_version: '0.1.0',
      work_item_id: 'wi_drift001',
      declared_by: 'verifier',
      declared_at: '2026-06-06T01:00:00Z',
      summary: 'done',
      acceptance: IDS.map((id) => ({ criterion_id: id, verdict: 'pass' })),
      final_verdict: 'pass',
    });
    const r = intentDriftGate({
      intent: mkIntent(IDS),
      workItem: mkWorkItem(IDS),
      graph: mkGraph(IDS),
      completion,
    });
    expect(r.pass).toBe(true);
  });

  test('H3: completion drops a work-item AC id → scope shrink', () => {
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

  test('whitespace-only goal difference is not drift (trimmed compare)', () => {
    const r = intentDriftGate({
      intent: mkIntent(IDS),
      workItem: mkWorkItem(IDS, { goal: `  ${GOAL}  ` }),
      graph: mkGraph(IDS),
    });
    expect(r.pass).toBe(true);
  });
});
