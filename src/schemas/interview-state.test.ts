import { describe, expect, test } from 'bun:test';
import { interviewQuestion, interviewState } from './interview-state';

/**
 * Additive-schema invariants for the converged interview design contract (wi_260723lny,
 * n-impl-schema, ac-1 / ac-5). These lock the LEGACY-PARSE invariant: every field added
 * for the 4-element choice structure, the internal/fired turn marker, and the verbatim
 * source anchor is additive-optional, and the exit.reason widening keeps cap_reached +
 * question_cap intact. Written red-first: they reference fields that do not yet exist.
 */

// A minimal LEGACY interview-state object carrying NONE of the new fields — exactly the
// shape a pre-existing .ditto interview-state.json on disk would have.
const legacyQuestion = {
  id: 'q1',
  asked_at: '2026-07-24T00:00:00.000Z',
  dimension: 'scope',
  question: 'Which scope?',
  why_matters: 'Decides the boundary',
  info_gain_estimate: 'high' as const,
};

const legacyState = {
  schema_version: '0.1.0' as const,
  work_item_id: 'wi_260723lny',
  status: 'active' as const,
  started_at: '2026-07-24T00:00:00.000Z',
  updated_at: '2026-07-24T00:00:00.000Z',
  readiness: { score: 0.5, threshold: 0.8, gate: 'blocked' as const },
  questions: [legacyQuestion],
  exit: {
    reason: 'cap_reached' as const,
    closure_mode: 'ledger_only' as const,
    question_cap: 8,
    questions_asked: 8,
  },
};

describe('interview-state additive schema (wi_260723lny)', () => {
  test('(i) legacy state with NONE of the new fields still parses (additive-optional)', () => {
    const parsed = interviewState.parse(legacyState);
    expect(parsed.questions[0]?.id).toBe('q1');
    // The new fields are simply absent — never defaulted into required shapes.
    expect(parsed.questions[0]?.options).toBeUndefined();
    expect(parsed.questions[0]?.turn_kind).toBeUndefined();
    expect(parsed.questions[0]?.source_anchor).toBeUndefined();
  });

  test('(ii) exit.reason accepts parked / blocked AND still accepts cap_reached', () => {
    for (const reason of ['cap_reached', 'parked', 'blocked'] as const) {
      const parsed = interviewState.parse({
        ...legacyState,
        exit: { ...legacyState.exit, reason },
      });
      expect(parsed.exit.reason).toBe(reason);
    }
    // The pre-existing terminating reasons remain valid too.
    for (const reason of [
      'readiness_met',
      'diminishing_returns',
      'user_deferred',
      'user_owned_decision',
    ] as const) {
      expect(() =>
        interviewState.parse({ ...legacyState, exit: { ...legacyState.exit, reason } }),
      ).not.toThrow();
    }
  });

  test('(iii) question_cap stays REQUIRED — omitting it fails parse', () => {
    const { question_cap: _omit, ...exitNoCap } = legacyState.exit;
    expect(() => interviewState.parse({ ...legacyState, exit: exitNoCap })).toThrow();
  });

  test('(iv) a question with the 4-element options[] structure parses', () => {
    const parsed = interviewQuestion.parse({
      ...legacyQuestion,
      options: [
        {
          label: 'Option A',
          expected_effect: 'Settles the boundary at the module edge',
          ripple: 'Forces callers to re-import',
          root_cause_approach: 'Addresses the coupling root cause, not a symptom',
        },
      ],
    });
    expect(parsed.options?.[0]?.expected_effect).toContain('boundary');
    expect(parsed.options?.[0]?.ripple).toContain('callers');
    expect(parsed.options?.[0]?.root_cause_approach).toContain('root cause');
  });

  test('turn_kind marker parses and ABSENT means fired (legacy metadata)', () => {
    const fired = interviewQuestion.parse({ ...legacyQuestion, turn_kind: 'fired' });
    const internal = interviewQuestion.parse({ ...legacyQuestion, turn_kind: 'internal' });
    const legacy = interviewQuestion.parse(legacyQuestion);
    expect(fired.turn_kind).toBe('fired');
    expect(internal.turn_kind).toBe('internal');
    // Absence is the legacy "fired" signal — consumers read undefined as fired.
    expect(legacy.turn_kind).toBeUndefined();
  });

  test('source_anchor holds the verbatim original utterance (scan-exempt tier)', () => {
    const parsed = interviewQuestion.parse({
      ...legacyQuestion,
      source_anchor: '원래 사용자가 말한 그대로의 요청 문장',
    });
    expect(parsed.source_anchor).toContain('원래');
  });
});
