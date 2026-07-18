// Per-gate catch-rate + specificity report generator (wi_260718srh, n7).
//
// WHY this file exists: the n6 harness drives each seeded defect down its gate's real
// execution path and emits a DriveResult tuple (defect_id, expected_gate_id, verdict). This
// module AGGREGATES those tuples — plus the n5 corpus + `runGate` specificity control — into
// a per-gate catch-rate / specificity report, identifies dead-gate candidates, and splits
// catch-0 into three kinds. It is derived ONLY from the tuples + runGate (a PURE function of
// the stored corpus state); it reads NO timestamp and calls NO synthesizeDecisionId, so the
// report is clock-free and deterministic (ac-6): two identical builds are byte-identical.

import type { GateId } from '~/core/gates';
import { GATE_ID } from '~/core/gates';
import { runGate } from '../../fixtures/scenarios/gate-coverage/corpus-schema';
import type { CorpusManifest, DriveResult } from '../drive/harness';

// The 16 canonical gate ids, in GATE_ID declaration order — the report row order.
const ALL_GATE_IDS = Object.values(GATE_ID) as GateId[];

/**
 * catch-0 taxonomy (ac-5). Populated ONLY on a gate that caught nothing of value:
 *  - `untargeted`      : targeted==0. The corpus never aimed at this gate (coverage gap).
 *                        NOT dead — absence of a probe, not a broken gate.
 *  - `unreachable-masked`: the gate was targeted but a prior gate/guard short-circuited so it
 *                        never ran. STRUCTURALLY impossible in the pure-`runGate` harness (each
 *                        gate is invoked directly, no ordering) — recorded as an N/A note, never
 *                        produced here. Would be a real dead-candidate if it ever arose.
 *  - `targeted-but-missed`: the gate ran on the seeded state and PASSed it (verdict==missed) —
 *                        a genuine escape signal. A dead-gate candidate.
 * `null` == the gate is healthy (targeted and caught ≥1, none missed).
 */
export type Catch0Kind = 'untargeted' | 'unreachable-masked' | 'targeted-but-missed';

export interface GateRow {
  gate_id: GateId;
  /** Denominator: corpus defects whose expected_gate_id === this gate (expected-miss excluded). */
  targeted: number;
  /** Of `targeted`, how many the gate actually FAILed (verdict==caught). */
  caught: number;
  /** Of `targeted`, how many the gate PASSed on the seeded state (verdict==missed) — escapes. */
  missed: number;
  /** caught/targeted, or 'N/A' when targeted==0 (coverage gap — NEVER rendered as 0%). */
  catch_rate: number | 'N/A';
  /** Fraction of this gate's clean_pairs that PASS the SAME gate (specificity control), or
   *  'N/A' when the gate has no targeted defect (no clean_pair to control against). */
  specificity: number | 'N/A';
  /** catch-0 classification, or null when the gate is healthy. */
  catch0: Catch0Kind | null;
  /** targeted-but-missed (or an always-unreachable gate). untargeted is NEVER a candidate. */
  is_dead_candidate: boolean;
}

export interface GateCoverageReport {
  gates: GateRow[];
  /** Gates whose seeded defect escaped (targeted-but-missed) or that are always unreachable. */
  dead_candidates: GateId[];
  /** Gates the corpus never aimed at (targeted==0). A coverage gap, NOT dead. */
  untargeted_gates: GateId[];
  /** Expected-miss defects (expected_gate_id === null): a coverage boundary, not a catch target. */
  no_gate: { defect_ids: string[]; note: string };
  /** Results with an UNDEFINED gate_id: attribution is MISSING (a different meaning from no-gate). */
  unstamped: { defect_ids: string[]; note: string };
  /** Defense against a vacuous (empty / all-expected-miss) corpus: ≥1 targeted defect exists. */
  has_real_defect: boolean;
  granularity_note: string;
  unreachable_masked_note: string;
  /** ac-8: LLM-reviewer-layer defects are OUT of scope here — verbatim from the corpus. */
  coverage_boundary: string;
}

const NO_GATE_NOTE =
  'expected-miss defects (expected_gate_id=null): a real defect that NO deterministic gate ' +
  'targets (LLM-reviewer-layer). These are a coverage boundary, N/A for catch — not a missed ' +
  'catch. Distinct from `unstamped` (a result whose gate attribution is missing).';

const UNSTAMPED_NOTE =
  'unstamped results (gate_id undefined): the drive tuple carries NO gate attribution. Unlike a ' +
  'no-gate (null) expected-miss, this is an attribution gap — the defect SHOULD map to a gate but ' +
  'none was recorded. Surfaced separately so it is never silently folded into coverage-boundary.';

