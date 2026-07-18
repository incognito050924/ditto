import { describe, expect, test } from 'bun:test';
import { type AutopilotDecision, synthesizeDecisionId } from '~/core/autopilot-store';
import { GATE_ID } from '~/core/gates';
import { autopilot } from '~/schemas/autopilot';
import { completionContract } from '~/schemas/completion-contract';
import { intentContract } from '~/schemas/intent';

// T1 "autopilot 무-전가" (wi_2606266az, node n1i-schemas). Four additive-OPTIONAL
// schema additions so the later ac-1/ac-3/ac-4 gate+loop nodes have a contract to
// read, while every legacy on-disk artifact still parses. The HARD constraint:
// the new completion/intent fields are `.optional()` (no default) so a legacy
// completion.json / intent.json round-trips byte-identical; the new autopilot
// caps field is `.default` (mirroring converge_rounds/loop_rounds), so a legacy
// graph gains only the default, exactly like those existing caps.

// ── minimal valid bases (each literal IS the "legacy" shape) ──────────────────

function baseCompletion(): Record<string, unknown> {
  return {
    schema_version: '0.1.0',
    work_item_id: 'wi_test0001',
    declared_by: 'implementer',
    declared_at: '2026-06-26T00:00:00.000Z',
    summary: 'something changed',
    acceptance: [{ criterion_id: 'ac-1', verdict: 'pass' }],
    final_verdict: 'pass',
  };
}

// A legacy non-pass completion that pre-dates EVERY field this node adds. Must
// parse unchanged: remaining_risks stays a bare string[]; no new fields appear.
function legacyNonPassCompletion(): Record<string, unknown> {
  return {
    schema_version: '0.1.0',
    work_item_id: 'wi_legacy0001',
    declared_by: 'implementer',
    declared_at: '2026-01-01T00:00:00.000Z',
    summary: 'partial legacy work',
    acceptance: [{ criterion_id: 'ac-1', verdict: 'partial' }],
    remaining_risks: ['a residual risk in the old bare-string shape'],
    next_handoff_path: '.ditto/local/work-items/wi_legacy0001/handoff.md',
    final_verdict: 'partial',
  };
}

