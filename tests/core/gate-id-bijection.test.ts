import { describe, expect, test } from 'bun:test';
import { GATE_ID } from '~/core/gates';

// wi_260718srh (n3) — stable gate_id namespace bijection/completeness.
//
// GATE_ID is the SoT for every deterministic-gate identity the decision log can stamp.
// The corpus is a HUMAN-PINNED literal set (see gates.ts) — NOT a reflective scan of
// "functions that return GateResult", because the gates span three return shapes
// (GateResult / *Result / blocker string[]) that no reflection can delimit. These
// assertions pin the three properties that make gate_id a usable attribution key:
//   (a) identity        — every key === its value (the id IS its own key),
//   (b) injective       — no two gates share a value (Set(values).size === entries),
//   (c) surjective/complete — the key set is EXACTLY the hand-pinned gate roster below.
// The expected roster is duplicated here as literals ON PURPOSE: it is the independent
// human pin the const is checked against, so a silently added/removed/renamed gate id
// fails this test instead of drifting unnoticed.

// The gates.ts deterministic-gate roster, each mapped to the verdict fn it names.
// (Sibling classifiers riskRecordBlockers / discoveredDefectCloseBlockers do NOT
// appear — they share the parent id resolvability / pass_close_residual.)
const EXPECTED_GATE_IDS = [
  'interview_readiness', // interviewReadinessGate
  'acceptance_testable', // acceptanceTestable
  'resolvability', // resolvabilityBlockers (+ sibling riskRecordBlockers)
  'pass_close_residual', // passCloseResidualBlockers (+ sibling discoveredDefectCloseBlockers)
  'oracle_satisfaction', // oracleSatisfaction
  'frozen_tests_intact', // assertFrozenTestsIntact
  'completion', // completionGate
  'completion_evidence', // completionEvidenceGate
  'non_pass_termination', // nonPassTerminationGate
  'convergence', // convergenceGate
  'decision_conflict', // decisionConflictGate
  'intent_drift', // intentDriftGate
  'direction_fork', // directionForkGate
  'knowledge_update', // knowledgeUpdateGate
  'interface_baseline_drift', // interfaceBaselineDriftGate
  'land', // landGate
] as const;

describe('GATE_ID stable gate identity (wi_260718srh n3)', () => {
  test('(a) identity: every entry key === value', () => {
    for (const [key, value] of Object.entries(GATE_ID)) {
      expect(key).toBe(value);
    }
  });

  test('(b) injective: no two gates share a gate_id value', () => {
    const entries = Object.entries(GATE_ID);
    const values = entries.map(([, v]) => v);
    expect(new Set(values).size).toBe(entries.length);
  });

  test('(c) surjective/complete: key set === hand-pinned expected roster', () => {
    const keys = Object.keys(GATE_ID).sort();
    const expected = [...EXPECTED_GATE_IDS].sort();
    expect(keys).toEqual(expected);
    // roster size is itself pinned so a duplicate-in-EXPECTED cannot mask a miss.
    expect(new Set(EXPECTED_GATE_IDS).size).toBe(EXPECTED_GATE_IDS.length);
    expect(Object.keys(GATE_ID).length).toBe(EXPECTED_GATE_IDS.length);
  });
});