const GRANULARITY_NOTE =
  'Attribution is GATE-granularity, not function-granularity: sibling classifiers share their ' +
  "parent gate's id and get no distinct id (riskRecordBlockers → resolvability, " +
  'discoveredDefectCloseBlockers → pass_close_residual). A per-gate row therefore aggregates all ' +
  'functions under that gate id; a catch cannot be attributed to a specific sibling function.';

const UNREACHABLE_MASKED_NOTE =
  'unreachable-masked (a gate skipped via prior short-circuit) is N/A in this measurement: the ' +
  'harness invokes each gate directly via the pure `runGate` seam with NO ordering, so no gate can ' +
  'mask another. It is enumerated in the taxonomy only so an ordering/wiring escape would classify ' +
  'here (and count as a dead candidate) if this harness were ever replaced by a sequenced one.';

/**
 * Build the per-gate coverage report from the corpus + the n6 drive tuples.
 * Pure and clock-free: no Date.now / Math.random / synthesizeDecisionId. `runGate` (pure over
 * the stored clean_pair) supplies specificity. Deterministic: identical inputs → identical output.
 *
 * @throws if the corpus has NO targeted defect (vacuous / all-expected-miss) — a coverage report
 *   over zero real defects would be every-row-N/A and pass vacuously; refuse it loud instead.
 */
export function buildReport(manifest: CorpusManifest, results: DriveResult[]): GateCoverageReport {
  const targetedDefects = manifest.defects.filter((d) => !d.is_expected_miss);
  if (targetedDefects.length === 0) {
    throw new Error(
      'VACUOUS CORPUS: no targeted (real) defect to measure — every catch_rate would be a ' +
        'vacuous N/A. Refusing to emit a coverage report over zero real defects.',
    );
  }

  // Index drive verdicts by defect_id for the per-gate roll-up.
  const verdictById = new Map(results.map((r) => [r.defect_id, r.verdict]));

  const gates: GateRow[] = ALL_GATE_IDS.map((gateId) => {
    const defectsForGate = targetedDefects.filter((d) => d.expected_gate_id === gateId);
    const targeted = defectsForGate.length;
    const caught = defectsForGate.filter((d) => verdictById.get(d.defect_id) === 'caught').length;
    const missed = defectsForGate.filter((d) => verdictById.get(d.defect_id) === 'missed').length;

    // denominator-0 → N/A, NEVER 0% (a coverage gap is not a 0% catch).
    const catch_rate: number | 'N/A' = targeted === 0 ? 'N/A' : caught / targeted;

    // specificity: of this gate's clean_pairs, how many PASS the SAME gate (runGate.pass).
    const specificity: number | 'N/A' =
      targeted === 0
        ? 'N/A'
        : defectsForGate.filter((d) => runGate(gateId, d.clean_pair).pass).length / targeted;

    // catch-0 taxonomy. unreachable-masked is never produced by the pure harness (see note).
    let catch0: Catch0Kind | null = null;
    if (targeted === 0) catch0 = 'untargeted';
    else if (missed > 0) catch0 = 'targeted-but-missed';

    // Dead-gate candidate = a targeted gate that let its seeded defect escape (or an
    // always-unreachable gate). An untargeted gate is a coverage gap, NEVER a candidate.
    const is_dead_candidate = catch0 === 'targeted-but-missed';

    return {
      gate_id: gateId,
      targeted,
      caught,
      missed,
      catch_rate,
      specificity,
      catch0,
      is_dead_candidate,
    };
  });

  // no-gate (null) vs unstamped (undefined): a deliberate, load-bearing distinction.
  const no_gate_ids = results.filter((r) => r.expected_gate_id === null).map((r) => r.defect_id);
  const unstamped_ids = results
    .filter((r) => r.expected_gate_id === undefined)
    .map((r) => r.defect_id);

  return {
    gates,
    dead_candidates: gates.filter((g) => g.is_dead_candidate).map((g) => g.gate_id),
    untargeted_gates: gates.filter((g) => g.targeted === 0).map((g) => g.gate_id),
    no_gate: { defect_ids: no_gate_ids, note: NO_GATE_NOTE },
    unstamped: { defect_ids: unstamped_ids, note: UNSTAMPED_NOTE },
    has_real_defect: targetedDefects.length > 0,
    granularity_note: GRANULARITY_NOTE,
    unreachable_masked_note: UNREACHABLE_MASKED_NOTE,
    coverage_boundary: manifest.coverage_boundary,
  };
}
