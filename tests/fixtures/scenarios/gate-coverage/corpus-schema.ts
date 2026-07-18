// Seeded-defect corpus: shared schema + parser + gate driver (wi_260718srh, n5).
//
// WHY this file exists: the gate-coverage corpus (corpus.json) is the substrate the
// n6 harness runs down the real gate execution path to measure per-gate catch-rate.
// This module is the SINGLE parser/driver both fixture-validation (n5) and the n6
// harness import — one seam, no drift. It is intentionally the only place that knows
// how each deterministic gate is invoked from a stored `fixture_state`.
//
// Corpus contract (n2-design):
//  - `expected_gate_id` is validated against a zod ENUM DERIVED from gates.ts GATE_ID
//    (NOT a hand-copied literal set) so the corpus can never drift from the real gate
//    identity set — same source of truth. An unknown / mistyped gate id is rejected
//    fail-closed at parse time.
//  - each defect carries a `fixture_state` (drives its target gate to FAIL) and a
//    `clean_pair` (same shape, drives the SAME gate to PASS — the specificity control).
//  - `is_expected_miss` marks a real defect that NO deterministic gate targets (an
//    LLM-reviewer-layer defect); it has no target gate (`expected_gate_id: null`) and
//    is not driven here.

import { z } from 'zod';
import {
  GATE_ID,
  type GateId,
  type GateResult,
  acceptanceTestable,
  completionEvidenceGate,
  convergenceGate,
  interviewReadinessGate,
  knowledgeUpdateGate,
  nonPassTerminationGate,
  oracleSatisfaction,
} from '~/core/gates';
import type { CompletionContract } from '~/schemas/completion-contract';
import type { Convergence } from '~/schemas/convergence';
import type { InterviewState } from '~/schemas/interview-state';
import type { AcOracle } from '~/schemas/work-item';

// Derive the expected-gate-id enum DIRECTLY from gates.ts GATE_ID — no hand-copied
// literal set (drift-proof). A value not in GATE_ID is rejected fail-closed here.
const GATE_IDS = Object.values(GATE_ID) as [GateId, ...GateId[]];
export const gateIdEnum = z.enum(GATE_IDS);

export const corpusEntry = z
  .object({
    defect_id: z.string().min(1),
    // The deterministic gate this defect targets. `null` ONLY for an expected-miss
    // (a defect no deterministic gate is meant to catch); non-null values MUST be a
    // real GATE_ID (fail-closed on a typo).
    expected_gate_id: gateIdEnum.nullable(),
    // Drives `expected_gate_id` to FAIL (boundary-strict, not sitting ON the threshold).
    fixture_state: z.unknown(),
    // Same shape as `fixture_state`, drives the SAME gate to PASS (specificity control).
    clean_pair: z.unknown(),
    // A real defect that no deterministic gate targets (LLM-reviewer-layer). Not driven.
    is_expected_miss: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    // Coupling invariant: a targeted defect names a gate; an expected-miss names none.
    if (v.is_expected_miss && v.expected_gate_id !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'is_expected_miss=true must have expected_gate_id=null (no gate targets a miss)',
        path: ['expected_gate_id'],
      });
    }
    if (!v.is_expected_miss && v.expected_gate_id === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a targeted defect requires a non-null expected_gate_id',
        path: ['expected_gate_id'],
      });
    }
  })
  .describe('One seeded defect: fixture_state (FAIL) + clean_pair (PASS) for one gate');

export type CorpusEntry = z.infer<typeof corpusEntry>;

export const corpusManifest = z
  .object({
    // ac-8 coverage boundary: this corpus measures DETERMINISTIC gates only. Defects
    // that live in the LLM-reviewer layer — regression, silent scope shrink, evidence-
    // free completion claims, out-of-scope refactors — are OUT of scope here (they are
    // caught, if at all, by the reviewer/verifier layers, not a pure gate). They appear
    // only as `is_expected_miss` markers, never as targeted deterministic entries.
    coverage_boundary: z.string().min(1),
    defects: z.array(corpusEntry).min(1),
  })
  .describe('Seeded-defect corpus manifest (gate-coverage substrate for the n6 harness)');

export type CorpusManifest = z.infer<typeof corpusManifest>;

/** Parse a raw manifest, rejecting unknown gate ids / malformed entries fail-closed. */
export function parseCorpus(raw: unknown): CorpusManifest {
  return corpusManifest.parse(raw);
}

/**
 * Drive one deterministic gate with a stored state (fixture_state or clean_pair) and
 * return its normalized GateResult. The dispatch — which gate function, and how the
 * stored state maps onto its arguments — lives HERE so both fixture-validation and the
 * n6 harness share one invocation seam. Throws on an expected-miss / null id (a miss
 * has no gate to drive; callers filter those out first).
 */
export function runGate(gateId: GateId, state: unknown): GateResult {
  switch (gateId) {
    case GATE_ID.acceptance_testable:
      return acceptanceTestable(state as { statement: string; evidence_required?: string[] });
    case GATE_ID.knowledge_update: {
      const s = state as {
        triggers: Parameters<typeof knowledgeUpdateGate>[0];
        delta: Parameters<typeof knowledgeUpdateGate>[1];
      };
      return knowledgeUpdateGate(s.triggers, s.delta);
    }
    case GATE_ID.oracle_satisfaction: {
      const s = state as {
        ac_id: string;
        oracle: AcOracle;
        closing_evidence: Parameters<typeof oracleSatisfaction>[2];
      };
      return oracleSatisfaction(s.ac_id, s.oracle, s.closing_evidence);
    }
    case GATE_ID.convergence:
      return convergenceGate(state as unknown as Convergence);
    case GATE_ID.completion_evidence:
      return completionEvidenceGate(state as unknown as CompletionContract);
    case GATE_ID.non_pass_termination:
      return nonPassTerminationGate(state as unknown as CompletionContract);
    case GATE_ID.interview_readiness:
      return interviewReadinessGate(state as unknown as InterviewState);
    default:
      throw new Error(`gate ${gateId} is not driveable from the corpus (no invocation mapping)`);
  }
}
