// Seeded-defect drive harness (wi_260718srh, n6).
//
// WHY this file exists: it flows the n5 seeded-defect corpus down the REAL gate
// execution path and decides, per defect, whether its expected deterministic gate
// actually catches the seeded flaw — with NO LLM and NO autopilot loop.
//
// WHY pure runGate (not the full loop): only ONE targeted gate (oracle_satisfaction)
// stamps its gate_id onto the decision log inside the loop (n3). The other six targeted
// gates (acceptance_testable, knowledge_update, convergence, completion_evidence,
// non_pass_termination, interview_readiness) are consumed as pure verdicts by the
// interview-driver / completion-assembly / CLI and never reach the decision log. So
// counting catches by decision-log gate_id would only ever observe oracle_satisfaction.
// The gate verdict function IS the execution path: we invoke each gate directly via the
// n5 `runGate` seam and read its PASS/FAIL. This is the "LLM-free execution path" of ac-3.
//
// Egress (pre-mortem constraint a): this harness calls ONLY pure functions — it never
// spawns a subprocess, never touches the autopilot loop, and never reaches
// resolveTarget/directPostDecisions. Therefore `gh` (and any network egress) is
// STRUCTURALLY impossible here, independent of any work-item coordinates. harness.test.ts
// additionally proves it positively with a PATH-mounted recording `gh` stub asserted at
// zero calls. No src/core change is involved.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GateId } from '~/core/gates';
import {
  type CorpusEntry,
  type CorpusManifest,
  parseCorpus,
  runGate,
} from '../../fixtures/scenarios/gate-coverage/corpus-schema';

export type { CorpusEntry, CorpusManifest } from '../../fixtures/scenarios/gate-coverage/corpus-schema';

// The canonical corpus produced by n5. Resolved relative to THIS module so the path
// holds no matter the caller's cwd.
const HERE = dirname(fileURLToPath(import.meta.url));
export const CORPUS_PATH = resolve(HERE, '../../fixtures/scenarios/gate-coverage/corpus.json');

/**
 * Per-defect drive verdict.
 *  - `caught`: the expected gate FAILed on `fixture_state` (runGate.pass === false) —
 *    the seeded defect was detected on the execution path.
 *  - `missed`: the gate PASSed on the seeded `fixture_state` — a real escape signal.
 *  - `n/a`: an expected-miss (no deterministic gate targets it); not a catch target
 *    (a coverage-gap marker, not a pass/fail of a gate).
 *  - `harness_error`: the drive itself threw (e.g. the gate call failed). A SEPARATE
 *    tier — NEVER folded into `missed` — so a broken harness cannot silently masquerade
 *    as an escape. Callers must fail loud on it (see `assertNoHarnessErrors`).
 */
export type DriveVerdict = 'caught' | 'missed' | 'n/a' | 'harness_error';

export interface DriveResult {
  defect_id: string;
  expected_gate_id: GateId | null;
  verdict: DriveVerdict;
  /** FAIL reasons from the gate (for `caught`), for the n7 report. */
  reasons?: string[];
  /** Populated ONLY for `harness_error`: the thrown error's message. */
  error?: string;
}

/** Load + fail-closed parse the seeded-defect corpus from disk (default: n5 corpus.json). */
export function loadCorpus(path: string = CORPUS_PATH): CorpusManifest {
  return parseCorpus(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * Drive ONE defect down its expected gate's execution path.
 * Pure: depends only on the entry — no shared/mutable state, so per-defect isolation
 * (pre-mortem constraint c) is intrinsic; ordering cannot leak state between defects.
 */
export function driveDefect(entry: CorpusEntry): DriveResult {
  // Expected-miss: no gate to drive — a coverage-gap marker, not a catch target.
  if (entry.is_expected_miss || entry.expected_gate_id === null) {
    return { defect_id: entry.defect_id, expected_gate_id: null, verdict: 'n/a' };
  }
  const gateId = entry.expected_gate_id;
  try {
    const result = runGate(gateId, entry.fixture_state);
    // FAIL (pass === false) === the defect was caught on the execution path.
    return {
      defect_id: entry.defect_id,
      expected_gate_id: gateId,
      verdict: result.pass ? 'missed' : 'caught',
      reasons: result.reasons,
    };
  } catch (err) {
    // Loud, SEPARATE tier — do not count a thrown drive as a `missed` escape.
    return {
      defect_id: entry.defect_id,
      expected_gate_id: gateId,
      verdict: 'harness_error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Drive every defect in a manifest (original order). One throwing defect does not abort the rest. */
export function driveCorpus(manifest: CorpusManifest): DriveResult[] {
  return manifest.defects.map(driveDefect);
}

/** Index drive results by defect_id — the order-independent view used for determinism checks. */
export function catchMap(results: DriveResult[]): Map<string, DriveVerdict> {
  return new Map(results.map((r) => [r.defect_id, r.verdict]));
}

/** Fraction of TARGETED (non-n/a) defects that were caught. Pinned by the corpus, env-independent. */
export function catchRate(results: DriveResult[]): number {
  const targeted = results.filter((r) => r.verdict !== 'n/a' && r.verdict !== 'harness_error');
  if (targeted.length === 0) return 0;
  const caught = targeted.filter((r) => r.verdict === 'caught').length;
  return caught / targeted.length;
}

/**
 * Loud backstop for the HARNESS_ERROR tier (pre-mortem constraint b): throw if ANY
 * defect landed in `harness_error`, so a broken drive fails CI loudly instead of being
 * miscounted as a miss.
 */
export function assertNoHarnessErrors(results: DriveResult[]): void {
  const broken = results.filter((r) => r.verdict === 'harness_error');
  if (broken.length > 0) {
    const detail = broken.map((r) => `${r.defect_id}: ${r.error ?? 'unknown'}`).join('; ');
    throw new Error(`HARNESS_ERROR: ${broken.length} defect(s) failed to drive — ${detail}`);
  }
}