function legacyGraph(): Record<string, unknown> {
  return {
    schema_version: '0.1.0',
    autopilot_id: 'orch_legacy01',
    work_item_id: 'wi_legacy0001',
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
    // caps as written before this node: no no_progress_rounds (and no
    // loop_rounds/oracle_failures_to_block either — those already rely on default).
    caps: { fix_per_node: 2, switch_per_node: 1 },
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

function legacyIntent(): Record<string, unknown> {
  return {
    schema_version: '0.1.0',
    work_item_id: 'wi_legacy0001',
    source_request: 'do the legacy thing',
    goal: 'the legacy outcome is observable',
    acceptance_criteria: [{ id: 'ac-1', statement: 'an observable behavior' }],
    question_policy: 'ask_only_if_user_only_can_answer',
  };
}

// ── field 1: remaining_risk_records + extended resolvability enum ──────────────

describe('completion-contract remaining_risk_records (ac-3)', () => {
  test('a structured residual risk carries resolvability + grounding', () => {
    const claim = {
      ...baseCompletion(),
      remaining_risk_records: [
        {
          risk: 'the cache may go stale under concurrent writes',
          resolvability: 'agent_resolvable',
          grounding: 'src/core/cache.ts:42',
        },
      ],
    };
    const parsed = completionContract.parse(claim);
    expect(parsed.remaining_risk_records?.[0]?.resolvability).toBe('agent_resolvable');
    expect(parsed.remaining_risk_records?.[0]?.grounding).toBe('src/core/cache.ts:42');
  });

  test('resolvability enum carries the four ac-3 surfacing-reason categories', () => {
    for (const cls of [
      'decision_or_adr_conflict',
      'multiple_comparable_solutions',
      'out_of_scope',
      'genuinely_dangerous',
    ] as const) {
      const claim = {
        ...baseCompletion(),
        remaining_risk_records: [{ risk: 'r', resolvability: cls }],
      };
      const parsed = completionContract.parse(claim);
      expect(parsed.remaining_risk_records?.[0]?.resolvability).toBe(cls);
    }
  });

  test('the same four categories are valid on unverified[].resolvability (one shared enum, R11)', () => {
    const claim = {
      ...baseCompletion(),
      unverified: [
        { item: 'i', reason: 'r', out_of_scope: true, resolvability: 'genuinely_dangerous' },
      ],
    };
    const parsed = completionContract.parse(claim);
    expect(parsed.unverified[0]?.resolvability).toBe('genuinely_dangerous');
  });

  test('remaining_risk_records rejects an unknown resolvability value', () => {
    const claim = {
      ...baseCompletion(),
      remaining_risk_records: [{ risk: 'r', resolvability: 'bogus' }],
    };
    expect(() => completionContract.parse(claim)).toThrow();
  });
});

// ── field 2: honest partial/blocked status marker (ac-1) ──────────────────────

describe('completion-contract non_pass_status (ac-1)', () => {
  test('a non-pass completion may declare an honest partial with reason + grounding', () => {
    const claim = {
      ...legacyNonPassCompletion(),
      non_pass_status: {
        state: 'partial',
        reason: 'ac-2 needs a runtime fixture not yet available',
        grounding: 'tests/fixtures/e2e/login.json (absent)',
      },
    };
    const parsed = completionContract.parse(claim);
    expect(parsed.non_pass_status?.state).toBe('partial');
    expect(parsed.non_pass_status?.reason).toBe('ac-2 needs a runtime fixture not yet available');
  });

  test('state accepts blocked and rejects an unknown state', () => {
    const ok = {
      ...legacyNonPassCompletion(),
      non_pass_status: { state: 'blocked', reason: 'r', grounding: 'g' },
    };
    expect(completionContract.parse(ok).non_pass_status?.state).toBe('blocked');
    const bad = {
      ...legacyNonPassCompletion(),
      non_pass_status: { state: 'nope', reason: 'r', grounding: 'g' },
    };
    expect(() => completionContract.parse(bad)).toThrow();
  });

  test('non_pass_status is NOT required — a legacy non-pass completion omitting it parses (R10)', () => {
    // The required-when-non-pass enforcement lives in the gate, NOT in superRefine:
    // a legacy on-disk non-pass completion without non_pass_status must still parse.
    expect(() => completionContract.parse(legacyNonPassCompletion())).not.toThrow();
    expect(completionContract.parse(legacyNonPassCompletion()).non_pass_status).toBeUndefined();
  });
});

// ── field 3: autopilot caps.no_progress_rounds (ac-1 no-progress floor) ────────

describe('autopilot caps.no_progress_rounds', () => {
  test('a legacy graph gains a positive-int default (mirrors loop_rounds/oracle_failures_to_block)', () => {
    const parsed = autopilot.parse(legacyGraph());
    expect(parsed.caps.no_progress_rounds).toBe(3);
    expect(Number.isInteger(parsed.caps.no_progress_rounds)).toBe(true);
    expect(parsed.caps.no_progress_rounds).toBeGreaterThan(0);
  });

  test('an explicit value overrides the default; zero/negative is rejected', () => {
    const g = {
      ...legacyGraph(),
      caps: { fix_per_node: 2, switch_per_node: 1, no_progress_rounds: 5 },
    };
    expect(autopilot.parse(g).caps.no_progress_rounds).toBe(5);
    const bad = {
      ...legacyGraph(),
      caps: { fix_per_node: 2, switch_per_node: 1, no_progress_rounds: 0 },
    };
    expect(() => autopilot.parse(bad)).toThrow();
  });
});

// ── field 4: intent follow_up_materialization (ac-4 batch) ────────────────────

describe('intent follow_up_materialization (ac-4)', () => {
  test('records the one-time batch approval + the work items it created', () => {
    const intent = {
      ...legacyIntent(),
      follow_up_candidates: ['extract the parser', 'add a retry cap'],
      follow_up_materialization: {
        batch_approved: true,
        materialized_wis: ['wi_followup01', 'wi_followup02'],
      },
    };
    const parsed = intentContract.parse(intent);
    expect(parsed.follow_up_materialization?.batch_approved).toBe(true);
    expect(parsed.follow_up_materialization?.materialized_wis).toEqual([
      'wi_followup01',
      'wi_followup02',
    ]);
    // follow_up_candidates is NOT redesigned — still a bare string[].
    expect(parsed.follow_up_candidates).toEqual(['extract the parser', 'add a retry cap']);
  });
});

// ── legacy round-trip proof (byte-identical for the optional fields) ──────────

describe('legacy artifacts round-trip unchanged', () => {
  test('legacy non-pass completion.json parses with NO new fields and is parse-stable', () => {
    const parsed = completionContract.parse(legacyNonPassCompletion());
    // the two new completion fields are .optional() (no default) → absent on legacy
    expect(parsed.remaining_risk_records).toBeUndefined();
    expect(parsed.non_pass_status).toBeUndefined();
    // the legacy bare-string remaining_risks survives untouched
    expect(parsed.remaining_risks).toEqual(['a residual risk in the old bare-string shape']);
    // parse is idempotent: re-parsing the defaults-filled object yields an equal object
    expect(completionContract.parse(parsed)).toEqual(parsed);
  });

  test('legacy intent.json parses with NO new field and is parse-stable', () => {
    const parsed = intentContract.parse(legacyIntent());
    expect(parsed.follow_up_materialization).toBeUndefined();
    expect(intentContract.parse(parsed)).toEqual(parsed);
  });

  test('legacy autopilot.json parses (only the new caps default is added) and is parse-stable', () => {
    const parsed = autopilot.parse(legacyGraph());
    // pre-existing caps survive; the new field is filled by its default, exactly
    // like loop_rounds/oracle_failures_to_block already are for this same literal.
    expect(parsed.caps.fix_per_node).toBe(2);
    expect(parsed.caps.switch_per_node).toBe(1);
    expect(parsed.caps.no_progress_rounds).toBe(3);
    expect(autopilot.parse(parsed)).toEqual(parsed);
  });
});

// ── wi_260718srh (n3): AutopilotDecision.gate_id additive-optional round-trip ──
// The decision log is NOT a zod schema (there is no decision schema in
// src/schemas/autopilot.ts — verified); AutopilotDecision is the TS interface in
// autopilot-store.ts and its persistence path is JSON.stringify → JSON.parse
// (appendDecision / readDecisions). So the round-trip proof here is the JSON path,
// and the idempotency proof is `synthesizeDecisionId` — the sha1 that
// posted_decision_ids is keyed on.

// A legacy decision-log line that pre-dates the gate_id field. Must survive untouched.
function legacyDecisionLine(): AutopilotDecision {
  return {
    ts: '2026-01-01T00:00:00.000Z',
    node_id: 'V',
    failure_class: 'user_decision_needed',
    decision: 'escalate',
    reason: 'oracle-unsatisfied: ac-1 (legacy line, no gate_id)',
    criterion_ids: ['ac-1'],
  };
}

describe('AutopilotDecision gate_id (additive-optional, wi_260718srh)', () => {
  test('a gate-stamped decision line round-trips through JSON preserving gate_id', () => {
    const stamped: AutopilotDecision = {
      ...legacyDecisionLine(),
      gate_id: GATE_ID.oracle_satisfaction,
    };
    // the exact persistence path: appendDecision writes JSON.stringify; readDecisions parses.
    const roundTripped = JSON.parse(JSON.stringify(stamped)) as AutopilotDecision;
    expect(roundTripped.gate_id).toBe('oracle_satisfaction');
    expect(roundTripped).toEqual(stamped);
  });

  test('a legacy line without gate_id round-trips unchanged — the field stays absent', () => {
    const legacy = legacyDecisionLine();
    const roundTripped = JSON.parse(JSON.stringify(legacy)) as AutopilotDecision;
    expect(roundTripped.gate_id).toBeUndefined();
    expect('gate_id' in roundTripped).toBe(false);
    expect(roundTripped).toEqual(legacy);
  });

  test('posted_decision_ids idempotency: adding the optional field does NOT change a legacy hash', () => {
    const legacy = legacyDecisionLine();
    // synthesizeDecisionId = sha1(`${index} ${JSON.stringify(decision)}`). JSON.stringify
    // omits an undefined key, so a decision carrying an explicit `gate_id: undefined`
    // serializes BYTE-IDENTICALLY to a legacy line that lacks the key → identical hash at
    // every index (the additive field never silently re-posts a legacy line). We assert on
    // the serialization substrate itself (the hash is a pure function of it).
    const withUndef = { ...legacy, gate_id: undefined };
    expect(JSON.stringify(withUndef)).toBe(JSON.stringify(legacy));
    // A line that actually CARRIES a gate_id takes a NEW hash (a stamped line is a distinct
    // entry, fail-loud) — so only stamped lines change, legacy lines never do.
    const stamped: AutopilotDecision = { ...legacy, gate_id: GATE_ID.oracle_satisfaction };
    expect(synthesizeDecisionId(stamped, 0)).not.toBe(synthesizeDecisionId(legacy, 0));
    expect(JSON.stringify(stamped)).not.toBe(JSON.stringify(legacy));
  });
});
